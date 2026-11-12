import { Injectable } from '@nestjs/common';
import { and, desc, eq, isNull, or, type SQL, sql } from 'drizzle-orm';

import type { AuthIdentity } from '../auth/auth.guard.js';
import { users } from '../auth/auth.schema.js';
import { AuthService } from '../auth/auth.service.js';
import type { DatabaseTransaction } from '../database/database.service.js';
import { DevicesService } from '../devices/devices.service.js';
import { ErrorService } from '../error/error.service.js';
import { decodeHistoryCursor, encodeHistoryCursor } from './call-history.cursor.js';
import type {
  CallHistoryItemDto,
  CallHistoryListResponseDto,
  CallHistoryQueryDto,
  CallHistoryResponseDto,
  HistoryOutcome,
} from './call-history.dto.js';
import { CallHistoryLimits } from './call-history.limits.js';
import type { CallHistoryRecord } from './call-history.schema.js';
import { callHistory } from './call-history.schema.js';
import { DirectCallsRepository } from './direct-calls.repository.js';

interface HistoryEntry {
  row: CallHistoryRecord;
  peerDisplayName: string;
  sortTimestamp: string;
  durationSeconds: number | null;
}

export function historyOutcome(
  row: Pick<CallHistoryRecord, 'startedAt' | 'endReason'>,
  incoming: boolean,
): HistoryOutcome {
  if (row.startedAt !== null) {
    return 'completed';
  }

  if (row.endReason === 'rejected') {
    return 'rejected';
  }

  if (row.endReason === 'no_answer') {
    return incoming ? 'missed' : 'unanswered';
  }

  if (row.endReason === 'cancelled') {
    return incoming ? 'missed' : 'cancelled';
  }

  return 'failed';
}

@Injectable()
export class CallHistoryService {
  constructor(
    private readonly repository: DirectCallsRepository,
    private readonly auth: AuthService,
    private readonly devices: DevicesService,
    private readonly limits: CallHistoryLimits,
    private readonly error: ErrorService,
  ) {}

  private async authorize(tx: DatabaseTransaction, actor: AuthIdentity): Promise<void> {
    const [account] = await this.auth.lockAccountStates(tx, [actor.userId]);

    if (!account || account.disabledAt) {
      throw this.error.sessionInvalid();
    }

    await this.auth.lockSession(tx, actor.userId, actor.sessionId);
    await this.devices.lockSessionBinding(tx, actor.userId, actor.sessionId);
  }

  private async rows(
    tx: DatabaseTransaction,
    userId: string,
    condition: SQL | undefined,
    limit: number,
  ): Promise<HistoryEntry[]> {
    return tx
      .select({
        row: callHistory,
        peerDisplayName: users.displayName,
        sortTimestamp: sql<string>`to_char(${callHistory.createdAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
        durationSeconds: sql<
          number | null
        >`case when ${callHistory.startedAt} is null then null else floor(extract(epoch from (${callHistory.endedAt} - ${callHistory.startedAt}))) end`.mapWith(
          Number,
        ),
      })
      .from(callHistory)
      .innerJoin(
        users,
        sql`${users.id} = case when ${callHistory.callerId} = ${userId} then ${callHistory.recipientId} else ${callHistory.callerId} end`,
      )
      .where(
        and(or(eq(callHistory.callerId, userId), eq(callHistory.recipientId, userId)), condition),
      )
      .orderBy(desc(callHistory.createdAt), desc(callHistory.callId))
      .limit(limit);
  }

  private item(
    row: CallHistoryRecord,
    peerDisplayName: string,
    userId: string,
    duration: number | null,
  ): CallHistoryItemDto {
    const created = row.createdAt.getTime();
    const ended = row.endedAt.getTime();
    const started = row.startedAt?.getTime() ?? null;

    if (
      !Number.isFinite(created) ||
      !Number.isFinite(ended) ||
      ended < created ||
      (started !== null && (!Number.isFinite(started) || started < created || started > ended)) ||
      (duration !== null && (!Number.isSafeInteger(duration) || duration < 0)) ||
      (started === null) !== (duration === null) ||
      !Number.isSafeInteger(row.version) ||
      row.version < 0
    ) {
      throw this.error.internal();
    }

    const incoming = row.recipientId === userId;

    return {
      call_id: row.callId,
      version: row.version,
      peer_id: incoming ? row.callerId : row.recipientId,
      peer_display_name: peerDisplayName,
      direction: incoming ? 'incoming' : 'outgoing',
      outcome: historyOutcome(row, incoming),
      created_at: row.createdAt.toISOString(),
      started_at: row.startedAt?.toISOString() ?? null,
      ended_at: row.endedAt.toISOString(),
      end_reason: row.endReason,
      duration_seconds: duration,
    };
  }

  async list(actor: AuthIdentity, query: CallHistoryQueryDto): Promise<CallHistoryListResponseDto> {
    const limit = Number(query.limit);

    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw this.error.validation({ fields: [{ field: 'limit', code: 'INVALID' }] });
    }

    const cursor = decodeHistoryCursor(query.cursor, actor.userId, query.filter, this.error);

    await this.limits.check(actor.userId);

    return this.repository.transaction(async (tx): Promise<CallHistoryListResponseDto> => {
      await this.authorize(tx, actor);
      const rows = await this.rows(
        tx,
        actor.userId,
        and(
          query.filter === 'missed'
            ? and(
                eq(callHistory.recipientId, actor.userId),
                isNull(callHistory.startedAt),
                or(eq(callHistory.endReason, 'cancelled'), eq(callHistory.endReason, 'no_answer')),
              )
            : undefined,
          cursor
            ? sql`(${callHistory.createdAt}, ${callHistory.callId}) < (${cursor.created_at}::timestamptz, ${cursor.id}::uuid)`
            : undefined,
        ),
        limit + 1,
      );
      const { slice, length } = rows;

      const page = slice.bind(rows)(0, limit);
      const last = page.at(-1);

      return {
        items: page.map(({ row, peerDisplayName, durationSeconds }): CallHistoryItemDto =>
          this.item(row, peerDisplayName, actor.userId, durationSeconds),
        ),
        next_cursor:
          length > limit && last
            ? encodeHistoryCursor(actor.userId, query.filter, last.sortTimestamp, last.row.callId)
            : null,
      };
    });
  }

  async get(actor: AuthIdentity, id: string): Promise<CallHistoryResponseDto> {
    await this.limits.check(actor.userId);

    return this.repository.transaction(async (tx): Promise<CallHistoryResponseDto> => {
      await this.authorize(tx, actor);
      const [entry] = await this.rows(
        tx,
        actor.userId,
        eq(callHistory.callId, id.toLowerCase()),
        1,
      );

      if (!entry) {
        throw this.error.notFound();
      }

      return {
        item: this.item(entry.row, entry.peerDisplayName, actor.userId, entry.durationSeconds),
      };
    });
  }
}

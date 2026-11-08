import { randomUUID } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { and, asc, desc, eq, gt, lt, or, sql } from 'drizzle-orm';

import type { AuthIdentity } from '../auth/auth.guard.js';
import { users } from '../auth/auth.schema.js';
import { AuthService } from '../auth/auth.service.js';
import { isDatabaseUnavailable } from '../database/database.errors.js';
import { DatabaseService, type DatabaseTransaction } from '../database/database.service.js';
import { DevicesService } from '../devices/devices.service.js';
import { AppError } from '../error/app.error.js';
import { ErrorService } from '../error/error.service.js';
import { GroupsService } from '../groups/groups.service.js';
import { DialogsCrypto } from './dialogs.crypto.js';
import type {
  DialogDto,
  DialogListResponseDto,
  HistoryResponseDto,
  MessageDto,
  PermissionsResponseDto,
  SendMessageDto,
} from './dialogs.dto.js';
import { DialogsEvents } from './dialogs.events.js';
import { DialogsLimits } from './dialogs.limits.js';
import { dialogMessages, type DialogRow, dialogs, type MessageRow } from './dialogs.schema.js';
import { contentValue } from './dialogs.validation.js';

@Injectable()
export class DialogsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly auth: AuthService,
    private readonly devices: DevicesService,
    private readonly groups: GroupsService,
    private readonly crypto: DialogsCrypto,
    private readonly limits: DialogsLimits,
    private readonly error: ErrorService,
    private readonly events: DialogsEvents,
  ) {}

  private async transaction<T>(work: (tx: DatabaseTransaction) => Promise<T>): Promise<T> {
    try {
      return await this.database.db.transaction(work, { isolationLevel: 'read committed' });
    } catch (cause) {
      if (cause instanceof AppError) {
        throw cause;
      }

      if (isDatabaseUnavailable(cause)) {
        throw this.error.serviceUnavailable();
      }

      throw this.error.internal();
    }
  }

  private member(actor: string): ReturnType<typeof or> {
    return or(eq(dialogs.participantLowId, actor), eq(dialogs.participantHighId, actor));
  }

  private async own(
    tx: DatabaseTransaction,
    actor: string,
    id: string,
    lock = false,
  ): Promise<DialogRow> {
    const query = tx
      .select()
      .from(dialogs)
      .where(and(eq(dialogs.id, id), this.member(actor)));
    const [row] = await (lock ? query.for('update') : query);

    if (!row) {
      throw this.error.notFound();
    }

    return row;
  }

  private peer(row: DialogRow, actor: string): string {
    return row.participantLowId === actor ? row.participantHighId : row.participantLowId;
  }

  private async metadata(
    tx: DatabaseTransaction,
    actor: string,
    limit: number,
    offset = 0,
    id?: string,
  ): Promise<DialogDto[]> {
    // One statement snapshots the read positions, peer name and incoming-message predicate.
    const rows = await tx
      .select({
        row: dialogs,
        name: users.displayName,
        unread: sql<boolean>`exists (
          select 1 from ${dialogMessages}
          where ${dialogMessages.dialogId} = ${dialogs.id}
            and ${dialogMessages.senderId} <> ${actor}
            and ${dialogMessages.sequence} > case
              when ${dialogs.participantLowId} = ${actor} then ${dialogs.lowRead}
              else ${dialogs.highRead} end
        )`,
      })
      .from(dialogs)
      .innerJoin(
        users,
        eq(
          users.id,
          sql`case when ${dialogs.participantLowId} = ${actor}
        then ${dialogs.participantHighId} else ${dialogs.participantLowId} end`,
        ),
      )
      .where(and(this.member(actor), id ? eq(dialogs.id, id) : undefined))
      .orderBy(desc(sql`coalesce(${dialogs.lastMessageAt},${dialogs.createdAt})`), desc(dialogs.id))
      .limit(limit)
      .offset(offset);

    return rows.map(({ row, name, unread }): DialogDto => ({
      dialog_id: row.id,
      peer_id: this.peer(row, actor),
      peer_display_name: name,
      has_unread_messages: unread,
      created_at: row.createdAt.toISOString(),
      last_message_at: row.lastMessageAt?.toISOString() ?? null,
      last_sequence: row.lastSequence,
      last_read_sequence: row.participantLowId === actor ? row.lowRead : row.highRead,
      peer_last_read_sequence: row.participantLowId === actor ? row.highRead : row.lowRead,
    }));
  }

  private message(row: MessageRow, dialog: DialogRow): MessageDto {
    const read = row.senderId === dialog.participantLowId ? dialog.highRead : dialog.lowRead;

    return {
      message_id: row.id,
      dialog_id: row.dialogId,
      client_message_id: row.clientMessageId,
      sequence: row.sequence,
      sender_id: row.senderId,
      created_at: row.createdAt.toISOString(),
      content: this.crypto.decrypt(row),
      status: read >= row.sequence ? 'read' : 'sent',
    };
  }

  private denied(): never {
    throw this.error.create({
      status: 403,
      code: 'DIALOG_NOT_ALLOWED',
      message: 'Диалог недоступен.',
    });
  }

  private async access(
    tx: DatabaseTransaction,
    actor: Pick<AuthIdentity, 'userId' | 'sessionId'>,
    peerId?: string,
    readingOnly = false,
  ): Promise<{ deviceId: string; can_read: boolean; can_send: boolean }> {
    const accounts = await this.auth.lockAccountStates(
      tx,
      peerId ? [actor.userId, peerId] : [actor.userId],
    );
    const me = accounts.find((a): boolean => a.id === actor.userId);

    if (!me || me.disabledAt) {
      throw this.error.sessionInvalid();
    }

    await this.auth.lockSession(tx, actor.userId, actor.sessionId);
    const { deviceId } = await this.devices.lockSessionBinding(tx, actor.userId, actor.sessionId);

    if (!peerId) {
      return { deviceId, can_read: false, can_send: false };
    }

    const peer = accounts.find((a): boolean => a.id === peerId);

    if (!peer) {
      return { deviceId, can_read: false, can_send: false };
    }

    const meAdmin = me.role === 'admin';
    const peerAdmin = peer.role === 'admin' && !peer.disabledAt;
    // Membership is still needed to distinguish an ordinary user's reply to an admin.
    const common =
      meAdmin || (readingOnly && peerAdmin)
        ? false
        : await this.groups.lockCommonGroup(tx, actor.userId, peerId);

    return {
      deviceId,
      can_read: meAdmin || peerAdmin || common,
      can_send: !peer.disabledAt && (meAdmin || common),
    };
  }

  async create(
    actor: AuthIdentity,
    peerId: string,
  ): Promise<{ dialog: DialogDto; created: boolean }> {
    await this.limits.check(actor.userId, 'create');

    if (peerId === actor.userId) {
      this.denied();
    }

    return this.transaction(async (tx): Promise<{ dialog: DialogDto; created: boolean }> => {
      const access = await this.access(tx, actor, peerId);

      if (!access.can_send) {
        this.denied();
      }

      const [low, high] = [actor.userId, peerId].sort();
      const [inserted] = await tx
        .insert(dialogs)
        .values({ participantLowId: low!, participantHighId: high! })
        .onConflictDoNothing({ target: [dialogs.participantLowId, dialogs.participantHighId] })
        .returning();
      const row =
        inserted ??
        (
          await tx
            .select()
            .from(dialogs)
            .where(and(eq(dialogs.participantLowId, low!), eq(dialogs.participantHighId, high!)))
        )[0];

      if (!row) {
        throw this.error.internal();
      }

      const [dialog] = await this.metadata(tx, actor.userId, 1, 0, row.id);

      if (!dialog) {
        throw this.error.internal();
      }

      return { dialog, created: !!inserted };
    });
  }

  async list(actor: AuthIdentity, limit: number, offset: number): Promise<DialogListResponseDto> {
    await this.limits.check(actor.userId, 'get');

    return this.transaction(async (tx): Promise<DialogListResponseDto> => {
      await this.access(tx, actor);
      const rows = await this.metadata(tx, actor.userId, limit + 1, offset);

      return { dialogs: rows.slice(0, limit), has_more: rows.length > limit };
    });
  }

  async get(actor: AuthIdentity, id: string): Promise<{ dialog: DialogDto }> {
    await this.limits.check(actor.userId, 'get');

    return this.transaction(async (tx): Promise<{ dialog: DialogDto }> => {
      await this.own(tx, actor.userId, id);
      await this.access(tx, actor);

      const [dialog] = await this.metadata(tx, actor.userId, 1, 0, id);

      if (!dialog) {
        throw this.error.notFound();
      }

      return { dialog };
    });
  }

  async permissions(actor: AuthIdentity, id: string): Promise<PermissionsResponseDto> {
    await this.limits.check(actor.userId, 'get');

    return this.transaction(async (tx): Promise<PermissionsResponseDto> => {
      const row = await this.own(tx, actor.userId, id);
      const rights = await this.access(tx, actor, this.peer(row, actor.userId));

      return { dialogs: { can_read: rights.can_read, can_send: rights.can_send } };
    });
  }

  async history(
    actor: AuthIdentity,
    id: string,
    limit: number,
    after?: number,
    before?: number,
  ): Promise<HistoryResponseDto> {
    await this.limits.check(actor.userId, 'get');

    return this.transaction(async (tx): Promise<HistoryResponseDto> => {
      const row = await this.own(tx, actor.userId, id);

      if (!(await this.access(tx, actor, this.peer(row, actor.userId), true)).can_read) {
        this.denied();
      }

      // One statement snapshots messages and read positions together.
      const rows = await tx
        .select({ message: dialogMessages, dialog: dialogs })
        .from(dialogMessages)
        .innerJoin(dialogs, eq(dialogs.id, dialogMessages.dialogId))
        .where(
          and(
            eq(dialogMessages.dialogId, id),
            after !== undefined
              ? gt(dialogMessages.sequence, after)
              : before !== undefined
                ? lt(dialogMessages.sequence, before)
                : undefined,
          ),
        )
        .orderBy(after !== undefined ? asc(dialogMessages.sequence) : desc(dialogMessages.sequence))
        .limit(limit + 1);
      const messages: MessageDto[] = [];

      for (const { message, dialog } of rows.slice(0, limit)) {
        const dto = this.message(message, dialog);
        const candidate = { messages: [...messages, dto], has_more: true };

        if (Buffer.byteLength(JSON.stringify(candidate)) > 524288) {
          if (!messages.length) {
            throw this.error.internal();
          }

          break;
        }

        messages.push(dto);
      }

      return { messages, has_more: rows.length > messages.length };
    });
  }

  async send(
    actor: AuthIdentity,
    id: string,
    input: SendMessageDto,
  ): Promise<{ message: MessageDto; created: boolean }> {
    const content = contentValue(input.content, this.error);

    await this.limits.check(actor.userId, 'send');
    // Reservation completes before any business locks or transaction acquire a connection.
    const reserved = await this.crypto.reserve();
    const result = await this.transaction(
      async (tx): Promise<{ message: MessageDto; created: boolean; users: string[] }> => {
        const initial = await this.own(tx, actor.userId, id);
        const access = await this.access(tx, actor, this.peer(initial, actor.userId));

        if (!access.can_send) {
          this.denied();
        }

        const dialog = await this.own(tx, actor.userId, id, true);
        const [existing] = await tx
          .select()
          .from(dialogMessages)
          .where(
            and(
              eq(dialogMessages.dialogId, id),
              eq(dialogMessages.senderId, actor.userId),
              eq(dialogMessages.clientMessageId, input.client_message_id),
            ),
          );
        const users = [dialog.participantLowId, dialog.participantHighId];

        if (existing) {
          return { message: this.message(existing, dialog), created: false, users };
        }

        if (!reserved) {
          throw this.error.serviceUnavailable();
        }

        if (dialog.lastSequence >= Number.MAX_SAFE_INTEGER) {
          throw this.error.internal();
        }

        const [clock] = await tx
          .select({
            now: sql<Date>`date_trunc('milliseconds',clock_timestamp())`.mapWith(dialogs.createdAt),
          })
          .from(dialogs)
          .where(eq(dialogs.id, id));

        if (!clock) {
          throw this.error.internal();
        }

        const metadata = {
          id: randomUUID(),
          dialogId: id,
          senderId: actor.userId,
          senderDeviceId: access.deviceId,
          clientMessageId: input.client_message_id,
          sequence: dialog.lastSequence + 1,
          createdAt: clock.now,
          encryptionVersion: 1,
          encryptionKeyId: this.crypto.active,
        };
        const encrypted = this.crypto.encrypt(metadata, content);
        const [message] = await tx
          .insert(dialogMessages)
          .values({ ...metadata, ...encrypted })
          .returning();

        if (!message) {
          throw this.error.internal();
        }

        await tx
          .update(dialogs)
          .set({ lastSequence: metadata.sequence, lastMessageAt: metadata.createdAt })
          .where(eq(dialogs.id, id));

        return { message: this.message(message, dialog), created: true, users };
      },
    );

    if (result.created) {
      this.events.publish({
        users: result.users,
        message: result.message,
        event: {
          type: 'dialog.messages_available',
          payload: { dialog_id: id, last_sequence: result.message.sequence },
        },
      });
    }

    return { message: result.message, created: result.created };
  }

  async read(
    actor: AuthIdentity,
    id: string,
    sequence: number,
  ): Promise<{ last_read_sequence: number }> {
    await this.limits.check(actor.userId, 'read');
    const result = await this.transaction(
      async (tx): Promise<{ sequence: number; changed: boolean; users: string[] }> => {
        const initial = await this.own(tx, actor.userId, id);

        if (!(await this.access(tx, actor, this.peer(initial, actor.userId), true)).can_read) {
          this.denied();
        }

        const row = await this.own(tx, actor.userId, id, true);

        if (sequence > row.lastSequence) {
          throw this.error.validation({ fields: [{ field: 'sequence', code: 'INVALID' }] });
        }

        const low = row.participantLowId === actor.userId;
        const previous = low ? row.lowRead : row.highRead;
        const maximum = Math.max(sequence, previous);

        if (maximum > previous) {
          await tx
            .update(dialogs)
            .set(low ? { lowRead: maximum } : { highRead: maximum })
            .where(eq(dialogs.id, id));
        }

        return {
          sequence: maximum,
          changed: maximum > previous,
          users: [row.participantLowId, row.participantHighId],
        };
      },
    );

    if (result.changed) {
      this.events.publish({
        users: result.users,
        event: {
          type: 'dialog.read_updated',
          payload: { dialog_id: id, reader_id: actor.userId, last_read_sequence: result.sequence },
        },
      });
    }

    return { last_read_sequence: result.sequence };
  }

  /** Reauthorize each notification destination; no Redis bucket is consumed for delivery. */
  async canDeliver(
    userId: string,
    sessionId: string,
    deviceId: string,
    id: string,
  ): Promise<boolean> {
    try {
      return await this.transaction(async (tx): Promise<boolean> => {
        const row = await this.own(tx, userId, id);
        const rights = await this.access(tx, { userId, sessionId }, this.peer(row, userId), true);

        return rights.deviceId === deviceId && rights.can_read;
      });
    } catch {
      return false;
    }
  }
}

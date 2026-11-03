import { Injectable } from '@nestjs/common';
import { and, eq, isNull, or, sql } from 'drizzle-orm';

import { isDatabaseUnavailable } from '../database/database.errors.js';
import type { DatabaseTransaction } from '../database/database.service.js';
import { DatabaseService } from '../database/database.service.js';
import { ErrorService } from '../error/error.service.js';
import type { CallRecord } from './direct-calls.schema.js';
import { callDeliveries, callDto, callParticipants, directCalls } from './direct-calls.schema.js';

/** Internal persistence: transitions, busy release and outbox share one transaction. */
@Injectable()
export class DirectCallsRepository {
  constructor(
    private readonly database: DatabaseService,
    private readonly error: ErrorService,
  ) {}

  get db(): DatabaseService['db'] {
    return this.database.db;
  }

  async transaction<T>(action: (tx: DatabaseTransaction) => Promise<T>): Promise<T> {
    try {
      return await this.database.db.transaction(action);
    } catch (cause) {
      if (isDatabaseUnavailable(cause)) throw this.error.serviceUnavailable({ cause });

      throw cause;
    }
  }

  async lock(tx: DatabaseTransaction, id: string): Promise<void> {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${id}, 0))`);
  }

  async save(tx: DatabaseTransaction, call: CallRecord, previousDto: string): Promise<void> {
    if (JSON.stringify(callDto(call)) !== previousDto) {
      call.version++;
      await tx.update(directCalls).set(call).where(eq(directCalls.id, call.id));
      await tx
        .insert(callDeliveries)
        .values({ callId: call.id, kind: 'state', version: call.version, snapshot: callDto(call) });
    }

    if (call.state !== 'ringing')
      await tx
        .update(callDeliveries)
        .set({ status: 'cancelled', completedAt: new Date() })
        .where(
          and(
            eq(callDeliveries.callId, call.id),
            eq(callDeliveries.kind, 'voip'),
            or(eq(callDeliveries.status, 'pending'), eq(callDeliveries.status, 'processing')),
          ),
        );

    if (call.state === 'ended')
      await tx
        .update(callParticipants)
        .set({ releasedAt: call.endedAt })
        .where(and(eq(callParticipants.callId, call.id), isNull(callParticipants.releasedAt)));
  }
}

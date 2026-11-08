import { Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';

import { isDatabaseUnavailable } from '../database/database.errors.js';
import { DatabaseService, type DatabaseTransaction } from '../database/database.service.js';
import { ErrorService } from '../error/error.service.js';
import { type Account, authSessions, users } from './auth.schema.js';

export type StoredSession = typeof authSessions.$inferSelect;

@Injectable()
export class AuthSessions {
  constructor(
    private readonly database: DatabaseService,
    private readonly error: ErrorService,
  ) {}

  async transaction<T>(action: (tx: DatabaseTransaction) => Promise<T>): Promise<T> {
    try {
      return await this.database.db.transaction(action);
    } catch (cause) {
      if (isDatabaseUnavailable(cause)) {
        throw this.error.serviceUnavailable({ cause });
      }

      throw cause;
    }
  }

  async now(tx: DatabaseTransaction): Promise<Date> {
    const result = await tx.execute<{ now: Date }>(sql`select clock_timestamp() as now`);

    return new Date(result.rows[0]!.now);
  }

  async lockAccount(tx: DatabaseTransaction, id: string): Promise<Account | undefined> {
    return (await tx.select().from(users).where(eq(users.id, id)).for('share'))[0];
  }

  async read(
    sid: string,
    tx?: DatabaseTransaction,
    lock = false,
  ): Promise<StoredSession | undefined> {
    if (!tx) {
      return this.transaction((connection): Promise<StoredSession | undefined> =>
        this.read(sid, connection),
      );
    }

    const query = tx.select().from(authSessions).where(eq(authSessions.id, sid));

    return (await (lock ? query.for('update') : query))[0];
  }

  /** Account and session are read by one statement, hence one PostgreSQL snapshot. */
  async access(
    userId: string,
    sid: string,
  ): Promise<{ account: Account; session: StoredSession | null } | undefined> {
    return this.transaction(
      async (tx): Promise<{ account: Account; session: StoredSession | null } | undefined> => {
        const [row] = await tx
          .select({ account: users, session: authSessions })
          .from(users)
          .leftJoin(authSessions, and(eq(authSessions.id, sid), eq(authSessions.userId, users.id)))
          .where(eq(users.id, userId));

        return row;
      },
    );
  }

  async revokeAll(tx: DatabaseTransaction, userId: string): Promise<void> {
    await tx.delete(authSessions).where(eq(authSessions.userId, userId));
  }
}

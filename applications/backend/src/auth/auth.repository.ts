import { Injectable } from '@nestjs/common';
import { asc, eq, inArray } from 'drizzle-orm';

import { isDatabaseUnavailable } from '../database/database.errors.js';
import type { DatabaseTransaction } from '../database/database.service.js';
import { DatabaseService } from '../database/database.service.js';
import { ErrorService } from '../error/error.service.js';
import type { Account } from './auth.schema.js';
import { users } from './auth.schema.js';

@Injectable()
export class AuthRepository {
  constructor(
    private readonly database: DatabaseService,
    private readonly error: ErrorService,
  ) {}

  byLogin(login: string): Promise<Account | undefined> {
    return this.find(eq(users.login, login));
  }

  byId(id: string): Promise<Account | undefined> {
    return this.find(eq(users.id, id));
  }

  async lockActiveAccounts(tx: DatabaseTransaction, userIds: string[]): Promise<string[]> {
    try {
      const rows = await tx
        .select({ id: users.id, disabledAt: users.disabledAt })
        .from(users)
        .where(inArray(users.id, [...new Set(userIds)].sort()))
        .orderBy(asc(users.id))
        .for('share');

      return rows.filter((row): boolean => row.disabledAt === null).map((row): string => row.id);
    } catch (cause) {
      if (isDatabaseUnavailable(cause)) throw this.error.serviceUnavailable({ cause });

      throw cause;
    }
  }

  private async find(where: ReturnType<typeof eq>): Promise<Account | undefined> {
    try {
      return (await this.database.db.select().from(users).where(where).limit(1))[0];
    } catch (cause) {
      if (isDatabaseUnavailable(cause)) throw this.error.serviceUnavailable({ cause });

      throw cause;
    }
  }
}

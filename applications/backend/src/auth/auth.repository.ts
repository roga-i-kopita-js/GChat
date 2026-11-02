import { Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';

import { DatabaseService } from '../database/database.service.js';
import { ErrorService } from '../error/error.service.js';
import type { Account } from './auth.schema.js';
import { users } from './auth.schema.js';

const connectionMessages = new Set([
  'Connection terminated unexpectedly',
  'Connection terminated',
  'Connection terminated due to connection timeout',
  'Client has encountered a connection error and is not queryable',
  'timeout exceeded when trying to connect',
  'Query read timeout',
]);

function dependencyUnavailable(cause: unknown): boolean {
  if (!(cause instanceof Error)) return false;

  const failure = cause.cause instanceof Error ? cause.cause : cause;
  const code = 'code' in failure && typeof failure.code === 'string' ? failure.code : '';

  return (
    /^(08|53|57P|57014|ECONN|ETIMEDOUT|EPIPE|ENOTFOUND|EAI_AGAIN)/.test(code) ||
    connectionMessages.has(failure.message)
  );
}

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

  private async find(where: ReturnType<typeof eq>): Promise<Account | undefined> {
    try {
      return (await this.database.db.select().from(users).where(where).limit(1))[0];
    } catch (cause) {
      if (dependencyUnavailable(cause)) throw this.error.serviceUnavailable({ cause });

      throw cause;
    }
  }
}

import { randomBytes } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { and, asc, count, eq, ilike, isNotNull, isNull, or, sql } from 'drizzle-orm';

import type { DatabaseTransaction } from '../database/database.service.js';
import { ErrorService } from '../error/error.service.js';
import { AuthCrypto } from './auth.crypto.js';
import type { AuthIdentity } from './auth.guard.js';
import { users } from './auth.schema.js';
import { AuthSessions } from './auth.sessions.js';

export const accountProjection = {
  id: users.id,
  login: users.login,
  displayName: users.displayName,
  role: users.role,
  disabledAt: users.disabledAt,
  createdAt: users.createdAt,
  updatedAt: users.updatedAt,
};

export type SafeAccount = { [K in keyof typeof accountProjection]: (typeof users.$inferSelect)[K] };

export interface AccountInput {
  display_name: string;
  login?: string;
  password: string;
}

export interface AccountQuery {
  q?: string;
  status?: 'all' | 'active' | 'disabled';
  limit: number;
  offset: number;
}

export function literalPattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, '\\$&')}%`;
}

@Injectable()
export class AuthAccounts {
  constructor(
    private readonly sessions: AuthSessions,
    private readonly crypto: AuthCrypto,
    private readonly error: ErrorService,
  ) {}

  async prepare(
    input: AccountInput,
  ): Promise<{ displayName: string; login: string | undefined; passwordHash: string }> {
    const displayName = typeof input.display_name === 'string' ? input.display_name.trim() : '';
    const login = typeof input.login === 'string' ? input.login.trim().toLowerCase() : input.login;

    if (
      !displayName ||
      [...displayName].length > 80 ||
      (login !== undefined && (typeof login !== 'string' || !/^[a-z0-9._-]{3,32}$/.test(login)))
    ) {
      throw this.error.validation();
    }

    const passwordHash = await this.preparePassword(input.password);

    return { displayName, login, passwordHash };
  }

  async preparePassword(password: string): Promise<string> {
    if (typeof password !== 'string' || [...password].length < 15 || [...password].length > 128) {
      throw this.error.validation();
    }

    return this.crypto.hashPassword(password);
  }

  async create(
    tx: DatabaseTransaction,
    input: Awaited<ReturnType<AuthAccounts['prepare']>>,
    role: 'user' | 'admin',
  ): Promise<SafeAccount> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const login = input.login ?? `user-${randomBytes(4).toString('hex')}`;
      const [account] = await tx
        .insert(users)
        .values({ ...input, login, role })
        .onConflictDoNothing({ target: users.login })
        .returning(accountProjection);

      if (account) {
        return account;
      }

      if (input.login !== undefined) {
        throw this.error.loginTaken();
      }
    }

    throw this.error.serviceUnavailable();
  }

  async list(
    tx: DatabaseTransaction,
    query: AccountQuery,
  ): Promise<{ accounts: SafeAccount[]; total: number }> {
    const pattern = literalPattern(query.q ?? '');
    const where = and(
      or(ilike(users.displayName, pattern), ilike(users.login, pattern)),
      query.status === 'active'
        ? isNull(users.disabledAt)
        : query.status === 'disabled'
          ? isNotNull(users.disabledAt)
          : undefined,
    );
    const [{ total }] = await tx.select({ total: count() }).from(users).where(where);
    const accounts = await tx
      .select(accountProjection)
      .from(users)
      .where(where)
      .orderBy(asc(users.displayName), asc(users.id))
      .limit(query.limit)
      .offset(query.offset);

    return { accounts, total: total! };
  }

  async get(tx: DatabaseTransaction, id: string): Promise<SafeAccount> {
    const [row] = await tx.select(accountProjection).from(users).where(eq(users.id, id));

    if (!row) {
      throw this.error.notFound();
    }

    return row;
  }

  /** Serialize administrative writes, then recheck the actor and lock accounts in UUID order. */
  async authorize(tx: DatabaseTransaction, actor: AuthIdentity, target?: string): Promise<void> {
    await tx.execute(sql`select pg_advisory_xact_lock(1195591745, 1)`);
    const rows = await tx
      .select(accountProjection)
      .from(users)
      .where(or(eq(users.id, actor.userId), target ? eq(users.id, target) : undefined))
      .orderBy(asc(users.id))
      .for('update');
    const current = rows.find((row): boolean => row.id === actor.userId);

    if (!current || current.disabledAt) {
      throw this.error.sessionInvalid();
    }

    const session = await this.sessions.read(actor.sessionId, tx, true);

    if (session?.userId !== current.id) {
      throw this.error.sessionInvalid();
    }

    if (current.role !== 'admin') {
      throw this.error.forbidden();
    }

    if (target && !rows.some((row): boolean => row.id === target)) {
      throw this.error.notFound();
    }
  }

  async change(
    tx: DatabaseTransaction,
    id: string,
    action: 'password' | 'disable' | 'enable',
    passwordHash?: string,
  ): Promise<SafeAccount> {
    const current = await this.get(tx, id);

    if (action === 'enable' && current.disabledAt === null) {
      return current;
    }

    await this.sessions.revokeAll(tx, id);
    const [account] = await tx
      .update(users)
      .set({
        updatedAt: sql`clock_timestamp()`,
        ...(action === 'password'
          ? { passwordHash }
          : {
              disabledAt:
                action === 'disable' ? (current.disabledAt ?? sql`clock_timestamp()`) : null,
            }),
      })
      .where(eq(users.id, id))
      .returning(accountProjection);

    return account!;
  }
}

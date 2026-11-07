import { randomUUID, timingSafeEqual } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';

import type { DatabaseTransaction } from '../database/database.service.js';
import { ErrorService } from '../error/error.service.js';
import { AuthCrypto, sessionId, tokenHash } from './auth.crypto.js';
import type { LoginDto, RefreshDto, TokensDto } from './auth.dto.js';
import type { AuthIdentity } from './auth.guard.js';
import { AuthLimits } from './auth.limits.js';
import { AuthRepository } from './auth.repository.js';
import type { Account } from './auth.schema.js';
import { authSessions, users } from './auth.schema.js';
import { AuthSessions } from './auth.sessions.js';
function matches(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);

  return x.length === y.length && timingSafeEqual(x, y);
}

@Injectable()
export class AuthService {
  constructor(
    private readonly accounts: AuthRepository,
    private readonly crypto: AuthCrypto,
    private readonly sessions: AuthSessions,
    private readonly limits: AuthLimits,
    private readonly error: ErrorService,
  ) {}

  async login(input: LoginDto): Promise<TokensDto> {
    const login = input.login.trim().toLowerCase();

    this.limits.check(login, 'login');
    const account = await this.accounts.byLogin(login);
    const valid = await this.crypto.verifyPassword(input.password, account?.passwordHash);

    if (!account || !valid || account.disabledAt) {
      this.limits.check(login, 'login', true);

      throw this.error.invalidCredentials();
    }

    this.limits.check(login, 'login');

    return this.sessions.transaction(async (tx): Promise<TokensDto> => {
      const current = await this.sessions.lockAccount(tx, account.id);

      if (!current || current.disabledAt || current.passwordHash !== account.passwordHash) {
        this.limits.check(login, 'login', true);

        throw this.error.invalidCredentials();
      }

      const sid = randomUUID();
      const tokens = await this.crypto.issue(current, sid);

      await tx
        .insert(authSessions)
        .values({ id: sid, userId: current.id, refreshTokenHash: tokenHash(tokens.refresh_token) });

      return tokens;
    });
  }

  async refresh(input: RefreshDto): Promise<TokensDto> {
    const sid = sessionId(input.refresh_token);
    const initial = sid ? await this.sessions.read(sid) : undefined;

    if (!sid || !initial) throw this.error.sessionInvalid();

    const hash = tokenHash(input.refresh_token);

    return this.sessions.transaction(async (tx): Promise<TokensDto> => {
      const account = await this.sessions.lockAccount(tx, initial.userId);
      const state = await this.sessions.read(sid, tx, true);

      if (!account || account.disabledAt || !state || state.userId !== account.id)
        throw this.error.sessionInvalid();

      const now = await this.sessions.now(tx);

      if (
        state.rotationExpiresAt &&
        state.rotationExpiresAt > now &&
        state.rotationRequestId === input.request_id &&
        matches(state.rotationTokenHash!, hash)
      ) {
        return this.crypto.decrypt(state.rotationEncrypted!, sid, input.request_id);
      }

      if (!matches(state.refreshTokenHash, hash) || state.rotationRequestId === input.request_id)
        throw this.error.sessionInvalid();

      this.limits.check(sid, 'refresh', true, `${input.request_id}:${hash}`);
      const tokens = await this.crypto.issue(account, sid);
      const encrypted = await this.crypto.encrypt(tokens, sid, input.request_id);

      await tx
        .update(authSessions)
        .set({
          refreshTokenHash: tokenHash(tokens.refresh_token),
          updatedAt: sql`clock_timestamp()`,
          rotationRequestId: input.request_id,
          rotationTokenHash: hash,
          rotationEncrypted: encrypted,
          rotationExpiresAt: sql`clock_timestamp() + interval '30 seconds'`,
        })
        .where(eq(authSessions.id, sid));

      return tokens;
    });
  }

  async logout(token: string): Promise<void> {
    const sid = sessionId(token);
    const initial = sid ? await this.sessions.read(sid) : undefined;

    if (!sid || !initial) return;

    const hash = tokenHash(token);

    await this.sessions.transaction(async (tx): Promise<void> => {
      await this.sessions.lockAccount(tx, initial.userId);
      const state = await this.sessions.read(sid, tx, true);

      if (!state || state.userId !== initial.userId) return;

      const now = await this.sessions.now(tx);

      if (
        matches(state.refreshTokenHash, hash) ||
        (state.rotationExpiresAt &&
          state.rotationExpiresAt > now &&
          matches(state.rotationTokenHash!, hash))
      ) {
        await tx.delete(authSessions).where(eq(authSessions.id, sid));
      }
    });
  }

  async checkSession(
    userId: string,
    sid: string,
  ): Promise<{ accountActive: boolean; sessionActive: boolean }> {
    const state = await this.sessions.access(userId, sid);

    return { accountActive: !!state && !state.account.disabledAt, sessionActive: !!state?.session };
  }

  lockActiveAccounts(tx: DatabaseTransaction, userIds: string[]): Promise<string[]> {
    return this.accounts.lockActiveAccounts(tx, userIds);
  }

  lockActiveAccountRoles(
    tx: DatabaseTransaction,
    userIds: string[],
  ): Promise<{ id: string; role: Account['role'] }[]> {
    return this.accounts.lockActiveAccountRoles(tx, userIds);
  }

  async lockAccountStates(
    tx: DatabaseTransaction,
    userIds: string[],
  ): Promise<{ id: string; role: Account['role']; disabledAt: Date | null }[]> {
    return tx
      .select({ id: users.id, role: users.role, disabledAt: users.disabledAt })
      .from(users)
      .where(inArray(users.id, [...new Set(userIds)].sort()))
      .orderBy(asc(users.id))
      .for('share');
  }

  async lockSession(tx: DatabaseTransaction, userId: string, sid: string): Promise<void> {
    const [session] = await tx
      .select({ id: authSessions.id })
      .from(authSessions)
      .where(and(eq(authSessions.id, sid), eq(authSessions.userId, userId)))
      .for('share');

    if (!session) throw this.error.sessionInvalid();
  }

  async authenticate(token: string): Promise<AuthIdentity> {
    const identity = await this.crypto.verifyAccess(token);
    const state = await this.sessions.access(identity.userId, identity.sessionId);

    if (!state || state.account.disabledAt || !state.session) throw this.error.sessionInvalid();

    return {
      ...identity,
      login: state.account.login,
      displayName: state.account.displayName,
      role: state.account.role,
    };
  }
}

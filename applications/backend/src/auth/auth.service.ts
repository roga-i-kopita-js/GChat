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

  async displayName(userId: string): Promise<string | undefined> {
    const { displayName, disabledAt } = (await this.accounts.byId(userId)) ?? {};

    return disabledAt ? undefined : displayName;
  }

  async login(input: LoginDto): Promise<TokensDto> {
    const login = input.login.trim().toLowerCase();

    this.limits.check(login, 'login');
    const account = await this.accounts.byLogin(login);
    const { passwordHash: accountPasswordHash } = account ?? {};
    const valid = await this.crypto.verifyPassword(input.password, accountPasswordHash);

    const { disabledAt: accountDisabledAt } = account ?? {};

    if (!account || !valid || accountDisabledAt) {
      this.limits.check(login, 'login', true);

      throw this.error.invalidCredentials();
    }

    this.limits.check(login, 'login');

    return this.sessions.transaction(async (tx): Promise<TokensDto> => {
      const { id: accountId } = account;
      const current = await this.sessions.lockAccount(tx, accountId);

      const { disabledAt: currentDisabledAt, passwordHash: currentPasswordHash } = current ?? {};
      const { passwordHash: accountPasswordHash2 } = account;

      if (!current || currentDisabledAt || currentPasswordHash !== accountPasswordHash2) {
        this.limits.check(login, 'login', true);

        throw this.error.invalidCredentials();
      }

      const sid = randomUUID();
      const tokens = await this.crypto.issue(current, sid);

      const { id: currentId } = current;
      const { refresh_token: tokensRefreshToken } = tokens;

      await tx
        .insert(authSessions)
        .values({ id: sid, userId: currentId, refreshTokenHash: tokenHash(tokensRefreshToken) });

      return tokens;
    });
  }

  async refresh(input: RefreshDto): Promise<TokensDto> {
    const sid = sessionId(input.refresh_token);
    const initial = sid ? await this.sessions.read(sid) : undefined;

    if (!sid || !initial) {
      throw this.error.sessionInvalid();
    }

    const hash = tokenHash(input.refresh_token);

    return this.sessions.transaction(async (tx): Promise<TokensDto> => {
      const account = await this.sessions.lockAccount(tx, initial.userId);
      const state = await this.sessions.read(sid, tx, true);

      const { disabledAt: accountDisabledAt2 } = account ?? {};
      const { userId: stateUserId } = state ?? {};
      const { id: accountId2 } = account ?? {};

      if (!account || accountDisabledAt2 || !state || stateUserId !== accountId2) {
        throw this.error.sessionInvalid();
      }

      const now = await this.sessions.now(tx);

      const {
        rotationExpiresAt: stateRotationExpiresAt,
        rotationRequestId: stateRotationRequestId,
        rotationTokenHash: stateRotationTokenHash,
      } = state;

      if (
        stateRotationExpiresAt &&
        stateRotationExpiresAt > now &&
        stateRotationRequestId === input.request_id &&
        matches(stateRotationTokenHash!, hash)
      ) {
        const { rotationEncrypted: stateRotationEncrypted } = state;

        return this.crypto.decrypt(stateRotationEncrypted!, sid, input.request_id);
      }

      const {
        refreshTokenHash: stateRefreshTokenHash,
        rotationRequestId: stateRotationRequestId2,
      } = state;

      if (!matches(stateRefreshTokenHash, hash) || stateRotationRequestId2 === input.request_id) {
        throw this.error.sessionInvalid();
      }

      this.limits.check(sid, 'refresh', true, `${input.request_id}:${hash}`);
      const tokens = await this.crypto.issue(account, sid);
      const encrypted = await this.crypto.encrypt(tokens, sid, input.request_id);

      const { refresh_token: tokensRefreshToken2 } = tokens;

      await tx
        .update(authSessions)
        .set({
          refreshTokenHash: tokenHash(tokensRefreshToken2),
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

    if (!sid || !initial) {
      return;
    }

    const hash = tokenHash(token);

    await this.sessions.transaction(async (tx): Promise<void> => {
      await this.sessions.lockAccount(tx, initial.userId);
      const state = await this.sessions.read(sid, tx, true);

      const { userId: stateUserId2 } = state ?? {};

      if (!state || stateUserId2 !== initial.userId) {
        return;
      }

      const now = await this.sessions.now(tx);

      const {
        refreshTokenHash: stateRefreshTokenHash2,
        rotationExpiresAt: stateRotationExpiresAt2,
        rotationTokenHash: stateRotationTokenHash2,
      } = state;

      if (
        matches(stateRefreshTokenHash2, hash) ||
        (stateRotationExpiresAt2 &&
          stateRotationExpiresAt2 > now &&
          matches(stateRotationTokenHash2!, hash))
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

    const { account: stateAccount, session: stateSession } = state ?? {};

    return {
      accountActive: !!stateAccount && !stateAccount.disabledAt,
      sessionActive: !!stateSession,
    };
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

    if (!session) {
      throw this.error.sessionInvalid();
    }
  }

  async authenticate(token: string): Promise<AuthIdentity> {
    const identity = await this.crypto.verifyAccess(token);
    const { userId: identityUserId, sessionId: identitySessionId } = identity;
    const state = await this.sessions.access(identityUserId, identitySessionId);

    const { account: stateAccount2, session: stateSession2 } = state ?? {};

    if (!stateAccount2 || stateAccount2.disabledAt || !stateSession2) {
      throw this.error.sessionInvalid();
    }

    return {
      ...identity,
      login: stateAccount2.login,
      displayName: stateAccount2.displayName,
      role: stateAccount2.role,
    };
  }
}

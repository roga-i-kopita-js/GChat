import { randomUUID, timingSafeEqual } from 'node:crypto';

import { Injectable } from '@nestjs/common';

import { ErrorService } from '../error/error.service.js';
import { AuthCrypto, sessionId, tokenHash } from './auth.crypto.js';
import type { LoginDto, RefreshDto, TokensDto } from './auth.dto.js';
import type { AuthIdentity } from './auth.guard.js';
import { AuthLimits } from './auth.limits.js';
import { AuthRepository } from './auth.repository.js';
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
    const current = await this.accounts.byId(account.id);

    if (!current || current.disabledAt || current.passwordHash !== account.passwordHash) {
      this.limits.check(login, 'login', true);

      throw this.error.invalidCredentials();
    }

    const sid = randomUUID();
    const tokens = await this.crypto.issue(current, sid);
    const now = Date.now();
    const created = await this.sessions.mutate('create', sid, current.id, undefined, {
      userId: current.id,
      hash: tokenHash(tokens.refresh_token),
      createdAt: now,
      updatedAt: now,
    });

    if (!created) throw this.error.serviceUnavailable();

    return tokens;
  }

  async refresh(input: RefreshDto): Promise<TokensDto> {
    const sid = sessionId(input.refresh_token);
    const initial = sid ? await this.sessions.read(sid) : undefined;

    if (!sid || !initial) throw this.error.sessionInvalid();

    const hash = tokenHash(input.refresh_token);

    if (!matches(initial.session.hash, hash) && !matches(initial.rotation?.hash ?? '', hash))
      throw this.error.sessionInvalid();

    // A CAS conflict is resolved by reading the winner's result, never by assuming a write failed.
    for (let attempt = 0; attempt < 3; attempt++) {
      const account = await this.accounts.byId(initial.session.userId);
      const state = await this.sessions.read(sid);

      if (!account || account.disabledAt || !state || state.session.userId !== account.id)
        throw this.error.sessionInvalid();

      if (state.rotation?.requestId === input.request_id && matches(state.rotation.hash, hash)) {
        return this.crypto.decrypt(state.rotation.encrypted, sid, input.request_id);
      }

      if (!matches(state.session.hash, hash) || state.rotation?.requestId === input.request_id)
        throw this.error.sessionInvalid();

      this.limits.check(sid, 'refresh', true, `${input.request_id}:${hash}`);
      const tokens = await this.crypto.issue(account, sid);
      const updated = await this.sessions.mutate(
        'rotate',
        sid,
        account.id,
        state,
        { ...state.session, hash: tokenHash(tokens.refresh_token), updatedAt: Date.now() },
        {
          requestId: input.request_id,
          hash,
          encrypted: await this.crypto.encrypt(tokens, sid, input.request_id),
        },
      );

      if (updated) return tokens;
    }

    throw this.error.serviceUnavailable();
  }

  async logout(token: string): Promise<void> {
    const sid = sessionId(token);

    if (!sid) return;

    const initial = await this.sessions.read(sid);

    if (!initial) return;

    const hash = tokenHash(token);

    if (!matches(initial.session.hash, hash) && !matches(initial.rotation?.hash ?? '', hash))
      return;

    await this.sessions.mutate(
      'delete',
      sid,
      initial.session.userId,
      undefined,
      undefined,
      undefined,
      hash,
    );
  }

  async authenticate(token: string): Promise<AuthIdentity> {
    const identity = await this.crypto.verifyAccess(token);
    const account = await this.accounts.byId(identity.userId);
    const state = await this.sessions.read(identity.sessionId);

    if (!account || account.disabledAt || !state || state.session.userId !== account.id)
      throw this.error.sessionInvalid();

    return { ...identity, login: account.login, displayName: account.displayName };
  }
}

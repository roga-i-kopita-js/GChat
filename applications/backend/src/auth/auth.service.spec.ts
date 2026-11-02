import { randomUUID } from 'node:crypto';

import { jest } from '@jest/globals';

import { ErrorService } from '../error/error.service.js';
import { LockError } from '../redlock/redlock.errors.js';
import type { LockContext } from '../redlock/redlock.service.js';
import { RedlockService } from '../redlock/redlock.service.js';
import { AuthCrypto, tokenHash } from './auth.crypto.js';
import type { TokensDto } from './auth.dto.js';
import { AuthLimits } from './auth.limits.js';
import { AuthRepository } from './auth.repository.js';
import type { Account } from './auth.schema.js';
import { AuthService } from './auth.service.js';
import type { SessionState } from './auth.sessions.js';
import { AuthSessions } from './auth.sessions.js';
interface Fixture {
  service: AuthService;
  account: Account;
  accounts: jest.Mocked<Pick<AuthRepository, 'byId' | 'byLogin'>>;
  crypto: jest.Mocked<
    Pick<AuthCrypto, 'verifyPassword' | 'issue' | 'decrypt' | 'encrypt' | 'verifyAccess'>
  >;
  sessions: jest.Mocked<Pick<AuthSessions, 'read' | 'mutate'>>;
  locks: {
    withLock: jest.Mock<
      (resource: string, action: (ctx: LockContext) => Promise<unknown>) => Promise<unknown>
    >;
  };
  limits: jest.Mocked<Pick<AuthLimits, 'check'>>;
  token: string;
  state: SessionState;
  tokens: TokensDto;
}
function fixture(): Fixture {
  const sid = randomUUID();
  const token = `v1.${sid}.${'a'.repeat(43)}`;
  const account: Account = {
    id: randomUUID(),
    login: 'test',
    displayName: 'Test',
    passwordHash: 'hash',
    disabledAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const state: SessionState = {
    session: { userId: account.id, hash: tokenHash(token), createdAt: 1, updatedAt: 1 },
    raw: 'state',
    rotationRaw: '',
  };
  const accounts = {
    byId: jest.fn<AuthRepository['byId']>().mockResolvedValue(account),
    byLogin: jest.fn<AuthRepository['byLogin']>().mockResolvedValue(account),
  };
  const tokens: TokensDto = {
    access_token: 'access',
    refresh_token: `v1.${sid}.${'b'.repeat(43)}`,
    token_type: 'Bearer',
  };
  const crypto = {
    verifyPassword: jest.fn<AuthCrypto['verifyPassword']>().mockResolvedValue(true),
    issue: jest.fn<AuthCrypto['issue']>().mockResolvedValue(tokens),
    decrypt: jest.fn<AuthCrypto['decrypt']>().mockResolvedValue(tokens),
    encrypt: jest.fn<AuthCrypto['encrypt']>().mockResolvedValue('encrypted'),
    verifyAccess: jest
      .fn<AuthCrypto['verifyAccess']>()
      .mockResolvedValue({ userId: account.id, sessionId: sid }),
  };
  const sessions = {
    read: jest.fn<AuthSessions['read']>().mockResolvedValue(state),
    mutate: jest.fn<AuthSessions['mutate']>().mockResolvedValue(undefined),
  };
  const locks = {
    withLock: jest.fn(
      async (_resource: string, action: (ctx: LockContext) => Promise<unknown>): Promise<unknown> =>
        action({
          signal: new AbortController().signal,
          assertHeld(): void {},
          redisOwnership: { key: 'lock', owner: 'owner' },
        }),
    ),
  };
  const limits = { check: jest.fn<AuthLimits['check']>() };
  const service = new AuthService(
    accounts as unknown as AuthRepository,
    crypto as unknown as AuthCrypto,
    sessions as unknown as AuthSessions,
    locks as unknown as RedlockService,
    limits as unknown as AuthLimits,
    new ErrorService(),
  );

  return { service, account, accounts, crypto, sessions, locks, limits, token, state, tokens };
}
describe('Auth orchestration', (): void => {
  it('does not issue credentials if the password or account changes while waiting for the lock', async (): Promise<void> => {
    const f = fixture();

    f.accounts.byId.mockResolvedValue({ ...f.account, passwordHash: 'new-hash' });
    await expect(f.service.login({ login: 'test', password: 'password' })).rejects.toMatchObject({
      code: 'INVALID_CREDENTIALS',
    });
    expect(f.crypto.issue).not.toHaveBeenCalled();
    expect(f.sessions.mutate).not.toHaveBeenCalled();
  });
  it('never returns tokens if session persistence fails', async (): Promise<void> => {
    const f = fixture();

    f.sessions.mutate.mockRejectedValue(new ErrorService().serviceUnavailable());
    await expect(f.service.login({ login: 'test', password: 'password' })).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
    });
  });
  it('uses dummy verification for an unknown login and keeps the same credentials error', async (): Promise<void> => {
    const f = fixture();

    f.accounts.byLogin.mockResolvedValue(undefined);
    await expect(
      f.service.login({ login: ' UNKNOWN ', password: 'password' }),
    ).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });
    expect(f.crypto.verifyPassword).toHaveBeenCalledWith('password', undefined);
    expect(f.locks.withLock).not.toHaveBeenCalled();
  });
  it('rechecks session existence before returning a cached rotation', async (): Promise<void> => {
    const f = fixture();

    f.sessions.read.mockResolvedValueOnce(f.state).mockResolvedValueOnce(undefined);
    await expect(
      f.service.refresh({ refresh_token: f.token, request_id: randomUUID() }),
    ).rejects.toMatchObject({ code: 'SESSION_INVALID' });
    expect(f.crypto.decrypt).not.toHaveBeenCalled();
  });
  it('checks session ownership for access tokens', async (): Promise<void> => {
    const f = fixture();

    f.state.session.userId = randomUUID();
    await expect(f.service.authenticate('signed')).rejects.toMatchObject({
      code: 'SESSION_INVALID',
    });
  });
  it('maps a lock failure to 503 and preserves unexpected programming errors', async (): Promise<void> => {
    const f = fixture();

    f.locks.withLock.mockRejectedValueOnce(new LockError('LOCK_LOST', true));
    await expect(f.service.login({ login: 'test', password: 'password' })).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
    });
    const unexpected = new TypeError('programming error');

    f.locks.withLock.mockRejectedValueOnce(unexpected);
    await expect(f.service.login({ login: 'test', password: 'password' })).rejects.toBe(unexpected);
  });
});

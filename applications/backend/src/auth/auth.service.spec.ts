import { randomUUID } from 'node:crypto';

import { jest } from '@jest/globals';

import type { DatabaseTransaction } from '../database/database.service.js';
import { ErrorService } from '../error/error.service.js';
import { AuthCrypto, tokenHash } from './auth.crypto.js';
import type { TokensDto } from './auth.dto.js';
import { AuthLimits } from './auth.limits.js';
import { AuthRepository } from './auth.repository.js';
import type { Account } from './auth.schema.js';
import { AuthService } from './auth.service.js';
import { AuthSessions, type StoredSession } from './auth.sessions.js';

interface Fixture {
  service: AuthService;
  account: Account;
  state: StoredSession;
  tokens: TokensDto;
  token: string;
  accounts: jest.Mocked<Pick<AuthRepository, 'byLogin' | 'byId'>>;
  crypto: jest.Mocked<
    Pick<AuthCrypto, 'verifyPassword' | 'issue' | 'decrypt' | 'encrypt' | 'verifyAccess'>
  >;
  sessions: {
    [K in 'transaction' | 'lockAccount' | 'read' | 'now' | 'access']: jest.Mock<AuthSessions[K]>;
  };
  write: jest.Mock<() => Promise<void>>;
  limits: jest.Mocked<Pick<AuthLimits, 'check'>>;
}

function fixture(): Fixture {
  const sid = randomUUID();
  const token = `v1.${sid}.${'a'.repeat(43)}`;
  const account: Account = {
    id: randomUUID(),
    login: 'test',
    displayName: 'Test',
    role: 'admin',
    passwordHash: 'hash',
    disabledAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const state: StoredSession = {
    id: sid,
    userId: account.id,
    refreshTokenHash: tokenHash(token),
    createdAt: new Date(),
    updatedAt: new Date(),
    rotationRequestId: null,
    rotationTokenHash: null,
    rotationEncrypted: null,
    rotationExpiresAt: null,
    wsTicketCount: 0,
    wsTicketWindowStartedAt: null,
  };
  const tokens = {
    access_token: 'access',
    refresh_token: `v1.${sid}.${'b'.repeat(43)}`,
    token_type: 'Bearer' as const,
  };
  const write = jest.fn<() => Promise<void>>().mockResolvedValue();
  const tx = {
    insert: (): { values: jest.Mock<() => Promise<void>> } => ({ values: write }),
    update: (): { set: () => { where: jest.Mock<() => Promise<void>> } } => ({
      set: (): { where: jest.Mock<() => Promise<void>> } => ({ where: write }),
    }),
  } as unknown as DatabaseTransaction;
  const accounts = {
    byLogin: jest.fn<AuthRepository['byLogin']>().mockResolvedValue(account),
    byId: jest.fn<AuthRepository['byId']>().mockResolvedValue(account),
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
    transaction: jest
      .fn<AuthSessions['transaction']>()
      .mockImplementation(<T>(fn: (tx: DatabaseTransaction) => Promise<T>): Promise<T> => fn(tx)),
    lockAccount: jest.fn<AuthSessions['lockAccount']>().mockResolvedValue(account),
    read: jest.fn<AuthSessions['read']>().mockResolvedValue(state),
    now: jest.fn<AuthSessions['now']>().mockResolvedValue(new Date()),
    access: jest.fn<AuthSessions['access']>().mockResolvedValue({ account, session: state }),
  };
  const limits = { check: jest.fn<AuthLimits['check']>() };
  const service = new AuthService(
    accounts as unknown as AuthRepository,
    crypto as unknown as AuthCrypto,
    sessions as unknown as AuthSessions,
    limits as unknown as AuthLimits,
    new ErrorService(),
  );

  return { service, account, state, tokens, token, accounts, crypto, sessions, write, limits };
}

describe('Auth PostgreSQL orchestration', (): void => {
  it('returns only the display name of an active account for notifications', async (): Promise<void> => {
    const f = fixture();

    await expect(f.service.displayName(f.account.id)).resolves.toBe('Test');
    expect(f.accounts.byId).toHaveBeenCalledWith(f.account.id);
    f.accounts.byId.mockResolvedValue({ ...f.account, disabledAt: new Date() });
    await expect(f.service.displayName(f.account.id)).resolves.toBeUndefined();
    f.accounts.byId.mockResolvedValue(undefined);
    await expect(f.service.displayName(f.account.id)).resolves.toBeUndefined();
  });

  it('rechecks the verified password hash under the account lock', async (): Promise<void> => {
    const f = fixture();

    f.sessions.lockAccount.mockResolvedValue({ ...f.account, passwordHash: 'changed' });
    await expect(f.service.login({ login: 'test', password: 'password' })).rejects.toMatchObject({
      code: 'INVALID_CREDENTIALS',
    });
    expect(f.crypto.issue).not.toHaveBeenCalled();
    expect(f.write).not.toHaveBeenCalled();
  });
  it('does not return credentials when COMMIT confirmation is lost', async (): Promise<void> => {
    const f = fixture();

    f.sessions.transaction.mockImplementation(async (fn): Promise<never> => {
      await fn({
        insert: (): { values: jest.Mock<() => Promise<void>> } => ({ values: f.write }),
      } as unknown as DatabaseTransaction);

      throw new ErrorService().serviceUnavailable();
    });
    await expect(f.service.login({ login: 'test', password: 'password' })).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
    });
    expect(f.write).toHaveBeenCalledTimes(1);
  });
  it('performs dummy verification for an unknown account', async (): Promise<void> => {
    const f = fixture();

    f.accounts.byLogin.mockResolvedValue(undefined);
    await expect(
      f.service.login({ login: ' UNKNOWN ', password: 'password' }),
    ).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });
    expect(f.crypto.verifyPassword).toHaveBeenCalledWith('password', undefined);
  });
  it('rechecks the session under lock before returning a cached result', async (): Promise<void> => {
    const f = fixture();

    f.sessions.read.mockResolvedValueOnce(f.state).mockResolvedValueOnce(undefined);
    await expect(
      f.service.refresh({ refresh_token: f.token, request_id: randomUUID() }),
    ).rejects.toMatchObject({ code: 'SESSION_INVALID' });
    expect(f.crypto.decrypt).not.toHaveBeenCalled();
  });
  it('returns the live rotation without counting it or writing again', async (): Promise<void> => {
    const f = fixture();
    const request_id = randomUUID();

    f.state.rotationRequestId = request_id;
    f.state.rotationTokenHash = f.state.refreshTokenHash;
    f.state.rotationEncrypted = 'winner';
    f.state.rotationExpiresAt = new Date(Date.now() + 30000);
    f.state.refreshTokenHash = 'new';
    await expect(f.service.refresh({ refresh_token: f.token, request_id })).resolves.toEqual(
      f.tokens,
    );
    expect(f.crypto.decrypt).toHaveBeenCalledWith('winner', f.state.id, request_id);
    expect(f.write).not.toHaveBeenCalled();
    expect(f.limits.check).not.toHaveBeenCalled();
  });
  it('rejects an expired rotation at the exact database clock boundary', async (): Promise<void> => {
    const f = fixture();
    const now = new Date();

    f.sessions.now.mockResolvedValue(now);
    f.state.rotationExpiresAt = now;
    f.state.rotationRequestId = randomUUID();
    f.state.rotationTokenHash = f.state.refreshTokenHash;
    f.state.refreshTokenHash = 'new';
    await expect(
      f.service.refresh({ refresh_token: f.token, request_id: f.state.rotationRequestId }),
    ).rejects.toMatchObject({ code: 'SESSION_INVALID' });
    expect(f.crypto.decrypt).not.toHaveBeenCalled();
  });
  it('uses the current database role and separates account/session activity', async (): Promise<void> => {
    const f = fixture();

    await expect(f.service.authenticate('signed')).resolves.toMatchObject({ role: 'admin' });
    f.sessions.access.mockResolvedValue({
      account: { ...f.account, disabledAt: new Date() },
      session: f.state,
    });
    await expect(f.service.checkSession(f.account.id, f.state.id)).resolves.toEqual({
      accountActive: false,
      sessionActive: true,
    });
    f.sessions.access.mockResolvedValue({ account: f.account, session: null });
    await expect(f.service.authenticate('signed')).rejects.toMatchObject({
      code: 'SESSION_INVALID',
    });
    f.sessions.access.mockRejectedValue(new ErrorService().serviceUnavailable());
    await expect(f.service.checkSession(f.account.id, f.state.id)).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
    });
  });
});

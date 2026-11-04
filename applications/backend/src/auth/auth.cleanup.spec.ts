import { jest } from '@jest/globals';

import type { DatabaseService, DatabaseTransaction } from '../database/database.service.js';
import type { LoggerService } from '../logger/logger.service.js';
import type { LockContext, RedlockService } from '../redlock/redlock.service.js';
import { AuthCleanup } from './auth.cleanup.js';

function fixture(): {
  cleanup: AuthCleanup;
  execute: jest.Mock<() => Promise<void>>;
  assertHeld: jest.Mock<() => void>;
  withLock: jest.Mock<RedlockService['withLock']>;
  warn: jest.Mock<() => void>;
} {
  const execute = jest.fn<() => Promise<void>>().mockResolvedValue();
  const assertHeld = jest.fn<() => void>();
  const context: LockContext = {
    signal: new AbortController().signal,
    assertHeld,
    redisOwnership: { key: 'unused', owner: 'unused' },
  };
  const withLock = jest
    .fn<RedlockService['withLock']>()
    .mockImplementation(<T>(_name: string, fn: (ctx: LockContext) => Promise<T>): Promise<T> =>
      fn(context),
    );
  const database = {
    db: {
      transaction: async (fn: (tx: DatabaseTransaction) => Promise<void>): Promise<void> =>
        fn({ execute } as unknown as DatabaseTransaction),
    },
  };
  const warn = jest.fn<() => void>();

  return {
    cleanup: new AuthCleanup(
      database as unknown as DatabaseService,
      { withLock } as unknown as RedlockService,
      { warn } as unknown as LoggerService,
    ),
    execute,
    assertHeld,
    withLock,
    warn,
  };
}

describe('Auth cleanup lease lifecycle', (): void => {
  it('defers without database writes when lease acquisition fails', async (): Promise<void> => {
    const f = fixture();

    f.withLock.mockRejectedValue(new Error('unavailable'));
    await f.cleanup.cleanup();
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.warn).toHaveBeenCalledWith('Auth cleanup deferred');
  });
  it('stops after losing the lease during SQL and retries only on the next invocation', async (): Promise<void> => {
    const f = fixture();

    f.execute.mockImplementationOnce(async (): Promise<void> => {
      f.assertHeld.mockImplementation((): never => {
        throw new Error('lease lost');
      });
    });
    await f.cleanup.cleanup();
    expect(f.execute).toHaveBeenCalledTimes(1);
    expect(f.withLock).toHaveBeenCalledTimes(1);
    f.assertHeld.mockReset();
    await f.cleanup.cleanup();
    expect(f.execute).toHaveBeenCalledTimes(4);
    expect(f.withLock).toHaveBeenCalledTimes(2);
  });
  it('prevents overlapping runs and drains the current batch before shutdown', async (): Promise<void> => {
    const f = fixture();
    let release!: () => void;

    f.execute.mockImplementationOnce(
      (): Promise<void> =>
        new Promise<void>((resolve): void => {
          release = resolve;
        }),
    );
    const running = f.cleanup.cleanup();

    await f.cleanup.cleanup();
    expect(f.execute).toHaveBeenCalledTimes(1);
    const stopped = f.cleanup.onModuleDestroy();

    release();
    await Promise.all([running, stopped]);
    await f.cleanup.cleanup();
    expect(f.execute).toHaveBeenCalledTimes(1);
  });

  it('recovers on the next scheduled invocation after a database failure', async (): Promise<void> => {
    const f = fixture();

    f.execute.mockRejectedValueOnce(new Error('database unavailable'));
    await f.cleanup.cleanup();
    expect(f.execute).toHaveBeenCalledTimes(1);
    await f.cleanup.cleanup();
    expect(f.execute).toHaveBeenCalledTimes(4);
  });
});

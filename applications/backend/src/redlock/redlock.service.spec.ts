import { LoggerService } from '../logger/logger.service.js';
import { ConfigService } from '@nestjs/config';
import { jest } from '@jest/globals';
import { RedlockService } from './redlock.service.js';
import type { RedisService } from '../redis/redis.service.js';
import { validateEnvironment } from '../config/environment.js';

function fixture(overrides = {}) {
  const client = {
    withCommandOptions: jest.fn<(...args: unknown[]) => unknown>(),
    set: jest.fn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue('OK'),
    eval: jest.fn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue(1),
  };
  client.withCommandOptions.mockReturnValue(client);
  const config = new ConfigService({
    REDIS_COMMAND_TIMEOUT_MS: 10, REDLOCK_LEASE_MS: 200,
    REDLOCK_ACQUIRE_TIMEOUT_MS: 30, REDLOCK_RETRY_DELAY_MS: 5,
    REDLOCK_RETRY_JITTER_MS: 0, REDLOCK_EXTEND_THRESHOLD_MS: 50,
    REDLOCK_MAX_HOLD_MS: 100, ...overrides,
  });
  const redis = { client, key: (key: string) => `test:${key}` };
  return { client, service: new RedlockService(redis as unknown as RedisService, config, new LoggerService()) };
}

describe('RedlockService', () => {
  it('runs once, namespaces lock keys and releases on success', async () => {
    const { client, service } = fixture();
    const action = jest.fn(async () => 42);
    await expect(service.withLock('auth:user:123', action)).resolves.toBe(42);
    expect(action).toHaveBeenCalledTimes(1);
    expect(client.set.mock.calls[0]?.[0]).toBe('test:lock:auth:user:123');
    expect(client.eval).toHaveBeenCalledTimes(1);
  });

  it('bounds contention without executing the callback', async () => {
    const { client, service } = fixture();
    client.set.mockResolvedValue(null);
    const action = jest.fn(async () => {});
    await expect(service.withLock('busy', action)).rejects.toMatchObject({ code: 'LOCK_ACQUIRE_FAILED' });
    expect(action).not.toHaveBeenCalled();
  });

  it('does not retry unknown acquisition results', async () => {
    const { client, service } = fixture();
    client.set.mockRejectedValue(new Error('secret'));
    await expect(service.withLock('unknown', async () => {})).rejects.toMatchObject({ code: 'LOCK_ACQUIRE_FAILED' });
    expect(client.set).toHaveBeenCalledTimes(1);
  });

  it('preserves callback failure if release also fails', async () => {
    const { client, service } = fixture();
    client.eval.mockRejectedValue(new Error('release'));
    const error = new Error('business failure');
    await expect(service.withLock('error', async () => { throw error; })).rejects.toBe(error);
  });

  it('reports unconfirmed release after successful work', async () => {
    const { client, service } = fixture();
    client.eval.mockResolvedValue(0);
    await expect(service.withLock('release', async () => 1)).rejects.toMatchObject({
      code: 'LOCK_RELEASE_FAILED', mayHaveExecuted: true,
    });
  });

  it('does not return success if an in-flight renewal fails during cleanup', async () => {
    const { client, service } = fixture({ REDLOCK_MAX_HOLD_MS: 1000 });
    let extending!: () => void;
    const started = new Promise<void>((resolve) => { extending = resolve; });
    client.eval.mockImplementationOnce(async () => {
      extending();
      await new Promise((resolve) => setTimeout(resolve, 5));
      throw new Error('renewal failed');
    });
    await expect(service.withLock('renew-race', async () => {
      await started;
      return 42;
    })).rejects.toMatchObject({ code: 'LOCK_LOST' });
  });

  it('rejects nested locks', async () => {
    const { service } = fixture();
    await expect(service.withLock('outer', async () => service.withLock('inner', async () => {})))
      .rejects.toThrow('Nested locks');
  });

  it('aborts at the hold limit, waits for callback settlement and rejects success', async () => {
    const { service } = fixture({ REDLOCK_MAX_HOLD_MS: 10 });
    let completed = false;
    await expect(service.withLock('limit', async ({ signal, assertHeld }) => {
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
      expect(() => assertHeld()).toThrow();
      completed = true;
    })).rejects.toMatchObject({ code: 'LOCK_LOST' });
    expect(completed).toBe(true);
  });

  it('detects the hold deadline even before a delayed timer can run', async () => {
    const { service } = fixture({ REDLOCK_MAX_HOLD_MS: 5 });
    await expect(service.withLock('paused', async ({ assertHeld }) => {
      const until = performance.now() + 15;
      while (performance.now() < until) { /* Simulate an event-loop pause. */ }
      assertHeld();
    })).rejects.toMatchObject({ code: 'LOCK_LOST' });
  });

  it('cancels active work and refuses new work during shutdown', async () => {
    const { service } = fixture();
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const task = service.withLock('shutdown', async ({ signal }) => {
      entered();
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
    });
    const rejected = expect(task).rejects.toMatchObject({ code: 'LOCK_SHUTTING_DOWN' });
    await started;
    await service.beforeApplicationShutdown();
    await rejected;
    await expect(service.withLock('new', async () => {})).rejects.toMatchObject({ code: 'LOCK_SHUTTING_DOWN' });
  });
});

describe('Redlock configuration', () => {
  it.each([
    { REDLOCK_LEASE_MS: 2000 }, { REDLOCK_EXTEND_THRESHOLD_MS: 500 },
    { REDLOCK_MAX_HOLD_MS: 0 }, { REDLOCK_RETRY_JITTER_MS: -1 },
  ])('rejects invalid budgets %j', (settings) => {
    expect(() => validateEnvironment({ ...process.env, ...settings })).toThrow();
  });
});

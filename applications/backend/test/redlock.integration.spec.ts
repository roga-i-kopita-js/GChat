import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createClient } from 'redis';
import { RedisService } from '../src/redis/redis.service.js';
import { RedlockService, EXTEND_LOCK, RELEASE_LOCK } from '../src/redlock/redlock.service.js';

// Explicit opt-in; never access a developer's Redis during ordinary unit tests.
const integration = process.env.REDLOCK_INTEGRATION_URL ? describe : describe.skip;
integration('Redlock with real Redis', () => {
  const prefix = `gchat:test:${randomUUID()}:`;
  const config = new ConfigService({
    REDIS_KEY_PREFIX: prefix, REDIS_COMMAND_TIMEOUT_MS: 100,
    REDLOCK_LEASE_MS: 500, REDLOCK_ACQUIRE_TIMEOUT_MS: 200,
    REDLOCK_RETRY_DELAY_MS: 10, REDLOCK_RETRY_JITTER_MS: 5,
    REDLOCK_EXTEND_THRESHOLD_MS: 200, REDLOCK_MAX_HOLD_MS: 2000,
  });
  const clients = [0, 1].map(() => createClient({
    url: process.env.REDLOCK_INTEGRATION_URL,
    disableOfflineQueue: true, commandOptions: { timeout: 100 },
    socket: { reconnectStrategy: false, connectTimeout: 1000 },
  }).on('error', () => {}));
  const services = clients.map((client) => new RedlockService(new RedisService(client, config), config));
  beforeAll(async () => { await Promise.all(clients.map((client) => client.connect())); });
  afterAll(async () => {
    await Promise.all(services.map((service) => service.beforeApplicationShutdown()));
    for (const client of clients) if (client.isOpen) client.destroy();
  });

  it('serializes independent clients and releases on exception', async () => {
    const order: string[] = [];
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const first = services[0]!.withLock('shared', async () => {
      order.push('first'); entered(); await delay(50); order.push('released');
    });
    await started;
    const second = services[1]!.withLock('shared', async () => { order.push('second'); });
    await Promise.all([first, second]);
    expect(order).toEqual(['first', 'released', 'second']);
    await expect(services[0]!.withLock('shared', async () => { throw new Error('business'); })).rejects.toThrow('business');
    await services[1]!.withLock('shared', async () => {});
  });

  it('extends a lease beyond its initial TTL while another resource stays available', async () => {
    await services[0]!.withLock('long', async ({ assertHeld }) => {
      await services[1]!.withLock('other', async () => {});
      await delay(650);
      assertHeld();
      expect(await clients[1]!.pTTL(prefix + 'lock:long')).toBeGreaterThan(0);
      await expect(services[1]!.withLock('long', async () => {})).rejects.toMatchObject({ code: 'LOCK_ACQUIRE_FAILED' });
    });
  });

  it('never extends or releases a successor lease with a stale token', async () => {
    const key = prefix + 'stale';
    await clients[0]!.set(key, 'old', { PX: 20 });
    await delay(40);
    await clients[1]!.set(key, 'new', { PX: 500, NX: true });
    expect(await clients[0]!.eval(EXTEND_LOCK, { keys: [key], arguments: ['old', '500'] })).toBe(0);
    expect(await clients[0]!.eval(RELEASE_LOCK, { keys: [key], arguments: ['old'] })).toBe(0);
    expect(await clients[1]!.get(key)).toBe('new');
    await clients[1]!.eval(RELEASE_LOCK, { keys: [key], arguments: ['new'] });
  });

  it('cancels work when ownership is lost during renewal', async () => {
    await expect(services[0]!.withLock('lost', async ({ signal, assertHeld }) => {
      await clients[1]!.del(prefix + 'lock:lost');
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
      assertHeld();
    })).rejects.toMatchObject({ code: 'LOCK_LOST' });
  });
});

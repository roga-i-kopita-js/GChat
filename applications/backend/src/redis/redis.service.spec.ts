import { jest } from '@jest/globals';
import { ConfigService } from '@nestjs/config';

import { validateEnvironment } from '../config/environment.js';
import type { RedisClient } from './redis.service.js';
import { RedisService } from './redis.service.js';

const config = new ConfigService({
  REDIS_KEY_PREFIX: 'gchat:test:',
  REDIS_STARTUP_TIMEOUT_MS: 20,
  REDIS_COMMAND_TIMEOUT_MS: 20,
});

interface Fixture {
  client: {
    isOpen: boolean;
    connect: jest.Mock<() => Promise<void>>;
    ping: jest.Mock<() => Promise<string>>;
    close: jest.Mock<() => Promise<void>>;
    destroy: jest.Mock<() => void>;
  };
  service: RedisService;
}
function fixture(): Fixture {
  const client = {
    isOpen: true,
    connect: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    ping: jest.fn<() => Promise<string>>().mockResolvedValue('PONG'),
    close: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    destroy: jest.fn<() => void>(),
  };

  return { client, service: new RedisService(client as unknown as RedisClient, config) };
}

describe('Redis lifecycle', (): void => {
  it('connects, verifies PING, namespaces domain keys and closes', async (): Promise<void> => {
    const { client, service } = fixture();

    await service.onModuleInit();
    expect(client.connect).toHaveBeenCalledTimes(1);
    expect(client.ping).toHaveBeenCalledTimes(1);
    expect(service.key('auth:session:123')).toBe('gchat:test:auth:session:123');
    await service.onApplicationShutdown();
    expect(client.close).toHaveBeenCalledTimes(1);
  });

  it('destroys a stalled startup connection and returns a sanitized error', async (): Promise<void> => {
    const { client, service } = fixture();

    client.connect.mockImplementation((): Promise<void> => new Promise((): void => {}));
    await expect(service.onModuleInit()).rejects.toThrow('Redis startup failed');
    expect(client.destroy).toHaveBeenCalledTimes(1);
  });

  it('cleans up after failed authentication without exposing credentials', async (): Promise<void> => {
    const { client, service } = fixture();

    client.connect.mockRejectedValue(new Error('private-password'));
    await expect(service.onModuleInit()).rejects.toThrow(/^Redis startup failed$/);
    expect(client.destroy).toHaveBeenCalledTimes(1);
  });

  it('forces a stalled graceful close to finish', async (): Promise<void> => {
    const { client, service } = fixture();

    client.close.mockImplementation((): Promise<void> => new Promise((): void => {}));
    await service.onApplicationShutdown();
    expect(client.destroy).toHaveBeenCalledTimes(1);
  });
});

describe('Redis configuration', (): void => {
  const env = {
    ...process.env,
    DATABASE_URL: 'postgresql://test:test@localhost/test',
    REDIS_URL: 'redis://localhost:6379/0',
    REDIS_KEY_PREFIX: 'gchat:test:',
  };

  it('normalizes timeout settings', (): void => {
    expect(validateEnvironment({ ...env, REDIS_COMMAND_TIMEOUT_MS: '123' })).toMatchObject({
      REDIS_COMMAND_TIMEOUT_MS: 123,
      REDIS_STARTUP_TIMEOUT_MS: 10000,
    });
  });

  it.each([
    { REDIS_URL: '' },
    { REDIS_URL: 'https://localhost' },
    { REDIS_URL: 'redis://localhost/not-a-db' },
    { REDIS_KEY_PREFIX: '' },
    { REDIS_KEY_PREFIX: 'missing-colon' },
    { REDIS_COMMAND_TIMEOUT_MS: '0' },
    { REDIS_CONNECT_TIMEOUT_MS: '1.5' },
    { REDIS_STARTUP_TIMEOUT_MS: '2147483648' },
  ])('rejects invalid configuration %j', (override): void => {
    expect((): ReturnType<typeof validateEnvironment> =>
      validateEnvironment({ ...env, ...override }),
    ).toThrow();
  });
});

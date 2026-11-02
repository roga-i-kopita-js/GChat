import { Injectable, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { RedlockModule } from '../src/redlock/redlock.module.js';
import { RedlockService } from '../src/redlock/redlock.service.js';
import { RedisService } from '../src/redis/redis.service.js';
import { RedisModule } from '../src/redis/redis.module.js';
import { REDIS_CLIENT } from '../src/redis/redis.constants.js';

@Injectable()
class ConsumerService {
  constructor(readonly redlock: RedlockService, readonly redis: RedisService) {}
}

@Module({
  imports: [RedlockModule.forFeature()],
  providers: [ConsumerService],
})
class ConsumerModule {}

describe('RedlockModule registration', () => {
  it('exports the service to a consumer using forFeature', async () => {
    const module = await Test.createTestingModule({ imports: [RedisModule.forRoot(), ConsumerModule] })
      .overrideProvider(ConfigService)
      .useValue(new ConfigService({ REDIS_COMMAND_TIMEOUT_MS: 1000 }))
      .overrideProvider(REDIS_CLIENT)
      .useValue({})
      .compile();
    try {
      expect(module.get(ConsumerService).redlock).toBeInstanceOf(RedlockService);
      expect(module.get(ConsumerService).redis).toBe(module.get(RedisService));
    } finally {
      await module.close();
    }
  });

  it('does not create a Redis client on a bare module import', async () => {
    const module = await Test.createTestingModule({ imports: [RedisModule] }).compile();
    try {
      expect(() => module.get(RedisService)).toThrow();
      expect(() => module.get(REDIS_CLIENT)).toThrow();
    } finally {
      await module.close();
    }
  });

  it('does not register the service on a bare module import', async () => {
    const module = await Test.createTestingModule({ imports: [RedlockModule] }).compile();
    try {
      expect(() => module.get(RedlockService)).toThrow();
    } finally {
      await module.close();
    }
  });
});

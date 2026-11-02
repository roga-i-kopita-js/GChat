import { Injectable, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';

import { LoggerModule } from '../logger/logger.module.js';
import { REDIS_CLIENT } from '../redis/redis.constants.js';
import { RedisModule } from '../redis/redis.module.js';
import { RedisService } from '../redis/redis.service.js';
import { RedlockModule } from './redlock.module.js';
import { RedlockService } from './redlock.service.js';

@Injectable()
class ConsumerService {
  constructor(
    readonly redlock: RedlockService,
    readonly redis: RedisService,
  ) {}
}

@Module({
  imports: [RedlockModule.forFeature()],
  providers: [ConsumerService],
})
class ConsumerModule {}

describe('RedlockModule registration', (): void => {
  it('exports the service to a consumer using forFeature', async (): Promise<void> => {
    const module = await Test.createTestingModule({
      imports: [LoggerModule.forRoot(), RedisModule.forRoot(), ConsumerModule],
    })
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

  it('does not create a Redis client on a bare module import', async (): Promise<void> => {
    const module = await Test.createTestingModule({ imports: [RedisModule] }).compile();

    try {
      expect((): RedisService => module.get(RedisService)).toThrow();
      expect((): void => module.get(REDIS_CLIENT)).toThrow();
    } finally {
      await module.close();
    }
  });

  it('does not register the service on a bare module import', async (): Promise<void> => {
    const module = await Test.createTestingModule({ imports: [RedlockModule] }).compile();

    try {
      expect((): RedlockService => module.get(RedlockService)).toThrow();
    } finally {
      await module.close();
    }
  });
});

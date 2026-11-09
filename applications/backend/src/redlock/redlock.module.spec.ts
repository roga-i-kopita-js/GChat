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
      const { get: moduleGet } = module;

      expect(moduleGet.bind(module)(ConsumerService).redlock).toBeInstanceOf(RedlockService);
      const { get: moduleGet2 } = module;

      expect(moduleGet2.bind(module)(ConsumerService).redis).toBe(
        moduleGet2.bind(module)(RedisService),
      );
    } finally {
      const { close: moduleClose } = module;

      await moduleClose.bind(module)();
    }
  });

  it('does not create a Redis client on a bare module import', async (): Promise<void> => {
    const module = await Test.createTestingModule({ imports: [RedisModule] }).compile();

    try {
      expect((): RedisService => {
        const { get: moduleGet3 } = module;

        return moduleGet3.bind(module)(RedisService);
      }).toThrow();
      expect((): void => {
        const { get: moduleGet4 } = module;

        return moduleGet4.bind(module)(REDIS_CLIENT);
      }).toThrow();
    } finally {
      const { close: moduleClose2 } = module;

      await moduleClose2.bind(module)();
    }
  });

  it('does not register the service on a bare module import', async (): Promise<void> => {
    const module = await Test.createTestingModule({ imports: [RedlockModule] }).compile();

    try {
      expect((): RedlockService => {
        const { get: moduleGet5 } = module;

        return moduleGet5.bind(module)(RedlockService);
      }).toThrow();
    } finally {
      const { close: moduleClose3 } = module;

      await moduleClose3.bind(module)();
    }
  });
});

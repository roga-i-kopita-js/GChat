import type { DynamicModule } from '@nestjs/common';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { createClient } from 'redis';

import { LoggerService } from '../logger/logger.service.js';
import { REDIS_CLIENT } from './redis.constants.js';
import { RedisService } from './redis.service.js';

@Module({})
export class RedisModule {
  static forRoot(): DynamicModule {
    return {
      module: RedisModule,
      global: true,
      imports: [ConfigModule],
      providers: [
        {
          provide: REDIS_CLIENT,
          inject: [ConfigService, LoggerService],
          useFactory: (
            config: ConfigService,
            logger: LoggerService,
          ): ReturnType<typeof createClient> => {
            const client = createClient({
              url: config.getOrThrow<string>('REDIS_URL'),
              disableOfflineQueue: true,
              commandsQueueMaxLength: 1000,
              commandOptions: {
                timeout: config.getOrThrow<number>('REDIS_COMMAND_TIMEOUT_MS'),
              },
              socket: {
                connectTimeout: config.getOrThrow<number>('REDIS_CONNECT_TIMEOUT_MS'),
                reconnectStrategy: (retries): number =>
                  Math.min(100 * 2 ** Math.min(retries, 8), 3000) + Math.floor(Math.random() * 100),
              },
            });

            // Never log the original error: connection details may contain credentials.
            client.on('error', (): void => logger.warn('Redis connection failed'));

            return client;
          },
        },
        RedisService,
      ],
      exports: [RedisService],
    };
  }
}

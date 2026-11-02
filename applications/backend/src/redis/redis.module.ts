import { Logger, Module } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { createClient } from 'redis';
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
          inject: [ConfigService],
          useFactory: (config: ConfigService) => {
            const client = createClient({
              url: config.getOrThrow<string>('REDIS_URL'),
              disableOfflineQueue: true,
              commandsQueueMaxLength: 1000,
              commandOptions: {
                timeout: config.getOrThrow<number>('REDIS_COMMAND_TIMEOUT_MS'),
              },
              socket: {
                connectTimeout: config.getOrThrow<number>('REDIS_CONNECT_TIMEOUT_MS'),
                reconnectStrategy: (retries) =>
                  Math.min(100 * 2 ** Math.min(retries, 8), 3000) + Math.floor(Math.random() * 100),
              },
            });
            // Never log the original error: connection details may contain credentials.
            client.on('error', () => Logger.warn('Redis connection failed', 'Redis'));
            return client;
          },
        },
        RedisService,
      ],
      exports: [RedisService],
    };
  }
}

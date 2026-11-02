import { Inject, Injectable } from '@nestjs/common';
import type { OnModuleInit, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { createClient } from 'redis';
import { REDIS_CLIENT } from './redis.constants.js';

export type RedisClient = ReturnType<typeof createClient>;

@Injectable()
export class RedisService implements OnModuleInit, OnApplicationShutdown {
  constructor(
    @Inject(REDIS_CLIENT) readonly client: RedisClient,
    private readonly config: ConfigService,
  ) {}

  /** All domain keys must pass through this helper, including lock keys. */
  key(logicalKey: string): string {
    if (!logicalKey || logicalKey.trim() !== logicalKey) {
      throw new Error('Redis logical key must be non-empty without surrounding whitespace');
    }
    return this.config.getOrThrow<string>('REDIS_KEY_PREFIX') + logicalKey;
  }

  async onModuleInit(): Promise<void> {
    try {
      await this.withDeadline(async () => {
        await this.client.connect();
        await this.ping();
      }, this.config.getOrThrow<number>('REDIS_STARTUP_TIMEOUT_MS'));
    } catch {
      if (this.client.isOpen) this.client.destroy();
      throw new Error('Redis startup failed');
    }
  }

  async ping(): Promise<void> {
    if (await this.client.ping() !== 'PONG') {
      throw new Error('Unexpected Redis PING response');
    }
  }

  async onApplicationShutdown(): Promise<void> {
    if (!this.client.isOpen) return;
    try {
      await this.withDeadline(
        () => this.client.close(),
        this.config.getOrThrow<number>('REDIS_COMMAND_TIMEOUT_MS'),
      );
    } catch {
      if (this.client.isOpen) this.client.destroy();
    }
  }

  private async withDeadline<T>(action: () => Promise<T>, ms: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        action(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('Redis operation timed out')), ms);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
}

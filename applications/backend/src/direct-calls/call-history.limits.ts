import { Injectable } from '@nestjs/common';

import { ErrorService } from '../error/error.service.js';
import { RedisService } from '../redis/redis.service.js';
import { tokenBucketScript } from '../redis/token-bucket-script.js';

@Injectable()
export class CallHistoryLimits {
  constructor(
    private readonly redis: RedisService,
    private readonly error: ErrorService,
  ) {}

  async check(userId: string): Promise<void> {
    let result: unknown;

    try {
      result = await this.redis.client.eval(tokenBucketScript, {
        keys: [this.redis.key(`direct-calls:history:rate:${userId}`)],
        arguments: ['10', '20'],
      });
    } catch {
      throw this.error.serviceUnavailable();
    }

    if (typeof result !== 'number' || !Number.isSafeInteger(result) || result < 0) {
      throw this.error.serviceUnavailable();
    }

    if (result > 0) {
      throw this.error.rateLimited({ retryAfterSeconds: Math.ceil(result / 1000) });
    }
  }
}

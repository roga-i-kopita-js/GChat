import { Injectable } from '@nestjs/common';

import { ErrorService } from '../error/error.service.js';
import { RedisService } from '../redis/redis.service.js';
import { tokenBucketScript } from '../redis/token-bucket-script.js';

export { tokenBucketScript as dialogRateScript } from '../redis/token-bucket-script.js';

@Injectable()
export class DialogsLimits {
  constructor(
    private readonly redis: RedisService,
    private readonly error: ErrorService,
  ) {}

  async check(userId: string, group: 'send' | 'create' | 'get' | 'read'): Promise<void> {
    let bucketSettings;

    if (group === 'create') {
      bucketSettings = [1, 5];
    } else if (group === 'get') {
      bucketSettings = [10, 20];
    } else {
      bucketSettings = [5, 10];
    }

    const [rate, capacity] = bucketSettings;
    let result: unknown;

    try {
      result = await this.redis.client.eval(tokenBucketScript, {
        keys: [this.redis.key(`dialogs:rate:${userId}:${group}`)],
        arguments: [String(rate), String(capacity)],
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

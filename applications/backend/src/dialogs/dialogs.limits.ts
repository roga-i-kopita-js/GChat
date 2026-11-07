import { Injectable } from '@nestjs/common';

import { ErrorService } from '../error/error.service.js';
import { RedisService } from '../redis/redis.service.js';

export const dialogRateScript = `
local r=tonumber(ARGV[1]); local c=tonumber(ARGV[2]);
local typ=redis.call('TYPE',KEYS[1]).ok;
if typ~='none' and typ~='hash' then return redis.error_reply('Invalid bucket') end
local t=redis.call('TIME'); local now=tonumber(t[1])*1000+math.floor(tonumber(t[2])/1000);
local values=redis.call('HMGET',KEYS[1],'credit_ms','updated_at_ms');
local credit=c*1000; local previous=now;
if values[1] or values[2] then
 credit=tonumber(values[1]); previous=tonumber(values[2]);
 if not credit or not previous or credit<0 or credit>c*1000 or credit~=math.floor(credit) or previous<0 or previous>9007199254740991 or previous~=math.floor(previous) then return redis.error_reply('Invalid bucket') end
end
now=math.max(now,previous);
credit=math.min(c*1000, credit+math.min(now-previous,math.ceil(c*1000/r))*r);
local wait=0;
if credit>=1000 then credit=credit-1000 else wait=math.ceil((1000-credit)/r) end
redis.call('HSET',KEYS[1],'credit_ms',credit,'updated_at_ms',now);
redis.call('PEXPIRE',KEYS[1],60000);
return wait
`;

@Injectable()
export class DialogsLimits {
  constructor(
    private readonly redis: RedisService,
    private readonly error: ErrorService,
  ) {}

  async check(userId: string, group: 'send' | 'create' | 'get' | 'read'): Promise<void> {
    const [rate, capacity] = group === 'create' ? [1, 5] : group === 'get' ? [10, 20] : [5, 10];
    let result: unknown;

    try {
      result = await this.redis.client.eval(dialogRateScript, {
        keys: [this.redis.key(`dialogs:rate:${userId}:${group}`)],
        arguments: [String(rate), String(capacity)],
      });
    } catch {
      throw this.error.serviceUnavailable();
    }

    if (typeof result !== 'number' || !Number.isSafeInteger(result) || result < 0)
      throw this.error.serviceUnavailable();

    if (result > 0) throw this.error.rateLimited({ retryAfterSeconds: Math.ceil(result / 1000) });
  }
}

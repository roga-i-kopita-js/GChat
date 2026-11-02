import { Injectable } from '@nestjs/common';

import { ErrorService } from '../error/error.service.js';
import { RedisService } from '../redis/redis.service.js';
import type { LockContext } from '../redlock/redlock.service.js';

export interface Session {
  userId: string;
  hash: string;
  createdAt: number;
  updatedAt: number;
}

export interface Rotation {
  requestId: string;
  hash: string;
  encrypted: string;
}

// All type and state checks precede writes: Redis Lua does not roll back runtime errors.
export const MUTATE_SESSION = `
if redis.call('get', KEYS[1]) ~= ARGV[1] then return -1 end
local mode = ARGV[2]
local current = redis.call('get', KEYS[2])
local rotation = redis.call('get', KEYS[3])
local indexType = redis.call('type', KEYS[4]).ok
if indexType ~= 'none' and indexType ~= 'set' then return redis.error_reply('Invalid session index') end
if mode == 'create' then
  if current or rotation then return 0 end
else
  if not current or current ~= ARGV[3] then return 0 end
  if (rotation or '') ~= ARGV[4] then
    -- Expiration is expected; a different live result is a conflicting mutation.
    if rotation then return 0 end
    -- An expired previous token no longer authorizes logout.
    if mode == 'delete' and cjson.decode(current).hash ~= ARGV[8] then return 2 end
  end
end
if mode == 'delete' then
  redis.call('del', KEYS[2], KEYS[3])
  redis.call('srem', KEYS[4], ARGV[5])
elseif mode == 'create' then
  redis.call('set', KEYS[2], ARGV[6])
  redis.call('sadd', KEYS[4], ARGV[5])
elseif mode == 'rotate' then
  redis.call('set', KEYS[2], ARGV[6])
  redis.call('set', KEYS[3], ARGV[7], 'PX', 30000)
else return redis.error_reply('Invalid mutation') end
return 1`;

export interface SessionState {
  session: Session;
  raw: string;
  rotation?: Rotation;
  rotationRaw: string;
}

@Injectable()
export class AuthSessions {
  constructor(
    private readonly redis: RedisService,
    private readonly error: ErrorService,
  ) {}

  async read(sid: string): Promise<SessionState | undefined> {
    let values;

    try {
      values = await this.redis.client
        .multi()
        .get(this.redis.key(`auth:session:${sid}`))
        .get(this.redis.key(`auth:rotation:${sid}`))
        .exec();
    } catch (cause) {
      throw this.error.serviceUnavailable({ cause });
    }

    const [raw, rotationRaw] = values;

    if (
      (raw !== null && typeof raw !== 'string') ||
      (rotationRaw !== null && typeof rotationRaw !== 'string')
    ) {
      throw this.error.serviceUnavailable();
    }

    if (raw === null) return undefined;

    const session: Session = JSON.parse(raw);

    return {
      session,
      raw,
      rotationRaw: rotationRaw ?? '',
      rotation: rotationRaw ? JSON.parse(rotationRaw) : undefined,
    };
  }

  async mutate(
    mode: 'create' | 'rotate' | 'delete',
    sid: string,
    userId: string,
    ctx: LockContext,
    previous?: SessionState,
    next?: Session,
    rotation?: Rotation,
    presentedHash?: string,
  ): Promise<void> {
    ctx.assertHeld();
    let result;

    try {
      result = await this.redis.client.eval(MUTATE_SESSION, {
        keys: [
          ctx.redisOwnership.key,
          this.redis.key(`auth:session:${sid}`),
          this.redis.key(`auth:rotation:${sid}`),
          this.redis.key(`auth:user-sessions:${userId}`),
        ],
        arguments: [
          ctx.redisOwnership.owner,
          mode,
          previous?.raw ?? '',
          previous?.rotationRaw ?? '',
          sid,
          next ? JSON.stringify(next) : '',
          rotation ? JSON.stringify(rotation) : '',
          presentedHash ?? '',
        ],
      });
    } catch (cause) {
      throw this.error.serviceUnavailable({ cause });
    }

    if (result !== 1 && !(mode === 'delete' && result === 2)) throw this.error.serviceUnavailable();

    ctx.assertHeld();
  }
}

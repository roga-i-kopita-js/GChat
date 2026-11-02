import { Injectable } from '@nestjs/common';

import { ErrorService } from '../error/error.service.js';
import { RedisService } from '../redis/redis.service.js';

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
local mode = ARGV[1]
local current = redis.call('get', KEYS[1])
local rotation = redis.call('get', KEYS[2])
local indexType = redis.call('type', KEYS[3]).ok
if indexType ~= 'none' and indexType ~= 'set' then return redis.error_reply('Invalid session index') end
if mode == 'create' then
  if current or rotation then return 0 end
elseif mode == 'delete' then
  if not current then return 1 end
  local session = cjson.decode(current)
  if session.userId ~= ARGV[7] then return 0 end
  local recognized = session.hash == ARGV[6]
  if not recognized and rotation then recognized = cjson.decode(rotation).hash == ARGV[6] end
  if not recognized then return 1 end
elseif mode == 'rotate' then
  if not current or current ~= ARGV[2] then return 0 end
  if rotation and rotation ~= ARGV[3] then return 0 end
else return redis.error_reply('Invalid mutation') end
if mode == 'delete' then
  redis.call('del', KEYS[1], KEYS[2])
  redis.call('srem', KEYS[3], ARGV[4])
elseif mode == 'create' then
  redis.call('set', KEYS[1], ARGV[5])
  redis.call('sadd', KEYS[3], ARGV[4])
else
  redis.call('set', KEYS[1], ARGV[5])
  redis.call('set', KEYS[2], ARGV[8], 'PX', 30000)
end
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
    previous?: SessionState,
    next?: Session,
    rotation?: Rotation,
    presentedHash?: string,
  ): Promise<boolean> {
    let result;

    try {
      result = await this.redis.client.eval(MUTATE_SESSION, {
        keys: [
          this.redis.key(`auth:session:${sid}`),
          this.redis.key(`auth:rotation:${sid}`),
          this.redis.key(`auth:user-sessions:${userId}`),
        ],
        arguments: [
          mode,
          previous?.raw ?? '',
          previous?.rotationRaw ?? '',
          sid,
          next ? JSON.stringify(next) : '',
          presentedHash ?? '',
          userId,
          rotation ? JSON.stringify(rotation) : '',
        ],
      });
    } catch (cause) {
      throw this.error.serviceUnavailable({ cause });
    }

    return result === 1;
  }
}

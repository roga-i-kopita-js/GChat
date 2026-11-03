import { Injectable } from '@nestjs/common';

import { ErrorService } from '../error/error.service.js';
import { RedisService } from '../redis/redis.service.js';
import type { Participant } from './direct-calls.schema.js';

const RESERVE = `
local a = redis.call('get',KEYS[1])
local b = redis.call('get',KEYS[2])
if a and a ~= ARGV[1] then return 1 end
if b and b ~= ARGV[1] then return 2 end
redis.call('set',KEYS[1],ARGV[1],'EX',60)
redis.call('set',KEYS[2],ARGV[1],'EX',60)
return 0`;
const RELEASE = `for _, key in ipairs(KEYS) do if redis.call('get',key) == ARGV[1] then redis.call('del',key) end end return 1`;
const PROJECT = `
local old = redis.call('get',KEYS[1])
if old then
  local value = cjson.decode(old)
  if (value.version or -1) > tonumber(ARGV[3]) or value.sequence > tonumber(ARGV[1]) then return 0 end
end
redis.call('set',KEYS[1],ARGV[2],'EX',60)
return 1`;

@Injectable()
export class DirectCallsPresence {
  constructor(
    private readonly redis: RedisService,
    private readonly error: ErrorService,
  ) {}

  keys(users: string[]): string[] {
    return users.map((id): string => this.redis.key('direct-calls:busy:' + id));
  }

  async reserve(callId: string, users: string[]): Promise<number> {
    try {
      const result = await this.redis.client.eval(RESERVE, {
        keys: this.keys(users),
        arguments: [callId],
      });

      if (typeof result !== 'number') throw this.error.serviceUnavailable();

      return result;
    } catch (cause) {
      throw this.error.serviceUnavailable({ cause });
    }
  }

  async read(users: string[]): Promise<(string | null)[]> {
    try {
      return await this.redis.client.mGet(this.keys(users));
    } catch (cause) {
      throw this.error.serviceUnavailable({ cause });
    }
  }

  async owns(callId: string, users: string[]): Promise<boolean> {
    try {
      const values = await this.redis.client.mGet(this.keys(users));

      return values.every((value): boolean => value === callId);
    } catch (cause) {
      throw this.error.serviceUnavailable({ cause });
    }
  }

  async release(callId: string, users: string[]): Promise<void> {
    try {
      await this.redis.client.eval(RELEASE, { keys: this.keys(users), arguments: [callId] });
    } catch (cause) {
      throw this.error.serviceUnavailable({ cause });
    }
  }

  async project(participant: Participant, version: number): Promise<void> {
    await this.redis.client.eval(PROJECT, {
      keys: [this.redis.key(`direct-calls:presence:${participant.callId}:${participant.role}`)],
      arguments: [
        String(participant.lastSequence),
        JSON.stringify({
          version,
          sequence: participant.lastSequence,
          last_ping_at: participant.lastPingAt?.toISOString() ?? null,
          audio_connected: participant.audioConnected,
          confirmed_recovery_id: participant.confirmedRecoveryId,
        }),
        String(version),
      ],
    });
  }
}

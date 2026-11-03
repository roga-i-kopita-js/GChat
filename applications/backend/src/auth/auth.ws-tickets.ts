import { createHash, randomBytes } from 'node:crypto';

import { Injectable } from '@nestjs/common';

import { ErrorService } from '../error/error.service.js';
import { RedisService } from '../redis/redis.service.js';
import type { AuthIdentity } from './auth.guard.js';
import { AuthRepository } from './auth.repository.js';
import { AuthSessions } from './auth.sessions.js';
import { BrowserOrigin } from './browser-origin.js';

const ISSUE = `
local count=redis.call('incr',KEYS[1])
if count==1 then redis.call('expire',KEYS[1],60) end
if count>10 then return math.max(1,redis.call('ttl',KEYS[1])) end
if not redis.call('set',KEYS[2],ARGV[1],'EX',30,'NX') then return -1 end
return 0`;

export interface WsTicket {
  ticket: string;
  expires_at: string;
}

@Injectable()
export class AuthWsTickets {
  constructor(
    private readonly redis: RedisService,
    private readonly accounts: AuthRepository,
    private readonly sessions: AuthSessions,
    private readonly origins: BrowserOrigin,
    private readonly error: ErrorService,
  ) {}

  private key(ticket: string): string {
    return this.redis.key('auth:ws-ticket:' + createHash('sha256').update(ticket).digest('hex'));
  }

  async issue(identity: AuthIdentity, origin: string | undefined): Promise<WsTicket> {
    const allowed = this.origins.assert(origin);
    const ticket = randomBytes(32).toString('base64url');
    const expires = Date.now() + 30000;
    let result;

    try {
      result = await this.redis.client.eval(ISSUE, {
        keys: [this.redis.key('auth:ws-ticket-rate:' + identity.sessionId), this.key(ticket)],
        arguments: [
          JSON.stringify({
            userId: identity.userId,
            sessionId: identity.sessionId,
            origin: allowed,
            expiresAt: expires,
          }),
        ],
      });
    } catch (cause) {
      throw this.error.serviceUnavailable({ cause });
    }

    if (typeof result !== 'number' || result < 0) throw this.error.serviceUnavailable();

    if (result > 0) throw this.error.rateLimited({ retryAfterSeconds: result });

    return { ticket, expires_at: new Date(expires).toISOString() };
  }

  async redeem(ticket: string, origin: string | undefined): Promise<AuthIdentity> {
    const allowed = this.origins.assert(origin);

    if (!/^[A-Za-z0-9_-]{43}$/.test(ticket)) throw this.error.accessTokenInvalid();

    let raw;

    try {
      raw = await this.redis.client.getDel(this.key(ticket));
    } catch (cause) {
      throw this.error.serviceUnavailable({ cause });
    }

    if (!raw) throw this.error.accessTokenInvalid();

    let value: unknown;

    try {
      value = JSON.parse(raw);
    } catch {
      throw this.error.serviceUnavailable();
    }

    if (
      !value ||
      typeof value !== 'object' ||
      !('userId' in value) ||
      typeof value.userId !== 'string' ||
      !('sessionId' in value) ||
      typeof value.sessionId !== 'string' ||
      !('expiresAt' in value) ||
      typeof value.expiresAt !== 'number' ||
      !('origin' in value)
    )
      throw this.error.serviceUnavailable();

    if (value.expiresAt <= Date.now()) throw this.error.accessTokenInvalid();

    if (value.origin !== allowed) throw this.error.forbidden();

    const account = await this.accounts.byId(value.userId);
    const state = await this.sessions.read(value.sessionId);

    if (!account || account.disabledAt || state?.session.userId !== account.id)
      throw this.error.sessionInvalid();

    return {
      userId: account.id,
      sessionId: value.sessionId,
      login: account.login,
      displayName: account.displayName,
    };
  }
}

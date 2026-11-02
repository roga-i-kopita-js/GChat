import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { ErrorService } from '../error/error.service.js';

@Injectable()
export class AuthLimits {
  private readonly entries = new Map<string, { time: number; operationId?: string }[]>();

  constructor(
    private readonly error: ErrorService,
    private readonly config: ConfigService,
  ) {}

  check(key: string, kind: 'login' | 'refresh', consume = false, operationId?: string): void {
    const now = Date.now();

    // Prune all keys as well as the current key; unknown logins must not accumulate forever.
    for (const [name, times] of this.entries) {
      const window = name.startsWith('login:')
        ? this.config.getOrThrow<number>('AUTH_LOGIN_WINDOW_MS')
        : this.config.getOrThrow<number>('AUTH_REFRESH_WINDOW_MS');
      const live = times.filter((entry): boolean => entry.time > now - window);

      if (live.length) this.entries.set(name, live);
      else this.entries.delete(name);
    }

    const name = `${kind}:${key}`;
    const times = this.entries.get(name) ?? [];
    const window = this.config.getOrThrow<number>(
      kind === 'login' ? 'AUTH_LOGIN_WINDOW_MS' : 'AUTH_REFRESH_WINDOW_MS',
    );
    const max = this.config.getOrThrow<number>(
      kind === 'login' ? 'AUTH_LOGIN_MAX_FAILURES' : 'AUTH_REFRESH_MAX_OPERATIONS',
    );

    if (operationId && times.some((entry): boolean => entry.operationId === operationId)) return;

    if (times.length >= max)
      throw this.error.rateLimited({
        retryAfterSeconds: Math.max(1, Math.ceil((times[0]!.time + window - now) / 1000)),
      });

    if (consume) {
      times.push({ time: now, operationId });
      this.entries.set(name, times);
    }
  }
}

import { LoggerService } from '../logger/logger.service.js';
import { Injectable } from '@nestjs/common';
import type { BeforeApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { RedisService } from '../redis/redis.service.js';
import { LockError } from './redlock.errors.js';

export interface LockContext {
  readonly signal: AbortSignal;
  assertHeld(): void;
}

// Compare and mutate in one Redis operation. A stale owner must never affect its successor.
export const RELEASE_LOCK = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('del', KEYS[1])
end
return 0`;
export const EXTEND_LOCK = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('pexpire', KEYS[1], ARGV[2])
end
return 0`;

@Injectable()
export class RedlockService implements BeforeApplicationShutdown {
  private stopping = false;
  private readonly scope = new AsyncLocalStorage<boolean>();
  private readonly active = new Map<AbortController, Promise<unknown>>();

  constructor(private readonly redis: RedisService, private readonly config: ConfigService, private readonly logger: LoggerService) {}

  withLock<T>(resource: string, action: (context: LockContext) => Promise<T>): Promise<T> {
    if (this.stopping) return Promise.reject(new LockError('LOCK_SHUTTING_DOWN', false));
    if (this.scope.getStore()) return Promise.reject(new Error('Nested locks are not supported'));
    const controller = new AbortController();
    const task = this.scope.run(true, () => this.run(resource, action, controller));
    this.active.set(controller, task);
    // Use both handlers so tracking never produces an unhandled rejected promise.
    void task.then(() => this.active.delete(controller), () => this.active.delete(controller));
    return task;
  }

  async beforeApplicationShutdown(): Promise<void> {
    this.stopping = true;
    for (const controller of this.active.keys()) {
      controller.abort(new LockError('LOCK_SHUTTING_DOWN', true));
    }
    const timer = new AbortController();
    try {
      await Promise.race([
        Promise.allSettled(this.active.values()),
        delay(this.ms('REDIS_COMMAND_TIMEOUT_MS') * 2, undefined, { signal: timer.signal }),
      ]);
    } finally {
      timer.abort();
    }
  }

  private ms(name: string): number { return this.config.getOrThrow<number>(name); }

  private async run<T>(resource: string, action: (ctx: LockContext) => Promise<T>, controller: AbortController): Promise<T> {
    if (!/^[a-zA-Z0-9:_-]+$/.test(resource)) throw new Error('Invalid lock resource');
    const key = this.redis.key(`lock:${resource}`);
    const owner = randomUUID();
    const lease = this.ms('REDLOCK_LEASE_MS');
    const drift = Math.ceil(lease * 0.01) + 2;
    const commandTimeout = this.ms('REDIS_COMMAND_TIMEOUT_MS');
    const acquireDeadline = performance.now() + this.ms('REDLOCK_ACQUIRE_TIMEOUT_MS');
    let expires = 0;

    while (true) {
      if (controller.signal.aborted || this.stopping) throw new LockError('LOCK_SHUTTING_DOWN', false);
      const start = performance.now();
      const remaining = Math.floor(acquireDeadline - start);
      if (remaining <= 0) throw new LockError('LOCK_ACQUIRE_FAILED', false);
      let result;
      try {
        result = await this.redis.client.withCommandOptions({ timeout: Math.min(commandTimeout, remaining) })
          .set(key, owner, { NX: true, PX: lease });
      } catch {
        // An unknown write may have acquired a lease: never run or retry the callback.
        throw new LockError('LOCK_ACQUIRE_FAILED', false);
      }
      if (result === 'OK') {
        expires = start + lease - drift;
        break;
      }
      const wait = Math.min(
        this.ms('REDLOCK_RETRY_DELAY_MS') + Math.floor(Math.random() * (this.ms('REDLOCK_RETRY_JITTER_MS') + 1)),
        Math.max(0, acquireDeadline - performance.now()),
      );
      try { await delay(wait, undefined, { signal: controller.signal }); }
      catch { throw new LockError('LOCK_SHUTTING_DOWN', false); }
    }

    const holdDeadline = performance.now() + this.ms('REDLOCK_MAX_HOLD_MS');
    let renewTimer: ReturnType<typeof setTimeout> | undefined;
    let expiryTimer: ReturnType<typeof setTimeout> | undefined;
    let renewal: Promise<void> | undefined;
    let finished = false;
    const lost = () => {
      if (!controller.signal.aborted) controller.abort(new LockError('LOCK_LOST', true));
    };
    const assertHeld = () => {
      if (performance.now() >= expires || performance.now() >= holdDeadline) lost();
      controller.signal.throwIfAborted();
    };
    const schedule = () => {
      clearTimeout(expiryTimer);
      expiryTimer = setTimeout(lost, Math.max(0, expires - performance.now()));
      renewTimer = setTimeout(() => { renewal = renew(); },
        Math.max(0, expires - performance.now() - this.ms('REDLOCK_EXTEND_THRESHOLD_MS')));
    };
    const renew = async () => {
      try {
        assertHeld();
        const start = performance.now();
        const result = await this.redis.client.eval(EXTEND_LOCK, { keys: [key], arguments: [owner, String(lease)] });
        // Do not revive a lease after its previously known validity has ended.
        assertHeld();
        if (result !== 1) { lost(); return; }
        expires = start + lease - drift;
        if (!finished && !controller.signal.aborted) schedule();
      } catch { lost(); }
    };
    controller.signal.addEventListener('abort', () => {
      clearTimeout(renewTimer);
      clearTimeout(expiryTimer);
    }, { once: true });
    const maxTimer = setTimeout(() => {
      this.logger.warn('Lock callback exceeded maximum hold time');
      lost();
    }, this.ms('REDLOCK_MAX_HOLD_MS'));
    let failed = false;
    try {
      assertHeld();
      if (performance.now() > acquireDeadline) throw new LockError('LOCK_ACQUIRE_FAILED', false);
      schedule();
      const result = await action({ signal: controller.signal, assertHeld });
      assertHeld();
      return result;
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      finished = true;
      clearTimeout(maxTimer);
      clearTimeout(renewTimer);
      clearTimeout(expiryTimer);
      // Serialize release after any in-flight extension.
      await renewal;
      try {
        const released = await this.redis.client.eval(RELEASE_LOCK, { keys: [key], arguments: [owner] });
        if (released !== 1) throw new Error('Ownership not confirmed');
      } catch {
        this.logger.warn('Lock release not confirmed');
        if (!failed) throw new LockError('LOCK_RELEASE_FAILED', true);
      }
      if (!failed) controller.signal.throwIfAborted();
    }
  }
}

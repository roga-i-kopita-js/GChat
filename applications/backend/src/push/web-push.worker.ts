import type { OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { DevicesService } from '../devices/devices.service.js';
import { DirectCallsDeliveryStore } from '../direct-calls/direct-calls.delivery-store.js';
import { DirectCallsService } from '../direct-calls/direct-calls.service.js';
import { LoggerService } from '../logger/logger.service.js';
import { WebPushClient } from './web-push.client.js';

@Injectable()
export class WebPushWorker implements OnApplicationBootstrap, OnModuleDestroy {
  private timer?: ReturnType<typeof setInterval>;
  private running?: Promise<void>;
  constructor(
    private readonly store: DirectCallsDeliveryStore,
    private readonly calls: DirectCallsService,
    private readonly devices: DevicesService,
    private readonly client: WebPushClient,
    private readonly config: ConfigService,
    private readonly logger: LoggerService,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.config.get<boolean>('WEB_PUSH_ENABLED', false)) return;
    this.timer = setInterval((): void => {
      if (this.running) return;
      this.running = this.tick()
        .catch((): void => {
          this.logger.warn('Web Push delivery deferred');
        })
        .finally((): void => {
          this.running = undefined;
        });
    }, 200);
    this.timer.unref();
  }

  private async tick(): Promise<void> {
    for (const job of await this.store.claim('web_push', 4)) {
      if (!job.leaseToken || !job.deviceId || !job.sessionId) continue;
      try {
        const target = await this.devices.resolveWebPushTarget(job.deviceId, job.sessionId);
        if (!target) {
          await this.store.complete(job.id, job.leaseToken, 'cancelled');
          continue;
        }
        const call = await this.calls.get(
          { userId: target.userId, sessionId: job.sessionId, deviceId: job.deviceId },
          job.callId,
        );
        if (
          call.state !== 'ringing' ||
          !call.ringing_deadline ||
          Date.parse(call.ringing_deadline) <= Date.now()
        ) {
          await this.store.complete(job.id, job.leaseToken, 'cancelled');
          continue;
        }
        const result = await this.client.send(target, call.call_id, call.ringing_deadline);
        if (result.status >= 200 && result.status < 300)
          await this.store.complete(job.id, job.leaseToken);
        else if (result.status === 404 || result.status === 410) {
          await this.devices.invalidateWebPushTarget(target.sessionId, target.version);
          await this.store.complete(job.id, job.leaseToken, 'cancelled');
        } else if (result.status === 429 || result.status >= 500) {
          await this.store.retry(job.id, job.leaseToken, job.attempts, result.retryAfterSeconds);
        } else {
          this.logger.warn('Web Push request rejected', { status: result.status });
          await this.store.complete(job.id, job.leaseToken, 'cancelled');
        }
      } catch {
        await this.store.retry(job.id, job.leaseToken, job.attempts);
      }
    }
  }

  async onModuleDestroy(): Promise<void> {
    clearInterval(this.timer);
    await this.running;
  }
}

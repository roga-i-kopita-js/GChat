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
    if (!this.config.get<boolean>('WEB_PUSH_ENABLED', false)) {
      return;
    }

    this.timer = setInterval((): void => {
      if (this.running) {
        return;
      }

      this.running = (async () => {
        try {
          return await this.tick();
        } catch (cause) {
          this.logger.warn('Web Push delivery deferred');
        } finally {
          this.running = undefined;
        }
      })();
    }, 200);
    this.timer.unref();
  }

  private async tick(): Promise<void> {
    for (const job of await this.store.claim('web_push', 4)) {
      if (!job.leaseToken || !job.deviceId || !job.sessionId) {
        continue;
      }

      try {
        const target = await this.devices.resolveWebPushTarget(job.deviceId, job.sessionId);

        if (!target) {
          await this.store.complete(job.id, job.leaseToken, 'cancelled');
          continue;
        }

        const { userId: targetUserId } = target;
        const call = await this.calls.get(
          { userId: targetUserId, sessionId: job.sessionId, deviceId: job.deviceId },
          job.callId,
        );

        const { state: callState, ringing_deadline: callRingingDeadline } = call ?? {};

        if (
          callState !== 'ringing' ||
          !callRingingDeadline ||
          Date.parse(callRingingDeadline) <= Date.now()
        ) {
          await this.store.complete(job.id, job.leaseToken, 'cancelled');
          continue;
        }

        const { call_id: callCallId, ringing_deadline: callRingingDeadline2 } = call;
        const result = await this.client.send(target, callCallId, callRingingDeadline);

        const { status: resultStatus } = result;

        if (resultStatus >= 200 && resultStatus < 300) {
          await this.store.repeatWebPush(job.id, job.leaseToken);
        } else if (resultStatus === 404 || resultStatus === 410) {
          const { sessionId: targetSessionId, version: targetVersion } = target;

          await this.devices.invalidateWebPushTarget(targetSessionId, targetVersion);
          await this.store.complete(job.id, job.leaseToken, 'cancelled');
        } else if (resultStatus === 429 || resultStatus >= 500) {
          const { retryAfterSeconds: resultRetryAfterSeconds } = result;

          await this.store.retry(job.id, job.leaseToken, job.attempts, resultRetryAfterSeconds);
        } else {
          const { status: resultStatus2 } = result;

          this.logger.warn('Web Push request rejected', { status: resultStatus2 });
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

import type { OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { DevicesService } from '../devices/devices.service.js';
import { DirectCallsDeliveryStore } from '../direct-calls/direct-calls.delivery-store.js';
import { DirectCallsService } from '../direct-calls/direct-calls.service.js';
import { LoggerService } from '../logger/logger.service.js';
import { PushClient } from './push.client.js';

@Injectable()
export class PushWorker implements OnApplicationBootstrap, OnModuleDestroy {
  private timer?: ReturnType<typeof setInterval>;
  private running?: Promise<void>;

  constructor(
    private readonly store: DirectCallsDeliveryStore,
    private readonly calls: DirectCallsService,
    private readonly devices: DevicesService,
    private readonly client: PushClient,
    private readonly config: ConfigService,
    private readonly logger: LoggerService,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.config.get<boolean>('APNS_ENABLED', true)) return;

    this.timer = setInterval((): void => {
      if (this.running) return;

      this.running = this.tick()
        .catch((): void => {
          this.logger.warn('VoIP delivery deferred');
        })
        .finally((): void => {
          this.running = undefined;
        });
    }, 200);
    this.timer.unref();
  }

  private async tick(): Promise<void> {
    for (const job of await this.store.claim('voip', 4)) {
      if (!job.leaseToken || !job.deviceId || !job.sessionId) continue;

      try {
        const target = await this.devices.resolveVoipTarget(job.deviceId, job.sessionId);

        if (!target || target.environment !== this.config.getOrThrow<string>('APNS_ENVIRONMENT')) {
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

        const result = await this.client.send(
          job.id,
          target.token,
          {
            aps: {},
            call_id: call.call_id,
            caller_id: call.caller_id,
            recipient_id: call.recipient_id,
            created_at: call.created_at,
            ringing_deadline: call.ringing_deadline,
          },
          new Date(call.ringing_deadline),
        );

        if (result.status === 200) await this.store.complete(job.id, job.leaseToken);
        else if (
          ['BadDeviceToken', 'Unregistered', 'DeviceTokenNotForTopic'].includes(result.reason ?? '')
        ) {
          await this.devices.invalidateVoipTarget(
            target.deviceId,
            target.version,
            result.reason === 'Unregistered' ? result.timestamp : undefined,
          );
          await this.store.complete(job.id, job.leaseToken, 'cancelled');
        } else if (result.status === 429 || result.status >= 500)
          await this.store.retry(job.id, job.leaseToken, job.attempts, result.retryAfterSeconds);
        else {
          this.logger.warn('APNs configuration or request rejected', {
            status: result.status,
            reason: result.reason,
          });
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

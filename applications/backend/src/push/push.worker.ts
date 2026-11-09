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
    if (!this.config.get<boolean>('APNS_ENABLED', true)) {
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
          this.logger.warn('VoIP delivery deferred');
        } finally {
          this.running = undefined;
        }
      })();
    }, 200);
    this.timer.unref();
  }

  private async tick(): Promise<void> {
    for (const job of await this.store.claim('voip', 4)) {
      if (!job.leaseToken || !job.deviceId || !job.sessionId) {
        continue;
      }

      try {
        const target = await this.devices.resolveVoipTarget(job.deviceId, job.sessionId);

        const { environment: targetEnvironment } = target ?? {};

        if (!target || targetEnvironment !== this.config.getOrThrow<string>('APNS_ENVIRONMENT')) {
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

        const { token: targetToken } = target;
        const {
          call_id: callCallId,
          caller_id: callCallerId,
          recipient_id: callRecipientId,
          created_at: callCreatedAt,
          ringing_deadline: callRingingDeadline2,
        } = call;
        const result = await this.client.send(
          job.id,
          targetToken,
          {
            aps: {},
            call_id: callCallId,
            caller_id: callCallerId,
            recipient_id: callRecipientId,
            created_at: callCreatedAt,
            ringing_deadline: callRingingDeadline2,
          },
          new Date(callRingingDeadline),
        );

        const { status: resultStatus, reason: resultReason } = result;

        if (resultStatus === 200) {
          await this.store.complete(job.id, job.leaseToken);
        } else if (
          ['BadDeviceToken', 'Unregistered', 'DeviceTokenNotForTopic'].includes(resultReason ?? '')
        ) {
          const { deviceId: targetDeviceId, version: targetVersion } = target;
          const { reason: resultReason2, timestamp: resultTimestamp } = result;

          await this.devices.invalidateVoipTarget(
            targetDeviceId,
            targetVersion,
            resultReason2 === 'Unregistered' ? resultTimestamp : undefined,
          );
          await this.store.complete(job.id, job.leaseToken, 'cancelled');
        } else if (resultStatus === 429 || resultStatus >= 500) {
          const { retryAfterSeconds: resultRetryAfterSeconds } = result;

          await this.store.retry(job.id, job.leaseToken, job.attempts, resultRetryAfterSeconds);
        } else {
          const { status: resultStatus2, reason: resultReason3 } = result;

          this.logger.warn('APNs configuration or request rejected', {
            status: resultStatus2,
            reason: resultReason3,
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

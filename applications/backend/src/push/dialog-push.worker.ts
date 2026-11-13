import type { OnModuleDestroy } from '@nestjs/common';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { AuthService } from '../auth/auth.service.js';
import { DevicesService } from '../devices/devices.service.js';
import type { MessageDto } from '../dialogs/dialogs.dto.js';
import { type DialogNotice, DialogsEvents } from '../dialogs/dialogs.events.js';
import { DialogsService } from '../dialogs/dialogs.service.js';
import { LoggerService } from '../logger/logger.service.js';
import { dialogPushPayload } from './dialog-push.payload.js';
import { PushClient } from './push.client.js';
import { WebPushClient } from './web-push.client.js';
interface Job {
  message: MessageDto;
  recipient: string;
  deadline: number;
}

@Injectable()
export class DialogPushWorker implements OnModuleDestroy {
  private readonly waiting: Job[] = [];
  private readonly active = new Set<Promise<void>>();
  private stopped = false;
  private readonly skipped = new Map<string, number>();

  private skip(reason: string): void {
    const count = (this.skipped.get(reason) ?? 0) + 1;

    this.skipped.set(reason, count);
    this.logger.warn('Dialog push skipped', { reason, count });
  }

  private async bounded(job: Job): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;

    try {
      await Promise.race([
        this.run(job),
        new Promise<void>((resolve): void => {
          timer = setTimeout(
            (): void => {
              this.skip('deadline');
              resolve();
            },
            Math.max(0, job.deadline - Date.now()),
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  private readonly unsubscribe: () => void;

  constructor(
    events: DialogsEvents,
    private readonly dialogs: DialogsService,
    private readonly devices: DevicesService,
    private readonly apns: PushClient,
    private readonly web: WebPushClient,
    private readonly config: ConfigService,
    private readonly logger: LoggerService,
    private readonly auth: AuthService,
  ) {
    this.unsubscribe = events.subscribe((notice): Promise<void> => {
      this.enqueue(notice);

      return Promise.resolve();
    });
  }

  private enqueue(notice: DialogNotice): void {
    if (!notice.message || this.stopped) {
      return;
    }

    const recipient = notice.users.find((id): boolean => id !== notice.message?.sender_id);

    if (!recipient) {
      return;
    }

    if (this.waiting.length >= 100) {
      this.skip('overload');

      return;
    }

    this.waiting.push({ message: notice.message, recipient, deadline: Date.now() + 10000 });
    this.drain();
  }

  private drain(): void {
    while (!this.stopped && this.active.size < 4 && this.waiting.length) {
      const job = this.waiting.shift()!;
      const execute = async (): Promise<void> => {
        try {
          await this.bounded(job);
        } catch {
          this.skip('dependency');
        } finally {
          this.active.delete(task);
          this.drain();
        }
      };
      const task = execute();

      this.active.add(task);
    }
  }

  private async run(job: Job): Promise<void> {
    if (Date.now() >= job.deadline) {
      this.skip('deadline');

      return;
    }

    const native = this.config.get<boolean>('APNS_ENABLED', true)
      ? await this.devices.listApnsTargets(job.recipient)
      : [];
    const browser = await this.devices.listWebPushTargets(job.recipient);
    const requests: (() => Promise<void>)[] = [];

    for (const target of native) {
      requests.push(async (): Promise<void> => {
        if (
          Date.now() >= job.deadline ||
          !(await this.dialogs.canDeliver(
            target.userId,
            target.sessionId,
            target.deviceId,
            job.message.dialog_id,
          ))
        ) {
          return;
        }

        const senderName = await this.senderName(job.message.sender_id);
        const current = await this.devices.resolveApnsTarget(target.deviceId, target.sessionId);

        const { version: currentVersion } = current ?? {};

        if (!current || currentVersion !== target.version || Date.now() >= job.deadline) {
          return;
        }

        const { token: currentToken } = current;
        const result = await this.apns.send(
          job.message.message_id,
          currentToken,
          dialogPushPayload(job.message, true, senderName),
          new Date(job.deadline),
          'alert',
        );

        const { reason: resultReason } = result;

        if (
          ['BadDeviceToken', 'Unregistered', 'DeviceTokenNotForTopic'].includes(resultReason ?? '')
        ) {
          const { deviceId: currentDeviceId, version: currentVersion2 } = current;
          const { timestamp: resultTimestamp } = result;

          await this.devices.invalidateApnsTarget(
            currentDeviceId,
            currentVersion2,
            resultTimestamp,
          );
        }
      });
    }

    for (const target of browser) {
      requests.push(async (): Promise<void> => {
        if (
          Date.now() >= job.deadline ||
          !(await this.dialogs.canDeliver(
            target.userId,
            target.sessionId,
            target.deviceId,
            job.message.dialog_id,
          ))
        ) {
          return;
        }

        const senderName = await this.senderName(job.message.sender_id);
        const current = await this.devices.resolveWebPushTarget(target.deviceId, target.sessionId);

        const { version: currentVersion3 } = current ?? {};

        if (!current || currentVersion3 !== target.version || Date.now() >= job.deadline) {
          return;
        }

        const { status: resultStatus } = await this.web.sendPayload(
          current,
          dialogPushPayload(job.message, false, senderName),
          new Date(job.deadline).toISOString(),
        );

        if (resultStatus === 404 || resultStatus === 410) {
          const { sessionId: currentSessionId, version: currentVersion4 } = current;

          await this.devices.invalidateWebPushTarget(currentSessionId, currentVersion4);
        }
      });
    }

    let next = 0;

    await Promise.all(
      Array.from({ length: Math.min(4, requests.length) }, async (): Promise<void> => {
        while (next < requests.length && Date.now() < job.deadline) {
          const request = requests[next++]!;

          try {
            await request();
          } catch {
            this.skip('provider');
          }
        }
      }),
    );
  }

  private async senderName(userId: string): Promise<string | undefined> {
    try {
      return await this.auth.displayName(userId);
    } catch {
      return undefined;
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    this.unsubscribe();
    this.waiting.length = 0;
    await Promise.allSettled(this.active);
  }
}

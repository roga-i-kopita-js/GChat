import type { OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { Injectable } from '@nestjs/common';

import { DirectCallsDeliveryStore } from '../direct-calls/direct-calls.delivery-store.js';
import { LoggerService } from '../logger/logger.service.js';
import { SignalingGateway } from './signaling.gateway.js';

@Injectable()
export class SignalingWorker implements OnApplicationBootstrap, OnModuleDestroy {
  private timer?: ReturnType<typeof setInterval>;
  private running?: Promise<void>;

  constructor(
    private readonly store: DirectCallsDeliveryStore,
    private readonly gateway: SignalingGateway,
    private readonly logger: LoggerService,
  ) {}

  onApplicationBootstrap(): void {
    this.timer = setInterval((): void => {
      if (this.running) {
        return;
      }

      this.running = (async () => {
        try {
          return await this.tick();
        } catch (cause) {
          this.logger.warn('State delivery deferred');
        } finally {
          this.running = undefined;
        }
      })();
    }, 200);
    this.timer.unref();
  }

  private async tick(): Promise<void> {
    for (const job of await this.store.claim('state')) {
      if (!job.leaseToken || !job.snapshot) {
        continue;
      }

      try {
        await this.gateway.broadcast(job.snapshot);
        await this.store.complete(job.id, job.leaseToken);
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

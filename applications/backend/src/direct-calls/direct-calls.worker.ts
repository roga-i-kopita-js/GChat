import type { OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { Injectable } from '@nestjs/common';

import { LoggerService } from '../logger/logger.service.js';
import { DirectCallsService } from './direct-calls.service.js';

@Injectable()
export class DirectCallsWorker implements OnApplicationBootstrap, OnModuleDestroy {
  private timer?: ReturnType<typeof setInterval>;
  private running?: Promise<void>;
  private cycles = 0;

  constructor(
    private readonly calls: DirectCallsService,
    private readonly logger: LoggerService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.calls.sweep(true, true);
    await this.calls.restoreReservations();
    this.timer = setInterval((): void => {
      if (this.running) return;

      this.running = this.tick()
        .catch((): void => {
          this.logger.warn('Direct calls maintenance failed');
        })
        .finally((): void => {
          this.running = undefined;
        });
    }, 1000);
    this.timer.unref();
  }

  private async tick(): Promise<void> {
    this.cycles++;
    await this.calls.sweep(this.cycles % 5 === 0);

    if (this.cycles % 10 === 0) await this.calls.restoreReservations();

    if (this.cycles % 86400 === 0) await this.calls.cleanup();
  }

  async onModuleDestroy(): Promise<void> {
    clearInterval(this.timer);
    await this.running;
  }
}

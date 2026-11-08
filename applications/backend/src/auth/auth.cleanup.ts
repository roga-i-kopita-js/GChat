import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { sql } from 'drizzle-orm';

import { DatabaseService } from '../database/database.service.js';
import { LoggerService } from '../logger/logger.service.js';
import { RedlockService } from '../redlock/redlock.service.js';

@Injectable()
export class AuthCleanup implements OnModuleDestroy {
  private stopping = false;
  private active?: Promise<void>;

  constructor(
    private readonly database: DatabaseService,
    private readonly locks: RedlockService,
    private readonly logger: LoggerService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE, { waitForCompletion: true })
  async cleanup(): Promise<void> {
    if (this.stopping || this.active) {
      return;
    }

    const task = this.run();

    this.active = task;

    try {
      await task;
    } finally {
      this.active = undefined;
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    await this.active;
  }

  private async run(): Promise<void> {
    try {
      await this.locks.withLock('auth:cleanup', async (context): Promise<void> => {
        // One bounded batch per kind and run. Expiry checks remain authoritative in requests.
        for (const query of [
          sql`delete from gchat_auth_ws_tickets where ticket_hash in (select ticket_hash from gchat_auth_ws_tickets where expires_at <= clock_timestamp() order by expires_at limit 100 for update skip locked)`,
          sql`update gchat_auth_sessions set rotation_request_id=null, rotation_token_hash=null, rotation_encrypted=null, rotation_expires_at=null where id in (select id from gchat_auth_sessions where rotation_expires_at <= clock_timestamp() order by rotation_expires_at limit 100 for update skip locked) and rotation_expires_at <= clock_timestamp()`,
          sql`update gchat_auth_sessions set ws_ticket_window_started_at=null, ws_ticket_count=0 where id in (select id from gchat_auth_sessions where ws_ticket_window_started_at <= clock_timestamp() - interval '60 seconds' order by ws_ticket_window_started_at limit 100 for update skip locked) and ws_ticket_window_started_at <= clock_timestamp() - interval '60 seconds'`,
        ]) {
          if (this.stopping || context.signal.aborted) {
            return;
          }

          context.assertHeld();
          await this.database.db.transaction(async (tx): Promise<void> => {
            context.assertHeld();
            await tx.execute(query);
          });
          context.assertHeld();
        }
      });
    } catch {
      this.logger.warn('Auth cleanup deferred');
    }
  }
}

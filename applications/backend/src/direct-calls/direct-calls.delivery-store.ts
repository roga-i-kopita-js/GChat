import { randomUUID } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { and, eq, lt, or, sql } from 'drizzle-orm';

import { DatabaseService } from '../database/database.service.js';
import type { Delivery } from './direct-calls.schema.js';
import { callDeliveries } from './direct-calls.schema.js';

@Injectable()
export class DirectCallsDeliveryStore {
  constructor(private readonly database: DatabaseService) {}

  async claim(kind: 'state' | 'voip' | 'web_push', limit = 20): Promise<Delivery[]> {
    return this.database.db.transaction(async (tx): Promise<Delivery[]> => {
      const now = new Date();
      const rows = await tx
        .select()
        .from(callDeliveries)
        .where(
          and(
            eq(callDeliveries.kind, kind),
            or(
              and(eq(callDeliveries.status, 'pending'), lt(callDeliveries.nextAttemptAt, now)),
              and(eq(callDeliveries.status, 'processing'), lt(callDeliveries.leaseUntil, now)),
            ),
          ),
        )
        .orderBy(callDeliveries.nextAttemptAt)
        .limit(limit)
        .for('update', { skipLocked: true });
      const result: Delivery[] = [];

      for (const row of rows) {
        if (kind === 'state' && now.getTime() - row.createdAt.getTime() >= 86400000) {
          await tx
            .update(callDeliveries)
            .set({ status: 'cancelled', completedAt: now })
            .where(eq(callDeliveries.id, row.id));

          continue;
        }

        const [claimed] = await tx
          .update(callDeliveries)
          .set({
            status: 'processing',
            leaseToken: randomUUID(),
            leaseUntil: new Date(now.getTime() + 30000),
            attempts: row.attempts + 1,
          })
          .where(eq(callDeliveries.id, row.id))
          .returning();

        result.push(claimed!);
      }

      return result;
    });
  }

  async complete(
    id: string,
    leaseToken: string,
    status: 'done' | 'cancelled' = 'done',
  ): Promise<void> {
    await this.database.db
      .update(callDeliveries)
      .set({ status, completedAt: new Date(), leaseUntil: null })
      .where(
        and(
          eq(callDeliveries.id, id),
          eq(callDeliveries.leaseToken, leaseToken),
          eq(callDeliveries.status, 'processing'),
          sql`${callDeliveries.leaseUntil} > now()`,
        ),
      );
  }

  async retry(
    id: string,
    leaseToken: string,
    attempts: number,
    retryAfterSeconds = 0,
  ): Promise<void> {
    const seconds = Math.max(
      retryAfterSeconds,
      Math.min(30, 2 ** Math.min(5, Math.max(0, attempts - 1))) * (1 + Math.random() * 0.2),
    );

    await this.database.db
      .update(callDeliveries)
      .set({
        status: 'pending',
        leaseUntil: null,
        nextAttemptAt: new Date(Date.now() + seconds * 1000),
      })
      .where(
        and(
          eq(callDeliveries.id, id),
          eq(callDeliveries.leaseToken, leaseToken),
          eq(callDeliveries.status, 'processing'),
          sql`${callDeliveries.leaseUntil} > now()`,
        ),
      );
  }

  async repeatWebPush(id: string, leaseToken: string): Promise<void> {
    await this.database.db
      .update(callDeliveries)
      .set({
        status: 'pending',
        attempts: 0,
        leaseUntil: null,
        nextAttemptAt: new Date(Date.now() + 2500),
      })
      .where(
        and(
          eq(callDeliveries.id, id),
          eq(callDeliveries.kind, 'web_push'),
          eq(callDeliveries.leaseToken, leaseToken),
          eq(callDeliveries.status, 'processing'),
          sql`${callDeliveries.leaseUntil} > now()`,
        ),
      );
  }
}

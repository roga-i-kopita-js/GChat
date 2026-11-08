import { randomUUID } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, eq, isNull, lt, sql } from 'drizzle-orm';

import { AuthService } from '../auth/auth.service.js';
import type { DatabaseTransaction } from '../database/database.service.js';
import { DatabaseService } from '../database/database.service.js';
import { ErrorService } from '../error/error.service.js';
import { apnsTokens, devices, deviceSessions, voipTokens } from './devices.schema.js';
import { webPushSubscriptions } from './web-push.schema.js';
import { validWebPushAddress, type WebPushAddress } from './web-push.validation.js';

export type ApnsTarget = typeof apnsTokens.$inferSelect & { userId: string };

export type VoipTarget = typeof voipTokens.$inferSelect & { userId: string };

@Injectable()
export class DevicesService {
  constructor(
    private readonly database: DatabaseService,
    private readonly auth: AuthService,
    private readonly error: ErrorService,
    private readonly config: ConfigService,
  ) {}

  async lockSessionBinding(
    tx: DatabaseTransaction,
    userId: string,
    sessionId: string,
  ): Promise<{ deviceId: string }> {
    const [binding] = await tx
      .select()
      .from(deviceSessions)
      .where(eq(deviceSessions.sessionId, sessionId))
      .for('share');

    if (!binding || binding.userId !== userId) {
      throw this.error.forbidden();
    }

    const [device] = await tx
      .select()
      .from(devices)
      .where(eq(devices.id, binding.deviceId))
      .for('share');

    if (!device || device.userId !== userId) {
      throw this.error.forbidden();
    }

    return { deviceId: device.id };
  }

  webPushConfig(): { public_key: string | null } {
    return {
      public_key: this.config.get<boolean>('WEB_PUSH_ENABLED', false)
        ? this.config.getOrThrow<string>('WEB_PUSH_PUBLIC_KEY')
        : null,
    };
  }

  async setWebPush(
    userId: string,
    sessionId: string,
    deviceId: string,
    subscription: WebPushAddress | null,
  ): Promise<void> {
    await this.assertBinding(userId, sessionId, deviceId);

    if (subscription && (!this.webPushConfig().public_key || !validWebPushAddress(subscription))) {
      throw this.error.validation();
    }

    await this.database.db.transaction(async (tx): Promise<void> => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${sessionId}, 1))`);

      if (subscription) {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${subscription.endpoint}, 3))`,
        );
        await tx
          .delete(webPushSubscriptions)
          .where(eq(webPushSubscriptions.endpoint, subscription.endpoint));
      }

      await tx.delete(webPushSubscriptions).where(eq(webPushSubscriptions.sessionId, sessionId));

      if (subscription) {
        await tx.insert(webPushSubscriptions).values({ sessionId, deviceId, ...subscription });
      }
    });
  }

  async listWebPushTargets(
    userId: string,
  ): Promise<(typeof webPushSubscriptions.$inferSelect & { userId: string })[]> {
    if (!this.webPushConfig().public_key) {
      return [];
    }

    const rows = await this.database.db
      .select({ address: webPushSubscriptions })
      .from(webPushSubscriptions)
      .innerJoin(deviceSessions, eq(deviceSessions.sessionId, webPushSubscriptions.sessionId))
      .where(eq(deviceSessions.userId, userId));
    const result: (typeof webPushSubscriptions.$inferSelect & { userId: string })[] = [];

    for (const { address } of rows) {
      const access = await this.auth.checkSession(userId, address.sessionId);

      if (access.accountActive && access.sessionActive) {
        result.push({ ...address, userId });
      }
    }

    return result;
  }

  async resolveWebPushTarget(
    deviceId: string,
    sessionId: string,
  ): Promise<(typeof webPushSubscriptions.$inferSelect & { userId: string }) | undefined> {
    const [row] = await this.database.db
      .select({ address: webPushSubscriptions, userId: deviceSessions.userId })
      .from(webPushSubscriptions)
      .innerJoin(deviceSessions, eq(deviceSessions.sessionId, webPushSubscriptions.sessionId))
      .where(
        and(
          eq(webPushSubscriptions.sessionId, sessionId),
          eq(webPushSubscriptions.deviceId, deviceId),
        ),
      );

    if (!row) {
      return undefined;
    }

    const access = await this.auth.checkSession(row.userId, sessionId);

    return access.accountActive && access.sessionActive
      ? { ...row.address, userId: row.userId }
      : undefined;
  }

  async invalidateWebPushTarget(sessionId: string, version: string): Promise<void> {
    await this.database.db
      .delete(webPushSubscriptions)
      .where(
        and(
          eq(webPushSubscriptions.sessionId, sessionId),
          eq(webPushSubscriptions.version, version),
        ),
      );
  }

  async bind(userId: string, sessionId: string, deviceId: string | null): Promise<string> {
    await this.assertAccess(userId, sessionId);

    return this.database.db.transaction(async (tx): Promise<string> => {
      // Serializes first registration, including concurrent device_id:null requests.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${sessionId}, 1))`);
      const [binding] = await tx
        .select()
        .from(deviceSessions)
        .where(eq(deviceSessions.sessionId, sessionId));

      if (binding) {
        if (binding.userId !== userId || (deviceId !== null && deviceId !== binding.deviceId)) {
          throw this.error.forbidden();
        }

        return binding.deviceId;
      }

      const id = deviceId ?? randomUUID();

      if (deviceId) {
        const [device] = await tx
          .select()
          .from(devices)
          .where(and(eq(devices.id, id), eq(devices.userId, userId)))
          .for('share');

        if (!device) {
          throw this.error.notFound();
        }
      } else {
        await tx.insert(devices).values({ id, userId });
      }

      await tx.insert(deviceSessions).values({ sessionId, deviceId: id, userId });

      return id;
    });
  }

  async assertAccess(userId: string, sessionId: string): Promise<void> {
    const access = await this.auth.checkSession(userId, sessionId);

    if (!access.accountActive || !access.sessionActive) {
      throw this.error.sessionInvalid();
    }
  }

  async assertBinding(userId: string, sessionId: string, deviceId: string): Promise<void> {
    await this.assertAccess(userId, sessionId);
    const [row] = await this.database.db
      .select()
      .from(deviceSessions)
      .where(
        and(
          eq(deviceSessions.userId, userId),
          eq(deviceSessions.sessionId, sessionId),
          eq(deviceSessions.deviceId, deviceId),
        ),
      );

    if (!row) {
      throw this.error.forbidden();
    }
  }

  async setPushToken(
    userId: string,
    sessionId: string,
    deviceId: string,
    token: string | null,
    environment: string,
  ): Promise<void> {
    if (environment !== this.config.getOrThrow<string>('APNS_ENVIRONMENT')) {
      throw this.error.validation();
    }

    await this.assertBinding(userId, sessionId, deviceId);
    await this.database.db.transaction(async (tx): Promise<void> => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${sessionId}, 1))`);

      if (token === null) {
        await tx
          .delete(voipTokens)
          .where(and(eq(voipTokens.deviceId, deviceId), eq(voipTokens.sessionId, sessionId)));

        return;
      }

      const normalized = token.toLowerCase();

      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${environment + ':' + normalized}, 2))`,
      );
      await tx
        .delete(voipTokens)
        .where(and(eq(voipTokens.environment, environment), eq(voipTokens.token, normalized)));
      await tx
        .insert(voipTokens)
        .values({ deviceId, sessionId, environment, token: normalized })
        .onConflictDoUpdate({
          target: [voipTokens.deviceId, voipTokens.sessionId],
          set: { environment, token: normalized, version: randomUUID(), updatedAt: new Date() },
        });
    });
  }

  async listVoipTargets(userId: string): Promise<VoipTarget[]> {
    const rows = await this.database.db
      .select({ address: voipTokens, userId: deviceSessions.userId })
      .from(voipTokens)
      .innerJoin(
        deviceSessions,
        and(
          eq(deviceSessions.deviceId, voipTokens.deviceId),
          eq(deviceSessions.sessionId, voipTokens.sessionId),
        ),
      )
      .where(eq(deviceSessions.userId, userId));
    const result: VoipTarget[] = [];

    for (const row of rows) {
      const access = await this.auth.checkSession(userId, row.address.sessionId);

      if (access.accountActive && access.sessionActive) {
        result.push({ ...row.address, userId });
      }
    }

    return result;
  }

  async resolveVoipTarget(deviceId: string, sessionId: string): Promise<VoipTarget | undefined> {
    const [row] = await this.database.db
      .select({ address: voipTokens, userId: deviceSessions.userId })
      .from(voipTokens)
      .innerJoin(deviceSessions, eq(deviceSessions.sessionId, voipTokens.sessionId))
      .where(and(eq(voipTokens.deviceId, deviceId), eq(voipTokens.sessionId, sessionId)));

    if (!row) {
      return undefined;
    }

    const access = await this.auth.checkSession(row.userId, sessionId);

    return access.accountActive && access.sessionActive
      ? { ...row.address, userId: row.userId }
      : undefined;
  }

  async cleanup(retainedSessionIds: Set<string>): Promise<void> {
    const now = new Date();
    const rows = await this.database.db.select().from(deviceSessions);

    for (const row of rows) {
      const access = await this.auth.checkSession(row.userId, row.sessionId);

      if (access.sessionActive) {
        if (row.inactiveSince) {
          await this.database.db
            .update(deviceSessions)
            .set({ inactiveSince: null })
            .where(eq(deviceSessions.sessionId, row.sessionId));
        }
      } else if (!row.inactiveSince) {
        await this.database.db
          .update(deviceSessions)
          .set({ inactiveSince: now })
          .where(
            and(eq(deviceSessions.sessionId, row.sessionId), isNull(deviceSessions.inactiveSince)),
          );
      } else if (
        now.getTime() - row.inactiveSince.getTime() >= 30 * 86400000 &&
        !retainedSessionIds.has(row.sessionId)
      ) {
        await this.database.db
          .delete(deviceSessions)
          .where(eq(deviceSessions.sessionId, row.sessionId));
      }
    }

    await this.database.db
      .delete(devices)
      .where(
        and(
          lt(devices.createdAt, new Date(now.getTime() - 30 * 86400000)),
          sql`not exists (select 1 from ${deviceSessions} where ${deviceSessions.deviceId} = ${devices.id})`,
        ),
      );
  }

  async invalidateVoipTarget(
    deviceId: string,
    version: string,
    providerTimestamp?: number,
  ): Promise<void> {
    await this.database.db
      .delete(voipTokens)
      .where(
        and(
          eq(voipTokens.deviceId, deviceId),
          eq(voipTokens.version, version),
          providerTimestamp === undefined
            ? undefined
            : sql`${voipTokens.updatedAt} <= ${new Date(providerTimestamp)}`,
        ),
      );
  }

  async setApnsToken(
    userId: string,
    sessionId: string,
    deviceId: string,
    token: string | null,
    environment: string,
  ): Promise<void> {
    if (environment !== this.config.getOrThrow<string>('APNS_ENVIRONMENT')) {
      throw this.error.validation();
    }

    await this.assertBinding(userId, sessionId, deviceId);
    await this.database.db.transaction(async (tx): Promise<void> => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${sessionId}, 1))`);

      if (token === null) {
        await tx
          .delete(apnsTokens)
          .where(and(eq(apnsTokens.deviceId, deviceId), eq(apnsTokens.sessionId, sessionId)));

        return;
      }

      const normalized = token.toLowerCase();
      const [existing] = await tx
        .select()
        .from(apnsTokens)
        .where(and(eq(apnsTokens.deviceId, deviceId), eq(apnsTokens.sessionId, sessionId)));

      if (existing?.token === normalized && existing.environment === environment) {
        return;
      }

      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${environment + ':' + normalized}, 2))`,
      );
      await tx
        .delete(apnsTokens)
        .where(and(eq(apnsTokens.environment, environment), eq(apnsTokens.token, normalized)));
      await tx
        .insert(apnsTokens)
        .values({ deviceId, sessionId, environment, token: normalized })
        .onConflictDoUpdate({
          target: [apnsTokens.deviceId, apnsTokens.sessionId],
          set: { environment, token: normalized, version: randomUUID(), updatedAt: new Date() },
        });
    });
  }

  async listApnsTargets(userId: string): Promise<ApnsTarget[]> {
    const rows = await this.database.db
      .select({ address: apnsTokens, userId: deviceSessions.userId })
      .from(apnsTokens)
      .innerJoin(
        deviceSessions,
        and(
          eq(deviceSessions.deviceId, apnsTokens.deviceId),
          eq(deviceSessions.sessionId, apnsTokens.sessionId),
        ),
      )
      .where(eq(deviceSessions.userId, userId));
    const result: ApnsTarget[] = [];

    for (const row of rows) {
      const access = await this.auth.checkSession(userId, row.address.sessionId);

      if (access.accountActive && access.sessionActive) {
        result.push({ ...row.address, userId });
      }
    }

    return result;
  }

  async resolveApnsTarget(deviceId: string, sessionId: string): Promise<ApnsTarget | undefined> {
    const [row] = await this.database.db
      .select({ address: apnsTokens, userId: deviceSessions.userId })
      .from(apnsTokens)
      .innerJoin(deviceSessions, eq(deviceSessions.sessionId, apnsTokens.sessionId))
      .where(and(eq(apnsTokens.deviceId, deviceId), eq(apnsTokens.sessionId, sessionId)));

    if (!row) {
      return undefined;
    }

    const access = await this.auth.checkSession(row.userId, sessionId);

    return access.accountActive && access.sessionActive
      ? { ...row.address, userId: row.userId }
      : undefined;
  }

  async invalidateApnsTarget(
    deviceId: string,
    version: string,
    providerTimestamp?: number,
  ): Promise<void> {
    await this.database.db
      .delete(apnsTokens)
      .where(
        and(
          eq(apnsTokens.deviceId, deviceId),
          eq(apnsTokens.version, version),
          providerTimestamp === undefined
            ? undefined
            : sql`${apnsTokens.updatedAt} <= ${new Date(providerTimestamp)}`,
        ),
      );
  }
}

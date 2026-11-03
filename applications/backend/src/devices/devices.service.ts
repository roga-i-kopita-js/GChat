import { randomUUID } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, eq, isNull, lt, sql } from 'drizzle-orm';

import { AuthService } from '../auth/auth.service.js';
import { DatabaseService } from '../database/database.service.js';
import { ErrorService } from '../error/error.service.js';
import { devices, deviceSessions, voipTokens } from './devices.schema.js';

export type VoipTarget = typeof voipTokens.$inferSelect & { userId: string };

@Injectable()
export class DevicesService {
  constructor(
    private readonly database: DatabaseService,
    private readonly auth: AuthService,
    private readonly error: ErrorService,
    private readonly config: ConfigService,
  ) {}

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
        if (binding.userId !== userId || (deviceId !== null && deviceId !== binding.deviceId))
          throw this.error.forbidden();

        return binding.deviceId;
      }

      const id = deviceId ?? randomUUID();

      if (deviceId) {
        const [device] = await tx
          .select()
          .from(devices)
          .where(and(eq(devices.id, id), eq(devices.userId, userId)))
          .for('share');

        if (!device) throw this.error.notFound();
      } else {
        await tx.insert(devices).values({ id, userId });
      }

      await tx.insert(deviceSessions).values({ sessionId, deviceId: id, userId });

      return id;
    });
  }

  async assertAccess(userId: string, sessionId: string): Promise<void> {
    const access = await this.auth.checkSession(userId, sessionId);

    if (!access.accountActive || !access.sessionActive) throw this.error.sessionInvalid();
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

    if (!row) throw this.error.forbidden();
  }

  async setPushToken(
    userId: string,
    sessionId: string,
    deviceId: string,
    token: string | null,
    environment: string,
  ): Promise<void> {
    if (environment !== this.config.getOrThrow<string>('APNS_ENVIRONMENT'))
      throw this.error.validation();

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

      if (access.accountActive && access.sessionActive) result.push({ ...row.address, userId });
    }

    return result;
  }

  async resolveVoipTarget(deviceId: string, sessionId: string): Promise<VoipTarget | undefined> {
    const [row] = await this.database.db
      .select({ address: voipTokens, userId: deviceSessions.userId })
      .from(voipTokens)
      .innerJoin(deviceSessions, eq(deviceSessions.sessionId, voipTokens.sessionId))
      .where(and(eq(voipTokens.deviceId, deviceId), eq(voipTokens.sessionId, sessionId)));

    if (!row) return undefined;

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
        if (row.inactiveSince)
          await this.database.db
            .update(deviceSessions)
            .set({ inactiveSince: null })
            .where(eq(deviceSessions.sessionId, row.sessionId));
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
}

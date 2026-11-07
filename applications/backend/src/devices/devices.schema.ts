import { sql } from 'drizzle-orm';
import type { AnyPgColumn, PgTableExtraConfigValue } from 'drizzle-orm/pg-core';
import {
  check,
  foreignKey,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

import { users } from '../auth/auth.schema.js';

export const devices = pgTable(
  'gchat_devices',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references((): AnyPgColumn => users.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t): PgTableExtraConfigValue[] => [unique('gchat_devices_owner').on(t.id, t.userId)],
);

export const deviceSessions = pgTable(
  'gchat_device_sessions',
  {
    sessionId: uuid('session_id').primaryKey(),
    inactiveSince: timestamp('inactive_since', { withTimezone: true }),
    deviceId: uuid('device_id').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references((): AnyPgColumn => users.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t): PgTableExtraConfigValue[] => [
    unique('gchat_device_session_pair').on(t.deviceId, t.sessionId),
    foreignKey({
      columns: [t.deviceId, t.userId],
      foreignColumns: [devices.id, devices.userId],
    }).onDelete('cascade'),
  ],
);

export const voipTokens = pgTable(
  'gchat_device_voip_tokens',
  {
    deviceId: uuid('device_id').notNull(),
    sessionId: uuid('session_id').notNull(),
    environment: text('environment').notNull(),
    token: text('token').notNull(),
    version: uuid('version').notNull().defaultRandom(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t): PgTableExtraConfigValue[] => [
    primaryKey({ columns: [t.deviceId, t.sessionId] }),
    foreignKey({
      columns: [t.deviceId, t.sessionId],
      foreignColumns: [deviceSessions.deviceId, deviceSessions.sessionId],
    }).onDelete('cascade'),
    unique('gchat_voip_address').on(t.environment, t.token),
    check('gchat_voip_environment', sql`${t.environment} in ('sandbox', 'production')`),
  ],
);

export const apnsTokens = pgTable(
  'gchat_device_apns_tokens',
  {
    deviceId: uuid('device_id').notNull(),
    sessionId: uuid('session_id').notNull(),
    environment: text('environment').notNull(),
    token: text('token').notNull(),
    version: uuid('version').notNull().defaultRandom(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t): PgTableExtraConfigValue[] => [
    primaryKey({ columns: [t.deviceId, t.sessionId] }),
    foreignKey({
      columns: [t.deviceId, t.sessionId],
      foreignColumns: [deviceSessions.deviceId, deviceSessions.sessionId],
    }).onDelete('cascade'),
    unique('gchat_apns_address').on(t.environment, t.token),
    check('gchat_apns_environment', sql`${t.environment} in ('sandbox', 'production')`),
  ],
);

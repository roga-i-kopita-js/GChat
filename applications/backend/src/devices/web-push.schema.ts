import type { PgTableExtraConfigValue } from 'drizzle-orm/pg-core';
import { foreignKey, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';

import { deviceSessions } from './devices.schema.js';

export const webPushSubscriptions = pgTable(
  'gchat_device_web_push',
  {
    sessionId: uuid('session_id').primaryKey(),
    deviceId: uuid('device_id').notNull(),
    endpoint: text('endpoint').notNull(),
    p256dh: text('p256dh').notNull(),
    auth: text('auth').notNull(),
    version: uuid('version').notNull().defaultRandom(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t): PgTableExtraConfigValue[] => [
    unique('gchat_web_push_endpoint').on(t.endpoint),
    foreignKey({
      columns: [t.deviceId, t.sessionId],
      foreignColumns: [deviceSessions.deviceId, deviceSessions.sessionId],
    }).onDelete('cascade'),
  ],
);

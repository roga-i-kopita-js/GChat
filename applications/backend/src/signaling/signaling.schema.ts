import { sql } from 'drizzle-orm';
import type { PgTableExtraConfigValue } from 'drizzle-orm/pg-core';
import { check, pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core';

// Restrictions apply only to Web messages forwarded through the native bridge.
// Delivered to the native transport by native.bridge_policy.
export const nativeWebsocketRestrictions = pgTable(
  'gchat_native_websocket_restrictions',
  {
    direction: text('direction').notNull(),
    messagePattern: text('message_pattern').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t): PgTableExtraConfigValue[] => [
    primaryKey({ columns: [t.direction, t.messagePattern] }),
    check('gchat_native_ws_direction_check', sql`${t.direction} in ('send', 'receive')`),
    check(
      'gchat_native_ws_pattern_check',
      sql`${t.messagePattern} ~ '^[a-z][a-z0-9_]*([.][a-z][a-z0-9_]*)*([.][*])?$' and length(${t.messagePattern}) <= 128`,
    ),
  ],
);

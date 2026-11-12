import { sql } from 'drizzle-orm';
import type { AnyPgColumn, PgTableExtraConfigValue } from 'drizzle-orm/pg-core';
import { bigint, check, index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

import { users } from '../auth/auth.schema.js';
import type { EndReason } from './direct-calls.dto.js';

/** Durable public metadata; intentionally independent of technical call cleanup. */
export const callHistory = pgTable(
  'gchat_direct_call_history',
  {
    callId: uuid('call_id').primaryKey(),
    callerId: uuid('caller_id')
      .notNull()
      .references((): AnyPgColumn => users.id, { onDelete: 'restrict' }),
    recipientId: uuid('recipient_id')
      .notNull()
      .references((): AnyPgColumn => users.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    endedAt: timestamp('ended_at', { withTimezone: true }).notNull(),
    endReason: text('end_reason').$type<EndReason>().notNull(),
    version: bigint('version', { mode: 'number' }).notNull(),
  },
  (t): PgTableExtraConfigValue[] => [
    check('gchat_call_history_users', sql`${t.callerId} <> ${t.recipientId}`),
    check('gchat_call_history_version', sql`${t.version} between 0 and 9007199254740991`),
    check(
      'gchat_call_history_reason',
      sql`${t.endReason} in ('cancelled','rejected','no_answer','connection_timeout','hangup','connection_lost','session_revoked','account_disabled')`,
    ),
    check(
      'gchat_call_history_times',
      sql`${t.endedAt} >= ${t.createdAt} and (${t.startedAt} is null or (${t.startedAt} >= ${t.createdAt} and ${t.startedAt} <= ${t.endedAt}))`,
    ),
    index('gchat_call_history_caller').on(t.callerId, t.createdAt.desc(), t.callId.desc()),
    index('gchat_call_history_recipient').on(t.recipientId, t.createdAt.desc(), t.callId.desc()),
    index('gchat_call_history_missed')
      .on(t.recipientId, t.createdAt.desc(), t.callId.desc())
      .where(sql`${t.startedAt} is null and ${t.endReason} in ('cancelled','no_answer')`),
  ],
);

export type CallHistoryRecord = typeof callHistory.$inferSelect;

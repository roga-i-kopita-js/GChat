import { sql } from 'drizzle-orm';
import type { AnyPgColumn, PgTableExtraConfigValue } from 'drizzle-orm/pg-core';
import {
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

export const users = pgTable(
  'gchat_users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    login: varchar('login', { length: 32 }).notNull().unique(),
    displayName: varchar('display_name', { length: 80 }).notNull(),
    role: text('role', { enum: ['user', 'admin'] })
      .notNull()
      .default('user'),
    passwordHash: text('password_hash').notNull(),
    disabledAt: timestamp('disabled_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t): PgTableExtraConfigValue[] => [
    check('gchat_users_role_check', sql`${t.role} in ('user', 'admin')`),
  ],
);

export type Account = typeof users.$inferSelect;

export const authSessions = pgTable(
  'gchat_auth_sessions',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references((): AnyPgColumn => users.id, { onDelete: 'cascade' }),
    refreshTokenHash: text('refresh_token_hash').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    rotationRequestId: uuid('rotation_request_id'),
    rotationTokenHash: text('rotation_token_hash'),
    rotationEncrypted: text('rotation_encrypted'),
    rotationExpiresAt: timestamp('rotation_expires_at', { withTimezone: true }),
    wsTicketWindowStartedAt: timestamp('ws_ticket_window_started_at', { withTimezone: true }),
    wsTicketCount: integer('ws_ticket_count').notNull().default(0),
  },
  (t): PgTableExtraConfigValue[] => [
    index('gchat_auth_sessions_user_id_idx').on(t.userId),
    index('gchat_auth_sessions_rotation_expiry_idx')
      .on(t.rotationExpiresAt)
      .where(sql`${t.rotationExpiresAt} is not null`),
    index('gchat_auth_sessions_ticket_window_idx')
      .on(t.wsTicketWindowStartedAt)
      .where(sql`${t.wsTicketWindowStartedAt} is not null`),
    check(
      'gchat_auth_sessions_rotation_check',
      sql`num_nonnulls(${t.rotationRequestId}, ${t.rotationTokenHash}, ${t.rotationEncrypted}, ${t.rotationExpiresAt}) in (0, 4)`,
    ),
    check(
      'gchat_auth_sessions_ticket_window_check',
      sql`(${t.wsTicketWindowStartedAt} is null and ${t.wsTicketCount} = 0) or (${t.wsTicketWindowStartedAt} is not null and ${t.wsTicketCount} > 0)`,
    ),
  ],
);

export const authWsTickets = pgTable(
  'gchat_auth_ws_tickets',
  {
    ticketHash: text('ticket_hash').primaryKey(),
    sessionId: uuid('session_id')
      .notNull()
      .references((): AnyPgColumn => authSessions.id, { onDelete: 'cascade' }),
    origin: text('origin').notNull(),
    issuedAt: timestamp('issued_at', { withTimezone: true }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (t): PgTableExtraConfigValue[] => [
    index('gchat_auth_ws_tickets_session_id_idx').on(t.sessionId),
    index('gchat_auth_ws_tickets_expiry_idx').on(t.expiresAt),
    check('gchat_auth_ws_tickets_expiry_check', sql`${t.expiresAt} > ${t.issuedAt}`),
  ],
);

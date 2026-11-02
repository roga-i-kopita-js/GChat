import { pgTable, text, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';

export const users = pgTable('gchat_users', {
  id: uuid('id').primaryKey().defaultRandom(),
  login: varchar('login', { length: 32 }).notNull().unique(),
  displayName: varchar('display_name', { length: 80 }).notNull(),
  passwordHash: text('password_hash').notNull(),
  disabledAt: timestamp('disabled_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type Account = typeof users.$inferSelect;

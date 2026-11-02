import type { AnyPgColumn, PgTableExtraConfigValue } from 'drizzle-orm/pg-core';
import { index, pgTable, primaryKey, text, uuid } from 'drizzle-orm/pg-core';

import { users } from '../auth/auth.schema.js';

export const groups = pgTable('gchat_groups', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
});

export const groupMembers = pgTable(
  'gchat_group_members',
  {
    groupId: uuid('group_id')
      .notNull()
      .references((): AnyPgColumn => groups.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references((): AnyPgColumn => users.id, { onDelete: 'cascade' }),
  },
  (table): PgTableExtraConfigValue[] => [
    primaryKey({ columns: [table.groupId, table.userId] }),
    index('gchat_group_members_user_id_idx').on(table.userId),
  ],
);

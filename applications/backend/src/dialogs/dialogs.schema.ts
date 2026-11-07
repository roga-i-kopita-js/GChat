import { sql } from 'drizzle-orm';
import type { AnyPgColumn, PgTableExtraConfigValue } from 'drizzle-orm/pg-core';
import {
  bigint,
  check,
  customType,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

import { users } from '../auth/auth.schema.js';
const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: (): string => 'bytea' });

export const dialogs = pgTable(
  'gchat_dialogs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    participantLowId: uuid('participant_low_id')
      .notNull()
      .references((): AnyPgColumn => users.id, { onDelete: 'restrict' }),
    participantHighId: uuid('participant_high_id')
      .notNull()
      .references((): AnyPgColumn => users.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastSequence: bigint('last_sequence', { mode: 'number' }).notNull().default(0),
    lastMessageAt: timestamp('last_message_at', { withTimezone: true }),
    lowRead: bigint('participant_low_last_read_sequence', { mode: 'number' }).notNull().default(0),
    highRead: bigint('participant_high_last_read_sequence', { mode: 'number' })
      .notNull()
      .default(0),
  },
  (t): PgTableExtraConfigValue[] => [
    unique('gchat_dialog_pair').on(t.participantLowId, t.participantHighId),
    check('gchat_dialog_pair_order', sql`${t.participantLowId} < ${t.participantHighId}`),
    check('gchat_dialog_sequence', sql`${t.lastSequence} between 0 and 9007199254740991`),
    check(
      'gchat_dialog_empty',
      sql`(${t.lastSequence} = 0 and ${t.lastMessageAt} is null) or (${t.lastSequence} > 0 and ${t.lastMessageAt} is not null)`,
    ),
    check('gchat_dialog_low_read', sql`${t.lowRead} between 0 and ${t.lastSequence}`),
    check('gchat_dialog_high_read', sql`${t.highRead} between 0 and ${t.lastSequence}`),
    index('gchat_dialog_low_activity').on(
      t.participantLowId,
      sql`coalesce(${t.lastMessageAt}, ${t.createdAt}) desc`,
      t.id.desc(),
    ),
    index('gchat_dialog_high_activity').on(
      t.participantHighId,
      sql`coalesce(${t.lastMessageAt}, ${t.createdAt}) desc`,
      t.id.desc(),
    ),
  ],
);

export const dialogMessages = pgTable(
  'gchat_dialog_messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    dialogId: uuid('dialog_id')
      .notNull()
      .references((): AnyPgColumn => dialogs.id, { onDelete: 'restrict' }),
    senderId: uuid('sender_id')
      .notNull()
      .references((): AnyPgColumn => users.id, { onDelete: 'restrict' }),
    senderDeviceId: uuid('sender_device_id').notNull(),
    clientMessageId: uuid('client_message_id').notNull(),
    sequence: bigint('sequence', { mode: 'number' }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    encryptionVersion: integer('encryption_version').notNull(),
    encryptionKeyId: text('encryption_key_id').notNull(),
    iv: bytea('iv').notNull(),
    ciphertext: bytea('ciphertext').notNull(),
    authTag: bytea('auth_tag').notNull(),
  },
  (t): PgTableExtraConfigValue[] => [
    unique('gchat_dialog_message_sequence').on(t.dialogId, t.sequence),
    unique('gchat_dialog_message_client').on(t.dialogId, t.senderId, t.clientMessageId),
    unique('gchat_dialog_message_iv').on(t.encryptionKeyId, t.iv),
    check('gchat_dialog_message_sequence_range', sql`${t.sequence} between 1 and 9007199254740991`),
    check('gchat_dialog_message_version', sql`${t.encryptionVersion} = 1`),
    check('gchat_dialog_message_key', sql`length(${t.encryptionKeyId}) > 0`),
    check('gchat_dialog_message_iv_size', sql`octet_length(${t.iv}) = 12`),
    check('gchat_dialog_message_cipher_size', sql`octet_length(${t.ciphertext}) > 0`),
    check('gchat_dialog_message_tag_size', sql`octet_length(${t.authTag}) = 16`),
  ],
);

export const dialogEncryptionKeys = pgTable(
  'gchat_dialog_encryption_keys',
  {
    keyId: text('key_id').primaryKey(),
    fingerprint: bytea('key_fingerprint').notNull().unique(),
    attempts: bigint('encryption_attempts', { mode: 'number' }).notNull().default(0),
  },
  (t): PgTableExtraConfigValue[] => [
    check('gchat_dialog_key_id', sql`${t.keyId} ~ '^[A-Za-z0-9_-]{1,64}$'`),
    check('gchat_dialog_key_fingerprint', sql`octet_length(${t.fingerprint}) = 32`),
    check('gchat_dialog_key_attempts', sql`${t.attempts} between 0 and 16777216`),
  ],
);

export type DialogRow = typeof dialogs.$inferSelect;

export type MessageRow = typeof dialogMessages.$inferSelect;

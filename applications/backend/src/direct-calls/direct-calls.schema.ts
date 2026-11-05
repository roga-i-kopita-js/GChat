import { sql } from 'drizzle-orm';
import type { AnyPgColumn, PgTableExtraConfigValue } from 'drizzle-orm/pg-core';
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { users } from '../auth/auth.schema.js';
import { deviceSessions } from '../devices/devices.schema.js';
import type { CallDto, CallState, EndReason } from './direct-calls.dto.js';

export const directCalls = pgTable(
  'gchat_direct_calls',
  {
    id: uuid('id').primaryKey(),
    callerId: uuid('caller_id')
      .notNull()
      .references((): AnyPgColumn => users.id, { onDelete: 'restrict' }),
    recipientId: uuid('recipient_id')
      .notNull()
      .references((): AnyPgColumn => users.id, { onDelete: 'restrict' }),
    state: text('state').$type<CallState>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    endReason: text('end_reason').$type<EndReason>(),
    version: bigint('version', { mode: 'number' }).notNull().default(0),
    ringingDeadline: timestamp('ringing_deadline', { withTimezone: true }),
    connectingStartedAt: timestamp('connecting_started_at', { withTimezone: true }),
    connectingDeadline: timestamp('connecting_deadline', { withTimezone: true }),
    recoveryId: uuid('recovery_id'),
    recoveryStartedAt: timestamp('recovery_started_at', { withTimezone: true }),
    recoveryDeadline: timestamp('recovery_deadline', { withTimezone: true }),
    negotiationId: uuid('negotiation_id'),
  },
  (t): PgTableExtraConfigValue[] => [
    check('gchat_calls_different_users', sql`${t.callerId} <> ${t.recipientId}`),
    check('gchat_calls_state', sql`${t.state} in ('ringing','connecting','active','ended')`),
    check('gchat_calls_version', sql`${t.version} between 0 and 9007199254740991`),
    check(
      'gchat_calls_ended',
      sql`(${t.state} = 'ended') = (${t.endedAt} is not null and ${t.endReason} is not null)`,
    ),
    check(
      'gchat_calls_ended_fields',
      sql`(${t.state} = 'ended') = (${t.endedAt} is not null) and (${t.state} = 'ended') = (${t.endReason} is not null)`,
    ),
    check(
      'gchat_calls_deadlines',
      sql`(${t.state} = 'ringing') = (${t.ringingDeadline} is not null) and (${t.state} = 'connecting') = (${t.connectingDeadline} is not null)`,
    ),
    check(
      'gchat_calls_reason',
      sql`${t.endReason} is null or ${t.endReason} in ('cancelled','rejected','no_answer','connection_timeout','hangup','connection_lost','session_revoked','account_disabled')`,
    ),
    check(
      'gchat_calls_recovery',
      sql`(${t.recoveryId} is null) = (${t.recoveryDeadline} is null) and (${t.recoveryId} is null or ${t.state} = 'active')`,
    ),
    index('gchat_calls_caller').on(t.callerId, t.createdAt),
    index('gchat_calls_recipient').on(t.recipientId, t.createdAt),
    index('gchat_calls_ringing_deadline')
      .on(t.ringingDeadline)
      .where(sql`${t.state} = 'ringing'`),
    index('gchat_calls_connecting_deadline')
      .on(t.connectingDeadline)
      .where(sql`${t.state} = 'connecting'`),
    index('gchat_calls_recovery_deadline')
      .on(t.recoveryDeadline)
      .where(sql`${t.state} = 'active'`),
  ],
);

export const callParticipants = pgTable(
  'gchat_direct_call_participants',
  {
    callId: uuid('call_id')
      .notNull()
      .references((): AnyPgColumn => directCalls.id, { onDelete: 'cascade' }),
    role: text('role').$type<'caller' | 'recipient'>().notNull(),
    userId: uuid('user_id')
      .notNull()
      .references((): AnyPgColumn => users.id, { onDelete: 'restrict' }),
    deviceId: uuid('device_id'),
    sessionId: uuid('session_id'),
    connectedAt: timestamp('connected_at', { withTimezone: true }),
    connectedNegotiationId: uuid('connected_negotiation_id'),
    lastSequence: bigint('last_sequence', { mode: 'number' }).notNull().default(0),
    lastPingAt: timestamp('last_ping_at', { withTimezone: true }),
    audioConnected: boolean('audio_connected').notNull().default(false),
    confirmedRecoveryId: uuid('confirmed_recovery_id'),
    releasedAt: timestamp('released_at', { withTimezone: true }),
  },
  (t): PgTableExtraConfigValue[] => [
    primaryKey({ columns: [t.callId, t.role] }),
    uniqueIndex('gchat_call_participant_busy')
      .on(t.userId)
      .where(sql`${t.releasedAt} is null`),
    index('gchat_call_participant_session').on(t.sessionId),
    foreignKey({
      columns: [t.deviceId, t.sessionId],
      foreignColumns: [deviceSessions.deviceId, deviceSessions.sessionId],
    }),
    check('gchat_call_participant_role', sql`${t.role} in ('caller','recipient')`),
    check(
      'gchat_call_participant_binding',
      sql`(${t.deviceId} is null) = (${t.sessionId} is null)`,
    ),
    check('gchat_call_participant_sequence', sql`${t.lastSequence} between 0 and 9007199254740991`),
  ],
);

export const callDeliveries = pgTable(
  'gchat_direct_call_deliveries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    callId: uuid('call_id')
      .notNull()
      .references((): AnyPgColumn => directCalls.id, { onDelete: 'cascade' }),
    kind: text('kind').$type<'state' | 'voip' | 'web_push'>().notNull(),
    version: bigint('version', { mode: 'number' }).notNull(),
    snapshot: jsonb('snapshot').$type<CallDto>(),
    deviceId: uuid('device_id'),
    sessionId: uuid('session_id'),
    status: text('status')
      .$type<'pending' | 'processing' | 'done' | 'cancelled'>()
      .notNull()
      .default('pending'),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
    leaseToken: uuid('lease_token'),
    leaseUntil: timestamp('lease_until', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (t): PgTableExtraConfigValue[] => [
    uniqueIndex('gchat_delivery_state_version')
      .on(t.callId, t.version)
      .where(sql`${t.kind} = 'state'`),
    uniqueIndex('gchat_delivery_voip_target')
      .on(t.callId, t.deviceId, t.sessionId)
      .where(sql`${t.kind} = 'voip'`),
    uniqueIndex('gchat_delivery_web_push_target')
      .on(t.callId, t.deviceId, t.sessionId)
      .where(sql`${t.kind} = 'web_push'`),
    index('gchat_delivery_pending')
      .on(t.nextAttemptAt)
      .where(sql`${t.status} = 'pending'`),
    index('gchat_delivery_processing')
      .on(t.leaseUntil)
      .where(sql`${t.status} = 'processing'`),
    check('gchat_delivery_kind', sql`${t.kind} in ('state','voip','web_push')`),
    check('gchat_delivery_status', sql`${t.status} in ('pending','processing','done','cancelled')`),
  ],
);

export type CallRecord = typeof directCalls.$inferSelect;

export type Participant = typeof callParticipants.$inferSelect;

export type Delivery = typeof callDeliveries.$inferSelect;

export function callDto(call: CallRecord): CallDto {
  return {
    call_id: call.id,
    state: call.state,
    caller_id: call.callerId,
    recipient_id: call.recipientId,
    created_at: call.createdAt.toISOString(),
    started_at: call.startedAt?.toISOString() ?? null,
    ended_at: call.endedAt?.toISOString() ?? null,
    end_reason: call.endReason,
    recovery_id: call.recoveryId,
    recovery_deadline: call.recoveryDeadline?.toISOString() ?? null,
    ringing_deadline: call.ringingDeadline?.toISOString() ?? null,
    connecting_deadline: call.connectingDeadline?.toISOString() ?? null,
    version: call.version,
  };
}

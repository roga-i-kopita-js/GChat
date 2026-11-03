import { createHmac, randomUUID } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, eq, isNull, lt, ne, or } from 'drizzle-orm';

import { AuthService } from '../auth/auth.service.js';
import type { DatabaseTransaction } from '../database/database.service.js';
import { DevicesService } from '../devices/devices.service.js';
import { AppError } from '../error/app.error.js';
import { ErrorService } from '../error/error.service.js';
import { GroupsService } from '../groups/groups.service.js';
import { LoggerService } from '../logger/logger.service.js';
import type {
  CallActor,
  CallDto,
  CallIceConfigDto,
  CallPingDto,
  CallPingResponseDto,
  EndReason,
} from './direct-calls.dto.js';
import { DirectCallsPresence } from './direct-calls.presence.js';
import { DirectCallsRepository } from './direct-calls.repository.js';
import type { CallRecord, Participant } from './direct-calls.schema.js';
import { callDeliveries, callDto, callParticipants, directCalls } from './direct-calls.schema.js';

type Command = 'get' | 'accept' | 'reject' | 'cancel' | 'end' | 'connected' | 'ping';

@Injectable()
export class DirectCallsService {
  constructor(
    private readonly repository: DirectCallsRepository,
    private readonly auth: AuthService,
    private readonly groups: GroupsService,
    private readonly devices: DevicesService,
    private readonly presence: DirectCallsPresence,
    private readonly config: ConfigService,
    private readonly error: ErrorService,
    private readonly logger: LoggerService,
  ) {}

  private failure(
    code: 'CALL_NOT_ALLOWED' | 'CALLER_BUSY' | 'RECIPIENT_BUSY' | 'CALL_STATE_CONFLICT',
  ): AppError {
    const messages = {
      CALL_NOT_ALLOWED: 'Не удалось позвонить этому пользователю.',
      CALLER_BUSY: 'У вас уже есть незавершённый звонок.',
      RECIPIENT_BUSY: 'Пользователь занят.',
      CALL_STATE_CONFLICT: 'Действие недоступно в текущем состоянии звонка.',
    };

    return this.error.create({
      status: code === 'CALL_NOT_ALLOWED' ? 403 : 409,
      code,
      message: messages[code],
    });
  }

  private timeout(name: string): number {
    return this.config.getOrThrow<number>(name) * 1000;
  }

  async create(actor: CallActor, recipientId: string): Promise<CallDto> {
    await this.devices.assertBinding(actor.userId, actor.sessionId, actor.deviceId);

    if (
      actor.userId === recipientId ||
      !(await this.groups.hasCommonGroup(actor.userId, recipientId))
    )
      throw this.failure('CALL_NOT_ALLOWED');

    const id = randomUUID();
    const userIds = [actor.userId, recipientId];
    // Preliminary account check before exposing recipient busy state.
    const active = await this.repository.transaction((tx): Promise<string[]> =>
      this.auth.lockActiveAccounts(tx, userIds),
    );

    if (!active.includes(recipientId)) throw this.failure('CALL_NOT_ALLOWED');

    if (!active.includes(actor.userId)) throw this.error.sessionInvalid();

    const reserved = await this.presence.reserve(id, userIds);

    if (reserved) throw this.failure(reserved === 1 ? 'CALLER_BUSY' : 'RECIPIENT_BUSY');

    let result: CallDto;

    try {
      result = await this.repository.transaction(async (tx): Promise<CallDto> => {
        const accounts = await this.auth.lockActiveAccounts(tx, userIds);

        if (!accounts.includes(actor.userId)) throw this.error.sessionInvalid();

        if (
          !accounts.includes(recipientId) ||
          !(await this.groups.lockCommonGroup(tx, actor.userId, recipientId))
        )
          throw this.failure('CALL_NOT_ALLOWED');

        await this.repository.lock(tx, id);

        if (!(await this.presence.owns(id, userIds))) throw this.error.serviceUnavailable();

        const busy = await tx
          .select({ userId: callParticipants.userId })
          .from(callParticipants)
          .where(
            and(
              or(
                eq(callParticipants.userId, actor.userId),
                eq(callParticipants.userId, recipientId),
              ),
              isNull(callParticipants.releasedAt),
            ),
          );

        if (busy.length)
          throw this.failure(
            busy.some((p): boolean => p.userId === actor.userId) ? 'CALLER_BUSY' : 'RECIPIENT_BUSY',
          );

        const targets = await this.devices.listVoipTargets(recipientId);

        await this.devices.assertAccess(actor.userId, actor.sessionId);
        const now = new Date();
        const [call] = await tx
          .insert(directCalls)
          .values({
            id,
            callerId: actor.userId,
            recipientId,
            state: 'ringing',
            createdAt: now,
            ringingDeadline: new Date(
              now.getTime() + this.timeout('DIRECT_CALLS_RINGING_TIMEOUT_SECONDS'),
            ),
          })
          .returning();

        await tx.insert(callParticipants).values([
          {
            callId: id,
            role: 'caller',
            userId: actor.userId,
            deviceId: actor.deviceId,
            sessionId: actor.sessionId,
          },
          { callId: id, role: 'recipient', userId: recipientId },
        ]);
        await tx
          .insert(callDeliveries)
          .values({ callId: id, kind: 'state', version: 0, snapshot: callDto(call!) });

        if (targets.length)
          await tx.insert(callDeliveries).values(
            targets.map((target): typeof callDeliveries.$inferInsert => ({
              callId: id,
              kind: 'voip',
              version: 0,
              deviceId: target.deviceId,
              sessionId: target.sessionId,
            })),
          );

        return callDto(call!);
      });
    } catch (cause) {
      // Advisory lock resolves an ambiguous commit before releasing this reservation.
      try {
        const existing = await this.repository.transaction(
          async (tx): Promise<CallRecord | undefined> => {
            await this.repository.lock(tx, id);
            const [row] = await tx.select().from(directCalls).where(eq(directCalls.id, id));

            if (!row) await this.presence.release(id, userIds);

            return row;
          },
        );

        if (existing) result = callDto(existing);
        else {
          const failure =
            cause instanceof Error && cause.cause instanceof Error ? cause.cause : cause;

          if (
            failure &&
            typeof failure === 'object' &&
            'code' in failure &&
            failure.code === '23505'
          ) {
            const callerBusy = await this.repository.db
              .select()
              .from(callParticipants)
              .where(
                and(eq(callParticipants.userId, actor.userId), isNull(callParticipants.releasedAt)),
              );

            throw this.failure(callerBusy.length ? 'CALLER_BUSY' : 'RECIPIENT_BUSY');
          }

          throw cause;
        }
      } catch (resolution) {
        if (resolution instanceof AppError) throw resolution;

        throw this.error.serviceUnavailable();
      }
    }

    // A post-commit access failure is not a rollback or permission to repeat create.
    try {
      await this.maintain(id, true);
    } catch {
      this.logger.warn('Call post-commit access check deferred', { callId: id });
    }

    return result;
  }

  get(actor: CallActor, id: string): Promise<CallDto> {
    return this.command(actor, id, 'get');
  }

  accept(actor: CallActor, id: string): Promise<CallDto> {
    return this.command(actor, id, 'accept');
  }

  reject(actor: CallActor, id: string): Promise<CallDto> {
    return this.command(actor, id, 'reject');
  }

  cancel(actor: CallActor, id: string): Promise<CallDto> {
    return this.command(actor, id, 'cancel');
  }

  end(actor: CallActor, id: string): Promise<CallDto> {
    return this.command(actor, id, 'end');
  }

  connected(actor: CallActor, id: string, negotiationId: string): Promise<CallDto> {
    return this.command(actor, id, 'connected', undefined, negotiationId);
  }

  async current(actor: CallActor): Promise<CallDto | null> {
    await this.devices.assertBinding(actor.userId, actor.sessionId, actor.deviceId);
    const [row] = await this.repository.db
      .select({ id: callParticipants.callId })
      .from(callParticipants)
      .where(and(eq(callParticipants.userId, actor.userId), isNull(callParticipants.releasedAt)));

    if (!row) return null;

    const call = await this.get(actor, row.id);

    return call.state === 'ended' ? null : call;
  }

  async ping(actor: CallActor, input: CallPingDto): Promise<CallPingResponseDto> {
    const call = await this.command(actor, input.call_id, 'ping', input);

    return {
      state: call.state,
      version: call.version,
      recovery_id: call.recovery_id,
      recovery_deadline: call.recovery_deadline,
    };
  }

  async iceConfig(actor: CallActor, id: string): Promise<CallIceConfigDto> {
    await this.withSelectedPeer(actor, id, async (): Promise<void> => {});
    const expires = Math.floor(Date.now() / 1000) + 3600;
    const username = `${expires}:${id}:${actor.userId}`;
    const credential = createHmac(
      'sha1',
      this.config.getOrThrow<string>('DIRECT_CALLS_TURN_SHARED_SECRET'),
    )
      .update(username)
      .digest('base64');

    return {
      ice_servers: [
        { urls: this.config.getOrThrow<string[]>('DIRECT_CALLS_TURN_URLS'), username, credential },
      ],
      expires_at: new Date(expires * 1000).toISOString(),
    };
  }

  async withSelectedPeer<T>(
    actor: CallActor,
    id: string,
    callback: (
      tx: DatabaseTransaction,
      call: CallRecord,
      peer: Participant,
      isCaller: boolean,
    ) => Promise<T>,
  ): Promise<T> {
    await this.devices.assertBinding(actor.userId, actor.sessionId, actor.deviceId);
    const result = await this.locked(
      id,
      async (tx, call, participants): Promise<{ value?: T; failure?: AppError }> => {
        this.authorize(actor, call, participants, 'ping');

        if (call.state !== 'connecting' && call.state !== 'active')
          return { failure: this.failure('CALL_STATE_CONFLICT') };

        const peer = participants.find((p): boolean => p.userId !== actor.userId)!;

        return { value: await callback(tx, call, peer, actor.userId === call.callerId) };
      },
      actor,
    );

    if (result.failure) throw result.failure;

    return result.value!;
  }

  async registerNegotiation(tx: DatabaseTransaction, call: CallRecord, id: string): Promise<void> {
    if (call.negotiationId === id) return;

    call.negotiationId = id;
    await tx.update(directCalls).set({ negotiationId: id }).where(eq(directCalls.id, call.id));

    if (call.state === 'connecting')
      await tx
        .update(callParticipants)
        .set({ connectedAt: null, connectedNegotiationId: null })
        .where(eq(callParticipants.callId, call.id));
  }

  private authorize(
    actor: CallActor,
    call: CallRecord,
    participants: Participant[],
    command: Command,
  ): Participant {
    const participant = participants.find((p): boolean => p.userId === actor.userId);

    if (!participant) throw this.error.notFound();

    if (command === 'get') return participant;

    if (
      command === 'reject' &&
      participant.role === 'recipient' &&
      (call.state === 'ringing' || call.state === 'ended')
    )
      return participant;

    if (
      command === 'accept' &&
      participant.role === 'recipient' &&
      (call.state === 'ringing' || participant.deviceId === null)
    )
      return participant;

    if (participant.deviceId !== actor.deviceId || participant.sessionId !== actor.sessionId)
      throw this.error.forbidden();

    if ((command === 'accept' || command === 'reject') && participant.role !== 'recipient')
      throw this.error.forbidden();

    if (command === 'cancel' && participant.role !== 'caller') throw this.error.forbidden();

    return participant;
  }

  private async command(
    actor: CallActor,
    id: string,
    command: Command,
    ping?: CallPingDto,
    negotiationId?: string,
  ): Promise<CallDto> {
    await this.devices.assertBinding(actor.userId, actor.sessionId, actor.deviceId);
    const result = await this.locked(
      id,
      async (tx, call, participants): Promise<{ call: CallRecord; failure?: AppError }> => {
        const me = this.authorize(actor, call, participants, command);
        const now = new Date();
        let failure: AppError | undefined;

        switch (command) {
          case 'get':
            break;
          case 'accept':
            if (call.state === 'ringing') {
              call.state = 'connecting';
              call.ringingDeadline = null;
              call.connectingStartedAt = now;
              call.connectingDeadline = new Date(
                now.getTime() + this.timeout('DIRECT_CALLS_CONNECTING_TIMEOUT_SECONDS'),
              );
              await tx
                .update(callParticipants)
                .set({ deviceId: actor.deviceId, sessionId: actor.sessionId })
                .where(
                  and(eq(callParticipants.callId, id), eq(callParticipants.role, 'recipient')),
                );
              await this.devices.assertAccess(actor.userId, actor.sessionId);
            } else if (call.state === 'ended') failure = this.failure('CALL_STATE_CONFLICT');

            break;
          case 'reject':
          case 'cancel':
          case 'end':
            if (call.state === 'ended') break;

            if ((command === 'end') === (call.state === 'ringing')) {
              failure = this.failure('CALL_STATE_CONFLICT');
              break;
            }

            this.finish(
              call,
              command === 'end' ? 'hangup' : command === 'reject' ? 'rejected' : 'cancelled',
              now,
            );
            break;
          case 'connected':
            if (
              !negotiationId ||
              call.negotiationId !== negotiationId ||
              (call.state !== 'connecting' && call.state !== 'active')
            ) {
              failure = this.failure('CALL_STATE_CONFLICT');
              break;
            }

            if (call.state === 'active') break;

            if (!me.connectedAt) {
              me.connectedAt = now;
              me.connectedNegotiationId = negotiationId;
              await tx
                .update(callParticipants)
                .set({ connectedAt: now, connectedNegotiationId: negotiationId })
                .where(and(eq(callParticipants.callId, id), eq(callParticipants.role, me.role)));
            }

            if (
              participants.every(
                (p): boolean => !!p.connectedAt && p.connectedNegotiationId === negotiationId,
              )
            ) {
              call.state = 'active';
              call.startedAt = now;
              call.connectingDeadline = null;
            }

            break;
          case 'ping':
            if (!ping || (call.state !== 'connecting' && call.state !== 'active')) {
              failure = this.failure('CALL_STATE_CONFLICT');
              break;
            }

            if (ping.sequence <= me.lastSequence) break;

            me.lastSequence = ping.sequence;
            me.lastPingAt = now;
            me.audioConnected = ping.audio_connected;

            if (call.state === 'active') {
              if (!ping.audio_connected && !call.recoveryId)
                await this.openRecovery(tx, call, participants, now);

              if (call.recoveryId) {
                me.confirmedRecoveryId =
                  ping.audio_connected && ping.recovery_id === call.recoveryId
                    ? call.recoveryId
                    : null;

                if (participants.every((p): boolean => p.confirmedRecoveryId === call.recoveryId)) {
                  call.recoveryId = null;
                  call.recoveryDeadline = null;
                  call.recoveryStartedAt = null;
                }
              }
            }

            await tx
              .update(callParticipants)
              .set({
                lastSequence: me.lastSequence,
                lastPingAt: now,
                audioConnected: me.audioConnected,
                confirmedRecoveryId: me.confirmedRecoveryId,
              })
              .where(and(eq(callParticipants.callId, id), eq(callParticipants.role, me.role)));
            break;
        }

        return { call, failure };
      },
      actor,
    );

    if (result.failure) throw result.failure;

    return callDto(result.call);
  }

  private finish(call: CallRecord, reason: EndReason, now: Date): void {
    if (call.state === 'ended') return;

    call.state = 'ended';
    call.endedAt = now;
    call.endReason = reason;
    call.ringingDeadline = null;
    call.connectingDeadline = null;
    call.recoveryId = null;
    call.recoveryDeadline = null;
    call.recoveryStartedAt = null;
  }

  private async openRecovery(
    tx: DatabaseTransaction,
    call: CallRecord,
    participants: Participant[],
    now: Date,
  ): Promise<void> {
    call.recoveryId = randomUUID();
    call.recoveryStartedAt = now;
    call.recoveryDeadline = new Date(
      now.getTime() + this.timeout('DIRECT_CALLS_RECONNECT_TIMEOUT_SECONDS'),
    );

    for (const p of participants) p.confirmedRecoveryId = null;

    await tx
      .update(callParticipants)
      .set({ confirmedRecoveryId: null })
      .where(eq(callParticipants.callId, call.id));
  }

  private async reconcile(
    tx: DatabaseTransaction,
    call: CallRecord,
    participants: Participant[],
    checkAuth: boolean,
  ): Promise<void> {
    if (call.state === 'ended') return;

    const now = new Date();

    if (checkAuth) {
      let disabled = false;
      let revoked = false;

      for (const p of participants) {
        const access = await this.auth.checkSession(
          p.userId,
          p.sessionId ?? '00000000-0000-0000-0000-000000000000',
        );

        disabled ||= !access.accountActive;
        revoked ||= !!p.sessionId && !access.sessionActive;
      }

      if (disabled || revoked) {
        this.finish(call, disabled ? 'account_disabled' : 'session_revoked', now);

        return;
      }
    }

    if (call.ringingDeadline && call.ringingDeadline <= now) this.finish(call, 'no_answer', now);
    else if (call.connectingDeadline && call.connectingDeadline <= now)
      this.finish(call, 'connection_timeout', now);
    else if (call.recoveryDeadline && call.recoveryDeadline <= now)
      this.finish(call, 'connection_lost', now);
    else if (
      call.state === 'active' &&
      !call.recoveryId &&
      participants.some(
        (p): boolean =>
          now.getTime() - (p.lastPingAt ?? call.connectingStartedAt ?? call.createdAt).getTime() >=
          this.timeout('DIRECT_CALLS_HEARTBEAT_TIMEOUT_SECONDS'),
      )
    )
      await this.openRecovery(tx, call, participants, now);
  }

  private async locked<T>(
    id: string,
    callback: (
      tx: DatabaseTransaction,
      call: CallRecord,
      participants: Participant[],
    ) => Promise<T>,
    actor?: CallActor,
    checkAuth = true,
  ): Promise<T> {
    const result = await this.repository.transaction(
      async (tx): Promise<{ value: T; call: CallRecord; participants: Participant[] }> => {
        const [initial] = await tx.select().from(directCalls).where(eq(directCalls.id, id));

        if (
          !initial ||
          (actor && initial.callerId !== actor.userId && initial.recipientId !== actor.userId)
        )
          throw this.error.notFound();

        await this.auth.lockActiveAccounts(tx, [initial.callerId, initial.recipientId]);
        const [call] = await tx
          .select()
          .from(directCalls)
          .where(eq(directCalls.id, id))
          .for('update');

        if (!call) throw this.error.notFound();

        const participants = await tx
          .select()
          .from(callParticipants)
          .where(eq(callParticipants.callId, id))
          .orderBy(callParticipants.role)
          .for('update');
        const before = JSON.stringify(callDto(call));

        await this.reconcile(tx, call, participants, checkAuth);
        const value = await callback(tx, call, participants);

        await this.repository.save(tx, call, before);

        return { value, call, participants };
      },
    );

    try {
      if (result.call.state === 'ended')
        await this.presence.release(id, [result.call.callerId, result.call.recipientId]);
      else for (const p of result.participants) await this.presence.project(p, result.call.version);
    } catch {
      this.logger.warn('Call Redis projection deferred', { callId: id });
    }

    return result.value;
  }

  async maintain(id: string, checkAuth: boolean): Promise<void> {
    await this.locked(id, async (): Promise<void> => {}, undefined, checkAuth);
  }

  async sweep(checkAuth: boolean, strict = false): Promise<void> {
    const rows = await this.repository.db
      .select({ id: directCalls.id })
      .from(directCalls)
      .where(ne(directCalls.state, 'ended'));

    for (const row of rows) {
      try {
        await this.maintain(row.id, checkAuth);
      } catch (cause) {
        if (strict) throw cause;

        this.logger.warn('Call maintenance deferred', { callId: row.id });
      }
    }
  }

  async restoreReservations(): Promise<void> {
    const rows = await this.repository.db
      .select()
      .from(directCalls)
      .where(ne(directCalls.state, 'ended'));

    for (const call of rows) {
      const userIds = [call.callerId, call.recipientId];
      const reservations = await this.presence.read(userIds);

      for (const foreign of new Set(reservations)) {
        if (!foreign || foreign === call.id) continue;

        await this.repository.transaction(async (tx): Promise<void> => {
          await this.repository.lock(tx, foreign);
          const [owner] = await tx
            .select()
            .from(directCalls)
            .where(eq(directCalls.id, foreign))
            .for('update');

          if (!owner || owner.state === 'ended') await this.presence.release(foreign, userIds);
        });
      }

      await this.repository.transaction(async (tx): Promise<void> => {
        await this.repository.lock(tx, call.id);
        const [current] = await tx
          .select()
          .from(directCalls)
          .where(eq(directCalls.id, call.id))
          .for('update');

        if (current?.state === 'ended' || !current)
          await this.presence.release(call.id, [call.callerId, call.recipientId]);
        else await this.presence.reserve(call.id, [call.callerId, call.recipientId]);
      });
    }
  }

  async cleanup(): Promise<void> {
    await this.repository.db
      .delete(directCalls)
      .where(
        and(
          eq(directCalls.state, 'ended'),
          lt(directCalls.endedAt, new Date(Date.now() - 30 * 86400000)),
        ),
      );
    const retained = await this.repository.db
      .select({ sessionId: callParticipants.sessionId })
      .from(callParticipants);

    await this.devices.cleanup(
      new Set(retained.flatMap((row): string[] => (row.sessionId ? [row.sessionId] : []))),
    );
  }
}

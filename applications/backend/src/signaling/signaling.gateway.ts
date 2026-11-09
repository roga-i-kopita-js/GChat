import { createHash } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

import type { OnModuleDestroy } from '@nestjs/common';
import { ValidationPipe } from '@nestjs/common';
import { WebSocketGateway } from '@nestjs/websockets';
import type { RawData } from 'ws';
import { WebSocket } from 'ws';

import { AuthService } from '../auth/auth.service.js';
import { isDatabaseUnavailable } from '../database/database.errors.js';
import { DevicesService } from '../devices/devices.service.js';
import { type DialogNotice, DialogsEvents } from '../dialogs/dialogs.events.js';
import { DialogsService } from '../dialogs/dialogs.service.js';
import type { CallActor, CallDto } from '../direct-calls/direct-calls.dto.js';
import {
  CallConnectedDto,
  CallCreateDto,
  CallIdDto,
  CallPingDto,
} from '../direct-calls/direct-calls.dto.js';
import { DirectCallsService } from '../direct-calls/direct-calls.service.js';
import { AppError } from '../error/app.error.js';
import { ErrorService } from '../error/error.service.js';
import { NativeWebsocketPolicyService } from './native-websocket-policy.service.js';
import { wsIdentities } from './signaling.adapter.js';
import {
  ApnsTokenDto,
  EmptyDto,
  PushTokenDto,
  RegisterDeviceDto,
  RtcIceDto,
  RtcSdpDto,
  WebPushDto,
  WsRequestDto,
} from './signaling.dto.js';

interface Connection {
  socket: WebSocket;
  userId: string;
  sessionId: string;
  deviceId?: string;
  registration: ReturnType<typeof setTimeout>;
  queue: Promise<void>;
  pending: number;
  closed: boolean;
}
interface Negotiation {
  id: string;
  offerHash: string;
  answerHash?: string;
}

@WebSocketGateway({ path: '/ws' })
export class SignalingGateway implements OnModuleDestroy {
  private readonly connections = new Set<Connection>();
  private negotiationQueue: Promise<void> = Promise.resolve();
  private readonly negotiations = new Map<string, Negotiation>();
  private readonly pipe: ValidationPipe;
  private timer?: ReturnType<typeof setInterval>;
  private checking?: Promise<void>;
  private readonly unsubscribeDialogs: () => void;

  constructor(
    private readonly auth: AuthService,
    private readonly devices: DevicesService,
    private readonly calls: DirectCallsService,
    private readonly error: ErrorService,
    private readonly nativePolicy: NativeWebsocketPolicyService,
    private readonly dialogs: DialogsService,
    events: DialogsEvents,
  ) {
    this.unsubscribeDialogs = events.subscribe((notice): Promise<void> =>
      this.broadcastDialog(notice),
    );
    this.pipe = new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
      exceptionFactory: (): AppError => this.error.validation(),
    });
  }

  handleConnection(socket: WebSocket, request: IncomingMessage): void {
    const identity = wsIdentities.get(request);

    if (!identity) {
      socket.close(1008);

      return;
    }

    const connection: Connection = {
      socket,
      userId: identity.userId,
      sessionId: identity.sessionId,
      queue: Promise.resolve(),
      pending: 0,
      closed: false,
      registration: setTimeout((): void => {
        socket.close(1008);
      }, 10000),
    };

    this.connections.add(connection);
    socket.on('close', (): void => {
      connection.closed = true;
      clearTimeout(connection.registration);
      this.connections.delete(connection);
    });
    socket.on('error', (): void => {
      socket.close(1011);
    });
    socket.on('message', (data: RawData, binary: boolean): void => {
      if (binary) {
        socket.close(1003);

        return;
      }

      if (++connection.pending > 128) {
        socket.close(1011);

        return;
      }

      connection.queue = (async () => {
        try {
          await connection.queue;

          if (!connection.closed && socket.readyState === WebSocket.OPEN) {
            await this.receive(connection, data.toString());
          }
        } catch (cause) {
          socket.close(1011);
        } finally {
          connection.pending--;
        }
      })();
    });

    if (!this.timer) {
      this.timer = setInterval((): void => {
        if (this.checking) {
          return;
        }

        this.checking = (async () => {
          try {
            return await this.checkConnections();
          } finally {
            this.checking = undefined;
          }
        })();
      }, 5000);
      this.timer.unref();
    }
  }

  private async validate<T extends object>(value: unknown, metatype: new () => T): Promise<T> {
    const dto: T = await this.pipe.transform(value, { type: 'body', metatype });

    return dto;
  }

  private async access(connection: Connection): Promise<void> {
    const access = await this.auth.checkSession(connection.userId, connection.sessionId);

    const { accountActive: accessAccountActive, sessionActive: accessSessionActive } = access ?? {};

    if (!accessAccountActive || !accessSessionActive) {
      throw this.error.sessionInvalid();
    }
  }

  private actor(connection: Connection): CallActor {
    if (!connection.deviceId) {
      throw this.error.forbidden();
    }

    return {
      userId: connection.userId,
      sessionId: connection.sessionId,
      deviceId: connection.deviceId,
    };
  }

  private async receive(connection: Connection, raw: string): Promise<void> {
    let parsed: unknown;

    try {
      parsed = JSON.parse(raw);
    } catch {
      connection.socket.close(1008);

      return;
    }

    if (
      !parsed ||
      typeof parsed !== 'object' ||
      !('request_id' in parsed) ||
      typeof parsed.request_id !== 'string' ||
      parsed.request_id.length < 1 ||
      parsed.request_id.length > 128
    ) {
      connection.socket.close(1008);

      return;
    }

    const requestId = parsed.request_id;

    try {
      await this.access(connection);
      const request = await this.validate(parsed, WsRequestDto);
      const payload = await this.dispatch(connection, request);

      this.send(connection, { type: 'response', request_id: requestId, payload });
    } catch (cause) {
      let failureValue;

      if (cause instanceof AppError) {
        failureValue = cause;
      } else if (isDatabaseUnavailable(cause)) {
        failureValue = this.error.serviceUnavailable();
      } else {
        failureValue = this.error.internal();
      }

      const failure = failureValue;

      this.send(connection, {
        type: 'response',
        request_id: requestId,
        error: {
          code: failure.code,
          message: failure.message,
          ...(failure.fields ? { fields: failure.fields } : {}),
        },
      });

      if (failure.code === 'SESSION_INVALID') {
        connection.socket.close(1008);
      } else if (failure.code === 'SERVICE_UNAVAILABLE' || failure.code === 'INTERNAL_ERROR') {
        connection.socket.close(1011);
      }
    }
  }

  private async dispatch(connection: Connection, request: WsRequestDto): Promise<object> {
    const { type, payload } = request;

    if (type === 'device.register') {
      const { device_id: inputDeviceId } = await this.validate(payload, RegisterDeviceDto);
      const deviceId = await this.devices.bind(
        connection.userId,
        connection.sessionId,
        inputDeviceId,
      );

      for (const old of this.connections) {
        if (
          old !== connection &&
          old.sessionId === connection.sessionId &&
          old.deviceId === deviceId
        ) {
          old.closed = true;
          old.socket.close(1008);
        }
      }

      connection.deviceId = deviceId;
      clearTimeout(connection.registration);

      return { device_id: deviceId };
    }

    const actor = this.actor(connection);

    if (type === 'native.bridge_policy') {
      await this.validate(payload, EmptyDto);

      return this.nativePolicy.read();
    }

    if (type === 'device.web_push_config') {
      await this.validate(payload, EmptyDto);

      return this.devices.webPushConfig();
    }

    if (type === 'device.web_push') {
      const { subscription: inputSubscription } = await this.validate(payload, WebPushDto);

      await this.devices.setWebPush(
        actor.userId,
        actor.sessionId,
        actor.deviceId,
        inputSubscription,
      );

      return {};
    }

    if (type === 'device.apns_token') {
      const { token: inputToken, environment: inputEnvironment } = await this.validate(
        payload,
        ApnsTokenDto,
      );

      await this.devices.setApnsToken(
        actor.userId,
        actor.sessionId,
        actor.deviceId,
        inputToken,
        inputEnvironment,
      );

      return {};
    }

    if (type === 'device.push_token') {
      const { voip_token: inputVoipToken, environment: inputEnvironment2 } = await this.validate(
        payload,
        PushTokenDto,
      );

      await this.devices.setPushToken(
        actor.userId,
        actor.sessionId,
        actor.deviceId,
        inputVoipToken,
        inputEnvironment2,
      );

      return {};
    }

    if (type === 'call.create') {
      const { recipient_id: inputRecipientId } = await this.validate(payload, CallCreateDto);
      const callValue = await this.calls.create(actor, inputRecipientId);

      return { call: callValue };
    }

    if (type === 'call.current') {
      await this.validate(payload, EmptyDto);

      const callValue2 = await this.calls.current(actor);

      return { call: callValue2 };
    }

    if (type === 'call.ping') {
      return this.calls.ping(actor, await this.validate(payload, CallPingDto));
    }

    if (type === 'call.connected') {
      const input = await this.validate(payload, CallConnectedDto);

      return this.serializeNegotiation(async (): Promise<object> => {
        const { call_id: inputCallId, negotiation_id: inputNegotiationId } = input;

        if (this.negotiations.get(inputCallId)?.id !== inputNegotiationId) {
          throw this.conflict();
        }

        const { call_id: inputCallId2, negotiation_id: inputNegotiationId2 } = input;
        const callValue3 = await this.calls.connected(actor, inputCallId2, inputNegotiationId2);

        return { call: callValue3 };
      });
    }

    if (type.startsWith('rtc.')) {
      await this.serializeNegotiation((): Promise<void> => this.rtc(actor, type, payload));

      return {};
    }

    const input = await this.validate(payload, CallIdDto);

    switch (type) {
      case 'call.get':
        const { call_id: inputCallId3 } = input;
        const callValue4 = await this.calls.get(actor, inputCallId3);

        return { call: callValue4 };
      case 'call.accept':
        const { call_id: inputCallId4 } = input;
        const callValue5 = await this.calls.accept(actor, inputCallId4);

        return { call: callValue5 };
      case 'call.reject':
        const { call_id: inputCallId5 } = input;
        const callValue6 = await this.calls.reject(actor, inputCallId5);

        return { call: callValue6 };
      case 'call.cancel':
        const { call_id: inputCallId6 } = input;
        const callValue7 = await this.calls.cancel(actor, inputCallId6);

        return { call: callValue7 };
      case 'call.end':
        const { call_id: inputCallId7 } = input;
        const callValue8 = await this.calls.end(actor, inputCallId7);

        return { call: callValue8 };
      case 'call.ice_config':
        const { call_id: inputCallId8 } = input;

        return this.calls.iceConfig(actor, inputCallId8);
      default:
        throw this.error.validation();
    }
  }

  private serializeNegotiation<T>(action: () => Promise<T>): Promise<T> {
    const result = (async () => {
      await this.negotiationQueue;

      return action();
    })();

    this.negotiationQueue = (async () => {
      try {
        await result;
      } catch (rejectedCause) {}
    })();

    return result;
  }

  private conflict(): AppError {
    return this.error.create({
      status: 409,
      code: 'CALL_STATE_CONFLICT',
      message: 'Действие недоступно в текущем состоянии звонка.',
    });
  }

  private async rtc(
    actor: CallActor,
    type: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    let inputValue;

    if (type === 'rtc.offer' || type === 'rtc.answer') {
      inputValue = await this.validate(payload, RtcSdpDto);
    } else if (type === 'rtc.ice') {
      inputValue = await this.validate(payload, RtcIceDto);
    } else if (type === 'rtc.restart') {
      inputValue = await this.validate(payload, CallIdDto);
    } else {
      inputValue = undefined;
    }

    const input = inputValue;

    if (!input) {
      throw this.error.validation();
    }

    let next: Negotiation | undefined;
    let destination: Connection | undefined;

    await this.calls.withSelectedPeer(
      actor,
      input.call_id,
      async (tx, call, peer, isCaller): Promise<void> => {
        destination = [...this.connections].find(
          (c): boolean =>
            !c.closed &&
            c.socket.readyState === WebSocket.OPEN &&
            c.deviceId === peer.deviceId &&
            c.sessionId === peer.sessionId,
        );

        if (!destination) {
          throw this.error.serviceUnavailable();
        }

        await this.access(destination);
        const current = this.negotiations.get(call.id);

        if (type === 'rtc.restart') {
          if (isCaller) {
            throw this.error.forbidden();
          }
        } else if (input instanceof RtcSdpDto) {
          if (
            Buffer.byteLength(input.sdp) > 65536 ||
            /(?:^|\r?\n)m=(?!audio\s)/.test(input.sdp) ||
            !/(?:^|\r?\n)m=audio\s/.test(input.sdp)
          ) {
            throw this.error.validation();
          }

          const hash = createHash('sha256').update(input.sdp).digest('hex');

          if (type === 'rtc.offer') {
            if (!isCaller) {
              throw this.error.forbidden();
            }

            if (!current && call.negotiationId === input.negotiation_id) {
              throw this.conflict();
            }

            if (current?.id === input.negotiation_id && current.offerHash !== hash) {
              throw this.conflict();
            }

            await this.calls.registerNegotiation(tx, call, input.negotiation_id);
            next =
              current?.id === input.negotiation_id
                ? current
                : { id: input.negotiation_id, offerHash: hash };
          } else {
            if (isCaller) {
              throw this.error.forbidden();
            }

            if (
              current?.id !== input.negotiation_id ||
              (current.answerHash && current.answerHash !== hash)
            ) {
              throw this.conflict();
            }

            next = { ...current, answerHash: hash };
          }
        } else if (input instanceof RtcIceDto) {
          if (current?.id !== input.negotiation_id) {
            throw this.conflict();
          }

          if (
            input.candidate &&
            (Buffer.byteLength(input.candidate.candidate) > 4096 ||
              (input.candidate.sdp_mid === null && input.candidate.sdp_mline_index === null))
          ) {
            throw this.error.validation();
          }
        }
      },
    );

    if (next) {
      this.negotiations.set(input.call_id, next);
    }

    if (destination) {
      this.send(destination, { type, payload });
    }
  }

  private send(connection: Connection, message: object): void {
    if (connection.closed || connection.socket.readyState !== WebSocket.OPEN) {
      return;
    }

    const encoded = JSON.stringify(message);

    if (connection.socket.bufferedAmount + Buffer.byteLength(encoded) > 1048576) {
      connection.socket.close(1011);

      return;
    }

    connection.socket.send(encoded, (cause?: Error): void => {
      if (cause) {
        connection.socket.close(1011);
      }
    });
  }

  private async broadcastDialog(notice: DialogNotice): Promise<void> {
    for (const connection of this.connections) {
      if (!connection.deviceId || !notice.users.includes(connection.userId)) {
        continue;
      }

      if (
        await this.dialogs.canDeliver(
          connection.userId,
          connection.sessionId,
          connection.deviceId,
          notice.event.payload.dialog_id,
        )
      ) {
        this.send(connection, notice.event);
      }
    }
  }

  async broadcast(call: CallDto): Promise<void> {
    if (call.state === 'ended') {
      this.negotiations.delete(call.call_id);
    }

    for (const connection of this.connections) {
      if (
        !connection.deviceId ||
        (connection.userId !== call.caller_id && connection.userId !== call.recipient_id)
      ) {
        continue;
      }

      try {
        await this.access(connection);
        this.send(connection, { type: 'call.updated', payload: { call } });
      } catch (cause) {
        connection.socket.close(
          cause instanceof AppError && cause.code === 'SESSION_INVALID' ? 1008 : 1011,
        );
      }
    }
  }

  private async checkConnections(): Promise<void> {
    for (const connection of this.connections) {
      try {
        await this.access(connection);
      } catch (cause) {
        connection.socket.close(
          cause instanceof AppError && cause.code === 'SESSION_INVALID' ? 1008 : 1011,
        );
      }
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.unsubscribeDialogs();
    clearInterval(this.timer);

    for (const c of this.connections) {
      clearTimeout(c.registration);
      c.closed = true;
      c.socket.terminate();
    }

    await this.checking;
    await Promise.all([...this.connections].map((c): Promise<void> => c.queue));
  }
}

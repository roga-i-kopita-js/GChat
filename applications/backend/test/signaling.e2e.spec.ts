import { randomUUID } from 'node:crypto';
import { once } from 'node:events';

import { jest } from '@jest/globals';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { WebSocket } from 'ws';

import { AuthService } from '../src/auth/auth.service.js';
import { AuthWsTickets } from '../src/auth/auth.ws-tickets.js';
import { DevicesService } from '../src/devices/devices.service.js';
import { DialogsEvents } from '../src/dialogs/dialogs.events.js';
import { DialogsService } from '../src/dialogs/dialogs.service.js';
import { DirectCallsService } from '../src/direct-calls/direct-calls.service.js';
import { ErrorService } from '../src/error/error.service.js';
import { NativeWebsocketPolicyService } from '../src/signaling/native-websocket-policy.service.js';
import { SignalingAdapter } from '../src/signaling/signaling.adapter.js';
import { SignalingGateway } from '../src/signaling/signaling.gateway.js';

function message(socket: WebSocket, type: string, payload: object): Promise<any> {
  const id = randomUUID();

  return new Promise((resolve, reject): void => {
    const timer = setTimeout((): void => {
      socket.off('message', receive);
      reject(new Error('No WS response'));
    }, 2000);
    const receive = (raw: Buffer): void => {
      const result = JSON.parse(raw.toString());

      if (result.request_id !== id) {
        return;
      }

      clearTimeout(timer);
      socket.off('message', receive);
      resolve(result);
    };

    socket.on('message', receive);
    socket.send(JSON.stringify({ type, request_id: id, payload }));
  });
}

describe('WSS protocol over the Nest ws adapter', (): void => {
  let app: INestApplication;
  let url: string;
  const sockets: WebSocket[] = [];
  const userId = randomUUID();
  const sessionId = randomUUID();
  const deviceId = randomUUID();
  const callId = randomUUID();
  const error = new ErrorService();
  let dialogEvents: DialogsEvents;
  const dialogs = { canDeliver: jest.fn<DialogsService['canDeliver']>() };
  const policy = { read: jest.fn<NativeWebsocketPolicyService['read']>() };
  const auth = {
    authenticate: jest.fn<AuthService['authenticate']>(),
    checkSession: jest.fn<AuthService['checkSession']>(),
  };
  const devices = {
    bind: jest.fn<DevicesService['bind']>(),
    setPushToken: jest.fn<DevicesService['setPushToken']>(),
    setApnsToken: jest.fn<DevicesService['setApnsToken']>(),
  };
  const calls = {
    create: jest.fn<DirectCallsService['create']>(),
    current: jest.fn<DirectCallsService['current']>(),
    ping: jest.fn<DirectCallsService['ping']>(),
    connected: jest.fn<DirectCallsService['connected']>(),
    withSelectedPeer: jest.fn<(actor: any, id: string, callback: any) => Promise<any>>(),
    registerNegotiation: jest.fn<(tx: any, call: any, id: string) => Promise<void>>(),
  };

  beforeAll(async (): Promise<void> => {
    const module = await Test.createTestingModule({
      providers: [
        {
          provide: AuthWsTickets,
          useValue: {
            redeem: jest
              .fn<AuthWsTickets['redeem']>()
              .mockRejectedValue(error.accessTokenInvalid()),
          },
        },
        SignalingGateway,
        DialogsEvents,
        { provide: DialogsService, useValue: dialogs },
        { provide: NativeWebsocketPolicyService, useValue: policy },
        { provide: AuthService, useValue: auth },
        { provide: DevicesService, useValue: devices },
        { provide: DirectCallsService, useValue: calls },
        { provide: ErrorService, useValue: error },
      ],
    }).compile();

    const { get: moduleGet } = module;

    dialogEvents = moduleGet.bind(module)(DialogsEvents);
    const { createNestApplication: moduleCreateNestApplication } = module;

    app = moduleCreateNestApplication.bind(module)();
    const { get: moduleGet2 } = module;

    app.useWebSocketAdapter(new SignalingAdapter(app, moduleGet2.bind(module)(AuthService)));
    await app.listen(0, '127.0.0.1');
    const resolved = await app.getUrl();
    const { replace: getUrlResultReplace } = resolved;

    url = getUrlResultReplace.bind(resolved)('http:', 'ws:') + '/ws';
  });

  beforeEach((): void => {
    dialogs.canDeliver.mockReset().mockResolvedValue(true);
    policy.read.mockReset().mockResolvedValue({ restrictions: [] });
    auth.authenticate
      .mockReset()
      .mockResolvedValue({ userId, sessionId, login: 'test', displayName: 'Test', role: 'user' });
    auth.checkSession.mockReset().mockResolvedValue({ accountActive: true, sessionActive: true });
    devices.bind.mockReset().mockResolvedValue(deviceId);
    calls.current.mockReset().mockResolvedValue(null);
    calls.create.mockReset();
    calls.connected.mockReset();
  });

  afterEach((): void => {
    for (const socket of sockets) {
      socket.terminate();
    }

    sockets.length = 0;
  });
  afterAll(async (): Promise<void> => {
    await app?.close();
  });

  async function connect(register = true, token = 'valid', id = deviceId): Promise<WebSocket> {
    const socket = new WebSocket(url, { headers: { Authorization: 'Bearer ' + token } });

    sockets.push(socket);
    socket.on('error', (): void => {});
    await once(socket, 'open');

    if (register) {
      const { payload: resultPayload } = await message(socket, 'device.register', {
        device_id: id,
      });

      expect(resultPayload).toEqual({
        device_id: id,
      });
    }

    return socket;
  }

  it('delivers content-free dialog events only after destination authorization', async (): Promise<void> => {
    const socket = await connect();
    const event = {
      type: 'dialog.messages_available' as const,
      payload: { dialog_id: randomUUID(), last_sequence: 4 },
    };
    const frame = once(socket, 'message');

    dialogEvents.publish({ users: [userId, randomUUID()], event });
    const { [0]: resultFirst } = await frame;

    expect(JSON.parse(String(resultFirst))).toEqual(event);
    expect(dialogs.canDeliver).toHaveBeenCalledWith(
      userId,
      sessionId,
      deviceId,
      event.payload.dialog_id,
    );
    const read = {
      type: 'dialog.read_updated' as const,
      payload: { dialog_id: event.payload.dialog_id, reader_id: userId, last_read_sequence: 4 },
    };
    const readFrame = once(socket, 'message');

    dialogEvents.publish({ users: [userId], event: read });
    const { [0]: resultFirst2 } = await readFrame;

    expect(JSON.parse(String(resultFirst2))).toEqual(read);
    const { error: resultError } = await message(socket, 'dialog.sync', {});

    expect(resultError).toBeDefined();
  });

  it('registers an ordinary APNs token using the authenticated device and validates it separately from VoIP', async (): Promise<void> => {
    const socket = await connect();

    const { payload: resultPayload2 } = await message(socket, 'device.apns_token', {
      token: 'AABB',
      environment: 'sandbox',
    });

    expect(resultPayload2).toEqual({});
    expect(devices.setApnsToken).toHaveBeenCalledWith(
      userId,
      sessionId,
      deviceId,
      'AABB',
      'sandbox',
    );
    const { error: resultError2 } = await message(socket, 'device.apns_token', {
      token: 'not-hex',
      environment: 'sandbox',
    });

    expect(resultError2.code).toBe('VALIDATION_ERROR');
  });

  it('delivers current native bridge policy only after device registration and validates payload', async (): Promise<void> => {
    const socket = await connect(false);

    const { error: resultError3 } = await message(socket, 'native.bridge_policy', {});

    expect(resultError3.code).toBe('FORBIDDEN');
    expect(policy.read).not.toHaveBeenCalled();
    await message(socket, 'device.register', { device_id: deviceId });
    policy.read.mockResolvedValueOnce({
      restrictions: [{ direction: 'send', message_pattern: 'rtc.*' }],
    });
    const { payload: resultPayload3 } = await message(socket, 'native.bridge_policy', {});

    expect(resultPayload3).toEqual({
      restrictions: [{ direction: 'send', message_pattern: 'rtc.*' }],
    });
    const { payload: resultPayload4 } = await message(socket, 'native.bridge_policy', {});

    expect(resultPayload4).toEqual({
      restrictions: [],
    });
    const { error: resultError4 } = await message(socket, 'native.bridge_policy', { extra: true });

    expect(resultError4.code).toBe('VALIDATION_ERROR');
  });

  it('closes the native connection when bridge policy cannot be read', async (): Promise<void> => {
    const socket = await connect();

    policy.read.mockRejectedValueOnce(error.serviceUnavailable());
    const closed = once(socket, 'close');

    const { error: resultError5 } = await message(socket, 'native.bridge_policy', {});

    expect(resultError5.code).toBe('SERVICE_UNAVAILABLE');
    const { [0]: resultFirst3 } = await closed;

    expect(resultFirst3).toBe(1011);
  });

  it('routes SDP/ICE only to the selected peer and rejects stale or conflicting attempts', async (): Promise<void> => {
    const peerUser = randomUUID();
    const peerSession = randomUUID();
    const peerDevice = randomUUID();
    const id = randomUUID();
    const record = { id, negotiationId: null };

    auth.authenticate.mockImplementation(async (token): Promise<any> =>
      token === 'peer'
        ? { userId: peerUser, sessionId: peerSession, login: 'peer', displayName: 'Peer' }
        : { userId, sessionId, login: 'test', displayName: 'Test', role: 'user' },
    );
    devices.bind.mockImplementation(async (_user, sid): Promise<string> =>
      sid === peerSession ? peerDevice : deviceId,
    );
    calls.withSelectedPeer.mockImplementation(async (actor, _callId, callback): Promise<any> =>
      callback(
        {},
        record,
        actor.userId === userId
          ? { deviceId: peerDevice, sessionId: peerSession }
          : { deviceId, sessionId },
        actor.userId === userId,
      ),
    );
    calls.registerNegotiation.mockImplementation(async (_tx, call, negotiation): Promise<void> => {
      call.negotiationId = negotiation;
    });
    const caller = await connect();
    const peer = await connect(true, 'peer', peerDevice);
    const attempt = randomUUID();
    const sdp = 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n';
    const received = once(peer, 'message');

    const { payload: resultPayload5 } = await message(caller, 'rtc.offer', {
      call_id: id,
      negotiation_id: attempt,
      sdp,
    });

    expect(resultPayload5).toEqual({});
    const { [0]: resultFirst4 } = await received;

    expect(JSON.parse(resultFirst4.toString())).toEqual({
      type: 'rtc.offer',
      payload: { call_id: id, negotiation_id: attempt, sdp },
    });
    const { error: resultError6 } = await message(caller, 'rtc.offer', {
      call_id: id,
      negotiation_id: attempt,
      sdp: sdp + 'a=changed\r\n',
    });

    expect(resultError6.code).toBe('CALL_STATE_CONFLICT');
    const { error: resultError7 } = await message(peer, 'rtc.offer', {
      call_id: id,
      negotiation_id: randomUUID(),
      sdp,
    });

    expect(resultError7.code).toBe('FORBIDDEN');
    const answered = once(caller, 'message');

    const { payload: resultPayload6 } = await message(peer, 'rtc.answer', {
      call_id: id,
      negotiation_id: attempt,
      sdp,
    });

    expect(resultPayload6).toEqual({});
    const { [0]: resultFirst5 } = await answered;

    expect(JSON.parse(resultFirst5.toString()).type).toBe('rtc.answer');
    const { error: resultError8 } = await message(peer, 'rtc.ice', {
      call_id: id,
      negotiation_id: randomUUID(),
      candidate: null,
    });

    expect(resultError8.code).toBe('CALL_STATE_CONFLICT');
    const next = randomUUID();

    await message(caller, 'rtc.offer', { call_id: id, negotiation_id: next, sdp });
    const { error: resultError9 } = await message(caller, 'call.connected', {
      call_id: id,
      negotiation_id: attempt,
    });

    expect(resultError9.code).toBe('CALL_STATE_CONFLICT');
    calls.connected.mockResolvedValue({ state: 'connecting' } as any);
    const { payload: resultPayload7 } = await message(caller, 'call.connected', {
      call_id: id,
      negotiation_id: next,
    });

    expect(resultPayload7.call.state).toBe('connecting');
    expect(calls.connected).toHaveBeenCalledWith({ userId, sessionId, deviceId }, id, next);
  });

  it('rejects upgrade without Authorization and does not accept query tokens', async (): Promise<void> => {
    const socket = new WebSocket(url + '?token=secret');

    sockets.push(socket);
    socket.on('error', (): void => {});
    const [, response] = await once(socket, 'unexpected-response');

    expect(response.statusCode).toBe(401);
    response.resume();
    socket.terminate();
    expect(auth.authenticate).not.toHaveBeenCalled();
  });

  it('requires device registration and preserves request correlation', async (): Promise<void> => {
    const socket = await connect(false);

    const { error: resultError10 } = await message(socket, 'call.current', {});

    expect(resultError10.code).toBe('FORBIDDEN');
    await message(socket, 'device.register', { device_id: null });
    const { payload: resultPayload8 } = await message(socket, 'call.current', {});

    expect(resultPayload8).toEqual({ call: null });
  });

  it('strictly validates payloads before executing a command', async (): Promise<void> => {
    const socket = await connect();

    const { error: resultError11 } = await message(socket, 'call.create', {
      recipient_id: randomUUID(),
      caller_id: randomUUID(),
    });

    expect(resultError11.code).toBe('VALIDATION_ERROR');
    const { error: resultError12 } = await message(socket, 'call.connected', { call_id: callId });

    expect(resultError12.code).toBe('VALIDATION_ERROR');
    const { error: resultError13 } = await message(socket, 'call.ping', {
      call_id: callId,
      sequence: 1,
      audio_connected: 'true',
      recovery_id: null,
    });

    expect(resultError13.code).toBe('VALIDATION_ERROR');
    expect(calls.create).not.toHaveBeenCalled();
    expect(calls.connected).not.toHaveBeenCalled();
  });

  it('rejects a confirmation before a new offer after process restart', async (): Promise<void> => {
    const socket = await connect();

    const { error: resultError14 } = await message(socket, 'call.connected', {
      call_id: callId,
      negotiation_id: randomUUID(),
    });

    expect(resultError14.code).toBe('CALL_STATE_CONFLICT');
    expect(calls.connected).not.toHaveBeenCalled();
  });

  it('rechecks session state without revalidating the original JWT', async (): Promise<void> => {
    const socket = await connect();

    auth.authenticate.mockRejectedValue(error.accessTokenExpired());
    const { payload: resultPayload9 } = await message(socket, 'call.current', {});

    expect(resultPayload9).toEqual({ call: null });
    expect(auth.authenticate).toHaveBeenCalledTimes(1);
    const closed = once(socket, 'close');

    auth.checkSession.mockResolvedValue({ accountActive: true, sessionActive: false });
    const { error: resultError15 } = await message(socket, 'call.current', {});

    expect(resultError15.code).toBe('SESSION_INVALID');
    const { [0]: resultFirst6 } = await closed;

    expect(resultFirst6).toBe(1008);
  });

  it('replaces an old connection for the same device/session pair', async (): Promise<void> => {
    const first = await connect();
    const closed = once(first, 'close');
    const second = await connect();

    const { [0]: resultFirst7 } = await closed;

    expect(resultFirst7).toBe(1008);
    const { payload: resultPayload10 } = await message(second, 'call.current', {});

    expect(resultPayload10.call).toBeNull();
  });

  it.each([
    ['not json', 1008],
    [JSON.stringify({ type: 'call.current', payload: {} }), 1008],
  ])('closes invalid messages safely', async (raw, code): Promise<void> => {
    const socket = await connect();
    const closed = once(socket, 'close');

    const { send: socketSend } = socket;

    socketSend.bind(socket)(raw);
    const { [0]: resultFirst8 } = await closed;

    expect(resultFirst8).toBe(code);
  });

  it('rejects binary and oversized messages using protocol close codes', async (): Promise<void> => {
    const binary = await connect();
    const binaryClosed = once(binary, 'close');

    const { send: binarySend } = binary;

    binarySend.bind(binary)(Buffer.from('binary'));
    const { [0]: resultFirst9 } = await binaryClosed;

    expect(resultFirst9).toBe(1003);
    const large = await connect();
    const largeClosed = new Promise<number>((resolve): void => {
      const { on: largeOn } = large;

      largeOn.bind(large)('close', (code): void => {
        resolve(code);
      });
    });

    const { send: largeSend } = large;

    largeSend.bind(large)('a'.repeat(131073));
    expect(await largeClosed).toBe(1009);
  });
});

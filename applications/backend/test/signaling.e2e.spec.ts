import { randomUUID } from 'node:crypto';
import { once } from 'node:events';

import { jest } from '@jest/globals';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { WebSocket } from 'ws';

import { AuthService } from '../src/auth/auth.service.js';
import { AuthWsTickets } from '../src/auth/auth.ws-tickets.js';
import { DevicesService } from '../src/devices/devices.service.js';
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

      if (result.request_id !== id) return;

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
  const policy = { read: jest.fn<NativeWebsocketPolicyService['read']>() };
  const auth = {
    authenticate: jest.fn<AuthService['authenticate']>(),
    checkSession: jest.fn<AuthService['checkSession']>(),
  };
  const devices = {
    bind: jest.fn<DevicesService['bind']>(),
    setPushToken: jest.fn<DevicesService['setPushToken']>(),
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
        { provide: NativeWebsocketPolicyService, useValue: policy },
        { provide: AuthService, useValue: auth },
        { provide: DevicesService, useValue: devices },
        { provide: DirectCallsService, useValue: calls },
        { provide: ErrorService, useValue: error },
      ],
    }).compile();

    app = module.createNestApplication();
    app.useWebSocketAdapter(new SignalingAdapter(app, module.get(AuthService)));
    await app.listen(0, '127.0.0.1');
    url = (await app.getUrl()).replace('http:', 'ws:') + '/ws';
  });

  beforeEach((): void => {
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
    for (const socket of sockets) socket.terminate();

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

    if (register)
      expect((await message(socket, 'device.register', { device_id: id })).payload).toEqual({
        device_id: id,
      });

    return socket;
  }

  it('delivers current native bridge policy only after device registration and validates payload', async (): Promise<void> => {
    const socket = await connect(false);

    expect((await message(socket, 'native.bridge_policy', {})).error.code).toBe('FORBIDDEN');
    expect(policy.read).not.toHaveBeenCalled();
    await message(socket, 'device.register', { device_id: deviceId });
    policy.read.mockResolvedValueOnce({
      restrictions: [{ direction: 'send', message_pattern: 'rtc.*' }],
    });
    expect((await message(socket, 'native.bridge_policy', {})).payload).toEqual({
      restrictions: [{ direction: 'send', message_pattern: 'rtc.*' }],
    });
    expect((await message(socket, 'native.bridge_policy', {})).payload).toEqual({
      restrictions: [],
    });
    expect((await message(socket, 'native.bridge_policy', { extra: true })).error.code).toBe(
      'VALIDATION_ERROR',
    );
  });

  it('closes the native connection when bridge policy cannot be read', async (): Promise<void> => {
    const socket = await connect();

    policy.read.mockRejectedValueOnce(error.serviceUnavailable());
    const closed = once(socket, 'close');

    expect((await message(socket, 'native.bridge_policy', {})).error.code).toBe(
      'SERVICE_UNAVAILABLE',
    );
    expect((await closed)[0]).toBe(1011);
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

    expect(
      (await message(caller, 'rtc.offer', { call_id: id, negotiation_id: attempt, sdp })).payload,
    ).toEqual({});
    expect(JSON.parse((await received)[0].toString())).toEqual({
      type: 'rtc.offer',
      payload: { call_id: id, negotiation_id: attempt, sdp },
    });
    expect(
      (
        await message(caller, 'rtc.offer', {
          call_id: id,
          negotiation_id: attempt,
          sdp: sdp + 'a=changed\r\n',
        })
      ).error.code,
    ).toBe('CALL_STATE_CONFLICT');
    expect(
      (await message(peer, 'rtc.offer', { call_id: id, negotiation_id: randomUUID(), sdp })).error
        .code,
    ).toBe('FORBIDDEN');
    const answered = once(caller, 'message');

    expect(
      (await message(peer, 'rtc.answer', { call_id: id, negotiation_id: attempt, sdp })).payload,
    ).toEqual({});
    expect(JSON.parse((await answered)[0].toString()).type).toBe('rtc.answer');
    expect(
      (
        await message(peer, 'rtc.ice', {
          call_id: id,
          negotiation_id: randomUUID(),
          candidate: null,
        })
      ).error.code,
    ).toBe('CALL_STATE_CONFLICT');
    const next = randomUUID();

    await message(caller, 'rtc.offer', { call_id: id, negotiation_id: next, sdp });
    expect(
      (await message(caller, 'call.connected', { call_id: id, negotiation_id: attempt })).error
        .code,
    ).toBe('CALL_STATE_CONFLICT');
    calls.connected.mockResolvedValue({ state: 'connecting' } as any);
    expect(
      (await message(caller, 'call.connected', { call_id: id, negotiation_id: next })).payload.call
        .state,
    ).toBe('connecting');
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

    expect((await message(socket, 'call.current', {})).error.code).toBe('FORBIDDEN');
    await message(socket, 'device.register', { device_id: null });
    expect((await message(socket, 'call.current', {})).payload).toEqual({ call: null });
  });

  it('strictly validates payloads before executing a command', async (): Promise<void> => {
    const socket = await connect();

    expect(
      (
        await message(socket, 'call.create', {
          recipient_id: randomUUID(),
          caller_id: randomUUID(),
        })
      ).error.code,
    ).toBe('VALIDATION_ERROR');
    expect((await message(socket, 'call.connected', { call_id: callId })).error.code).toBe(
      'VALIDATION_ERROR',
    );
    expect(
      (
        await message(socket, 'call.ping', {
          call_id: callId,
          sequence: 1,
          audio_connected: 'true',
          recovery_id: null,
        })
      ).error.code,
    ).toBe('VALIDATION_ERROR');
    expect(calls.create).not.toHaveBeenCalled();
    expect(calls.connected).not.toHaveBeenCalled();
  });

  it('rejects a confirmation before a new offer after process restart', async (): Promise<void> => {
    const socket = await connect();

    expect(
      (await message(socket, 'call.connected', { call_id: callId, negotiation_id: randomUUID() }))
        .error.code,
    ).toBe('CALL_STATE_CONFLICT');
    expect(calls.connected).not.toHaveBeenCalled();
  });

  it('rechecks session state without revalidating the original JWT', async (): Promise<void> => {
    const socket = await connect();

    auth.authenticate.mockRejectedValue(error.accessTokenExpired());
    expect((await message(socket, 'call.current', {})).payload).toEqual({ call: null });
    expect(auth.authenticate).toHaveBeenCalledTimes(1);
    const closed = once(socket, 'close');

    auth.checkSession.mockResolvedValue({ accountActive: true, sessionActive: false });
    expect((await message(socket, 'call.current', {})).error.code).toBe('SESSION_INVALID');
    expect((await closed)[0]).toBe(1008);
  });

  it('replaces an old connection for the same device/session pair', async (): Promise<void> => {
    const first = await connect();
    const closed = once(first, 'close');
    const second = await connect();

    expect((await closed)[0]).toBe(1008);
    expect((await message(second, 'call.current', {})).payload.call).toBeNull();
  });

  it.each([
    ['not json', 1008],
    [JSON.stringify({ type: 'call.current', payload: {} }), 1008],
  ])('closes invalid messages safely', async (raw, code): Promise<void> => {
    const socket = await connect();
    const closed = once(socket, 'close');

    socket.send(raw);
    expect((await closed)[0]).toBe(code);
  });

  it('rejects binary and oversized messages using protocol close codes', async (): Promise<void> => {
    const binary = await connect();
    const binaryClosed = once(binary, 'close');

    binary.send(Buffer.from('binary'));
    expect((await binaryClosed)[0]).toBe(1003);
    const large = await connect();
    const largeClosed = new Promise<number>((resolve): void => {
      large.on('close', (code): void => {
        resolve(code);
      });
    });

    large.send('a'.repeat(131073));
    expect(await largeClosed).toBe(1009);
  });
});

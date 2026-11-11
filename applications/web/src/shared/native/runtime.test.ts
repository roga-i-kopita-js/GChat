import { createMemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Mocks = {
  listeners: Map<string, (event: unknown) => void>;
  plugin: Record<
    | 'httpRequest'
    | 'httpCancel'
    | 'getCapabilities'
    | 'webReady'
    | 'getAccessToken'
    | 'login'
    | 'logout'
    | 'placeCall'
    | 'acceptCall'
    | 'endCall'
    | 'setCallMuted'
    | 'sendWsMessage'
    | 'navigationReady'
    | 'completeNavigation'
    | 'addListener',
    ReturnType<typeof vi.fn>
  >;
};

const mock = vi.hoisted((): Mocks => ({
  listeners: new Map<string, (event: unknown) => void>(),
  plugin: {
    httpRequest: vi.fn(),
    httpCancel: vi.fn(),
    getCapabilities: vi.fn(),
    webReady: vi.fn(),
    getAccessToken: vi.fn(),
    login: vi.fn(),
    logout: vi.fn(),
    placeCall: vi.fn(),
    acceptCall: vi.fn(),
    endCall: vi.fn(),
    setCallMuted: vi.fn(),
    sendWsMessage: vi.fn(),
    navigationReady: vi.fn(),
    completeNavigation: vi.fn(),
    addListener: vi.fn(),
  },
}));

vi.mock('@capacitor/core', (): object => ({
  Capacitor: { isNativePlatform: (): boolean => true },
  registerPlugin: (): unknown => mock.plugin,
}));

import { NativeCallsClient } from '../calls/native-client';
import { DeviceCalls } from '../device/calls';
import { DeviceNavigation } from '../device/navigation';
import { currentSession, login, logout, request } from '../session/session';
import { bridgeError, serverUrl } from './bridge';
import { NativeRuntime, nativeRuntime, type NativeState } from './runtime';

function token(sid = 'A', suffix = 'one'): string {
  return (
    'e30.' +
    Buffer.from(
      JSON.stringify({
        sub: 'user',
        sid,
        login: 'anna',
        display_name: 'Анна',
        role: 'user',
        iat: 100,
        exp: 200,
      }),
    ).toString('base64url') +
    '.' +
    suffix
  );
}

function emit(name: string, payload: object, cycleId = nativeRuntime.getSnapshot().cycleId): void {
  mock.listeners.get(name)?.({ ...payload, cycleId });
}

function snapshot(call: NativeState['call'] = null): void {
  emit('callSnapshot', { call, runtime: { status: 'online', muted: false, selected: true } });
}

async function ready(): Promise<void> {
  await nativeRuntime.ready();
  emit('route', { path: '/calls', accessToken: token() });
  snapshot();
}

function call(
  version = 1,
  state: 'ringing' | 'ended' = 'ringing',
): NonNullable<NativeState['call']> {
  return {
    call_id: 'c9308a56-c680-49ee-a664-e36566311111',
    caller_id: 'user',
    recipient_id: 'peer',
    state,
    version,
    created_at: '',
    started_at: null,
    ended_at: null,
    end_reason: null,
    recovery_id: null,
    recovery_deadline: null,
    ringing_deadline: null,
    connecting_deadline: null,
  };
}

beforeEach((): void => {
  vi.useFakeTimers();
  vi.resetAllMocks();
  mock.listeners.clear();
  const window = Object.assign(new EventTarget(), {
    location: new URL('https://gchat.test/apps/client/login?serverUrl=https%3A%2F%2Fgchat.test'),
  });

  vi.stubGlobal('window', window);
  vi.stubGlobal('localStorage', {
    getItem: (): never => {
      throw new Error('Native touched browser storage');
    },
    setItem: (): never => {
      throw new Error('Native stored a token');
    },
  });
  mock.plugin.httpCancel.mockResolvedValue({});
  mock.plugin.getCapabilities.mockResolvedValue({
    bridgeVersion: 1,
    httpVersion: 1,
    navigationVersion: 1,
    platform: 'ios',
    nativeAuth: true,
    nativeCalls: true,
    webCallControls: true,
  });
  mock.plugin.addListener.mockImplementation(
    async (
      name: string,
      listener: (value: unknown) => void,
    ): Promise<{ remove(): Promise<void> }> => {
      mock.listeners.set(name, listener);

      return {
        remove: async (): Promise<void> => {
          if (mock.listeners.get(name) === listener) {
            mock.listeners.delete(name);
          }
        },
      };
    },
  );
});

afterEach((): void => {
  nativeRuntime.stop();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('native bridge handshake and synchronization', (): void => {
  it('registers listeners before webReady and waits for both route and a full null snapshot', async (): Promise<void> => {
    mock.plugin.webReady.mockImplementation(async (): Promise<void> => {
      expect(mock.listeners.size).toBe(5);
      emit('route', { path: '/calls', accessToken: token() });
      expect(nativeRuntime.getSnapshot().phase).toBe('waiting');
      snapshot();
    });
    await nativeRuntime.ready();
    expect(nativeRuntime.getSnapshot().phase).toBe('ready');
    expect(nativeRuntime.getSnapshot().call).toBeNull();
    expect(JSON.stringify(nativeRuntime.getSnapshot())).not.toContain(token());
    expect(currentSession()?.access_token).toBe(token());
  });

  it.each(['before', 'after'] as const)(
    'delivers the pending native transition when the router attaches %s native readiness',
    async (attachment): Promise<void> => {
      const runtime = new NativeRuntime();
      const router = createMemoryRouter(
        [
          { path: '/login', element: null },
          { path: '/calls', element: null },
        ],
        { initialEntries: ['/login'] },
      );
      const navigation = new DeviceNavigation(router, (to): string => to);
      const requestId = crypto.randomUUID();

      mock.plugin.webReady.mockImplementation(async (): Promise<void> => {
        const cycleId = runtime.getSnapshot().cycleId;

        mock.listeners.get('route')?.({ cycleId, path: '/calls', accessToken: token() });
        mock.listeners.get('callSnapshot')?.({
          cycleId,
          call: null,
          runtime: { status: 'offline', muted: false },
        });
      });
      mock.plugin.navigationReady.mockImplementation(async (value): Promise<void> => {
        expect(mock.listeners.has('navigationCommand')).toBe(true);
        mock.listeners.get('navigationCommand')?.({
          navigationVersion: 1,
          cycleId: value.cycleId,
          requestId,
          command: 'navigate',
          args: { to: '/calls', replace: true },
        });
      });
      mock.plugin.completeNavigation.mockResolvedValue(undefined);

      try {
        if (attachment === 'before') {
          runtime.attachNavigation(navigation);
          expect(mock.plugin.navigationReady).not.toHaveBeenCalled();
        }

        await runtime.ready();
        expect(runtime.getSnapshot().phase).toBe('ready');

        if (attachment === 'after') {
          runtime.attachNavigation(navigation);
        }

        await vi.waitFor((): void => {
          expect(mock.plugin.completeNavigation).toHaveBeenCalledWith({
            navigationVersion: 1,
            cycleId: runtime.getSnapshot().cycleId,
            requestId,
            result: {
              id: requestId,
              outcome: 'committed',
              location: { pathname: '/calls', search: '', hash: '' },
            },
          });
        });
        expect(mock.plugin.navigationReady).toHaveBeenCalledTimes(1);
        expect(router.state.location.pathname).toBe('/calls');
      } finally {
        runtime.stop();
        navigation.stop();
      }
    },
  );

  it('ignores messages and delayed token results from a previous cycle and aborts its HTTP requests', async (): Promise<void> => {
    await ready();
    const oldCycle = nativeRuntime.getSnapshot().cycleId;
    const oldRoute = mock.listeners.get('route')!;
    const oldSignal = nativeRuntime.getSignal();
    let complete!: (value: unknown) => void;

    mock.plugin.getAccessToken.mockReturnValue(
      new Promise((resolve): void => {
        complete = resolve;
      }),
    );
    const access = nativeRuntime.access(true);
    const assertion = expect(access).rejects.toMatchObject({ name: 'AbortError' });

    await nativeRuntime.ready();
    oldRoute({ cycleId: oldCycle, path: '/calls', accessToken: token('B') });
    emit('route', { path: '/calls', accessToken: token('B') }, oldCycle);
    complete({ accessToken: token() });
    await assertion;
    expect(oldSignal.aborted).toBe(true);
    expect(currentSession()).toBeNull();
    expect(nativeRuntime.getSnapshot().phase).toBe('waiting');
  });

  it('fails explicitly for a missing or incompatible bridge and never reads browser storage', async (): Promise<void> => {
    mock.plugin.getCapabilities.mockRejectedValueOnce(new Error('native secret'));
    await nativeRuntime.ready();
    expect(nativeRuntime.getSnapshot()).toMatchObject({
      phase: 'error',
      error: 'Связь с приложением недоступна',
    });
    mock.plugin.getCapabilities.mockResolvedValueOnce({ bridgeVersion: 2 });
    await nativeRuntime.ready();
    expect(nativeRuntime.getSnapshot()).toMatchObject({
      phase: 'error',
      error: 'Обновите приложение для продолжения',
    });
    expect(currentSession()).toBeNull();
  });

  it('supports an auth-only shell and keeps dialing unavailable', async (): Promise<void> => {
    mock.plugin.getCapabilities.mockResolvedValueOnce({
      bridgeVersion: 1,
      httpVersion: 1,
      navigationVersion: 1,
      platform: 'ios',
      nativeAuth: true,
      nativeCalls: false,
    });
    await nativeRuntime.ready();
    emit('route', { path: '/calls', accessToken: token() });
    emit('callSnapshot', { call: null, runtime: { status: 'offline', muted: false } });
    expect(nativeRuntime.getSnapshot()).toMatchObject({ phase: 'ready', nativeCalls: false });
    const client = new NativeCallsClient();
    const stop = client.start();

    emit('callRuntimeChanged', { status: { status: 'online', muted: false } });
    await client.dial('c9308a56-c680-49ee-a664-e36566311111');
    expect(mock.plugin.placeCall).not.toHaveBeenCalled();
    emit('loggedOut', {});
    emit('route', { path: '/login' });
    emit('route', { path: '/calls', accessToken: token('B') });
    expect(nativeRuntime.getSnapshot().nativeCalls).toBe(false);
    stop();
  });

  it('reads Capacitor retry metadata without exposing native error text', (): void => {
    expect(
      bridgeError({ code: 'RATE_LIMITED', message: 'secret', data: { retryAfter: 12 } }),
    ).toMatchObject({ code: 'RATE_LIMITED', retryAfter: 12 });
    expect(bridgeError({ code: 'INVALID_CREDENTIALS' }).message).toBe('Неверный логин или пароль');
  });

  it('times out an incomplete handshake and ignores subsequent events', async (): Promise<void> => {
    await nativeRuntime.ready();
    await vi.advanceTimersByTimeAsync(15000);
    emit('route', { path: '/calls', accessToken: token() });
    snapshot();
    expect(nativeRuntime.getSnapshot().phase).toBe('error');
    expect(currentSession()).toBeNull();
  });

  it.each([
    'https://evil.test',
    '//evil.test',
    '/%2f/evil.test',
    '/calls?accessToken=secret',
    '/calls#secret',
    '/admin/../calls',
    '/apps/client/calls',
    '/calls\\evil',
    '/calls%0a',
  ])('rejects unsafe or unsupported native route %s', async (path): Promise<void> => {
    await nativeRuntime.ready();
    emit('route', { path, accessToken: token() });
    expect(nativeRuntime.getSnapshot().phase).toBe('error');
    expect(currentSession()).toBeNull();
  });

  it('keeps the route stable across snapshots/updates, discards old DTO versions and does not resurrect retired calls', async (): Promise<void> => {
    await ready();
    const route = nativeRuntime.getSnapshot().route;

    emit('callStateChanged', { call: call(3) });
    emit('callStateChanged', { call: call(2) });
    snapshot(call(1));
    expect(nativeRuntime.getSnapshot().call?.version).toBe(3);
    emit('callStateChanged', { call: call(4, 'ended') });
    emit('callStateChanged', { call: call(5) });
    expect(nativeRuntime.getSnapshot().call?.state).toBe('ended');
    emit('callStateChanged', { call: null });
    emit('callStateChanged', { call: call(6) });
    expect(nativeRuntime.getSnapshot().call).toBeNull();
    expect(nativeRuntime.getSnapshot().route).toBe(route);
  });

  it('clears credentials and call state on logout, then obeys the native login route', async (): Promise<void> => {
    await ready();
    emit('callStateChanged', { call: call() });
    const signal = nativeRuntime.getSignal();

    emit('loggedOut', {});
    expect(currentSession()).toBeNull();
    expect(signal.aborted).toBe(true);
    emit('route', { path: '/login?serverUrl=https%3A%2F%2Fgchat.test', replace: true });
    expect(nativeRuntime.getSnapshot()).toMatchObject({
      phase: 'ready',
      call: null,
      route: { path: '/login?serverUrl=https%3A%2F%2Fgchat.test', replace: true },
    });
  });
});

describe('native auth transport', (): void => {
  it('passes login and logout only to native, retaining the token after an unknown logout', async (): Promise<void> => {
    const fetch = vi.fn();

    vi.stubGlobal('fetch', fetch);
    await login('anna', 'password');
    expect(mock.plugin.login).toHaveBeenCalledWith({
      serverUrl: 'https://gchat.test',
      login: 'anna',
      password: 'password',
    });
    await ready();
    mock.plugin.logout.mockRejectedValueOnce({ code: 'NETWORK_ERROR', message: token() });
    await expect(logout()).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
    expect(currentSession()?.access_token).toBe(token());
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects a query server outside the loaded origin and URLs with credentials or paths', (): void => {
    for (const value of [
      'https://evil.test',
      'https://user:pass@gchat.test',
      'https://gchat.test/path',
      'http://gchat.test',
      'https://gchat.test/?token=secret',
    ]) {
      expect((): string => serverUrl(value)).toThrow();
    }
  });

  it('retries HTTP exactly once on ACCESS_TOKEN_EXPIRED using native refresh and no HTTP auth', async (): Promise<void> => {
    await ready();
    const paths: string[] = [];
    const refreshed = token('A', 'two');

    mock.plugin.getAccessToken.mockResolvedValue({ accessToken: refreshed });
    mock.plugin.httpRequest.mockImplementation(
      async (envelope: Record<string, unknown>): Promise<unknown> => {
        const value = envelope.request as { url: string; headers: [string, string][] };

        paths.push(value.url);
        expect(new Headers(value.headers).get('Authorization')).toBe('Bearer native');

        return {
          httpVersion: 1,
          cycleId: envelope.cycleId,
          requestId: envelope.requestId,
          result: {
            status: 401,
            statusText: '',
            headers: [['Content-Type', 'application/json']],
            bodyBase64: btoa(
              JSON.stringify({ error: { code: 'ACCESS_TOKEN_EXPIRED', message: 'Expired' } }),
            ),
            url: value.url,
          },
        };
      },
    );
    await expect(
      request((api): ReturnType<typeof api.groupsList> => api.groupsList()),
    ).rejects.toMatchObject({
      code: 'ACCESS_TOKEN_EXPIRED',
    });
    expect(paths).toEqual(['https://gchat.test/api/groups', 'https://gchat.test/api/groups']);
    expect(mock.plugin.getAccessToken).toHaveBeenCalledExactlyOnceWith({ forceRefresh: true });
  });

  it('discards a completed HTTP response after the session cycle changed', async (): Promise<void> => {
    await ready();
    let complete!: (value: Response) => void;
    let started!: () => void;
    const sent = new Promise<void>((resolve): void => {
      started = resolve;
    });

    mock.plugin.httpRequest.mockImplementation((_envelope: unknown): Promise<unknown> => {
      started();

      return new Promise((resolve): void => {
        complete = resolve;
      });
    });
    const pending = request((api): ReturnType<typeof api.groupsList> => api.groupsList());
    const assertion = expect(pending).rejects.toMatchObject({ name: 'AbortError' });

    await sent;
    await nativeRuntime.ready();
    complete(new Response(JSON.stringify({ groups: [] })));
    await assertion;
  });

  it('keeps temporary refresh failures separate from confirmed session invalidation and sanitizes errors', async (): Promise<void> => {
    await ready();
    mock.plugin.getAccessToken.mockRejectedValueOnce({
      code: 'SECURE_STORAGE_ERROR',
      message: token(),
    });
    await expect(nativeRuntime.access(true)).rejects.toMatchObject({
      code: 'SECURE_STORAGE_ERROR',
    });
    expect(currentSession()).not.toBeNull();
    mock.plugin.getAccessToken.mockRejectedValueOnce({ code: 'SESSION_INVALID' });
    await expect(nativeRuntime.access(true)).rejects.toMatchObject({ code: 'SESSION_INVALID' });
    expect(currentSession()).toBeNull();
    expect(bridgeError({ code: 'RATE_LIMITED', retryAfter: 12, message: token() })).toMatchObject({
      retryAfter: 12,
      message: 'Слишком много запросов. Попробуйте позже',
    });
  });
});

it('uses only placeCall, does not fabricate call state on acknowledgement, and never retries an unknown result', async (): Promise<void> => {
  await ready();
  const client = new NativeCallsClient();
  const stop = client.start();

  await client.dial('c9308a56-c680-49ee-a664-e36566311112');
  expect(mock.plugin.placeCall).toHaveBeenCalledTimes(1);
  expect(client.getSnapshot().call).toBeNull();
  mock.plugin.placeCall.mockRejectedValueOnce({ code: 'NETWORK_ERROR' });
  await client.dial('c9308a56-c680-49ee-a664-e36566311112');
  expect(mock.plugin.placeCall).toHaveBeenCalledTimes(2);
  expect(client.getSnapshot().error).toBe('Проверьте соединение и повторите попытку');
  stop();
});

describe('shared call screen commands on iOS', (): void => {
  async function controls(): Promise<{
    client: NativeCallsClient;
    calls: DeviceCalls;
    stop(): void;
  }> {
    await ready();
    const client = new NativeCallsClient();
    const stopClient = client.start();
    const calls = new DeviceCalls(
      client,
      () => 'user',
      {
        execute: async (): Promise<never> => {
          throw new Error('Unexpected device command');
        },
      },
      nativeRuntime.getSignal,
    );

    calls.start();

    return {
      client,
      calls,
      stop: (): void => {
        calls.stop();
        stopClient();
      },
    };
  }

  it('routes answer, mute and end through native with the current call and cycle, without fabricating state', async (): Promise<void> => {
    const { client, calls, stop } = await controls();
    const incoming = { ...call(), caller_id: 'peer', recipient_id: 'user' };

    emit('callStateChanged', { call: incoming });
    emit('callRuntimeChanged', { status: { status: 'online', muted: false, selected: false } });
    const args = { cycleId: nativeRuntime.getSnapshot().cycleId, callId: incoming.call_id };

    try {
      await calls.accept();
      expect(mock.plugin.acceptCall).toHaveBeenCalledExactlyOnceWith(args);
      expect(client.getSnapshot().call?.state).toBe('ringing');
      emit('callStateChanged', { call: { ...incoming, version: 2, state: 'active' } });
      emit('callRuntimeChanged', { status: { status: 'online', muted: false, selected: true } });
      await calls.setMuted(true);
      expect(mock.plugin.setCallMuted).toHaveBeenCalledExactlyOnceWith({ ...args, muted: true });
      expect(client.getSnapshot().muted).toBe(false);
      emit('callRuntimeChanged', { status: { status: 'online', muted: true, selected: true } });
      await calls.setMuted(true);
      expect(mock.plugin.setCallMuted).toHaveBeenCalledTimes(1);
      await calls.end();
      expect(mock.plugin.endCall).toHaveBeenCalledExactlyOnceWith(args);
      expect(client.getSnapshot().call?.state).toBe('active');
    } finally {
      stop();
    }
  });

  it('does not clear a pending control when an earlier dial acknowledgement arrives', async (): Promise<void> => {
    const { client, stop } = await controls();
    let completeDial!: () => void;
    let completeMute!: () => void;

    mock.plugin.placeCall.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        completeDial = resolve;
      }),
    );
    mock.plugin.setCallMuted.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        completeMute = resolve;
      }),
    );

    try {
      const dial = client.dial('c9308a56-c680-49ee-a664-e36566311112');

      emit('callStateChanged', { call: { ...call(), state: 'active' } });
      const mute = client.setMuted(true);

      completeDial();
      await dial;
      expect(client.getSnapshot().busy).toBe(true);
      completeMute();
      await mute;
      expect(client.getSnapshot().busy).toBe(false);
    } finally {
      stop();
    }
  });

  it('blocks repeated clicks and reports sanitized failures without retrying an unknown result', async (): Promise<void> => {
    const { calls, stop } = await controls();

    emit('callStateChanged', { call: call() });
    let reject!: (cause: unknown) => void;

    mock.plugin.endCall.mockReturnValueOnce(
      new Promise((_resolve, fail): void => {
        reject = fail;
      }),
    );

    try {
      const pending = calls.end();
      const assertion = expect(pending).rejects.toMatchObject({ code: 'NETWORK_ERROR' });

      const { busy: pendingBusy } = await calls.getState();

      expect(pendingBusy).toBe(true);
      await expect(calls.end()).rejects.toMatchObject({ code: 'BUSY' });
      expect(mock.plugin.endCall).toHaveBeenCalledTimes(1);
      reject({ code: 'NETWORK_ERROR', message: 'native secret' });
      await assertion;
      const { error, busy } = await calls.getState();

      expect(error?.code).toBe('NETWORK_ERROR');
      expect(JSON.stringify(error)).not.toContain('native secret');
      expect(busy).toBe(false);
      expect(mock.plugin.endCall).toHaveBeenCalledTimes(1);
    } finally {
      stop();
    }
  });

  it.each(['cycle', 'call', 'logout'] as const)(
    'discards a delayed command failure after %s changes',
    async (change): Promise<void> => {
      const { client, calls, stop } = await controls();

      emit('callStateChanged', { call: call() });
      let reject!: (cause: unknown) => void;

      mock.plugin.endCall.mockReturnValueOnce(
        new Promise((_resolve, fail): void => {
          reject = fail;
        }),
      );

      try {
        const pending = (async (): Promise<void> => {
          try {
            await calls.end();
          } catch {}
        })();

        if (change === 'cycle') {
          await ready();
        } else if (change === 'logout') {
          emit('loggedOut', {});
        } else {
          emit('callStateChanged', {
            call: { ...call(), call_id: 'c9308a56-c680-49ee-a664-e36566311112' },
          });
        }

        reject({ code: 'NETWORK_ERROR' });
        await pending;
        expect(client.getSnapshot().error).toBeNull();
        const { error, busy } = await calls.getState();

        expect(error).toBeNull();
        expect(busy).toBe(false);
      } finally {
        stop();
      }
    },
  );

  it('does not offer local control over a call selected on another device', async (): Promise<void> => {
    const { client, calls, stop } = await controls();

    try {
      emit('callStateChanged', { call: { ...call(), state: 'active' } });
      emit('callRuntimeChanged', { status: { status: 'online', muted: false, selected: false } });
      expect(client.getSnapshot().selected).toBe(false);
      const { control } = await calls.getState();

      expect(control).toBe('unavailable');
      await expect(calls.setMuted(true)).rejects.toMatchObject({ code: 'INVALID_STATE' });
      expect(mock.plugin.setCallMuted).not.toHaveBeenCalled();
    } finally {
      stop();
    }
  });

  it('keeps an older shell usable for navigation but never invokes unsupported control methods', async (): Promise<void> => {
    mock.plugin.getCapabilities.mockResolvedValueOnce({
      bridgeVersion: 1,
      httpVersion: 1,
      navigationVersion: 1,
      platform: 'ios',
      nativeAuth: true,
      nativeCalls: true,
    });
    const { calls, stop } = await controls();

    try {
      emit('callStateChanged', { call: call() });
      expect(nativeRuntime.getSnapshot().phase).toBe('ready');
      const { control } = await calls.getState();

      expect(control).toBe('unavailable');
      await expect(calls.end()).rejects.toMatchObject({ code: 'UNSUPPORTED_VERSION' });
      expect(mock.plugin.endCall).not.toHaveBeenCalled();
    } finally {
      stop();
    }
  });
});

describe('shared native WebSocket', (): void => {
  async function socketReady(): Promise<void> {
    mock.plugin.getCapabilities.mockResolvedValueOnce({
      bridgeVersion: 1,
      httpVersion: 1,
      navigationVersion: 1,
      platform: 'ios',
      nativeAuth: true,
      nativeCalls: false,
      nativeWebSocket: true,
    });
    await ready();
    emit('wsState', { status: 'online' });
  }

  it('subscribes before webReady, sends the current cycle and keeps raw messages out of snapshots', async (): Promise<void> => {
    await socketReady();
    const listener = vi.fn();
    const unsubscribe = nativeRuntime.subscribeWs(listener);
    const message = { type: 'chat.list', request_id: 'web-1', payload: {} };

    await nativeRuntime.sendWsMessage(message);
    expect(mock.plugin.sendWsMessage).toHaveBeenCalledWith({
      cycleId: nativeRuntime.getSnapshot().cycleId,
      message,
    });
    emit('wsMessage', {
      message: { type: 'response', request_id: 'web-1', payload: { secret: 'content' } },
    });
    expect(listener).toHaveBeenCalledOnce();
    expect(JSON.stringify(nativeRuntime.getSnapshot())).not.toContain('content');
    expect(nativeRuntime.getSnapshot().call).toBeNull();
    unsubscribe();
    emit('wsMessage', { message: { type: 'chat.updated', payload: {} } });
    expect(listener).toHaveBeenCalledOnce();
  });

  it('ignores previous-cycle and logged-out delivery and cannot resurrect connection state', async (): Promise<void> => {
    await socketReady();
    const oldCycle = nativeRuntime.getSnapshot().cycleId;
    const listener = vi.fn();
    const unsubscribe = nativeRuntime.subscribeWs(listener);

    await socketReady();
    emit('wsMessage', { message: { type: 'chat.updated', payload: {} } }, oldCycle);
    emit('wsState', { status: 'offline' }, oldCycle);
    expect(listener).not.toHaveBeenCalled();
    expect(nativeRuntime.getSnapshot().wsStatus).toBe('online');
    emit('loggedOut', {});
    emit('wsState', { status: 'online' });
    emit('wsMessage', { message: { type: 'chat.updated', payload: {} } });
    expect(listener).not.toHaveBeenCalled();
    expect(nativeRuntime.getSnapshot().wsStatus).toBe('offline');
    await expect(
      nativeRuntime.sendWsMessage({ type: 'chat.list', request_id: '1', payload: {} }),
    ).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    unsubscribe();
  });

  it('rejects offline, invalid and excessive messages before calling native', async (): Promise<void> => {
    await socketReady();
    await expect(
      nativeRuntime.sendWsMessage({ type: '', request_id: '1', payload: {} }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(
      nativeRuntime.sendWsMessage({
        type: 'chat.send',
        request_id: '1',
        payload: { text: 'я'.repeat(70000) },
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    emit('wsState', { status: 'connecting' });
    await expect(
      nativeRuntime.sendWsMessage({ type: 'chat.list', request_id: '1', payload: {} }),
    ).rejects.toMatchObject({ code: 'BRIDGE_UNAVAILABLE' });
    expect(mock.plugin.sendWsMessage).not.toHaveBeenCalled();
  });

  it('does not apply a send result after a cycle reset and does not retry a denied command', async (): Promise<void> => {
    await socketReady();
    let complete!: () => void;

    mock.plugin.sendWsMessage.mockReturnValueOnce(
      new Promise<void>((resolve): void => {
        complete = resolve;
      }),
    );
    const pending = nativeRuntime.sendWsMessage({
      type: 'chat.send',
      request_id: '1',
      payload: {},
    });
    const assertion = expect(pending).rejects.toMatchObject({ name: 'AbortError' });

    await socketReady();
    complete();
    await assertion;
    mock.plugin.sendWsMessage.mockRejectedValueOnce({ code: 'FORBIDDEN', message: 'raw secret' });
    await expect(
      nativeRuntime.sendWsMessage({ type: 'call.create', request_id: '2', payload: {} }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', message: 'Действие недоступно' });
    expect(mock.plugin.sendWsMessage).toHaveBeenCalledTimes(2);
  });
});

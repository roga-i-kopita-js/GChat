import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Mocks = {
  listeners: Map<string, (event: unknown) => void>;
  plugin: Record<
    | 'getCapabilities'
    | 'webReady'
    | 'getAccessToken'
    | 'login'
    | 'logout'
    | 'placeCall'
    | 'addListener',
    ReturnType<typeof vi.fn>
  >;
};

const mock = vi.hoisted((): Mocks => ({
  listeners: new Map<string, (event: unknown) => void>(),
  plugin: {
    getCapabilities: vi.fn(),
    webReady: vi.fn(),
    getAccessToken: vi.fn(),
    login: vi.fn(),
    logout: vi.fn(),
    placeCall: vi.fn(),
    addListener: vi.fn(),
  },
}));

vi.mock('@capacitor/core', (): object => ({
  Capacitor: { isNativePlatform: (): boolean => true },
  registerPlugin: (): unknown => mock.plugin,
}));

import { currentSession, login, logout, request } from '../../features/auth/session';
import { NativeCallsClient } from '../../features/calls/native-client';
import { bridgeError, serverUrl } from './bridge';
import { nativeRuntime, type NativeState } from './runtime';

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
  emit('callSnapshot', { call, runtime: { status: 'online', muted: false } });
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
  mock.plugin.getCapabilities.mockResolvedValue({
    bridgeVersion: 1,
    platform: 'ios',
    nativeAuth: true,
    nativeCalls: true,
  });
  mock.plugin.addListener.mockImplementation(
    async (
      name: string,
      listener: (value: unknown) => void,
    ): Promise<{ remove(): Promise<void> }> => {
      mock.listeners.set(name, listener);

      return {
        remove: async (): Promise<void> => {
          if (mock.listeners.get(name) === listener) mock.listeners.delete(name);
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
    ])
      expect((): string => serverUrl(value)).toThrow();
  });

  it('retries HTTP exactly once on ACCESS_TOKEN_EXPIRED using native refresh and no HTTP auth', async (): Promise<void> => {
    await ready();
    const paths: string[] = [];
    const refreshed = token('A', 'two');

    mock.plugin.getAccessToken.mockResolvedValue({ accessToken: refreshed });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (path: string, init: RequestInit): Promise<Response> => {
        paths.push(path);
        expect(init.cache).toBe('no-store');
        expect(new Headers(init.headers).get('Authorization')).toBe(
          'Bearer ' + (paths.length === 1 ? token() : refreshed),
        );

        return new Response(
          JSON.stringify({ error: { code: 'ACCESS_TOKEN_EXPIRED', message: 'Expired' } }),
          { status: 401, headers: { 'Content-Type': 'application/json' } },
        );
      }),
    );
    await expect(
      request((api): ReturnType<typeof api.groupsList> => api.groupsList()),
    ).rejects.toMatchObject({
      code: 'ACCESS_TOKEN_EXPIRED',
    });
    expect(paths).toEqual(['/api/groups', '/api/groups']);
    expect(mock.plugin.getAccessToken).toHaveBeenCalledExactlyOnceWith({ forceRefresh: true });
  });

  it('discards a completed HTTP response after the session cycle changed', async (): Promise<void> => {
    await ready();
    let complete!: (value: Response) => void;
    let started!: () => void;
    const sent = new Promise<void>((resolve): void => {
      started = resolve;
    });

    vi.stubGlobal(
      'fetch',
      vi.fn((_path: string, init: RequestInit): Promise<Response> => {
        expect(init.signal?.aborted).toBe(false);
        started();

        return new Promise((resolve): void => {
          complete = resolve;
        });
      }),
    );
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

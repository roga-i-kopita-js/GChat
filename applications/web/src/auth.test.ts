import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Session } from './auth';
import { identity, readSession, request, saveSession } from './auth';

function session(exp = Date.now() / 1000 + 120, lifetime = 120): Session {
  const jwt =
    'e30.' +
    Buffer.from(
      JSON.stringify({
        sub: 'user',
        sid: 'session',
        login: 'anna',
        display_name: 'Анна',
        iat: exp - lifetime,
        exp,
      }),
    ).toString('base64url') +
    '.signature';

  return {
    access_token: jwt,
    refresh_token: 'refresh',
    token_type: 'Bearer',
    deviceId: null,
    pending: null,
  };
}

beforeEach((): void => {
  const values = new Map<string, string>();

  vi.stubGlobal('localStorage', {
    getItem: (key: string): string | null => values.get(key) ?? null,
    setItem: (key: string, value: string): void => {
      values.set(key, value);
    },
    removeItem: (key: string): void => {
      values.delete(key);
    },
  });
  vi.stubGlobal('window', new EventTarget());
  vi.stubGlobal('navigator', {
    locks: {
      request: async (_name: string, action: () => Promise<unknown>): Promise<unknown> => action(),
    },
  });
});

afterEach((): void => {
  vi.restoreAllMocks();
});

describe('browser session', (): void => {
  it('decodes Unicode names and retains the same session/device on reload', (): void => {
    const stored = { ...session(), deviceId: 'd09edc48-297f-4809-bc98-d250555ea952' };

    saveSession(stored);
    expect(identity(readSession()!).display_name).toBe('Анна');
    expect(readSession()?.deviceId).toBe(stored.deviceId);
  });
  it('refreshes short-lived JWTs proportionally without rotating on every HTTP request', async (): Promise<void> => {
    const now = 1700000000000;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    const paths: string[] = [];

    saveSession(session(now / 1000 + 10, 10));
    vi.stubGlobal(
      'fetch',
      vi.fn(async (path: string): Promise<Response> => {
        paths.push(path);

        return new Response(
          JSON.stringify(
            path === '/api/auth/refresh' ? session(Date.now() / 1000 + 10, 10) : { groups: [] },
          ),
        );
      }),
    );
    await request('/groups');
    expect(paths).toEqual(['/api/groups']);
    clock.mockReturnValue(now + 8000);
    await request('/groups');
    await request('/groups');
    expect(paths).toEqual(['/api/groups', '/api/auth/refresh', '/api/groups', '/api/groups']);
    expect(identity(readSession()!).exp).toBe(now / 1000 + 18);
    expect(readSession()?.pending).toBeNull();
  });
  it('refreshes after the server shortens the age limit of an otherwise unexpired JWT', async (): Promise<void> => {
    saveSession(session());
    const paths: string[] = [];
    let expired = true;

    vi.stubGlobal(
      'fetch',
      vi.fn(async (path: string): Promise<Response> => {
        paths.push(path);

        if (path === '/api/auth/refresh')
          return new Response(JSON.stringify(session(Date.now() / 1000 + 15, 15)));

        if (expired) {
          expired = false;

          return new Response(
            JSON.stringify({ error: { code: 'ACCESS_TOKEN_EXPIRED', message: 'Expired' } }),
            { status: 401 },
          );
        }

        return new Response(JSON.stringify({ groups: [] }));
      }),
    );
    await expect(request('/groups')).resolves.toEqual({ groups: [] });
    expect(paths).toEqual(['/api/groups', '/api/auth/refresh', '/api/groups']);
    const jwt = identity(readSession()!);

    expect(jwt.exp - jwt.iat).toBe(15);
  });
  it('preserves refresh request identity across an unknown result', async (): Promise<void> => {
    saveSession(session(1));
    const bodies: string[] = [];

    vi.stubGlobal(
      'fetch',
      vi.fn(async (_path: string, init: RequestInit): Promise<Response> => {
        bodies.push(String(init.body));

        throw new TypeError('Network unavailable');
      }),
    );
    await expect(request('/groups')).rejects.toThrow('Network unavailable');
    await expect(request('/groups')).rejects.toThrow('Network unavailable');
    expect(bodies[0]).toBe(bodies[1]);
    expect(readSession()?.pending?.request_id).toBeTruthy();
  });
  it('clears a confirmed invalid session but retains credentials after dependency failure', async (): Promise<void> => {
    saveSession(session());
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async (): Promise<Response> =>
          new Response(
            JSON.stringify({ error: { code: 'SERVICE_UNAVAILABLE', message: 'Unavailable' } }),
            { status: 503 },
          ),
      ),
    );
    await expect(request('/groups')).rejects.toThrow('Unavailable');
    expect(readSession()).not.toBeNull();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async (): Promise<Response> =>
          new Response(JSON.stringify({ error: { code: 'SESSION_INVALID', message: 'Revoked' } }), {
            status: 401,
          }),
      ),
    );
    await expect(request('/groups')).rejects.toThrow('Revoked');
    expect(readSession()).toBeNull();
  });
});

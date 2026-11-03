import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Session } from './auth';
import { identity, readSession, request, saveSession } from './auth';

function session(exp = Date.now() / 1000 + 120): Session {
  const jwt =
    'e30.' +
    Buffer.from(
      JSON.stringify({ sub: 'user', sid: 'session', login: 'anna', display_name: 'Анна', exp }),
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

describe('browser session', (): void => {
  it('decodes Unicode names and retains the same session/device on reload', (): void => {
    const stored = { ...session(), deviceId: 'd09edc48-297f-4809-bc98-d250555ea952' };

    saveSession(stored);
    expect(identity(readSession()!).display_name).toBe('Анна');
    expect(readSession()?.deviceId).toBe(stored.deviceId);
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

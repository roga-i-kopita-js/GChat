import { ApiError, type GroupsResponseDto } from '@gchat/backend-api';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { errorMessage, retryAfter } from '../../shared/api/client';
import type { Session } from '../../shared/session/session';
import {
  identity,
  login,
  logout,
  readSession,
  request,
  saveSession,
} from '../../shared/session/session';

function session(exp = Date.now() / 1000 + 120, lifetime = 120, sid = 'session'): Session {
  const jwt =
    'e30.' +
    Buffer.from(
      JSON.stringify({
        sub: 'user',
        sid,
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

function groups(): Promise<GroupsResponseDto> {
  return request((api): ReturnType<typeof api.groupsList> => api.groupsList());
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
  vi.unstubAllGlobals();
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
    await groups();
    expect(paths).toEqual(['/api/groups']);
    clock.mockReturnValue(now + 8000);
    await groups();
    await groups();
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

        if (path === '/api/auth/refresh') {
          return new Response(JSON.stringify(session(Date.now() / 1000 + 15, 15)));
        }

        if (expired) {
          expired = false;

          return new Response(
            JSON.stringify({ error: { code: 'ACCESS_TOKEN_EXPIRED', message: 'Expired' } }),
            { status: 401, headers: { 'Content-Type': 'application/json' } },
          );
        }

        return new Response(JSON.stringify({ groups: [] }));
      }),
    );
    await expect(groups()).resolves.toEqual({ groups: [] });
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
    await expect(groups()).rejects.toThrow('Network unavailable');
    await expect(groups()).rejects.toThrow('Network unavailable');
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
            { status: 503, headers: { 'Content-Type': 'application/json' } },
          ),
      ),
    );
    await expect(groups()).rejects.toThrow('Unavailable');
    expect(readSession()).not.toBeNull();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async (): Promise<Response> =>
          new Response(JSON.stringify({ error: { code: 'SESSION_INVALID', message: 'Revoked' } }), {
            status: 401,
            headers: { 'Content-Type': 'application/json' },
          }),
      ),
    );
    await expect(groups()).rejects.toThrow('Revoked');
    expect(readSession()).toBeNull();
  });
});

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

it('uses generated login/logout operations without Bearer and retains session after unknown logout', async (): Promise<void> => {
  const next = session();
  const fetch = vi.fn(async (path: string, init: RequestInit): Promise<Response> => {
    expect(init.cache).toBe('no-store');
    expect(new Headers(init.headers).has('Authorization')).toBe(false);

    if (path === '/api/auth/login') {
      expect(JSON.parse(String(init.body))).toEqual({ login: 'anna', password: 'password' });

      return json(next);
    }

    expect(path).toBe('/api/auth/logout');
    expect(JSON.parse(String(init.body))).toEqual({ refresh_token: next.refresh_token });

    throw new TypeError('Unknown logout result');
  });

  vi.stubGlobal('fetch', fetch);
  await login('anna', 'password');
  expect(readSession()?.deviceId).toBeNull();
  await expect(logout()).rejects.toThrow('Unknown logout result');
  expect(readSession()?.access_token).toBe(next.access_token);
  fetch.mockImplementationOnce(async (): Promise<Response> => new Response(null, { status: 204 }));
  await logout();
  expect(readSession()).toBeNull();
});

it('keeps SDK error metadata and Retry-After available to reconnect policy', async (): Promise<void> => {
  saveSession(session());
  const body = {
    error: {
      code: 'RATE_LIMITED',
      message: 'Try later',
      fields: [{ field: 'ticket', code: 'limited' }],
    },
  };
  const fetch = vi.fn(async (): Promise<Response> => json(body, 429, { 'Retry-After': '12' }));

  vi.stubGlobal('fetch', fetch);
  const failure = await (async () => {
    try {
      return await request((api): ReturnType<typeof api.authWsTicket> =>
        api.authWsTicket({ body: {} }),
      );
    } catch (cause) {
      return cause;
    }
  })();

  expect(failure).toBeInstanceOf(ApiError);

  if (!(failure instanceof ApiError)) {
    throw new Error('Expected SDK error');
  }

  const { status: failureStatus } = failure;

  expect(failureStatus).toBe(429);
  const { body: failureBody } = failure;

  expect(failureBody).toEqual(body);
  const { fields: failureFields } = failure;

  expect(failureFields).toEqual(body.error.fields);
  expect(retryAfter(failure)).toBe(12);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(readSession()).not.toBeNull();
});

it('shares one proactive refresh through the browser lock and retains device binding', async (): Promise<void> => {
  let tail: Promise<unknown> = Promise.resolve();

  vi.stubGlobal('navigator', {
    locks: {
      request: (_name: string, action: () => Promise<unknown>): Promise<unknown> => {
        const next = (async () => {
          await tail;

          return action();
        })();

        tail = (async () => {
          try {
            return await next;
          } catch (cause) {}
        })();

        return next;
      },
    },
  });
  const next = { ...session(), refresh_token: 'rotated' };

  saveSession({ ...session(1), deviceId: 'same-device' });
  let refreshes = 0;

  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string, init: RequestInit): Promise<Response> => {
      if (path === '/api/auth/refresh') {
        refreshes++;
        expect(new Headers(init.headers).has('Authorization')).toBe(false);

        return json(next);
      }

      expect(new Headers(init.headers).get('Authorization')).toBe('Bearer ' + next.access_token);

      return json({ groups: [] });
    }),
  );
  await Promise.all([groups(), groups()]);
  expect(refreshes).toBe(1);
  expect(readSession()?.deviceId).toBe('same-device');
  expect(readSession()?.refresh_token).toBe('rotated');
});

it('does not resurrect a logged-out session after a late refresh', async (): Promise<void> => {
  saveSession(session(1));
  vi.stubGlobal(
    'fetch',
    vi.fn(async (): Promise<Response> => {
      saveSession(null);

      return json(session());
    }),
  );
  await expect(groups()).rejects.toThrow('Сессия завершена');
  expect(readSession()).toBeNull();
});

it('does not clear a replacement session after an old refresh or HTTP refusal', async (): Promise<void> => {
  const replacement = session(Date.now() / 1000 + 120, 120, 'other-session');

  for (const expired of [true, false]) {
    saveSession(expired ? session(1) : session());
    vi.stubGlobal(
      'fetch',
      vi.fn(async (): Promise<Response> => {
        saveSession(replacement);

        return expired
          ? json(session())
          : json({ error: { code: 'SESSION_INVALID', message: 'Revoked' } }, 401);
      }),
    );
    await expect(groups()).rejects.toThrow();
    expect(identity(readSession()!).sid).toBe('other-session');
  }
});

it('clears an invalid session on the single retry and does not refresh repeatedly', async (): Promise<void> => {
  saveSession(session());
  let calls = 0;

  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string): Promise<Response> => {
      calls++;

      if (path === '/api/auth/refresh') {
        return json(session());
      }

      return json(
        {
          error: {
            code: calls === 1 ? 'ACCESS_TOKEN_EXPIRED' : 'SESSION_INVALID',
            message: 'Denied',
          },
        },
        401,
      );
    }),
  );
  await expect(groups()).rejects.toThrow('Denied');
  expect(calls).toBe(3);
  expect(readSession()).toBeNull();
});

it('passes AbortSignal to SDK operations without clearing the session or retrying', async (): Promise<void> => {
  saveSession(session());
  const controller = new AbortController();

  controller.abort();
  const failure = new DOMException('Aborted', 'AbortError');
  const fetch = vi.fn(async (_path: string, init: RequestInit): Promise<Response> => {
    expect(init.signal).toBe(controller.signal);

    throw failure;
  });

  vi.stubGlobal('fetch', fetch);
  await expect(
    request((api): ReturnType<typeof api.groupsList> =>
      api.groupsList({ signal: controller.signal }),
    ),
  ).rejects.toBe(failure);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(readSession()).not.toBeNull();
});

it('keeps the service fallback for HTTP errors without a backend envelope', async (): Promise<void> => {
  saveSession(session());
  vi.stubGlobal(
    'fetch',
    vi.fn(async (): Promise<Response> => new Response('Unavailable', { status: 503 })),
  );
  const failure = await (async () => {
    try {
      return await groups();
    } catch (cause) {
      return cause;
    }
  })();

  expect(failure).toBeInstanceOf(ApiError);
  expect(errorMessage(failure, 'Fallback')).toBe('Сервис временно недоступен');
  expect(readSession()).not.toBeNull();
});

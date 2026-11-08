import { ApiError, type ApiResult, BackendApi } from '@gchat/backend-api';
import { z } from 'zod';

import { ClientError, createApi } from '../api/client';
import { purgeAccount } from '../dialogs/storage';
import { identity } from '../identity';

export { identity } from '../identity';

const tokens = z.object({
  access_token: z.string(),
  refresh_token: z.string(),
  token_type: z.literal('Bearer'),
});
const stored = tokens.extend({
  deviceId: z.string().nullable(),
  pending: z.object({ refresh_token: z.string(), request_id: z.string() }).nullable(),
});

export type Session = z.infer<typeof stored>;

const key = 'gchat.session.v1';

export function readSession(): Session | null {
  try {
    const raw = localStorage.getItem(key);

    if (!raw) {
      return null;
    }

    const value = stored.parse(JSON.parse(raw));

    identity(value);

    return value;
  } catch {
    return null;
  }
}

export function saveSession(value: Session | null): void {
  if (value) {
    localStorage.setItem(key, JSON.stringify(value));
  } else {
    localStorage.removeItem(key);
  }

  window.dispatchEvent(new Event('gchat-session'));
}

const publicApi = createApi();

async function invalidateSession(cause: unknown, original: Session): Promise<void> {
  if (!(cause instanceof ApiError || cause instanceof ClientError)) {
    return;
  }

  if (!['SESSION_INVALID', 'ACCESS_TOKEN_INVALID'].includes(cause.code ?? '')) {
    return;
  }

  const current = readSession();

  if (current && identity(current).sid === identity(original).sid) {
    // Token invalidation still wins if storage is temporarily unavailable. A new session's
    // storage-open barrier discards prior generations before any cache can be exposed.
    try {
      if (typeof indexedDB !== 'undefined') {
        await purgeAccount({ serverOrigin: location.origin, accountId: identity(current).sub });
      }
    } finally {
      saveSession(null);
    }
  }
}

/** Only after a server response has confirmed revocation of this session. */
export async function confirmRevocation(original: Session): Promise<void> {
  const current = readSession();

  if (!current || identity(current).sid !== identity(original).sid) {
    return;
  }

  // Remove the credentials synchronously: a slow storage purge must not keep a revoked identity live.
  saveSession(null);

  if (typeof indexedDB !== 'undefined') {
    await purgeAccount({ serverOrigin: location.origin, accountId: identity(current).sub });
  }
}

export async function login(login: string, password: string): Promise<void> {
  const result = tokens.parse((await publicApi.authLogin({ body: { login, password } })).data);

  saveSession({ ...result, deviceId: null, pending: null });
}

async function access(force = false): Promise<Session> {
  return navigator.locks.request('gchat-refresh', async (): Promise<Session> => {
    let session = readSession();

    if (!session) {
      throw new ClientError('SESSION_INVALID', 'Войдите в аккаунт');
    }

    const jwt = identity(session);
    const refreshAheadMs = Math.min(15000, ((jwt.exp - jwt.iat) * 1000) / 4);

    if (!force && !session.pending && jwt.exp * 1000 > Date.now() + refreshAheadMs) {
      return session;
    }

    const pending = session.pending ?? {
      refresh_token: session.refresh_token,
      request_id: crypto.randomUUID(),
    };

    saveSession({ ...session, pending });

    try {
      const next = tokens.parse((await publicApi.authRefresh({ body: pending })).data);

      // A concurrent logout must not be undone by a late refresh.
      if (!readSession() || identity(readSession()!).sid !== identity(session).sid) {
        throw new ClientError('SESSION_INVALID', 'Сессия завершена');
      }

      session = { ...next, deviceId: session.deviceId, pending: null };
      saveSession(session);

      return session;
    } catch (cause) {
      await invalidateSession(cause, session);

      throw cause;
    }
  });
}

/** Session policy belongs to the application; the SDK performs each HTTP operation once. */
export function request<T>(
  operation: (api: BackendApi) => Promise<ApiResult<T>>,
  signal?: AbortSignal,
): Promise<T> {
  return run(async (api): Promise<T> => (await operation(api)).data, signal);
}

export async function run<T>(
  operation: (api: BackendApi, signal: AbortSignal) => Promise<T>,
  callerSignal?: AbortSignal,
): Promise<T> {
  const signal = callerSignal ?? new AbortController().signal;

  signal.throwIfAborted();
  const initial = readSession();
  const session = await access();
  const check = (): void => {
    signal?.throwIfAborted();
    const current = readSession();

    if (
      !initial ||
      !current ||
      identity(current).sid !== identity(initial).sid ||
      identity(session).sid !== identity(initial).sid
    ) {
      throw new DOMException('Session changed', 'AbortError');
    }
  };

  check();

  try {
    try {
      const result = await operation(createApi(session.access_token, callerSignal), signal);

      check();

      return result;
    } catch (cause) {
      if (!(cause instanceof ApiError && cause.code === 'ACCESS_TOKEN_EXPIRED')) {
        throw cause;
      }

      check();
      const refreshed = await access(true);

      check();

      const result = await operation(createApi(refreshed.access_token, callerSignal), signal);

      check();

      return result;
    }
  } catch (cause) {
    await invalidateSession(cause, session);

    throw cause;
  }
}

export async function logout(): Promise<void> {
  await navigator.locks.request('gchat-refresh', async (): Promise<void> => {
    const session = readSession();

    if (!session) {
      return;
    }

    await publicApi.authLogout({ body: { refresh_token: session.refresh_token } });

    try {
      if (typeof indexedDB !== 'undefined') {
        await purgeAccount({ serverOrigin: location.origin, accountId: identity(session).sub });
      }
    } finally {
      saveSession(null);
    }
  });
}

import { ApiError, type ApiResult, BackendApi } from '@gchat/backend-api';
import { z } from 'zod';

import { ClientError, createApi } from '../../shared/api/client';
import { purgeAccount } from '../../shared/dialogs/storage';
import { identity } from '../../shared/identity';

export { identity } from '../../shared/identity';

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

    if (!raw) return null;

    const value = stored.parse(JSON.parse(raw));

    identity(value);

    return value;
  } catch {
    return null;
  }
}

export function saveSession(value: Session | null): void {
  if (value) localStorage.setItem(key, JSON.stringify(value));
  else localStorage.removeItem(key);

  window.dispatchEvent(new Event('gchat-session'));
}

const publicApi = createApi();

async function invalidateSession(cause: unknown, original: Session): Promise<void> {
  if (!(cause instanceof ApiError || cause instanceof ClientError)) return;

  if (!['SESSION_INVALID', 'ACCESS_TOKEN_INVALID'].includes(cause.code ?? '')) return;

  const current = readSession();

  if (current && identity(current).sid === identity(original).sid) {
    // Token invalidation still wins if storage is temporarily unavailable. A new session's
    // storage-open barrier discards prior generations before any cache can be exposed.
    try {
      if (typeof indexedDB !== 'undefined')
        await purgeAccount({ serverOrigin: location.origin, accountId: identity(current).sub });
    } finally {
      saveSession(null);
    }
  }
}

export async function login(login: string, password: string): Promise<void> {
  const result = tokens.parse((await publicApi.authLogin({ body: { login, password } })).data);

  saveSession({ ...result, deviceId: null, pending: null });
}

async function access(force = false): Promise<Session> {
  return navigator.locks.request('gchat-refresh', async (): Promise<Session> => {
    let session = readSession();

    if (!session) throw new ClientError('SESSION_INVALID', 'Войдите в аккаунт');

    const jwt = identity(session);
    const refreshAheadMs = Math.min(15000, ((jwt.exp - jwt.iat) * 1000) / 4);

    if (!force && !session.pending && jwt.exp * 1000 > Date.now() + refreshAheadMs) return session;

    const pending = session.pending ?? {
      refresh_token: session.refresh_token,
      request_id: crypto.randomUUID(),
    };

    saveSession({ ...session, pending });

    try {
      const next = tokens.parse((await publicApi.authRefresh({ body: pending })).data);

      // A concurrent logout must not be undone by a late refresh.
      if (!readSession() || identity(readSession()!).sid !== identity(session).sid)
        throw new ClientError('SESSION_INVALID', 'Сессия завершена');

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
export async function request<T>(
  operation: (api: BackendApi) => Promise<ApiResult<T>>,
): Promise<T> {
  const session = await access();

  try {
    try {
      return (await operation(createApi(session.access_token))).data;
    } catch (cause) {
      if (!(cause instanceof ApiError && cause.code === 'ACCESS_TOKEN_EXPIRED')) throw cause;

      const refreshed = await access(true);

      return (await operation(createApi(refreshed.access_token))).data;
    }
  } catch (cause) {
    await invalidateSession(cause, session);

    throw cause;
  }
}

export async function logout(): Promise<void> {
  await navigator.locks.request('gchat-refresh', async (): Promise<void> => {
    const session = readSession();

    if (!session) return;

    await publicApi.authLogout({ body: { refresh_token: session.refresh_token } });

    try {
      if (typeof indexedDB !== 'undefined')
        await purgeAccount({ serverOrigin: location.origin, accountId: identity(session).sub });
    } finally {
      saveSession(null);
    }
  });
}

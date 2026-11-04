import { z } from 'zod';

const tokens = z.object({
  access_token: z.string(),
  refresh_token: z.string(),
  token_type: z.literal('Bearer'),
});
const claims = z.object({
  sub: z.string(),
  sid: z.string(),
  login: z.string(),
  display_name: z.string(),
  iat: z.number(),
  exp: z.number(),
});
const stored = tokens.extend({
  deviceId: z.string().nullable(),
  pending: z.object({ refresh_token: z.string(), request_id: z.string() }).nullable(),
});

export type Session = z.infer<typeof stored>;

const key = 'gchat.session.v1';

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryAfter = 0,
  ) {
    super(message);
  }
}

export function identity(session: Session): z.infer<typeof claims> {
  const part = session.access_token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
  const bytes = Uint8Array.from(atob(part), (char): number => char.charCodeAt(0));

  return claims.parse(JSON.parse(new TextDecoder().decode(bytes)));
}

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

async function json(path: string, body?: object, bearer?: string): Promise<unknown> {
  const response = await fetch('/api' + path, {
    method: body ? 'POST' : 'GET',
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(bearer ? { Authorization: 'Bearer ' + bearer } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    cache: 'no-store',
  });
  const value: unknown = response.status === 204 ? {} : await response.json();

  if (!response.ok) {
    const failure = z
      .object({ error: z.object({ code: z.string(), message: z.string() }) })
      .safeParse(value);

    throw new ApiError(
      failure.success ? failure.data.error.code : 'HTTP_ERROR',
      failure.success ? failure.data.error.message : 'Сервис временно недоступен',
      Number(response.headers.get('Retry-After') ?? 0),
    );
  }

  return value;
}

export async function login(login: string, password: string): Promise<void> {
  const result = tokens.parse(await json('/auth/login', { login, password }));

  saveSession({ ...result, deviceId: null, pending: null });
}

async function access(force = false): Promise<Session> {
  return navigator.locks.request('gchat-refresh', async (): Promise<Session> => {
    let session = readSession();

    if (!session) throw new ApiError('SESSION_INVALID', 'Войдите в аккаунт');

    const jwt = identity(session);
    const refreshAheadMs = Math.min(15000, ((jwt.exp - jwt.iat) * 1000) / 4);

    if (!force && !session.pending && jwt.exp * 1000 > Date.now() + refreshAheadMs) return session;

    const pending = session.pending ?? {
      refresh_token: session.refresh_token,
      request_id: crypto.randomUUID(),
    };

    saveSession({ ...session, pending });

    try {
      const next = tokens.parse(await json('/auth/refresh', pending));

      // A concurrent logout must not be undone by a late refresh.
      if (!readSession() || identity(readSession()!).sid !== identity(session).sid)
        throw new ApiError('SESSION_INVALID', 'Сессия завершена');

      session = { ...next, deviceId: session.deviceId, pending: null };
      saveSession(session);

      return session;
    } catch (cause) {
      if (cause instanceof ApiError && cause.code === 'SESSION_INVALID') saveSession(null);

      throw cause;
    }
  });
}

export async function request(path: string, body?: object): Promise<unknown> {
  const session = await access();

  try {
    return await json(path, body, session.access_token);
  } catch (cause) {
    if (cause instanceof ApiError && cause.code === 'ACCESS_TOKEN_EXPIRED') {
      const refreshed = await access(true);

      return json(path, body, refreshed.access_token);
    }

    if (
      cause instanceof ApiError &&
      ['SESSION_INVALID', 'ACCESS_TOKEN_INVALID'].includes(cause.code)
    )
      saveSession(null);

    throw cause;
  }
}

export async function logout(): Promise<void> {
  await navigator.locks.request('gchat-refresh', async (): Promise<void> => {
    const session = readSession();

    if (!session) return;

    await json('/auth/logout', { refresh_token: session.refresh_token });
    saveSession(null);
  });
}

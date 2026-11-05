import { ApiError, type ApiResult, type BackendApi } from '@gchat/backend-api';

import { createApi } from '../../shared/api/client';
import { embedded, invoke, nativePlugin, serverUrl } from '../../shared/native/bridge';
import { nativeRuntime } from '../../shared/native/runtime';
import * as browser from './browser-session';

export { identity, readSession, saveSession, type Session } from './browser-session';

export function currentSession(): { access_token: string } | null {
  if (!embedded) return browser.readSession();

  const token = nativeRuntime.getToken();

  return token ? { access_token: token } : null;
}

export async function login(login: string, password: string): Promise<void> {
  if (!embedded) return browser.login(login, password);

  const selected = new URLSearchParams(window.location.search).get('serverUrl');

  await invoke((): Promise<void> =>
    nativePlugin.login({ serverUrl: serverUrl(selected ?? ''), login, password }),
  );
}

/** A native session never reads browser tokens or calls the HTTP auth endpoints. */
export async function request<T>(
  operation: (api: BackendApi) => Promise<ApiResult<T>>,
): Promise<T> {
  if (!embedded) return browser.request(operation);

  const signal = nativeRuntime.getSignal();
  const run = async (force: boolean): Promise<T> => {
    const token = await nativeRuntime.access(force);

    signal.throwIfAborted();
    const result = await operation(createApi(token, signal));

    signal.throwIfAborted();

    return result.data;
  };

  try {
    try {
      return await run(false);
    } catch (cause) {
      signal.throwIfAborted();

      if (!(cause instanceof ApiError && cause.code === 'ACCESS_TOKEN_EXPIRED')) throw cause;

      return await run(true);
    }
  } catch (cause) {
    if (
      !signal.aborted &&
      cause instanceof ApiError &&
      ['SESSION_INVALID', 'ACCESS_TOKEN_INVALID'].includes(cause.code ?? '')
    ) {
      nativeRuntime.clear();
      // Native determines the next route and clears its own session after confirmation.
      void nativeRuntime.ready();
    }

    throw cause;
  }
}

export async function logout(): Promise<void> {
  if (!embedded) return browser.logout();

  await invoke((): Promise<void> => nativePlugin.logout());
}

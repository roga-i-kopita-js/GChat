import { ApiError, BackendApi } from '@gchat/backend-api';

import { embedded, nativeHttp } from '../native/bridge';
import { ClientError } from './client-error';

export { ClientError } from './client-error';

export function createApi(
  accessToken?: string | (() => string | undefined),
  cycleSignal?: AbortSignal,
): BackendApi {
  return new BackendApi({
    baseUrl: '/api',
    getAccessToken: (): string | undefined =>
      typeof accessToken === 'function' ? accessToken() : accessToken,
    fetch: (input, init): Promise<Response> =>
      (embedded ? nativeHttp.request : globalThis.fetch)(input, {
        ...init,
        cache: 'no-store',
        signal: cycleSignal
          ? AbortSignal.any([cycleSignal, ...(init?.signal ? [init.signal] : [])])
          : init?.signal,
      }),
  });
}

export function errorMessage(cause: unknown, fallback: string): string {
  if (cause instanceof ApiError && !cause.code) {
    return 'Сервис временно недоступен';
  }

  return cause instanceof Error ? cause.message : fallback;
}

export function retryAfter(cause: unknown): number {
  if (cause instanceof ClientError) {
    return cause.retryAfter;
  }

  if (!(cause instanceof ApiError)) {
    return 0;
  }

  const seconds = Number(cause.headers.get('Retry-After') ?? 0);

  return Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
}

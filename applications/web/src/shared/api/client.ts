import { ApiError, BackendApi } from '@gchat/backend-api';

export class ClientError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryAfter = 0,
  ) {
    super(message);
  }
}

export function createApi(accessToken?: string, cycleSignal?: AbortSignal): BackendApi {
  return new BackendApi({
    baseUrl: '/api',
    getAccessToken: (): string | undefined => accessToken,
    fetch: (input, init): Promise<Response> =>
      globalThis.fetch(input, {
        ...init,
        cache: 'no-store',
        signal: cycleSignal
          ? AbortSignal.any([cycleSignal, ...(init?.signal ? [init.signal] : [])])
          : init?.signal,
      }),
  });
}

export function errorMessage(cause: unknown, fallback: string): string {
  if (cause instanceof ApiError && !cause.code) return 'Сервис временно недоступен';

  return cause instanceof Error ? cause.message : fallback;
}

export function retryAfter(cause: unknown): number {
  if (cause instanceof ClientError) return cause.retryAfter;

  if (!(cause instanceof ApiError)) return 0;

  const seconds = Number(cause.headers.get('Retry-After') ?? 0);

  return Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
}

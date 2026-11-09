import type { MiddlewareFunction } from 'react-router';

export const ROUTE_LOADING_MIN_DURATION_MS = 150;

function wait(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();

  if (ms <= 0) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject): void => {
    const abort = (): void => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout((): void => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, ms);

    signal.addEventListener('abort', abort, { once: true });
  });
}

/** Start loaders immediately; keep fast GET transitions pending for at least 150 ms. */
export const routeLoadingMiddleware: MiddlewareFunction = async (
  { request },
  next,
): Promise<void> => {
  const started = performance.now();

  try {
    await next();
  } finally {
    if (request.method === 'GET') {
      await wait(ROUTE_LOADING_MIN_DURATION_MS - (performance.now() - started), request.signal);
    }
  }
};

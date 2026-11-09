import { z } from 'zod';

const limit = 8 * 1024 * 1024;
const fields = new Set([
  'method',
  'headers',
  'body',
  'signal',
  'credentials',
  'cache',
  'mode',
  'redirect',
  'referrer',
  'referrerPolicy',
  'integrity',
  'keepalive',
  'window',
]);
const pair = z.tuple([z.string(), z.string()]);
const failure = z.strictObject({
  kind: z.enum(['network', 'aborted', 'timeout', 'unsupported', 'invalid']),
  code: z.string(),
});
const response = z
  .strictObject({
    httpVersion: z.literal(1),
    cycleId: z.uuid(),
    requestId: z.uuid(),
    result: z
      .strictObject({
        status: z.number().int().min(200).max(599),
        statusText: z.string(),
        headers: z.array(pair).max(128),
        bodyBase64: z.string().max(Math.ceil(limit / 3) * 4),
        url: z.string(),
      })
      .optional(),
    error: failure.optional(),
  })
  .refine((value): boolean => Boolean(value.result) !== Boolean(value.error));

export interface NativeHttpPort {
  httpRequest(value: Record<string, unknown>): Promise<unknown>;
  httpCancel(value: Record<string, unknown>): Promise<unknown>;
}

class NativeFetchError extends TypeError {
  constructor(code: string) {
    super('Не удалось выполнить HTTP-запрос', { cause: { code } });
  }
}

function error(code: string): TypeError {
  return new NativeFetchError(code);
}
function abort(): DOMException {
  return new DOMException('Запрос отменён', 'AbortError');
}
function base64(bytes: Uint8Array): string {
  let value = '';

  for (let offset = 0; offset < bytes.length; offset += 32768) {
    value += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
  }

  return btoa(value);
}
function decorate(value: Response, url: string): Response {
  const clone = value.clone.bind(value);

  Object.defineProperties(value, {
    url: { value: url },
    type: { value: 'basic' },
    redirected: { value: false },
    clone: { value: (): Response => decorate(clone(), url) },
  });

  return value;
}
async function boundedBody(request: Request, signal: AbortSignal): Promise<Uint8Array | null> {
  if (!request.body) {
    return null;
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  const cancelled = (): void => {
    void (async () => {
      try {
        return await reader.cancel();
      } catch (cause) {}
    })();
  };

  signal.addEventListener('abort', cancelled, { once: true });

  try {
    while (true) {
      if (signal.aborted) {
        throw abort();
      }

      const next = await reader.read();

      if (signal.aborted) {
        throw abort();
      }

      const { done: nextDone } = next;

      if (nextDone) {
        break;
      }

      const { value: nextValue } = next;

      length += nextValue.byteLength;

      if (length > limit) {
        void (async () => {
          try {
            return await reader.cancel();
          } catch (cause) {}
        })();

        throw error('UNSUPPORTED');
      }

      const { value: nextValue2 } = next;

      chunks.push(nextValue2);
    }

    const bytes = new Uint8Array(length);
    let offset = 0;

    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }

    return bytes;
  } finally {
    signal.removeEventListener('abort', cancelled);
    reader.releaseLock();
  }
}

/** Fetch profile over the native network stack. No WebView fetch or refresh fallback. */
export class NativeHttpTransport {
  private context?: { cycle: string; origin: string; signal: AbortSignal };

  constructor(private readonly port: NativeHttpPort) {}

  activate(cycle: string, origin: string, signal: AbortSignal): void {
    if (
      this.context?.cycle === cycle &&
      this.context.origin === origin &&
      this.context.signal === signal
    ) {
      return;
    }

    this.context = { cycle, origin, signal };
  }

  clear(): void {
    this.context = undefined;
  }

  readonly request: typeof fetch = async (input, init = {}): Promise<Response> => {
    const context = this.context;

    if (!context) {
      throw error('BRIDGE_UNAVAILABLE');
    }

    if (Object.keys(init).some((key): boolean => !fields.has(key))) {
      throw error('UNSUPPORTED');
    }

    if (typeof ReadableStream !== 'undefined' && init.body instanceof ReadableStream) {
      throw error('UNSUPPORTED');
    }

    const from = input instanceof Request ? input : undefined;
    const credentials = init.credentials ?? from?.credentials ?? 'same-origin';
    const cache = init.cache ?? from?.cache ?? 'default';
    const redirect = init.redirect ?? from?.redirect ?? 'error';
    const mode = init.mode ?? from?.mode ?? 'cors';

    if (
      !['omit', 'same-origin'].includes(credentials) ||
      !['default', 'no-store'].includes(cache) ||
      redirect !== 'error' ||
      !['cors', 'same-origin'].includes(mode) ||
      (init.integrity ?? from?.integrity) ||
      (init.keepalive ?? from?.keepalive)
    ) {
      throw error('UNSUPPORTED');
    }

    let requestSignals: AbortSignal[];

    if (init.signal) {
      requestSignals = [init.signal];
    } else if (init.signal === null) {
      requestSignals = [];
    } else if (from) {
      requestSignals = [from.signal];
    } else {
      requestSignals = [];
    }

    const signal = AbortSignal.any([context.signal, ...requestSignals]);

    if (signal.aborted) {
      throw abort();
    }

    let request: Request;

    try {
      const url = new URL(from?.url ?? String(input), context.origin);

      if (url.origin !== context.origin || url.username || url.password || url.hash) {
        throw error('INVALID_ARGUMENT');
      }

      const headers = new Headers(init.headers ?? from?.headers);

      for (const name of [
        'cookie',
        'cookie2',
        'host',
        'content-length',
        'transfer-encoding',
        'connection',
        'upgrade',
      ]) {
        if (headers.has(name)) {
          throw error('INVALID_ARGUMENT');
        }
      }

      // Only a protected-operation marker crosses the bridge; the native owner reads its token.
      if (headers.has('authorization')) {
        headers.set('authorization', 'Bearer native');
      }

      request = new Request(from ?? url, {
        ...init,
        headers,
        cache: 'no-store',
        credentials: 'omit',
        redirect: 'error',
        signal,
      });
    } catch (cause) {
      if (cause instanceof NativeFetchError) {
        throw cause;
      }

      throw error('INVALID_ARGUMENT');
    }

    const bytes = await boundedBody(request, signal);

    if (signal.aborted || this.context !== context) {
      throw abort();
    }

    const requestId = crypto.randomUUID();
    const identity = { httpVersion: 1, cycleId: context.cycle, requestId };

    return new Promise<Response>((resolve, reject): void => {
      let settled = false;
      const finish = (operation: () => void): void => {
        if (settled) {
          return;
        }

        settled = true;
        clearTimeout(deadline);
        signal.removeEventListener('abort', cancelled);
        operation();
      };
      const cancelNative = (): void => {
        void (async () => {
          try {
            return await this.port.httpCancel(identity);
          } catch (cause) {}
        })();
      };
      const cancelled = (): void => {
        cancelNative();
        finish((): void => reject(abort()));
      };
      const deadline = setTimeout((): void => {
        cancelNative();
        finish((): void => reject(error('TIMEOUT')));
      }, 30000);

      signal.addEventListener('abort', cancelled, { once: true });

      if (signal.aborted) {
        cancelled();

        return;
      }

      let pending: Promise<unknown>;

      try {
        pending = this.port.httpRequest({
          ...identity,
          request: {
            url: request.url,
            method: request.method,
            headers: [...request.headers],
            bodyBase64: bytes === null ? null : base64(bytes),
          },
        });
      } catch {
        finish((): void => reject(error('BRIDGE_UNAVAILABLE')));

        return;
      }

      void (async () => {
        let fulfilledValue;

        try {
          fulfilledValue = await pending;
        } catch (rejectedCause) {
          return finish((): void => reject(error('BRIDGE_UNAVAILABLE')));
        }

        const raw = fulfilledValue;

        return finish((): void => {
          try {
            if (this.context !== context || signal.aborted) {
              throw abort();
            }

            const parsed = response.safeParse(raw);

            if (
              !parsed.success ||
              parsed.data.cycleId !== context.cycle ||
              parsed.data.requestId !== requestId
            ) {
              throw error('BRIDGE_UNAVAILABLE');
            }

            if (parsed.data.error) {
              if (parsed.data.error.kind === 'aborted') {
                throw abort();
              }

              const allowed = [
                'UNSUPPORTED',
                'INVALID_ARGUMENT',
                'TIMEOUT',
                'NETWORK_ERROR',
                'UNAUTHENTICATED',
                'FORBIDDEN',
                'UNSUPPORTED_VERSION',
              ];

              throw error(
                allowed.includes(parsed.data.error.code) ? parsed.data.error.code : 'NETWORK_ERROR',
              );
            }

            const result = parsed.data.result!;
            const url = new URL(result.url);

            if (
              url.origin !== context.origin ||
              url.username ||
              url.password ||
              url.hash ||
              [301, 302, 303, 307, 308].includes(result.status)
            ) {
              throw error('NETWORK_ERROR');
            }

            const binary = atob(result.bodyBase64);

            if (binary.length > limit) {
              throw error('UNSUPPORTED');
            }

            const body = Uint8Array.from(binary, (value): number => value.charCodeAt(0));
            const headers = result.headers.filter(
              ([name]): boolean => !['set-cookie', 'set-cookie2'].includes(name.toLowerCase()),
            );

            resolve(
              decorate(
                new Response(
                  request.method === 'HEAD' || [204, 205, 304].includes(result.status)
                    ? null
                    : body,
                  { status: result.status, statusText: result.statusText, headers },
                ),
                result.url,
              ),
            );
          } catch (cause) {
            reject(
              (cause instanceof DOMException && cause.name === 'AbortError') ||
                cause instanceof NativeFetchError
                ? cause
                : error('BRIDGE_UNAVAILABLE'),
            );
          }
        });
      })();
    });
  };
}

import type { RouteObject } from 'react-router';

import { createDevice } from '../src/shared/device/create';

export class TestHttp {
  constructor(readonly options: { fetch?: typeof fetch; label: string }) {}

  async ping(signal: AbortSignal): Promise<string> {
    const response = await this.options.fetch?.('/device-ping', { signal });

    if (!response) {
      throw new Error('missing fetch');
    }

    return response.text();
  }
}

export function makeDevice(): ReturnType<
  typeof createDevice<{ fetch?: typeof fetch; label: string }, TestHttp>
> {
  return createDevice({
    http: { client: TestHttp, options: { label: 'injected' } },
    routing: {
      basename: '/',
      createRoutes: (): RouteObject[] => [{ path: '*', loader: (): null => null }],
      resolveNativeLocation: (to): string => to,
    },
  });
}

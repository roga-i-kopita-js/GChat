import { BackendApi } from '@gchat/backend-api';
import { createMemoryRouter, type DataRouter, type RouterContextProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ApplicationDevice, ApplicationSessionState } from './device';
import { createApplicationContext, type RouteUser, userContext } from './router-context';
import { sessionMiddleware } from './session-middleware';

const routers: DataRouter[] = [];

afterEach((): void => {
  for (const router of routers.splice(0)) {
    router.dispose();
  }
});
const authenticated: ApplicationSessionState = {
  revision: 1,
  status: 'authenticated',
  generation: 1,
  error: null,
  identity: { id: 'user-one', login: 'anna', displayName: 'Анна', role: 'user' },
};

function fixture(state = authenticated): {
  device: ApplicationDevice;
  getState: ReturnType<typeof vi.fn<() => Promise<ApplicationSessionState>>>;
} {
  const getState = vi.fn(async (): Promise<ApplicationSessionState> => state);
  const http = new BackendApi({ baseUrl: 'https://fixture.test/api' });

  return {
    getState,
    device: {
      http,
      session: {
        getState,
        on: (): (() => void) => (): void => {},
        run: <T>(operation: (api: BackendApi, signal: AbortSignal) => Promise<T>): Promise<T> =>
          operation(http, new AbortController().signal),
        login: async (): Promise<void> => {},
        logout: async (): Promise<void> => {},
      },
    },
  };
}
async function initialized(router: DataRouter): Promise<void> {
  if (router.state.initialized) {
    return;
  }

  await new Promise<void>((resolve): void => {
    const off = router.subscribe((state): void => {
      if (state.initialized) {
        off();
        resolve();
      }
    });
  });
}

describe('session middleware', (): void => {
  it('authenticates once before parallel parent and child loaders and shares their user context', async (): Promise<void> => {
    const { device, getState } = fixture();
    const order: string[] = [];

    getState.mockImplementation(async (): Promise<ApplicationSessionState> => {
      order.push('session');

      return authenticated;
    });
    const router = createMemoryRouter(
      [
        {
          id: 'protected',
          middleware: [sessionMiddleware],
          loader: ({ context }): RouteUser => {
            order.push('parent');

            return context.get(userContext);
          },
          children: [
            {
              id: 'private',
              path: '/private',
              loader: ({ context }): RouteUser => {
                order.push('child');

                return context.get(userContext);
              },
            },
          ],
        },
      ],
      { initialEntries: ['/private'], getContext: createApplicationContext(device) },
    );

    routers.push(router);
    await initialized(router);
    expect(getState).toHaveBeenCalledOnce();
    expect(order[0]).toBe('session');
    expect(order.slice(1).sort()).toEqual(['child', 'parent']);
    expect(router.state.loaderData.protected).toBe(router.state.loaderData.private);
    expect(router.state.loaderData.private).toEqual({
      sub: 'user-one',
      sid: '1',
      role: 'user',
    });
  });
  it('redirects anonymous requests before protected loaders and preserves a logical returnTo with basename', async (): Promise<void> => {
    const { device } = fixture({
      revision: 1,
      status: 'anonymous',
      generation: 1,
      error: null,
      identity: null,
    });
    const protectedRead = vi.fn();
    const router = createMemoryRouter(
      [
        {
          middleware: [sessionMiddleware],
          children: [{ path: '/private', loader: protectedRead }],
        },
        { path: '/login', loader: (): null => null },
      ],
      {
        basename: '/apps/client',
        initialEntries: ['/apps/client/private?q=one'],
        getContext: createApplicationContext(device),
      },
    );

    routers.push(router);
    await initialized(router);
    expect(protectedRead).not.toHaveBeenCalled();
    expect(router.state.location.pathname).toBe('/apps/client/login');
    expect(new URLSearchParams(router.state.location.search).get('returnTo')).toBe(
      '/private?q=one',
    );
  });
  it('populates a fresh user for protected resource fetchers and actions', async (): Promise<void> => {
    const { device, getState } = fixture();
    const seen: string[] = [];
    const contexts: RouterContextProvider[] = [];
    const getContext = createApplicationContext(device);
    const router = createMemoryRouter(
      [
        {
          id: 'protected',
          middleware: [sessionMiddleware],
          children: [
            { path: '/private', loader: (): null => null },
            {
              path: '/resource',
              loader: ({ context }): null => {
                seen.push(context.get(userContext).sid);

                return null;
              },
              action: ({ context }): null => {
                seen.push(context.get(userContext).sid);

                return null;
              },
            },
          ],
        },
      ],
      {
        initialEntries: ['/private'],
        getContext: (): RouterContextProvider => {
          const context = getContext();

          contexts.push(context);

          return context;
        },
      },
    );

    routers.push(router);
    await initialized(router);
    getState.mockResolvedValue({ ...authenticated, generation: 2 });
    router.getFetcher('read');
    await router.fetch('read', 'protected', '/resource');
    await router.navigate('/resource', { formMethod: 'post', formData: new FormData() });
    expect(seen.length).toBeGreaterThanOrEqual(2);
    expect(seen.every((sid): boolean => sid === '2')).toBe(true);
    expect(
      contexts.every(
        (context): boolean =>
          context.get(userContext).sid === (context === contexts[0] ? '1' : '2'),
      ),
    ).toBe(true);
    expect(new Set(contexts).size).toBe(contexts.length);
  });
  it('does not continue an aborted transition after delayed session readiness', async (): Promise<void> => {
    const { device, getState } = fixture();
    let finish!: (state: ApplicationSessionState) => void;

    getState.mockImplementation(
      (): Promise<ApplicationSessionState> =>
        new Promise((resolve): void => {
          finish = resolve;
        }),
    );
    const protectedRead = vi.fn();
    const router = createMemoryRouter(
      [
        {
          middleware: [sessionMiddleware],
          children: [{ path: '/private', loader: protectedRead }],
        },
        { path: '/login', loader: (): null => null },
      ],
      { initialEntries: ['/private'], getContext: createApplicationContext(device) },
    );

    routers.push(router);
    await vi.waitFor((): void => {
      expect(getState).toHaveBeenCalledOnce();
    });
    await router.navigate('/login');
    finish(authenticated);
    await new Promise<void>((resolve): void => {
      setTimeout(resolve, 0);
    });
    expect(protectedRead).not.toHaveBeenCalled();
    expect(router.state.location.pathname).toBe('/login');
  });
});

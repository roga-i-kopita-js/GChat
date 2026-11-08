import { BackendApi } from '@gchat/backend-api';
import { createMemoryRouter, type DataRouter, type RouterContextProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { type ContactsData, contactsLoader } from '../features/calls/contacts';
import type { ApplicationDevice, ApplicationSessionState } from './device';
import { applicationLoader, type ApplicationLoaderData } from './loaders';
import { applicationDevice, createApplicationContext, deviceContext } from './router-context';
import { sessionMiddleware } from './session-middleware';

const group = '00000000-0000-4000-8000-000000000031';
const routers: DataRouter[] = [];

afterEach((): void => {
  for (const router of routers.splice(0)) {
    router.dispose();
  }
});

function fixture(name: string): { device: ApplicationDevice; fetch: ReturnType<typeof vi.fn> } {
  const fetch = vi.fn(
    async (input: RequestInfo | URL): Promise<Response> =>
      new Response(
        JSON.stringify(
          String(input).includes('/members')
            ? { members: [{ id: 'peer', display_name: name }] }
            : { groups: [{ id: group, name }] },
        ),
        { headers: { 'Content-Type': 'application/json' } },
      ),
  );
  const http = new BackendApi({ baseUrl: 'https://fixture.test/api', fetch });
  const state: ApplicationSessionState = {
    revision: 1,
    status: 'authenticated',
    generation: 1,
    error: null,
    identity: { id: name, login: name, displayName: name, role: 'user' },
  };
  const device: ApplicationDevice = {
    http,
    session: {
      getState: async (): Promise<ApplicationSessionState> => state,
      on: (): (() => void) => (): void => {},
      run: <T>(
        operation: (api: BackendApi, signal: AbortSignal) => Promise<T>,
        options: { signal?: AbortSignal } = {},
      ): Promise<T> => operation(http, options.signal ?? new AbortController().signal),
      login: async (): Promise<void> => {},
      logout: async (): Promise<void> => {},
    },
  };

  return { device, fetch };
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
function routerFor(
  device: ApplicationDevice,
  contexts: RouterContextProvider[],
  resources: ApplicationDevice[] = [],
): DataRouter {
  const getContext = createApplicationContext(device);
  const router = createMemoryRouter(
    [
      {
        id: 'application',
        loader: applicationLoader,
        middleware: [sessionMiddleware],
        children: [
          { id: 'contacts', path: 'calls', loader: contactsLoader },
          {
            path: 'resource',
            loader: ({ context }): { device: ApplicationDevice } => {
              const received = applicationDevice(context);

              resources.push(received);

              return { device: received };
            },
            action: ({ context }): { device: ApplicationDevice } => {
              const received = applicationDevice(context);

              resources.push(received);

              return { device: received };
            },
          },
        ],
      },
    ],
    {
      initialEntries: ['/calls?group=' + group],
      getContext: (): RouterContextProvider => {
        const value = getContext();

        contexts.push(value);

        return value;
      },
    },
  );

  routers.push(router);

  return router;
}

describe('device in React Router context', (): void => {
  it('uses the injected device in real loaders and returns that same instance through loaderData', async (): Promise<void> => {
    const alpha = fixture('alpha');
    const beta = fixture('beta');
    const first = routerFor(alpha.device, []);
    const second = routerFor(beta.device, []);

    await Promise.all([initialized(first), initialized(second)]);
    expect((first.state.loaderData.application as ApplicationLoaderData).device).toBe(alpha.device);
    expect((second.state.loaderData.application as ApplicationLoaderData).device).toBe(beta.device);
    expect((first.state.loaderData.contacts as ContactsData).members[0].display_name).toBe('alpha');
    expect((second.state.loaderData.contacts as ContactsData).members[0].display_name).toBe('beta');
    expect(alpha.fetch).toHaveBeenCalledTimes(2);
    expect(beta.fetch).toHaveBeenCalledTimes(2);
  });
  it('creates fresh contexts for navigation, fetcher and action while keeping one device', async (): Promise<void> => {
    const { device } = fixture('document');
    const contexts: RouterContextProvider[] = [];
    const resources: ApplicationDevice[] = [];
    const router = routerFor(device, contexts, resources);

    await initialized(router);
    await router.navigate('/calls?group=' + group + '#details');
    router.getFetcher('resource');
    await router.fetch('resource', 'application', '/resource');
    expect(resources).toEqual([device]);
    expect(router.state.errors).toBeNull();
    await router.navigate('/resource', { formMethod: 'post', formData: new FormData() });
    expect(router.state.actionData).toEqual({
      [router.state.matches.at(-1)!.route.id]: { device },
    });
    expect(contexts.length).toBeGreaterThanOrEqual(3);
    expect(new Set(contexts).size).toBe(contexts.length);

    for (const context of contexts) {
      expect(context.get(deviceContext)).toBe(device);
    }
  });
  it('fails explicitly when the device is missing instead of using a global session or SDK', async (): Promise<void> => {
    const router = createMemoryRouter([
      { id: 'application', path: '/', loader: applicationLoader },
    ]);

    routers.push(router);
    await initialized(router);
    expect(router.state.errors?.application).toBeInstanceOf(Error);
    expect(router.state.loaderData.application).toBeUndefined();
  });
});

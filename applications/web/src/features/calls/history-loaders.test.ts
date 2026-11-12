import { createContext, createMemoryRouter, RouterContextProvider } from 'react-router';
import { afterEach, expect, it, vi } from 'vitest';

import { applicationCore, userContext } from '../../app/router-context';
import { callHistoryDetailLoader, callHistoryLoader } from './history-loaders';
import { historyModel } from './history-model';

vi.mock('../../app/router-context', (): object => ({
  applicationCore: vi.fn(),
  userContext: createContext(),
}));
vi.mock('./history-model', (): object => ({ historyModel: vi.fn() }));

afterEach((): void => {
  vi.resetAllMocks();
});

it('waits for the initial history read before committing a route and forwards cancellation', async (): Promise<void> => {
  const device = {
    session: { getState: async (): Promise<object> => ({ generation: 1 }) },
  } as ReturnType<typeof applicationCore>;

  vi.mocked(applicationCore).mockReturnValue(device);
  let resolve!: () => void;
  let signal: AbortSignal | undefined;
  const head = vi.fn(async (_filter, abort): Promise<void> => {
    signal = abort;
    await new Promise<void>((done): void => {
      resolve = done;
    });
  });

  vi.mocked(historyModel).mockReturnValue({ head } as unknown as ReturnType<typeof historyModel>);
  const router = createMemoryRouter(
    [
      { path: '/', element: null },
      { id: 'calls', path: '/calls', loader: callHistoryLoader },
    ],
    {
      initialEntries: ['/'],
      getContext: (): RouterContextProvider => {
        const context = new RouterContextProvider();

        context.set(userContext, { sub: 'me', sid: 'sid', role: 'user' });

        return context;
      },
    },
  );

  try {
    const navigation = router.navigate('/calls?filter=missed');

    await vi.waitFor((): void => expect(head).toHaveBeenCalledOnce());
    expect(router.state.location.pathname).toBe('/');
    expect(head.mock.calls[0][0]).toBe('missed');
    await router.navigate('/');
    expect(signal?.aborted).toBe(true);
    resolve();
    await navigation;
    expect(router.state.location.pathname).toBe('/');
  } finally {
    router.dispose();
  }
});

it('rejects a malformed call ID before the HTTP/runtime preparation', async (): Promise<void> => {
  await expect(
    callHistoryDetailLoader({
      params: { callId: 'invalid' },
      request: new Request('https://fixture.test/calls/invalid'),
      url: new URL('https://fixture.test/calls/invalid'),
      pattern: '/calls/:callId',
      context: new RouterContextProvider(),
    }),
  ).rejects.toMatchObject({ status: 404 });
  expect(applicationCore).not.toHaveBeenCalled();
  expect(historyModel).not.toHaveBeenCalled();
});

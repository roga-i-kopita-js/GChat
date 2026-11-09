import { createMemoryRouter, type DataRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { routeLoadingMiddleware } from './route-loading';

const routers: DataRouter[] = [];

beforeEach((): void => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
});
afterEach((): void => {
  for (const router of routers.splice(0)) {
    router.dispose();
  }

  vi.useRealTimers();
});

function fixture(loader = vi.fn(async (): Promise<null> => null)): {
  router: DataRouter;
  loader: typeof loader;
  action: ReturnType<typeof vi.fn>;
} {
  const action = vi.fn(async (): Promise<null> => null);
  const router = createMemoryRouter(
    [
      { path: '/' },
      { id: 'page', path: '/page', middleware: [routeLoadingMiddleware], loader, action },
    ],
    { initialEntries: ['/'] },
  );

  routers.push(router);

  return { router, loader, action };
}

describe('layout route loading duration', (): void => {
  it('starts reads immediately and commits fast navigation at 150 ms', async (): Promise<void> => {
    const { router, loader } = fixture();
    const navigation = router.navigate('/page');

    await vi.advanceTimersByTimeAsync(0);
    expect(loader).toHaveBeenCalledTimes(1);
    expect(router.state.location.pathname).toBe('/');
    await vi.advanceTimersByTimeAsync(149);
    expect(router.state.navigation.state).toBe('loading');
    await vi.advanceTimersByTimeAsync(1);
    await navigation;
    expect(router.state.location.pathname).toBe('/page');
    expect(performance.now()).toBe(150);
  });

  it('does not add a further delay after a slow read', async (): Promise<void> => {
    const { router } = fixture(
      vi.fn(
        (): Promise<null> =>
          new Promise((resolve): void => {
            setTimeout((): void => resolve(null), 300);
          }),
      ),
    );
    const navigation = router.navigate('/page');

    await vi.advanceTimersByTimeAsync(300);
    await navigation;
    expect(router.state.location.pathname).toBe('/page');
    expect(performance.now()).toBe(300);
  });

  it('cancels the pending delay and allows the following transition', async (): Promise<void> => {
    const { router } = fixture();
    const abandoned = router.navigate('/page');

    await vi.advanceTimersByTimeAsync(50);
    await router.navigate('/');
    await abandoned;
    expect(vi.getTimerCount()).toBe(0);
    const navigation = router.navigate('/page');

    await vi.advanceTimersByTimeAsync(150);
    await navigation;
    expect(router.state.location.pathname).toBe('/page');
  });

  it('sends mutations immediately and delays only their GET revalidation', async (): Promise<void> => {
    const { router, action, loader } = fixture();
    const navigation = router.navigate('/page', { formMethod: 'post', formData: new FormData() });

    await vi.advanceTimersByTimeAsync(0);
    expect(action).toHaveBeenCalledTimes(1);
    expect(loader).toHaveBeenCalledTimes(1);
    expect(router.state.navigation.state).toBe('loading');
    await vi.advanceTimersByTimeAsync(150);
    await navigation;
    expect(performance.now()).toBe(150);
  });
});

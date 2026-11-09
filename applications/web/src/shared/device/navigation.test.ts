import { createMemoryRouter, redirect } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DeviceNavigation, NavigationEvent, NavigationOutcome } from './navigation';

const services: DeviceNavigation[] = [];
const resolver = (to: string): string => to;

function fixture(loader?: () => Promise<null>): {
  router: ReturnType<typeof createMemoryRouter>;
  navigation: DeviceNavigation;
} {
  const router = createMemoryRouter(
    [
      { path: '/calls', element: null },
      { path: '/settings/general/audio', element: null, loader: loader ?? ((): null => null) },
      { path: '/settings', loader: (): Response => redirect('/settings/general/audio') },
      {
        path: '/admin/users',
        loader: (): never => {
          throw new Error('private backend text');
        },
      },
    ],
    { initialEntries: ['/calls'] },
  );
  const navigation = new DeviceNavigation(router, resolver);

  services.push(navigation);

  return { router, navigation };
}
afterEach((): void => {
  for (const service of services.splice(0)) {
    service.stop();
  }
});

describe('Data router navigation', (): void => {
  it('commits with one history and applies replace semantics', async (): Promise<void> => {
    const { router, navigation } = fixture();
    const { outcome: resultOutcome } = await navigation.navigate('/settings/general/audio');

    expect(resultOutcome).toBe(NavigationOutcome.Committed);
    expect(router.state.location.pathname).toBe('/settings/general/audio');
    const { outcome: navigateResultOutcome } = await navigation.navigate('/calls', {
      replace: true,
    });

    expect(navigateResultOutcome).toBe('committed');
    expect(router.state.historyAction).toBe('REPLACE');
  });
  it('reports router redirects and route loader failures without raw errors', async (): Promise<void> => {
    const { router, navigation } = fixture();

    const { outcome: navigateResultOutcome2 } = await navigation.navigate('/settings');

    expect(navigateResultOutcome2).toBe('redirected');
    const failure = await navigation.navigate('/admin/users');

    const { outcome: failureOutcome } = failure;

    expect(failureOutcome).toBe('failed');
    expect(JSON.stringify(failure)).not.toContain('private backend text');
    expect(router.state.errors).toBeTruthy();
  });
  it('supersedes pending navigation and aborts its loader', async (): Promise<void> => {
    let release!: () => void;
    const { router, navigation } = fixture(
      (): Promise<null> =>
        new Promise<null>((resolve): void => {
          release = (): void => resolve(null);
        }),
    );
    const first = navigation.navigate('/settings/general/audio');

    await vi.waitFor((): void => expect(router.state.navigation.state).toBe('loading'));
    const second = await navigation.navigate('/calls');

    const { outcome: resultOutcome2 } = await first;

    expect(resultOutcome2).toBe('superseded');
    const { outcome: secondOutcome } = second;

    expect(secondOutcome).toBe('committed');
    release();
  });
  it('tracks regular router navigation as a competing transition', async (): Promise<void> => {
    let release!: () => void;
    const { router, navigation } = fixture(
      (): Promise<null> =>
        new Promise<null>((resolve): void => {
          release = (): void => resolve(null);
        }),
    );
    const first = navigation.navigate('/settings/general/audio');

    await vi.waitFor((): void => expect(router.state.navigation.state).toBe('loading'));
    await router.navigate('/calls');
    const { outcome: resultOutcome3 } = await first;

    expect(resultOutcome3).toBe('superseded');
    release();
  });
  it('waits for blocker decision and distinguishes reset from proceed', async (): Promise<void> => {
    const { router, navigation } = fixture();

    router.getBlocker('dirty-form', (): boolean => true);
    const blocked = navigation.navigate('/settings/general/audio');

    await vi.waitFor((): void =>
      expect(router.state.blockers.get('dirty-form')?.state).toBe('blocked'),
    );
    const blocker = router.state.blockers.get('dirty-form');

    if (blocker?.state === 'blocked') {
      blocker.reset();
    }

    const { outcome: resultOutcome4 } = await blocked;

    expect(resultOutcome4).toBe('blocked');
    expect(router.state.location.pathname).toBe('/calls');
    const proceeding = navigation.navigate('/settings');

    await vi.waitFor((): void =>
      expect(router.state.blockers.get('dirty-form')?.state).toBe('blocked'),
    );
    const next = router.state.blockers.get('dirty-form');

    if (next?.state === 'blocked') {
      next.proceed();
    }

    const { outcome: resultOutcome5 } = await proceeding;

    expect(resultOutcome5).toBe('redirected');
  });
  it('does not start pre-aborted navigation; late abort cancels waiting and still publishes actual completion', async (): Promise<void> => {
    let release!: () => void;
    const { router, navigation } = fixture(
      (): Promise<null> =>
        new Promise<null>((resolve): void => {
          release = (): void => resolve(null);
        }),
    );
    const controller = new AbortController();

    controller.abort();
    await expect(
      navigation.navigate('/settings/general/audio', { signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(router.state.location.pathname).toBe('/calls');
    const late = new AbortController();
    const completed: string[] = [];

    navigation.on(NavigationEvent.Completed, (event): void => {
      completed.push(event.result.outcome);
    });
    const waiting = navigation.navigate('/settings/general/audio', { signal: late.signal });
    const rejection = expect(waiting).rejects.toMatchObject({ code: 'CANCELLED' });

    await vi.waitFor((): void => expect(router.state.navigation.state).toBe('loading'));
    late.abort();
    await rejection;
    release();
    await vi.waitFor((): void => expect(completed).toEqual(['committed']));
  });
  it('uses stable immutable snapshots and monotonic revisions; subscriber errors and unsubscription are isolated', async (): Promise<void> => {
    const { navigation } = fixture();
    const initial = await navigation.getState();
    const revisions: number[] = [];

    expect(await navigation.getState()).toBe(initial);
    navigation.on(NavigationEvent.Completed, (): never => {
      throw new Error('subscriber failed');
    });
    const off = navigation.on(NavigationEvent.Completed, (event): void => {
      revisions.push(event.revision);
    });

    await navigation.navigate('/settings/general/audio');
    await navigation.navigate('/calls');
    expect(revisions.length).toBe(2);
    expect(revisions[1]).toBeGreaterThan(revisions[0]);
    expect(Object.isFrozen(await navigation.getState())).toBe(true);
    off();
    off();
    await navigation.navigate('/settings/general/audio');
    expect(revisions.length).toBe(2);
  });
  it('coalesces revalidation while independent signals cancel only their wait', async (): Promise<void> => {
    let held = false;
    let release!: () => void;
    let calls = 0;
    const router = createMemoryRouter(
      [
        {
          path: '/calls',
          element: null,
          loader: (): null | Promise<null> => {
            calls++;

            return held
              ? new Promise<null>((resolve): void => {
                  release = (): void => resolve(null);
                })
              : null;
          },
        },
      ],
      { initialEntries: ['/calls'] },
    );
    const navigation = new DeviceNavigation(router, resolver);

    services.push(navigation);
    await vi.waitFor((): void => expect(router.state.initialized).toBe(true));
    const key = router.state.location.key;
    const controller = new AbortController();

    held = true;
    const first = navigation.revalidate({ signal: controller.signal });
    const rejection = expect(first).rejects.toMatchObject({ code: 'CANCELLED' });
    const second = navigation.revalidate();

    await vi.waitFor((): void => expect(calls).toBe(2));
    controller.abort();
    await rejection;
    release();
    await second;
    expect(calls).toBe(2);
    expect(router.state.location.key).toBe(key);
  });
  it('strips basename from logical location and stops idempotently', async (): Promise<void> => {
    const router = createMemoryRouter(
      [
        { path: '/calls', element: null },
        { path: '/settings/general/audio', element: null },
      ],
      { basename: '/apps/client', initialEntries: ['/apps/client/calls'] },
    );
    const navigation = new DeviceNavigation(router, resolver, '/apps/client');

    const { location: navigateResultLocation } =
      await navigation.navigate('/settings/general/audio');

    expect(navigateResultLocation.pathname).toBe('/settings/general/audio');
    navigation.stop();
    navigation.stop();
    await expect(navigation.navigate('/calls')).rejects.toMatchObject({ code: 'INVALID_STATE' });
  });
});

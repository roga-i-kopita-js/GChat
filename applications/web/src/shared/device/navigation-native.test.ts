import { createMemoryRouter } from 'react-router';
import { afterEach, expect, it, vi } from 'vitest';

import { DeviceNavigation, NavigationEvent } from './navigation';
import { NativeNavigationBinding, type NativeNavigationPort } from './navigation-native';

class Port implements NativeNavigationPort {
  callback?: (data: unknown) => void;
  ready: Record<string, unknown>[] = [];
  completions: Record<string, unknown>[] = [];
  listeners = 0;
  failListener = false;

  async addListener(
    _name: string,
    callback: (data: unknown) => void,
  ): Promise<{ remove(): Promise<void> }> {
    this.listeners++;

    if (this.failListener) {
      throw new Error('offline');
    }

    this.callback = callback;

    return {
      remove: async (): Promise<void> => {
        this.callback = undefined;
      },
    };
  }

  async navigationReady(value: Record<string, unknown>): Promise<void> {
    this.ready.push(value);
  }

  async completeNavigation(value: Record<string, unknown>): Promise<void> {
    this.completions.push(value);
  }
}

const fixtures: { binding: NativeNavigationBinding; navigation: DeviceNavigation }[] = [];

function fixture(loader?: () => Promise<null>): {
  port: Port;
  navigation: DeviceNavigation;
  binding: NativeNavigationBinding;
} {
  const router = createMemoryRouter(
    [
      { path: '/calls', element: null },
      { path: '/settings/general/audio', element: null, loader: loader ?? ((): null => null) },
    ],
    { initialEntries: ['/calls'] },
  );
  const navigation = new DeviceNavigation(router, (to): string => to);
  const port = new Port();
  const binding = new NativeNavigationBinding(port, navigation);

  fixtures.push({ binding, navigation });

  return { port, navigation, binding };
}
function command(
  cycle: string,
  id = crypto.randomUUID(),
  to = '/settings/general/audio',
): Record<string, unknown> {
  return {
    navigationVersion: 1,
    cycleId: cycle,
    requestId: id,
    command: 'navigate',
    args: { to, replace: false },
  };
}
afterEach(async (): Promise<void> => {
  for (const item of fixtures.splice(0)) {
    await item.binding.stop();
    item.navigation.stop();
  }
});
it('subscribes before ready and correlates the actual router result', async (): Promise<void> => {
  const { port, binding } = fixture();
  const cycle = crypto.randomUUID();
  const request = command(cycle);

  await binding.start(cycle);
  expect(port.listeners).toBe(1);
  expect(port.ready[0]).toMatchObject({
    phase: 'ready',
    cycleId: cycle,
    location: { pathname: '/calls' },
  });
  port.callback?.(request);
  await vi.waitFor((): void => expect(port.completions).toHaveLength(1));
  expect(port.completions[0]).toMatchObject({
    cycleId: cycle,
    requestId: request.requestId,
    result: {
      id: request.requestId,
      outcome: 'committed',
      location: { pathname: '/settings/general/audio' },
    },
  });
});
it('joins active duplicate and replays completed results without another router transition', async (): Promise<void> => {
  let release!: () => void;
  const { port, binding, navigation } = fixture(
    (): Promise<null> =>
      new Promise<null>((resolve): void => {
        release = (): void => resolve(null);
      }),
  );
  const cycle = crypto.randomUUID();
  const request = command(cycle);
  let starts = 0;

  navigation.on(NavigationEvent.Started, (): void => {
    starts++;
  });
  await binding.start(cycle);
  port.callback?.(request);
  port.callback?.(request);
  await vi.waitFor((): void => expect(starts).toBe(1));
  release();
  await vi.waitFor((): void => expect(port.completions).toHaveLength(2));
  port.callback?.(request);
  await vi.waitFor((): void => expect(port.completions).toHaveLength(3));
  expect(starts).toBe(1);
});
it('ignores old cycles and refuses malformed arguments before navigation', async (): Promise<void> => {
  const { port, binding } = fixture();
  const cycle = crypto.randomUUID();

  await binding.start(cycle);
  port.callback?.(command(crypto.randomUUID()));
  port.callback?.({ ...command(cycle), args: { to: '/calls', replace: false, token: 'secret' } });
  await vi.waitFor((): void => expect(port.completions).toHaveLength(1));
  expect(port.completions[0]).toMatchObject({ error: { code: 'INVALID_ARGUMENT' } });
  expect(JSON.stringify(port.completions)).not.toContain('secret');
});
it('resync keeps router revision, one listener and drops pending old responses', async (): Promise<void> => {
  let release!: () => void;
  const { port, binding, navigation } = fixture(
    (): Promise<null> =>
      new Promise<null>((resolve): void => {
        release = (): void => resolve(null);
      }),
  );
  const oldCycle = crypto.randomUUID();

  await binding.start(oldCycle);
  port.callback?.(command(oldCycle));
  await vi.waitFor(async (): Promise<void> =>
    expect((await navigation.getState()).status).toBe('loading'),
  );
  const revision = (await navigation.getState()).revision;
  const nextCycle = crypto.randomUUID();

  await binding.start(nextCycle);
  release();
  await vi.waitFor(async (): Promise<void> =>
    expect((await navigation.getState()).status).toBe('idle'),
  );
  expect((await navigation.getState()).revision).toBeGreaterThanOrEqual(revision);
  expect(port.completions).toHaveLength(0);
  expect(port.listeners).toBe(1);
});
it('can retry failed listener setup without fallback', async (): Promise<void> => {
  const { port, binding } = fixture();
  const cycle = crypto.randomUUID();

  port.failListener = true;
  await expect(binding.start(cycle)).rejects.toThrow('offline');
  expect(port.ready[0]).toMatchObject({ phase: 'failed' });
  port.failListener = false;
  await binding.start(cycle);
  expect(port.ready.at(-1)).toMatchObject({ phase: 'ready' });
  expect(port.listeners).toBe(2);
});

it('late completion rejected as stale does not invalidate a live native cycle', async (): Promise<void> => {
  const { port, binding } = fixture();
  const cycle = crypto.randomUUID();

  port.completeNavigation = vi.fn().mockRejectedValue({ code: 'INVALID_STATE' });
  await binding.start(cycle);
  port.callback?.(command(cycle));
  await vi.waitFor((): void => expect(port.completeNavigation).toHaveBeenCalled());
  expect(port.ready).toHaveLength(1);
  expect(port.ready[0]).toMatchObject({ phase: 'ready' });
});
it('invalid result delivery reports integration failure without browser fallback', async (): Promise<void> => {
  const { port, binding } = fixture();
  const cycle = crypto.randomUUID();

  port.completeNavigation = vi.fn().mockRejectedValue({ code: 'INTEGRATION_ERROR' });
  await binding.start(cycle);
  port.callback?.(command(cycle));
  await vi.waitFor((): void => expect(port.ready.at(-1)).toMatchObject({ phase: 'failed' }));
});

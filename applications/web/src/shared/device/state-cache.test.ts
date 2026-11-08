import { describe, expect, it, vi } from 'vitest';

import { cancellable, Events, StateSource } from './events';
import { disposeStateCaches, StateCache, stateCache } from './state-cache';

interface State {
  revision: number;
  value: string;
}
function source(): {
  events: Events<{ changed: State }>;
  getState: ReturnType<typeof vi.fn<() => Promise<State>>>;
  on: Events<{ changed: State }>['on'];
} {
  const events = new Events<{ changed: State }>();
  const getState = vi.fn<() => Promise<State>>();

  return { events, getState, on: events.on.bind(events) };
}

describe('device state cache', (): void => {
  it('subscribes before reading and ignores a stale initial response', async (): Promise<void> => {
    const service = source();
    let resolve!: (state: State) => void;

    service.getState.mockImplementation(
      (): Promise<State> =>
        new Promise((done): void => {
          resolve = done;
        }),
    );
    const cache = new StateCache(service, 'changed');

    cache.ensure();
    service.events.emit('changed', { revision: 3, value: 'event' });
    resolve({ revision: 1, value: 'read' });
    await Promise.resolve();
    expect(cache.getSnapshot()).toEqual({
      status: 'ready',
      value: { revision: 3, value: 'event' },
    });
    cache.dispose();
  });
  it('preserves a newer event when the initial read fails', async (): Promise<void> => {
    const service = source();
    let reject!: (cause: unknown) => void;

    service.getState.mockImplementation(
      (): Promise<State> =>
        new Promise((_done, fail): void => {
          reject = fail;
        }),
    );
    const cache = new StateCache(service, 'changed');

    cache.ensure();
    service.events.emit('changed', { revision: 2, value: 'event' });
    reject(new Error('read failed'));
    await Promise.resolve();
    expect(cache.getSnapshot().status).toBe('ready');
    cache.dispose();
  });
  it('shares one subscription and read, detaches at the last consumer, and reconnects', async (): Promise<void> => {
    const service = source();

    service.getState.mockResolvedValue({ revision: 1, value: 'initial' });
    const on = vi.spyOn(service, 'on');
    const cache = stateCache(service, 'changed');

    expect(stateCache(service, 'changed')).toBe(cache);
    const off1 = cache.subscribe(vi.fn());
    const off2 = cache.subscribe(vi.fn());

    await cache.preload();
    expect(on).toHaveBeenCalledTimes(1);
    expect(service.getState).toHaveBeenCalledTimes(1);
    off1();
    service.events.emit('changed', { revision: 2, value: 'next' });
    off2();
    service.events.emit('changed', { revision: 3, value: 'detached' });
    expect(cache.getSnapshot()).toEqual({ status: 'ready', value: { revision: 2, value: 'next' } });
    service.getState.mockResolvedValue({ revision: 3, value: 'reconnected' });
    const off3 = cache.subscribe(vi.fn());

    await cache.preload();
    await Promise.resolve();
    expect(on).toHaveBeenCalledTimes(2);
    expect(cache.getSnapshot()).toEqual({
      status: 'ready',
      value: { revision: 3, value: 'reconnected' },
    });
    off3();
    disposeStateCaches(service);
  });
});

describe('device event and state publication', (): void => {
  it('isolates consumers and gives duplicate handlers independent subscriptions', (): void => {
    const events = new Events<{ changed: number }>();
    const handler = vi.fn();
    const off = events.on('changed', handler);

    events.on('changed', handler);
    events.on('changed', (): never => {
      throw new Error('consumer');
    });
    events.emit('changed', 1);
    off();
    off();
    events.emit('changed', 2);
    expect(handler.mock.calls).toEqual([[1], [1], [2]]);
  });
  it('publishes immutable nested snapshots with stable increasing revisions', (): void => {
    const states = new StateSource({ revision: 0, nested: { value: 0 } });
    const listener = vi.fn();

    states.on(listener);
    const first = states.getSnapshot();

    expect(Object.isFrozen(first.nested)).toBe(true);
    expect(states.set({ revision: 999, nested: { value: 0 } })).toBe(first);
    const next = states.set({ revision: 0, nested: { value: 1 } });

    expect(first.nested.value).toBe(0);
    expect(next.revision).toBe(1);
    expect(listener).toHaveBeenCalledTimes(1);
  });
  it('cancels the caller without claiming an in-flight mutation was rolled back', async (): Promise<void> => {
    const controller = new AbortController();
    let resolve!: (value: number) => void;
    let completed = false;
    const operation = new Promise<number>((done): void => {
      resolve = done;
    });
    const result = cancellable(
      async (): Promise<number> => {
        const value = await operation;

        completed = true;

        return value;
      },
      { signal: controller.signal },
    );

    controller.abort();
    await expect(result).rejects.toMatchObject({ code: 'CANCELLED' });
    resolve(1);
    await Promise.resolve();
    expect(completed).toBe(true);
  });
});

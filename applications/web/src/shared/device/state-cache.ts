import type { CallOptions, Unsubscribe, Versioned } from './api';
import { DeviceError } from './contract';

interface Source<T extends Versioned, E extends string> {
  getState(options?: CallOptions): Promise<T>;
  on(event: NoInfer<E>, handler: (value: NoInfer<T>) => void): Unsubscribe;
}
type Snapshot<T> =
  | { status: 'loading'; promise: Promise<void> }
  | { status: 'ready'; value: T }
  | { status: 'error'; error: unknown };
const cache = new WeakMap<object, Map<string, unknown>>();
const branded = new WeakSet<object>();

export class StateCache<T extends Versioned, E extends string> {
  private snapshot: Snapshot<T> | null = null;
  private listeners = new Set<() => void>();
  private off: Unsubscribe | null = null;
  private controller: AbortController | null = null;
  private generation = 0;

  constructor(
    private readonly source: Source<T, E>,
    private readonly event: E,
  ) {
    branded.add(this);
  }

  private publish(snapshot: Snapshot<T>): void {
    this.snapshot = snapshot;

    for (const listener of this.listeners) {
      listener();
    }
  }

  ensure(): void {
    if (this.off) {
      return;
    }

    const generation = ++this.generation;
    const controller = new AbortController();

    this.controller = controller;
    let latest: T | null = this.snapshot?.status === 'ready' ? this.snapshot.value : null;
    const accept = (value: T): void => {
      if (
        generation !== this.generation ||
        controller.signal.aborted ||
        (latest && value.revision < latest.revision)
      ) {
        return;
      }

      if (latest && value.revision === latest.revision) {
        return;
      }

      latest = value;
      this.publish({ status: 'ready', value });
    };

    // Subscribe first: an event may beat the initial async read.
    this.off = this.source.on(this.event, accept);
    let reading: Promise<T>;

    try {
      reading = this.source.getState({ signal: controller.signal });
    } catch (cause) {
      reading = Promise.reject(cause);
    }

    const promise = reading.then(accept, (error): void => {
      if (generation === this.generation && !controller.signal.aborted && !latest) {
        this.publish({ status: 'error', error });
      }
    });

    if (!this.snapshot || this.snapshot.status !== 'ready') {
      this.snapshot = { status: 'loading', promise };
    }

    void promise.catch((): void => {});
  }

  async preload(): Promise<void> {
    this.ensure();
    const value = this.snapshot;

    if (value?.status === 'loading') {
      await value.promise;
    }
  }

  getSnapshot = (): Snapshot<T> => {
    if (!this.snapshot) {
      throw new DeviceError('INTEGRATION_ERROR');
    }

    return this.snapshot;
  };
  subscribe = (listener: () => void): Unsubscribe => {
    this.listeners.add(listener);
    this.ensure();

    return (): void => {
      this.listeners.delete(listener);

      if (!this.listeners.size) {
        this.detach();
      }
    };
  };

  private detach(): void {
    this.generation++;
    this.off?.();
    this.off = null;
    this.controller?.abort();
    this.controller = null;
  }

  dispose(): void {
    this.detach();
    this.listeners.clear();
  }
}

function isCache<T extends Versioned, E extends string>(value: unknown): value is StateCache<T, E> {
  return typeof value === 'object' && value !== null && branded.has(value);
}

export function stateCache<T extends Versioned, const E extends string>(
  source: Source<T, E>,
  event: E,
): StateCache<T, E> {
  let events = cache.get(source);

  if (!events) {
    events = new Map();
    cache.set(source, events);
  }

  const existing = events.get(event);

  if (isCache<T, E>(existing)) {
    return existing;
  }

  const value = new StateCache(source, event);

  events.set(event, value);

  return value;
}

export function disposeStateCaches(source: object): void {
  const events = cache.get(source);

  if (!events) {
    return;
  }

  for (const value of events.values()) {
    if (isCache(value)) {
      value.dispose();
    }
  }

  cache.delete(source);
}

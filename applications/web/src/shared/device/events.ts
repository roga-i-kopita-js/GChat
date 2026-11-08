import type { CallOptions, EventSource, Unsubscribe, Versioned } from './api';
import { DeviceError } from './contract';

export class Events<T extends object> implements EventSource<T> {
  private readonly listeners: { [E in keyof T]?: Set<(value: T[E]) => void> } = {};

  on<E extends keyof T>(event: E, handler: (value: T[E]) => void): Unsubscribe {
    const listeners = (this.listeners[event] ??= new Set<(value: T[E]) => void>());
    const listener = (value: T[E]): void => handler(value);

    listeners.add(listener);
    let active = true;

    return (): void => {
      if (active) {
        active = false;
        listeners.delete(listener);
      }
    };
  }

  emit<E extends keyof T>(event: E, value: T[E]): void {
    for (const listener of [...(this.listeners[event] ?? [])]) {
      try {
        listener(value);
      } catch {
        /* A consumer cannot stop publication. */
      }
    }
  }

  clear(): void {
    for (const key of Reflect.ownKeys(this.listeners)) {
      Reflect.deleteProperty(this.listeners, key);
    }
  }
}

/** Caller cancellation stops waiting; it does not falsely promise rollback of a mutation. */
export function cancellable<T>(
  operation: () => Promise<T>,
  options: CallOptions = {},
  context?: AbortSignal,
): Promise<T> {
  const signal = context
    ? AbortSignal.any([context, ...(options.signal ? [options.signal] : [])])
    : options.signal;

  if (signal?.aborted) {
    return Promise.reject(new DeviceError('CANCELLED'));
  }

  return new Promise<T>((resolve, reject): void => {
    const cancel = (): void => reject(new DeviceError('CANCELLED'));

    signal?.addEventListener('abort', cancel, { once: true });

    try {
      void operation()
        .then(resolve, reject)
        .finally((): void => signal?.removeEventListener('abort', cancel));
    } catch (cause) {
      signal?.removeEventListener('abort', cancel);
      reject(cause);
    }
  });
}

function freeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    for (const key of Reflect.ownKeys(value)) {
      freeze(Reflect.get(value, key));
    }

    Object.freeze(value);
  }

  return value;
}

/** One immutable state cache and revision per adapter; no native revision leaks across cycles. */
export class StateSource<T extends Versioned> {
  private state: T;
  private readonly events = new Events<{ changed: T }>();

  constructor(initial: T) {
    this.state = freeze(initial);
  }

  getSnapshot = (): T => this.state;
  getState = async (options: CallOptions = {}): Promise<T> => {
    if (options.signal?.aborted) {
      throw new DeviceError('CANCELLED');
    }

    return this.state;
  };

  on(listener: (value: T) => void): Unsubscribe {
    return this.events.on('changed', listener);
  }

  set(next: T): T {
    const value = { ...next, revision: this.state.revision };

    if (JSON.stringify(value) === JSON.stringify(this.state)) {
      return this.state;
    }

    if (this.state.revision === Number.MAX_SAFE_INTEGER) {
      throw new DeviceError('INTEGRATION_ERROR');
    }

    this.state = freeze({ ...value, revision: this.state.revision + 1 });
    this.events.emit('changed', this.state);

    return this.state;
  }

  stop(): void {
    this.events.clear();
  }
}

import { pwaSupported, registerPwa } from './pwa';

export const updateLock = 'gchat-frontend-update';

export const updateChannel = 'gchat-frontend-update';

export const prepareUpdate = 'gchat-prepare-update';

export interface UpdateState {
  available: boolean;
  pending: boolean;
  applying?: boolean;
  error: string;
}

let state: UpdateState = { available: false, pending: false, error: '' };
const listeners = new Set<() => void>();
let waiting: ServiceWorker | null = null;
let started = false;
let generation = 0;
let controller = new AbortController();
const cleanup: (() => void)[] = [];

export function stopUpdates(): void {
  generation++;
  started = false;
  controller.abort();

  for (const stop of cleanup.splice(0)) {
    stop();
  }

  waiting = null;
  set({ available: false, pending: false, applying: false, error: '' });
}

function set(patch: Partial<UpdateState>): void {
  state = { ...state, ...patch };

  for (const listener of listeners) {
    listener();
  }
}

export const updateSnapshot = (): UpdateState => state;

export function subscribeUpdate(listener: () => void): () => void {
  listeners.add(listener);

  return (): void => {
    listeners.delete(listener);
  };
}

export async function updateRequested(): Promise<boolean> {
  const locks = await navigator.locks.query();

  const { held: locksHeld, pending: locksPending } = locks;

  return [...(locksHeld ?? []), ...(locksPending ?? [])].some(
    (lock): boolean => lock.name === updateLock && lock.mode === 'exclusive',
  );
}

export function startUpdates(): void {
  if (started || !pwaSupported()) {
    return;
  }

  started = true;
  controller = new AbortController();
  const current = ++generation;
  const channel = new BroadcastChannel(updateChannel);

  channel.onmessage = (event: MessageEvent<unknown>): void => {
    if (event.data === 'prepare') {
      set({ pending: true });
    }
  };
  const heartbeat = setInterval((): void => {
    if (state.pending) {
      void (async () => {
        try {
          const pending = await updateRequested();

          if (!pending) {
            set({ pending: false });
          }
        } catch (cause) {}
      })();
    }
  }, 1000);

  cleanup.push((): void => {
    clearInterval(heartbeat);
    channel.close();
  });
  let controlled = !!navigator.serviceWorker.controller;

  const controlledChange = (): void => {
    // First installation claims open clients too; only replacement reloads them.
    if (controlled || state.pending) {
      window.location.reload();
    }

    controlled = true;
  };

  navigator.serviceWorker.addEventListener('controllerchange', controlledChange);
  cleanup.push((): void =>
    navigator.serviceWorker.removeEventListener('controllerchange', controlledChange),
  );
  void (async () => {
    try {
      const registration = await registerPwa();

      if (current !== generation) {
        return;
      }

      const inspect = (): void => {
        const { waiting: registrationWaiting } = registration;

        waiting = registrationWaiting;
        set({ available: !!waiting });
      };

      inspect();
      const update = (): void => {
        void (async () => {
          try {
            const { update: registrationUpdate } = registration;

            return await registrationUpdate.bind(registration)();
          } catch (cause) {}
        })();
      };
      const visible = (): void => {
        if (document.visibilityState === 'visible') {
          update();
        }
      };
      const found = (): void => {
        const { installing: registrationInstalling } = registration;
        const installing = registrationInstalling;

        installing?.addEventListener('statechange', inspect);
        cleanup.push((): void => installing?.removeEventListener('statechange', inspect));
      };

      const { addEventListener: registrationAddEventListener } = registration;

      registrationAddEventListener.bind(registration)('updatefound', found);
      window.addEventListener('online', update);
      document.addEventListener('visibilitychange', visible);
      cleanup.push((): void => {
        const { removeEventListener: registrationRemoveEventListener } = registration;

        registrationRemoveEventListener.bind(registration)('updatefound', found);
        window.removeEventListener('online', update);
        document.removeEventListener('visibilitychange', visible);
      });
    } catch (cause) {
      if (current !== generation) {
        return;
      }

      set({ error: 'Не удалось подготовить офлайн-режим. Перезагрузите страницу для повтора.' });
    }
  })();
}

export async function applyUpdate(): Promise<void> {
  if (!waiting || state.pending) {
    return;
  }

  const worker = waiting;
  const signal = controller.signal;
  const current = generation;

  set({ pending: true, error: '' });
  const channel = new BroadcastChannel(updateChannel);
  const notify = (): void => {
    channel.postMessage('prepare');
    window.dispatchEvent(new Event(prepareUpdate));
  };
  // Queue the exclusive request before asking current owners to release their shared locks.
  const request = navigator.locks.request(updateLock, { signal }, async (): Promise<void> => {
    set({ applying: true });

    if (worker.state !== 'installed') {
      throw new Error('Сборка уже изменилась. Перезагрузите страницу.');
    }

    await new Promise<void>((resolve, reject): void => {
      const cancel = (): void => {
        worker.removeEventListener('statechange', changed);
        reject(new DOMException('Cancelled', 'AbortError'));
      };

      signal.addEventListener('abort', cancel, { once: true });
      const changed = (): void => {
        if (worker.state === 'activated' || worker.state === 'redundant') {
          worker.removeEventListener('statechange', changed);
          signal.removeEventListener('abort', cancel);

          if (worker.state === 'redundant') {
            reject(new Error('Не удалось активировать обновление.'));
          } else {
            resolve();
          }
        }
      };

      worker.addEventListener('statechange', changed);
      worker.postMessage({ type: 'GCHAT_ACTIVATE' });
    });
    window.location.reload();
    // Retain exclusion until this document is actually destroyed by navigation.
    await new Promise<void>((resolve): void => {
      if (signal.aborted) {
        resolve();
      } else {
        signal.addEventListener('abort', (): void => resolve(), { once: true });
      }
    });
  });

  notify();
  const timer = setInterval(notify, 500);

  try {
    await request;
  } catch (cause) {
    if (current !== generation || signal.aborted) {
      return;
    }

    set({
      applying: false,
      pending: false,
      error: cause instanceof Error ? cause.message : 'Не удалось обновить GChat.',
    });
  } finally {
    clearInterval(timer);
    channel.close();
    window.dispatchEvent(new Event('gchat-update-finished'));
  }
}

import { pwaSupported, registerPwa } from './pwa';

export const updateLock = 'gchat-frontend-update';

export const updateChannel = 'gchat-frontend-update';

export const prepareUpdate = 'gchat-prepare-update';

export interface UpdateState {
  available: boolean;
  pending: boolean;
  error: string;
}

let state: UpdateState = { available: false, pending: false, error: '' };
const listeners = new Set<() => void>();
let waiting: ServiceWorker | null = null;
let started = false;

function set(patch: Partial<UpdateState>): void {
  state = { ...state, ...patch };

  for (const listener of listeners) listener();
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

  return [...(locks.held ?? []), ...(locks.pending ?? [])].some(
    (lock): boolean => lock.name === updateLock && lock.mode === 'exclusive',
  );
}

export function startUpdates(): void {
  if (started || !pwaSupported()) return;

  started = true;
  const channel = new BroadcastChannel(updateChannel);

  channel.onmessage = (event: MessageEvent<unknown>): void => {
    if (event.data === 'prepare') set({ pending: true });
  };
  setInterval((): void => {
    if (state.pending)
      void updateRequested()
        .then((pending): void => {
          if (!pending) set({ pending: false });
        })
        .catch((): void => {});
  }, 1000);
  let controlled = !!navigator.serviceWorker.controller;

  navigator.serviceWorker.addEventListener('controllerchange', (): void => {
    // First installation claims open clients too; only replacement reloads them.
    if (controlled || state.pending) window.location.reload();

    controlled = true;
  });
  void registerPwa()
    .then((registration): void => {
      const inspect = (): void => {
        waiting = registration.waiting;
        set({ available: !!waiting });
      };

      inspect();
      registration.addEventListener('updatefound', (): void => {
        registration.installing?.addEventListener('statechange', inspect);
      });
      window.addEventListener('online', (): void => {
        void registration.update().catch((): void => {});
      });
      document.addEventListener('visibilitychange', (): void => {
        if (document.visibilityState === 'visible')
          void registration.update().catch((): void => {});
      });
    })
    .catch((): void => {
      set({ error: 'Не удалось подготовить офлайн-режим. Перезагрузите страницу для повтора.' });
    });
}

export async function applyUpdate(): Promise<void> {
  if (!waiting || state.pending) return;

  const worker = waiting;

  set({ pending: true, error: '' });
  const channel = new BroadcastChannel(updateChannel);
  const notify = (): void => {
    channel.postMessage('prepare');
    window.dispatchEvent(new Event(prepareUpdate));
  };
  // Queue the exclusive request before asking current owners to release their shared locks.
  const request = navigator.locks.request(updateLock, async (): Promise<void> => {
    if (worker.state !== 'installed')
      throw new Error('Сборка уже изменилась. Перезагрузите страницу.');

    await new Promise<void>((resolve, reject): void => {
      const changed = (): void => {
        if (worker.state === 'activated' || worker.state === 'redundant') {
          worker.removeEventListener('statechange', changed);

          if (worker.state === 'redundant')
            reject(new Error('Не удалось активировать обновление.'));
          else resolve();
        }
      };

      worker.addEventListener('statechange', changed);
      worker.postMessage({ type: 'GCHAT_ACTIVATE' });
    });
    window.location.reload();
    // Retain exclusion until this document is actually destroyed by navigation.
    await new Promise<void>((): void => {});
  });

  notify();
  const timer = setInterval(notify, 500);

  try {
    await request;
  } catch (cause) {
    set({
      pending: false,
      error: cause instanceof Error ? cause.message : 'Не удалось обновить GChat.',
    });
  } finally {
    clearInterval(timer);
    channel.close();
    window.dispatchEvent(new Event('gchat-update-finished'));
  }
}

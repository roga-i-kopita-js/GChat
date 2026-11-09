import { cancellable } from './device/events';
import { pwaSupported } from './pwa';
import { updateLock } from './pwa-update';

export interface FrontendUpdateLease {
  ready: Promise<void>;
  release(): void;
}

let references = 0;
let controller: AbortController | null = null;
let releaseLock: (() => void) | null = null;
let ready: Promise<void> | null = null;
let generation = 0;

/** Borrow the document's held lock: acquiring another shared lock behind a queued updater can deadlock. */
export function retainFrontendUpdate(): FrontendUpdateLease {
  if (!pwaSupported()) {
    return { ready: Promise.resolve(), release: (): void => {} };
  }

  references++;

  if (!controller) {
    const current = ++generation;
    const abort = new AbortController();

    controller = abort;
    let acquired!: () => void;
    let failed!: (cause: unknown) => void;

    ready = new Promise<void>((resolve, reject): void => {
      acquired = resolve;
      failed = reject;
    });
    void (async () => {
      try {
        return await ready;
      } catch (cause) {}
    })();
    void (async () => {
      try {
        return await navigator.locks.request(
          updateLock,
          { mode: 'shared', signal: abort.signal },
          async (): Promise<void> => {
            if (current !== generation || !references) {
              return;
            }

            acquired();
            await new Promise<void>((resolve): void => {
              releaseLock = resolve;
            });
          },
        );
      } catch (cause) {
        return failed(cause);
      }
    })();
  }

  const acquired = ready!;
  let released = false;

  return {
    ready: acquired,
    release: (): void => {
      if (released) {
        return;
      }

      released = true;
      references--;

      if (!references) {
        generation++;
        controller?.abort();
        controller = null;
        releaseLock?.();
        releaseLock = null;
        ready = null;
      }
    },
  };
}

export async function withFrontendUpdate<T>(
  operation: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const lease = retainFrontendUpdate();

  try {
    await cancellable((): Promise<void> => lease.ready, { signal });
    signal?.throwIfAborted();

    return await operation();
  } finally {
    lease.release();
  }
}

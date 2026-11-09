import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { retainFrontendUpdate, withFrontendUpdate } from './frontend-update-lease';
vi.mock('./pwa', (): object => ({ pwaSupported: (): boolean => true }));
let owner: (() => Promise<void>) | null = null;
let request: ReturnType<typeof vi.fn>;

beforeEach((): void => {
  owner = null;
  request = vi.fn(
    (_name: string, options: { signal: AbortSignal }, run: () => Promise<void>): Promise<void> =>
      new Promise((resolve, reject): void => {
        owner = async (): Promise<void> => {
          await run();
          resolve();
        };
        options.signal.addEventListener(
          'abort',
          (): void => {
            if (!owner) {
              reject(new DOMException('Aborted', 'AbortError'));
            }
          },
          { once: true },
        );
      }),
  );
  vi.stubGlobal('navigator', { locks: { request } });
});
afterEach((): void => {
  vi.unstubAllGlobals();
});

describe('frontend update lease', (): void => {
  it('borrows the already held lock for an action even when an updater could be queued', async (): Promise<void> => {
    const form = retainFrontendUpdate();
    const done = owner!();

    await form.ready;
    const action = retainFrontendUpdate();

    await action.ready;
    expect(request).toHaveBeenCalledTimes(1);
    let released = false;

    void (async () => {
      await done;

      released = true;
    })();
    form.release();
    await Promise.resolve();
    expect(released).toBe(false);
    action.release();
    await done;
    expect(released).toBe(true);
    action.release();
  });
  it('keeps an operation protected after its form unmounts and passes the lease to credentials before releasing it', async (): Promise<void> => {
    const form = retainFrontendUpdate();
    const done = owner!();

    await form.ready;
    let resolve!: () => void;
    let credentials: ReturnType<typeof retainFrontendUpdate> | null = null;
    let started!: () => void;
    const beginning = new Promise<void>((done): void => {
      started = done;
    });
    const pending = withFrontendUpdate(async (): Promise<void> => {
      started();
      await new Promise<void>((finish): void => {
        resolve = finish;
      });
      credentials = retainFrontendUpdate();
    });

    await beginning;
    form.release();
    resolve();
    await pending;
    expect(request).toHaveBeenCalledTimes(1);
    expect(credentials).not.toBeNull();

    if (credentials) {
      (credentials as ReturnType<typeof retainFrontendUpdate>).release();
    }

    await done;
  });
});

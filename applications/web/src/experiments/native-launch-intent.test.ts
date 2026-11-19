import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { consumeNativeLaunchIntent, watchNativeLaunchIntent } from './native-launch-intent';

function fixture(): any {
  let marker: unknown;
  const page = new EventTarget();
  const document = Object.assign(new EventTarget(), { visibilityState: 'visible' });
  const controller = {};
  const worker = Object.assign(new EventTarget(), { controller });
  const assign = vi.fn();
  const cache = {
    match: vi.fn(async (): Promise<Response | undefined> =>
      marker === undefined ? undefined : new Response(JSON.stringify(marker)),
    ),
    delete: vi.fn(async (): Promise<boolean> => {
      marker = undefined;

      return true;
    }),
  };
  const storage = { open: vi.fn().mockResolvedValue(cache) };

  vi.stubGlobal('caches', storage);
  vi.stubGlobal('window', {
    location: { origin: 'https://gchat.example', assign },
    addEventListener: page.addEventListener.bind(page),
    setInterval,
    clearInterval,
  });
  vi.stubGlobal('document', document);
  vi.stubGlobal('navigator', { serviceWorker: worker });

  return {
    page,
    document,
    worker,
    controller,
    assign,
    cache,
    storage,
    put: (value: unknown): void => {
      marker = value;
    },
  };
}

describe('experimental native launch click recovery', (): void => {
  beforeEach((): void => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-17T07:00:00Z'));
  });
  afterEach((): void => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it.each(['/calls', '/apps/client/calls'])(
    'recovers a cold PWA start without a query and consumes the click once: %s',
    async (startUrl): Promise<void> => {
      const f = fixture();

      f.put({ createdAt: Date.now() - 1000, url: 'https://other.example' });
      expect(await watchNativeLaunchIntent(startUrl)).toBe(true);
      expect(f.assign).toHaveBeenCalledExactlyOnceWith(startUrl + '?native_launch_spike=1');
      expect(await consumeNativeLaunchIntent()).toBe(false);
    },
  );
  it.each([undefined, {}, { createdAt: 'now' }, { createdAt: 0 }, { createdAt: Infinity }])(
    'does not launch for absent, malformed or expired markers: %j',
    async (marker): Promise<void> => {
      const f = fixture();

      f.put(marker);
      expect(await watchNativeLaunchIntent('/calls')).toBe(false);
      await vi.advanceTimersByTimeAsync(16_000);
      expect(f.assign).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    },
  );
  it('rejects future and older-than-30-second markers', async (): Promise<void> => {
    const f = fixture();

    for (const createdAt of [Date.now() + 1, Date.now() - 30_001]) {
      f.put({ createdAt });
      expect(await consumeNativeLaunchIntent()).toBe(false);
    }
  });
  it('does not relaunch native after the direct launch page consumes its marker', async (): Promise<void> => {
    const f = fixture();

    f.put({ createdAt: Date.now() });
    expect(await consumeNativeLaunchIntent()).toBe(true);
    expect(await watchNativeLaunchIntent('/calls')).toBe(false);
    await vi.advanceTimersByTimeAsync(16_000);
    expect(f.assign).not.toHaveBeenCalled();
  });
  it('recovers on resume but does not consume a marker while hidden', async (): Promise<void> => {
    const f = fixture();

    f.document.visibilityState = 'hidden';
    f.put({ createdAt: Date.now() });
    expect(await watchNativeLaunchIntent('/calls')).toBe(false);
    expect(f.cache.delete).not.toHaveBeenCalled();
    f.document.visibilityState = 'visible';
    f.document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(0);
    expect(f.assign).toHaveBeenCalledExactlyOnceWith('/calls?native_launch_spike=1');
  });
  it('accepts a wake-up message only from the controlling service worker and still needs a marker', async (): Promise<void> => {
    const f = fixture();

    await watchNativeLaunchIntent('/calls');
    const message = (source: unknown): Event =>
      Object.assign(new Event('message'), {
        source,
        data: { type: 'gchat.launch-spike.clicked' },
      });

    f.worker.dispatchEvent(message(f.controller));
    await vi.advanceTimersByTimeAsync(0);
    expect(f.assign).not.toHaveBeenCalled();
    f.put({ createdAt: Date.now() });
    f.worker.dispatchEvent(message({}));
    await vi.advanceTimersByTimeAsync(0);
    expect(f.assign).not.toHaveBeenCalled();
    f.worker.dispatchEvent(message(f.controller));
    await vi.advanceTimersByTimeAsync(0);
    expect(f.assign).toHaveBeenCalledTimes(1);
    f.worker.dispatchEvent(message(f.controller));
    await vi.advanceTimersByTimeAsync(0);
    expect(f.assign).toHaveBeenCalledTimes(1);
  });
  it('recovers a marker written after the PWA cold start', async (): Promise<void> => {
    const f = fixture();

    expect(await watchNativeLaunchIntent('/calls')).toBe(false);
    f.put({ createdAt: Date.now() });
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.assign).toHaveBeenCalledExactlyOnceWith('/calls?native_launch_spike=1');
  });
  it('leaves the Web client available when CacheStorage is unavailable', async (): Promise<void> => {
    const f = fixture();

    f.storage.open.mockRejectedValue(new Error('storage unavailable'));
    expect(await watchNativeLaunchIntent('/calls')).toBe(false);
    expect(f.assign).not.toHaveBeenCalled();
  });
});

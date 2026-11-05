import { afterEach, describe, expect, it, vi } from 'vitest';

import { readyPwa } from './pwa';
import { syncWebPush, vapidKey } from './web-push';

vi.mock('./pwa', (): object => ({ readyPwa: vi.fn() }));

function fixture(): any {
  const key = btoa(String.fromCharCode(4, 1, 2));
  const subscription = {
    options: { applicationServerKey: vapidKey(key).buffer },
    toJSON: (): object => ({
      endpoint: 'https://push.example/sub',
      keys: { p256dh: 'public', auth: 'auth' },
    }),
    unsubscribe: vi.fn().mockResolvedValue(true),
  };
  const manager = {
    getSubscription: vi.fn().mockResolvedValue(subscription),
    subscribe: vi.fn().mockResolvedValue(subscription),
  };

  vi.mocked(readyPwa).mockResolvedValue({ pushManager: manager } as any);
  vi.stubGlobal('navigator', {
    locks: { request: (_name: string, callback: () => unknown): unknown => callback() },
  });
  vi.stubGlobal('Notification', { permission: 'granted' });

  return { key, subscription, manager, send: vi.fn().mockResolvedValue({}) };
}

afterEach((): void => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('Web Push session recovery', (): void => {
  it('rebinds existing consent without requesting permission or replacing the subscription', async (): Promise<void> => {
    const f = fixture();

    expect(await syncWebPush(f.key, (): boolean => true, f.send)).toBe(true);
    expect(f.manager.subscribe).not.toHaveBeenCalled();
    expect(f.subscription.unsubscribe).not.toHaveBeenCalled();
    expect(f.send).toHaveBeenCalledWith({
      endpoint: 'https://push.example/sub',
      p256dh: 'public',
      auth: 'auth',
    });
  });
  it('removes the old server binding and replaces subscriptions after VAPID rotation', async (): Promise<void> => {
    const f = fixture();

    f.subscription.options.applicationServerKey = new Uint8Array([4, 9, 9]).buffer;
    expect(await syncWebPush(f.key, (): boolean => true, f.send)).toBe(true);
    expect(f.send.mock.calls[0]).toEqual([null]);
    expect(f.subscription.unsubscribe).toHaveBeenCalledOnce();
    expect(f.manager.subscribe).toHaveBeenCalledWith({
      userVisibleOnly: true,
      applicationServerKey: vapidKey(f.key),
    });
    expect(f.send).toHaveBeenCalledTimes(2);
  });
  it('does not apply a delayed result to another session', async (): Promise<void> => {
    const f = fixture();
    let current = true;

    f.manager.getSubscription.mockImplementation(async (): Promise<unknown> => {
      current = false;

      return f.subscription;
    });
    expect(await syncWebPush(f.key, (): boolean => current, f.send)).toBe(false);
    expect(f.send).not.toHaveBeenCalled();
    expect(f.manager.subscribe).not.toHaveBeenCalled();
  });
  it('leaves notifications disabled and supports explicit retry after a browser failure', async (): Promise<void> => {
    const f = fixture();

    f.subscription.options.applicationServerKey = new Uint8Array([4, 9, 9]).buffer;
    f.manager.subscribe.mockRejectedValueOnce(new Error('browser refused'));
    await expect(syncWebPush(f.key, (): boolean => true, f.send)).rejects.toThrow(
      'browser refused',
    );
    f.manager.getSubscription.mockResolvedValue(null);
    expect(await syncWebPush(f.key, (): boolean => true, f.send, true)).toBe(true);
  });
  it('never bypasses denied notification permission', async (): Promise<void> => {
    const f = fixture();

    vi.stubGlobal('Notification', { permission: 'denied' });
    f.manager.getSubscription.mockResolvedValue(null);
    expect(await syncWebPush(f.key, (): boolean => true, f.send, true)).toBe(false);
    expect(f.manager.subscribe).not.toHaveBeenCalled();
  });
});

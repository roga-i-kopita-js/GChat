import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

import { describe, expect, it, vi } from 'vitest';

function fixture(server = true, nativeLaunchSpike = false): any {
  const handlers: Record<string, (event: any) => void> = {};
  const base = server ? '/apps/' : '/';
  const startPath = server ? '/apps/client' : '';
  const config = {
    cacheName: 'gchat-shell-server-new',
    cachePrefix: 'gchat-shell-server-',
    assets: [`${base}static/main.js`],
    html: '<html>new build</html>',
    startUrl: `${startPath}/calls`,
    startPath,
    scope: server ? '/apps/client' : '/',
    icon: `${base}icons/icon-192.png`,
    nativeLaunchSpike,
  };
  const cache = { put: vi.fn(), match: vi.fn().mockResolvedValue(new Response('cached')) };
  const caches = {
    open: vi.fn().mockResolvedValue(cache),
    delete: vi.fn(),
    keys: vi
      .fn()
      .mockResolvedValue(['gchat-shell-server-old', config.cacheName, 'unrelated-cache']),
  };
  const self = {
    location: { origin: 'https://gchat.example' },
    addEventListener: (name: string, handler: any): void => {
      handlers[name] = handler;
    },
    registration: { showNotification: vi.fn() },
    skipWaiting: vi.fn(),
    clients: { claim: vi.fn(), matchAll: vi.fn().mockResolvedValue([]), openWindow: vi.fn() },
  };
  const fetch = vi
    .fn()
    .mockResolvedValue(new Response('script', { headers: { 'Content-Type': 'text/javascript' } }));

  runInNewContext(
    readFileSync(new URL('./worker.js', import.meta.url), 'utf8').replace(
      '__GCHAT_PWA__',
      JSON.stringify(config),
    ),
    { self, caches, fetch, URL, Response, Set, Date },
  );
  const dispatch = async (name: string, event: any = {}): Promise<void> => {
    let pending;

    handlers[name]({
      waitUntil: (p: Promise<void>): void => {
        pending = p;
      },
      ...event,
    });
    await pending;
  };

  return { handlers, cache, caches, self, fetch, dispatch, config };
}

describe('PWA worker', (): void => {
  it.each([true, false])(
    'opens the fixed native launch page for experimental call notifications (%s)',
    async (server): Promise<void> => {
      const f = fixture(server, true);
      const focus = vi.fn();

      f.self.clients.matchAll.mockResolvedValue([
        { url: `https://gchat.example${f.config.startUrl}`, focus },
      ]);
      await f.dispatch('notificationclick', {
        notification: { close: vi.fn(), data: { url: 'https://other.example/' } },
      });
      expect(f.self.clients.openWindow).toHaveBeenCalledExactlyOnceWith(
        `https://gchat.example${f.config.startUrl}?native_launch_spike=1`,
      );
      expect(focus).not.toHaveBeenCalled();
      const stored = f.cache.put.mock.calls[0];

      expect(stored[0]).toBe('https://gchat.example/__gchat_launch_spike_intent');
      expect(await stored[1].json()).toEqual({ createdAt: expect.any(Number) });
    },
  );
  it('still opens the native launch page if storing the click intent fails', async (): Promise<void> => {
    const f = fixture(true, true);
    const postMessage = vi.fn();

    f.caches.open.mockRejectedValue(new Error('storage unavailable'));
    f.self.clients.openWindow.mockResolvedValue({ postMessage });
    await f.dispatch('notificationclick', { notification: { close: vi.fn() } });
    expect(f.self.clients.openWindow).toHaveBeenCalledExactlyOnceWith(
      'https://gchat.example/apps/client/calls?native_launch_spike=1',
    );
    expect(postMessage).toHaveBeenCalledWith({ type: 'gchat.launch-spike.clicked' });
  });
  it('preserves dialog notification navigation in the experimental build', async (): Promise<void> => {
    const f = fixture(true, true);
    const id = '00000000-0000-0000-0000-000000000001';

    await f.dispatch('notificationclick', {
      notification: { close: vi.fn(), data: { dialogId: id } },
    });
    expect(f.self.clients.openWindow).toHaveBeenCalledExactlyOnceWith(
      `https://gchat.example/apps/client/calls?dialog_id=${id}`,
    );
  });
  it('installs a complete shell and removes only old GChat caches on activation', async (): Promise<void> => {
    const f = fixture();

    await f.dispatch('install');
    expect(f.cache.put).toHaveBeenCalledTimes(2);
    await f.dispatch('activate');
    expect(f.caches.delete).toHaveBeenCalledExactlyOnceWith('gchat-shell-server-old');
  });
  it('activates early only after an explicit update command', async (): Promise<void> => {
    const f = fixture();

    await f.dispatch('install');
    expect(f.self.skipWaiting).not.toHaveBeenCalled();
    await f.dispatch('message', { data: { type: 'unknown' } });
    expect(f.self.skipWaiting).not.toHaveBeenCalled();
    await f.dispatch('message', { data: { type: 'GCHAT_ACTIVATE' } });
    expect(f.self.skipWaiting).toHaveBeenCalledOnce();
  });
  it('rejects a partial deployment and discards its cache', async (): Promise<void> => {
    const f = fixture();

    f.fetch.mockResolvedValue(
      new Response('SPA fallback', { headers: { 'Content-Type': 'text/html' } }),
    );
    await expect(f.dispatch('install')).rejects.toThrow('Incomplete frontend deployment');
    expect(f.caches.delete).toHaveBeenCalledWith(f.config.cacheName);
  });
  it.each([true, false])(
    'caches frontend navigation but never API, cross-origin or non-GET requests (%s)',
    async (server): Promise<void> => {
      const f = fixture(server);
      const respondWith = vi.fn();

      for (const request of [
        { url: 'https://gchat.example/api/auth/me', mode: 'cors', method: 'GET' },
        { url: 'https://gchat.example/api/auth/me', mode: 'navigate', method: 'GET' },
        { url: 'https://gchat.example/ws', mode: 'navigate', method: 'GET' },
        { url: 'https://other.example/apps/client/calls', mode: 'navigate', method: 'GET' },
        { url: 'https://gchat.example/apps/client/calls', mode: 'navigate', method: 'POST' },
      ]) {
        f.handlers.fetch({ request, respondWith });
      }

      expect(respondWith).not.toHaveBeenCalled();
      f.handlers.fetch({
        request: {
          url: `https://gchat.example${f.config.startUrl}`,
          mode: 'navigate',
          method: 'GET',
        },
        respondWith,
      });
      expect(await respondWith.mock.calls[0][0]).toBeInstanceOf(Response);
      expect(f.cache.match).toHaveBeenCalledWith(`https://gchat.example${f.config.startUrl}`);
    },
  );
  it('replaces duplicate call notifications and uses a visible fallback for late pushes', async (): Promise<void> => {
    const f = fixture();
    const call_id = '11111111-1111-4111-8111-111111111111';

    await f.dispatch('push', {
      data: {
        json: (): object => ({
          call_id,
          ringing_deadline: new Date(Date.now() + 60000).toISOString(),
        }),
      },
    });
    expect(f.self.registration.showNotification).toHaveBeenLastCalledWith(
      'GChat',
      expect.objectContaining({
        tag: `gchat-call-${call_id}`,
        renotify: true,
        body: expect.stringContaining('Входящий звонок'),
      }),
    );
    await f.dispatch('push', {
      data: { json: (): object => ({ call_id, ringing_deadline: new Date(0).toISOString() }) },
    });
    expect(f.self.registration.showNotification).toHaveBeenLastCalledWith(
      'GChat',
      expect.objectContaining({
        body: expect.stringContaining('проверить звонки'),
        renotify: false,
      }),
    );
  });
  it.each([true, false])(
    'shows the caller name as the notification title (%s)',
    async (server): Promise<void> => {
      const f = fixture(server);

      await f.dispatch('push', {
        data: {
          json: (): object => ({
            call_id: '11111111-1111-4111-8111-111111111111',
            ringing_deadline: new Date(Date.now() + 60000).toISOString(),
            caller_display_name: '  Андрей  ',
          }),
        },
      });
      expect(f.self.registration.showNotification).toHaveBeenCalledWith(
        'Андрей',
        expect.objectContaining({
          body: 'Входящий звонок',
          renotify: true,
        }),
      );
    },
  );
  it.each([undefined, null, 42, {}, '', '   ', 'я'.repeat(81)])(
    'uses the general call text for a missing or invalid name (%s)',
    async (name): Promise<void> => {
      const f = fixture();

      await f.dispatch('push', {
        data: {
          json: (): object => ({
            call_id: '11111111-1111-4111-8111-111111111111',
            ringing_deadline: new Date(Date.now() + 60000).toISOString(),
            caller_display_name: name,
          }),
        },
      });
      expect(f.self.registration.showNotification).toHaveBeenCalledWith(
        'GChat',
        expect.objectContaining({
          body: 'Входящий звонок. Откройте GChat, чтобы ответить.',
        }),
      );
    },
  );
  it.each(['11111111-1111-4111-8111-111111111111', 'invalid'])(
    'hides the caller name for late or invalid calls (%s)',
    async (call_id): Promise<void> => {
      const f = fixture();

      await f.dispatch('push', {
        data: {
          json: (): object => ({
            call_id,
            ringing_deadline: new Date(
              call_id === 'invalid' ? Date.now() + 60000 : 0,
            ).toISOString(),
            caller_display_name: 'Андрей',
          }),
        },
      });
      expect(f.self.registration.showNotification).toHaveBeenCalledWith(
        'GChat',
        expect.objectContaining({
          body: 'Откройте GChat, чтобы проверить звонки.',
          renotify: false,
        }),
      );
    },
  );
  it('accepts an 80-code-point caller name', async (): Promise<void> => {
    const f = fixture();
    const name = '😀'.repeat(80);

    await f.dispatch('push', {
      data: {
        json: (): object => ({
          call_id: '11111111-1111-4111-8111-111111111111',
          ringing_deadline: new Date(Date.now() + 60000).toISOString(),
          caller_display_name: name,
        }),
      },
    });
    expect(f.self.registration.showNotification).toHaveBeenCalledWith(
      name,
      expect.objectContaining({
        body: 'Входящий звонок',
      }),
    );
  });
  it('shows message text with a per-message tag and forwards only a validated dialog intent', async (): Promise<void> => {
    const f = fixture();
    const id = '11111111-1111-4111-8111-111111111111';
    const message = '22222222-2222-4222-8222-222222222222';

    await f.dispatch('push', {
      data: {
        json: (): object => ({
          type: 'dialog.message',
          dialog_id: id,
          message_id: message,
          body: 'Тест уведомления',
          title: '  Андрей  ',
          url: 'https://evil.invalid',
        }),
      },
    });
    expect(f.self.registration.showNotification).toHaveBeenCalledWith(
      'Андрей',
      expect.objectContaining({
        body: 'Тест уведомления',
        tag: 'gchat-message-' + message,
        data: { dialogId: id },
      }),
    );
    const postMessage = vi.fn();
    const focus = vi.fn();

    f.self.clients.matchAll.mockResolvedValue([
      { url: 'https://gchat.example/apps/client/dialogs', postMessage, focus },
    ]);
    await f.dispatch('notificationclick', {
      notification: { close: vi.fn(), data: { dialogId: id, url: 'https://evil.invalid' } },
    });
    expect(focus).toHaveBeenCalledOnce();
    expect(postMessage).toHaveBeenCalledWith({ type: 'dialog.notification', dialogId: id });
    f.self.clients.matchAll.mockResolvedValue([]);
    await f.dispatch('notificationclick', {
      notification: { close: vi.fn(), data: { dialogId: id } },
    });
    expect(f.self.clients.openWindow).toHaveBeenCalledWith(
      'https://gchat.example/apps/client/calls?dialog_id=' + id,
    );
  });
  it.each([undefined, null, 42, {}, '', '  ', 'я'.repeat(81)])(
    'keeps message text and uses GChat for missing or invalid message titles (%s)',
    async (title): Promise<void> => {
      const f = fixture();

      await f.dispatch('push', {
        data: {
          json: (): object => ({
            type: 'dialog.message',
            dialog_id: '11111111-1111-4111-8111-111111111111',
            message_id: '22222222-2222-4222-8222-222222222222',
            title,
            body: 'Some text',
          }),
        },
      });
      expect(f.self.registration.showNotification).toHaveBeenCalledWith(
        'GChat',
        expect.objectContaining({
          body: 'Some text',
        }),
      );
    },
  );
  it('focuses an existing call client without reloading it and never follows payload URLs', async (): Promise<void> => {
    const f = fixture();
    const focus = vi.fn();

    f.self.clients.matchAll.mockResolvedValue([
      { url: 'https://gchat.example/apps/client/admin/users', focus },
    ]);
    await f.dispatch('notificationclick', {
      notification: { close: vi.fn(), data: { url: 'https://evil.example/' } },
    });
    expect(focus).toHaveBeenCalledOnce();
    expect(f.self.clients.openWindow).not.toHaveBeenCalled();
    f.self.clients.matchAll.mockResolvedValue([]);
    await f.dispatch('notificationclick', { notification: { close: vi.fn() } });
    expect(f.self.clients.openWindow).toHaveBeenCalledWith('/apps/client/calls');
  });
  it('does not focus an unrelated window on the root deployment origin', async (): Promise<void> => {
    const f = fixture(false);
    const focus = vi.fn();

    f.self.clients.matchAll.mockResolvedValue([{ url: 'https://gchat.example/api/docs', focus }]);
    await f.dispatch('notificationclick', { notification: { close: vi.fn() } });
    expect(focus).not.toHaveBeenCalled();
    expect(f.self.clients.openWindow).toHaveBeenCalledWith('/calls');
  });
});

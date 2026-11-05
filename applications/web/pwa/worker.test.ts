import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

import { describe, expect, it, vi } from 'vitest';

function fixture(server = true): any {
  const handlers: Record<string, (event: any) => void> = {};
  const base = server ? '/apps/' : '/';
  const startPath = server ? '/apps/client' : '';
  const config = { cacheName: 'gchat-shell-server-new', cachePrefix: 'gchat-shell-server-', assets: [`${base}static/main.js`], html: '<html>new build</html>', startUrl: `${startPath}/calls`, startPath, scope: server ? '/apps/client' : '/', icon: `${base}icons/icon-192.png` };
  const cache = { put: vi.fn(), match: vi.fn().mockResolvedValue(new Response('cached')) };
  const caches = { open: vi.fn().mockResolvedValue(cache), delete: vi.fn(), keys: vi.fn().mockResolvedValue(['gchat-shell-server-old', config.cacheName, 'unrelated-cache']) };
  const self = { location: { origin: 'https://gchat.example' }, addEventListener: (name: string, handler: any): void => { handlers[name] = handler; }, registration: { showNotification: vi.fn() }, clients: { matchAll: vi.fn().mockResolvedValue([]), openWindow: vi.fn() } };
  const fetch = vi.fn().mockResolvedValue(new Response('script', { headers: { 'Content-Type': 'text/javascript' } }));
  runInNewContext(readFileSync(new URL('./worker.js', import.meta.url), 'utf8').replace('__GCHAT_PWA__', JSON.stringify(config)), { self, caches, fetch, URL, Response, Set, Date });
  const dispatch = async (name: string, event: any = {}): Promise<void> => {
    let pending;
    handlers[name]({ waitUntil: (p: Promise<void>): void => { pending = p; }, ...event });
    await pending;
  };
  return { handlers, cache, caches, self, fetch, dispatch, config };
}

describe('PWA worker', (): void => {
  it('installs a complete shell and removes only old GChat caches on activation', async (): Promise<void> => {
    const f = fixture();
    await f.dispatch('install');
    expect(f.cache.put).toHaveBeenCalledTimes(2);
    await f.dispatch('activate');
    expect(f.caches.delete).toHaveBeenCalledExactlyOnceWith('gchat-shell-server-old');
  });
  it('rejects a partial deployment and discards its cache', async (): Promise<void> => {
    const f = fixture();
    f.fetch.mockResolvedValue(new Response('SPA fallback', { headers: { 'Content-Type': 'text/html' } }));
    await expect(f.dispatch('install')).rejects.toThrow('Incomplete frontend deployment');
    expect(f.caches.delete).toHaveBeenCalledWith(f.config.cacheName);
  });
  it.each([true, false])('caches frontend navigation but never API, cross-origin or non-GET requests (%s)', async (server): Promise<void> => {
    const f = fixture(server);
    const respondWith = vi.fn();
    for (const request of [
      { url: 'https://gchat.example/api/auth/me', mode: 'cors', method: 'GET' },
      { url: 'https://gchat.example/api/auth/me', mode: 'navigate', method: 'GET' },
      { url: 'https://gchat.example/ws', mode: 'navigate', method: 'GET' },
      { url: 'https://other.example/apps/client/calls', mode: 'navigate', method: 'GET' },
      { url: 'https://gchat.example/apps/client/calls', mode: 'navigate', method: 'POST' },
    ]) f.handlers.fetch({ request, respondWith });
    expect(respondWith).not.toHaveBeenCalled();
    f.handlers.fetch({ request: { url: `https://gchat.example${f.config.startUrl}`, mode: 'navigate', method: 'GET' }, respondWith });
    expect(await respondWith.mock.calls[0][0]).toBeInstanceOf(Response);
    expect(f.cache.match).toHaveBeenCalledWith(`https://gchat.example${f.config.startUrl}`);
  });
  it('replaces duplicate call notifications and uses a visible fallback for late pushes', async (): Promise<void> => {
    const f = fixture();
    const call_id = '11111111-1111-4111-8111-111111111111';
    await f.dispatch('push', { data: { json: (): object => ({ call_id, ringing_deadline: new Date(Date.now() + 60000).toISOString() }) } });
    expect(f.self.registration.showNotification).toHaveBeenLastCalledWith('GChat', expect.objectContaining({ tag: `gchat-call-${call_id}`, body: expect.stringContaining('Входящий звонок') }));
    await f.dispatch('push', { data: { json: (): object => ({ call_id, ringing_deadline: new Date(0).toISOString() }) } });
    expect(f.self.registration.showNotification).toHaveBeenLastCalledWith('GChat', expect.objectContaining({ body: expect.stringContaining('проверить звонки') }));
  });
  it('focuses an existing call client without reloading it and never follows payload URLs', async (): Promise<void> => {
    const f = fixture();
    const focus = vi.fn();
    f.self.clients.matchAll.mockResolvedValue([{ url: 'https://gchat.example/apps/client/admin/users', focus }]);
    await f.dispatch('notificationclick', { notification: { close: vi.fn(), data: { url: 'https://evil.example/' } } });
    expect(focus).toHaveBeenCalledOnce();
    expect(f.self.clients.openWindow).not.toHaveBeenCalled();
    f.self.clients.matchAll.mockResolvedValue([]);
    await f.dispatch('notificationclick', { notification: { close: vi.fn() } });
    expect(f.self.clients.openWindow).toHaveBeenCalledWith('/apps/client/calls');
  });
});

/* Values below are replaced by the Vite build. No session or API data enters this cache. */
const config = __GCHAT_PWA__;
const cacheName = config.cacheName;
const assetUrls = new Set(config.assets.map((path) => new URL(path, self.location.origin).href));
const startUrl = new URL(config.startUrl, self.location.origin).href;

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(cacheName);

      try {
        const results = await Promise.allSettled(
          [...assetUrls].map(async (url) => {
            const response = await fetch(url, { cache: 'reload', credentials: 'omit' });

            if (
              !response.ok ||
              response.redirected ||
              response.headers.get('content-type')?.includes('text/html')
            ) {
              throw new Error('Incomplete frontend deployment');
            }

            await cache.put(url, response);
          }),
        );

        if (results.some((result) => result.status === 'rejected'))
          throw new Error('Incomplete frontend deployment');

        await cache.put(
          startUrl,
          new Response(config.html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } }),
        );
      } catch (cause) {
        await caches.delete(cacheName);

        throw cause;
      }
    })(),
  );
  // Let existing tabs and calls finish before replacing their frontend version.
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'GCHAT_ACTIVATE') event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const prefix = config.cachePrefix;

      for (const key of await caches.keys()) {
        if (key.startsWith(prefix) && key !== cacheName) await caches.delete(key);
      }

      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;

  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  if (url.origin !== self.location.origin) return;

  const navigation =
    request.mode === 'navigate' &&
    (config.scope === '/'
      ? /^\/(?:$|calls(?:\/|$)|login(?:\/|$)|admin(?:\/|$))/.test(url.pathname)
      : url.pathname === config.startPath || url.pathname.startsWith(config.startPath + '/'));

  if (!navigation && !assetUrls.has(url.href)) return;

  event.respondWith(
    (async () => {
      const cache = await caches.open(cacheName);

      return (await cache.match(navigation ? startUrl : request)) ?? fetch(request);
    })(),
  );
});

self.addEventListener('push', (event) => {
  event.waitUntil(
    (async () => {
      let payload;

      try {
        payload = event.data?.json();
      } catch {
        /* Visible fallback for an invalid payload. */
      }

      const valid =
        typeof payload?.call_id === 'string' &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(payload.call_id);
      const expired = !valid || !(Date.parse(payload.ringing_deadline) > Date.now());

      await self.registration.showNotification('GChat', {
        body: expired
          ? 'Откройте GChat, чтобы проверить звонки.'
          : 'Входящий звонок. Откройте GChat, чтобы ответить.',
        icon: config.icon,
        badge: config.icon,
        tag: valid ? 'gchat-call-' + payload.call_id : 'gchat-calls',
        data: { url: config.startUrl },
      });
    })(),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const existing = windows.find((client) => {
        const url = new URL(client.url);

        return (
          url.origin === self.location.origin &&
          (config.scope === '/'
            ? /^\/(?:$|calls(?:\/|$)|login(?:\/|$)|admin(?:\/|$))/.test(url.pathname)
            : url.pathname === config.startPath || url.pathname.startsWith(config.startPath + '/'))
        );
      });

      if (existing) await existing.focus();
      else await self.clients.openWindow(config.startUrl);
    })(),
  );
});

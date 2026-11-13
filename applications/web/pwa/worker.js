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

            const {
              ok: responseOk,
              redirected: responseRedirected,
              headers: responseHeaders,
            } = response ?? {};

            if (
              !responseOk ||
              responseRedirected ||
              responseHeaders.get('content-type')?.includes('text/html')
            ) {
              throw new Error('Incomplete frontend deployment');
            }

            const { put: cachePut } = cache;

            await cachePut.bind(cache)(url, response);
          }),
        );

        const { some: resultsSome } = results;

        if (resultsSome.bind(results)((result) => result.status === 'rejected')) {
          throw new Error('Incomplete frontend deployment');
        }

        const { put: cachePut2 } = cache;

        await cachePut2.bind(cache)(
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
  if (event.data?.type === 'GCHAT_ACTIVATE') {
    event.waitUntil(self.skipWaiting());
  }
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const prefix = config.cachePrefix;

      for (const key of await caches.keys()) {
        if (key.startsWith(prefix) && key !== cacheName) {
          await caches.delete(key);
        }
      }

      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;

  if (request.method !== 'GET') {
    return;
  }

  const url = new URL(request.url);

  if (url.origin !== self.location.origin) {
    return;
  }

  const navigation =
    request.mode === 'navigate' &&
    (config.scope === '/'
      ? /^\/(?:$|calls(?:\/|$)|dialogs(?:\/|$)|settings(?:\/|$)|login(?:\/|$)|admin(?:\/|$))/.test(
          url.pathname,
        )
      : url.pathname === config.startPath || url.pathname.startsWith(config.startPath + '/'));

  if (!navigation && !assetUrls.has(url.href)) {
    return;
  }

  event.respondWith(
    (async () => {
      const cache = await caches.open(cacheName);

      const { match: cacheMatch } = cache;

      return (await cacheMatch.bind(cache)(navigation ? startUrl : request)) ?? fetch(request);
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

      const uuid = (value) =>
        typeof value === 'string' &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

      if (
        payload?.type === 'dialog.message' &&
        uuid(payload.dialog_id) &&
        uuid(payload.message_id) &&
        typeof payload.body === 'string'
      ) {
        const name = typeof payload.title === 'string' ? payload.title.trim() : '';
        const title = name && [...name].length <= 80 ? name : 'GChat';

        await self.registration.showNotification(title, {
          body: payload.body,
          icon: config.icon,
          badge: config.icon,
          tag: 'gchat-message-' + payload.message_id,
          data: { dialogId: payload.dialog_id },
        });

        return;
      }

      const valid =
        typeof payload?.call_id === 'string' &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(payload.call_id);
      const expired = !valid || !(Date.parse(payload.ringing_deadline) > Date.now());
      const name =
        typeof payload?.caller_display_name === 'string' ? payload.caller_display_name.trim() : '';
      const callerName = name && [...name].length <= 80 ? name : '';
      const callBody = callerName
        ? 'Входящий звонок'
        : 'Входящий звонок. Откройте GChat, чтобы ответить.';
      const title = !expired && callerName ? callerName : 'GChat';

      await self.registration.showNotification(title, {
        body: expired ? 'Откройте GChat, чтобы проверить звонки.' : callBody,
        icon: config.icon,
        badge: config.icon,
        tag: valid ? 'gchat-call-' + payload.call_id : 'gchat-calls',
        renotify: !expired,
        data: { url: config.startUrl },
      });
    })(),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    (async () => {
      if (config.nativeLaunchSpike && !event.notification.data?.dialogId) {
        const target = new URL(config.startUrl, self.location.origin);

        target.searchParams.set('native_launch_spike', '1');

        try {
          const intents = await caches.open('gchat-launch-spike-intents');

          const { put: intentsPut } = intents;

          await intentsPut.bind(intents)(
            new URL('/__gchat_launch_spike_intent', self.location.origin).href,
            new Response(JSON.stringify({ createdAt: Date.now() })),
          );
        } catch {
          // The original navigation can still work when persistent storage is unavailable.
        }

        const opened = await self.clients.openWindow(target.href);

        const { postMessage: openedPostMessage } = opened ?? {};

        openedPostMessage?.bind(opened)({ type: 'gchat.launch-spike.clicked' });

        return;
      }

      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const { find: windowsFind } = windows;
      const existing = windowsFind.bind(windows)((client) => {
        const url = new URL(client.url);

        return (
          url.origin === self.location.origin &&
          (config.scope === '/'
            ? /^\/(?:$|calls(?:\/|$)|dialogs(?:\/|$)|settings(?:\/|$)|login(?:\/|$)|admin(?:\/|$))/.test(
                url.pathname,
              )
            : url.pathname === config.startPath || url.pathname.startsWith(config.startPath + '/'))
        );
      });

      const id = event.notification.data?.dialogId;
      const validDialog =
        typeof id === 'string' &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);

      if (existing) {
        await existing.focus();

        if (validDialog) {
          existing.postMessage({ type: 'dialog.notification', dialogId: id });
        }
      } else {
        const target = new URL(config.startUrl, self.location.origin);

        if (validDialog) {
          target.searchParams.set('dialog_id', id);
        }

        await self.clients.openWindow(validDialog ? target.href : config.startUrl);
      }
    })(),
  );
});

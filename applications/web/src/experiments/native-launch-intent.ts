const cacheName = 'gchat-launch-spike-intents';

/** Consume only the short-lived notification click marker, never call or session data. */
export async function consumeNativeLaunchIntent(): Promise<boolean> {
  try {
    const cache = await caches.open(cacheName);
    const { match, delete: deleteEntry } = cache;
    const key = new URL('/__gchat_launch_spike_intent', window.location.origin).href;
    const response = await match.bind(cache)(key);

    if (!response) {
      return false;
    }

    await deleteEntry.bind(cache)(key);
    const { json } = response;
    const value: unknown = await json.bind(response)();

    if (typeof value !== 'object' || value === null || !('createdAt' in value)) {
      return false;
    }

    const { createdAt } = value;
    const age = typeof createdAt === 'number' ? Date.now() - createdAt : -1;

    return age >= 0 && age <= 30_000;
  } catch {
    // Storage failure must not prevent opening the ordinary Web client.
    return false;
  }
}

/** Recover when iOS opens the PWA start URL instead of the notification's launch URL. */
export async function watchNativeLaunchIntent(startUrl: string): Promise<boolean> {
  let reading = false;
  let redirected = false;
  const recover = async (): Promise<boolean> => {
    if (reading || redirected || document.visibilityState !== 'visible') {
      return redirected;
    }

    reading = true;

    try {
      if (await consumeNativeLaunchIntent()) {
        redirected = true;
        window.location.assign(startUrl + '?native_launch_spike=1');
      }

      return redirected;
    } finally {
      reading = false;
    }
  };

  window.addEventListener('pageshow', (): void => {
    void recover();
  });
  document.addEventListener('visibilitychange', (): void => {
    void recover();
  });
  navigator.serviceWorker?.addEventListener('message', (event: MessageEvent): void => {
    const controller = navigator.serviceWorker.controller;

    if (
      controller &&
      event.source === controller &&
      event.data?.type === 'gchat.launch-spike.clicked'
    ) {
      void recover();
    }
  });

  if (await recover()) {
    return true;
  }

  // Cover a cold start that becomes visible before notificationclick stores its marker.
  let checks = 0;
  const timer = window.setInterval((): void => {
    void recover();

    if (++checks >= 15 || redirected) {
      window.clearInterval(timer);
    }
  }, 1000);

  return false;
}

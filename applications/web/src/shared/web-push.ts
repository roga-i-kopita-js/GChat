import { z } from 'zod';

import { readyPwa } from './pwa';

export const pushConfig = z.object({ public_key: z.string().nullable() });

const addressSchema = z.object({ endpoint: z.string(), p256dh: z.string(), auth: z.string() });

export function vapidKey(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), (char): number =>
    char.charCodeAt(0),
  );
}

export function matchesVapid(subscription: PushSubscription, key: string): boolean {
  const actual = subscription.options.applicationServerKey;
  const expected = vapidKey(key);

  return (
    !!actual &&
    new Uint8Array(actual).length === expected.length &&
    new Uint8Array(actual).every((byte, index): boolean => byte === expected[index])
  );
}

/** Serialize browser mutations and reject results belonging to an old session/connection. */
export async function syncWebPush(
  key: string,
  current: () => boolean,
  send: (
    subscription: { endpoint: string; p256dh: string; auth: string } | null,
  ) => Promise<unknown>,
  create = false,
): Promise<boolean> {
  return navigator.locks.request('gchat-web-push', async (): Promise<boolean> => {
    const registration = await readyPwa();

    if (!current()) return false;

    let subscription = await registration.pushManager.getSubscription();

    if (!current()) return false;

    if (subscription && !matchesVapid(subscription, key)) {
      await send(null);

      if (!current()) return false;

      if (!(await subscription.unsubscribe()))
        throw new Error('Не удалось заменить подписку. Повторите попытку.');

      subscription = null;
      create = true;
    }

    if (!current()) return false;

    if (!subscription && create && Notification.permission === 'granted') {
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: vapidKey(key),
      });
    }

    if (!current()) return false;

    const json = subscription?.toJSON();

    await send(
      json
        ? addressSchema.parse({
            endpoint: json.endpoint,
            p256dh: json.keys?.p256dh,
            auth: json.keys?.auth,
          })
        : null,
    );

    return !!subscription && current();
  });
}

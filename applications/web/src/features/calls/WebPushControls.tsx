import type { JSX } from 'react';
import { useEffect, useState } from 'react';
import { z } from 'zod';

import { errorMessage } from '../../shared/api/client';
import { pwaSupported, readyPwa } from '../../shared/pwa';
import { useAuth } from '../auth/AuthProvider';
import { identity, readSession } from '../auth/session';

function currentSession(sid: string | undefined): boolean {
  const session = readSession();
  return !!session && identity(session).sid === sid;
}
import { useCalls } from './CallsProvider';

function address(subscription: PushSubscription): {
  endpoint: string;
  p256dh: string;
  auth: string;
} {
  const json = subscription.toJSON();
  return z.object({ endpoint: z.string(), p256dh: z.string(), auth: z.string() }).parse({
    endpoint: json.endpoint,
    p256dh: json.keys?.p256dh,
    auth: json.keys?.auth,
  });
}

export function WebPushControls(): JSX.Element | null {
  const { client, state } = useCalls();
  const { user } = useAuth();
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [serverKey, setServerKey] = useState<string | null>(null);
  const supported = pwaSupported() && 'PushManager' in window && 'Notification' in window;
  const online = state.owner && state.connection === 'online';

  useEffect((): (() => void) => {
    let stopped = false;
    setEnabled(false);
    setServerKey(null);
    setError('');
    if (supported && online && client.webPush) {
      void (async (): Promise<void> => {
        const { public_key } = z
          .object({ public_key: z.string().nullable() })
          .parse(await client.webPush?.('device.web_push_config', {}));
        if (stopped || !currentSession(user?.sid)) return;
        setServerKey(public_key);
        const registration = await readyPwa();
        const subscription = await registration.pushManager.getSubscription();
        if (stopped || !currentSession(user?.sid)) return;
        if (public_key && subscription && Notification.permission === 'granted') {
          await client.webPush?.('device.web_push', { subscription: address(subscription) });
          if (!stopped) setEnabled(true);
        } else if (public_key) {
          await client.webPush?.('device.web_push', { subscription: null });
        }
      })().catch((cause: unknown): void => {
        if (!stopped) setError(errorMessage(cause, 'Не удалось настроить уведомления.'));
      });
    }
    return (): void => {
      stopped = true;
    };
  }, [client, supported, online, user?.sid]);

  if (!client.webPush || !pwaSupported()) return null;

  async function toggle(): Promise<void> {
    if (!client.webPush || !serverKey) return;
    setBusy(true);
    setError('');
    const sid = user?.sid;
    try {
      // Permission must be requested directly in the click handler, before awaiting registration.
      const permission = enabled ? Notification.permission : await Notification.requestPermission();
      if (!enabled && permission !== 'granted')
        throw new Error('Разрешите уведомления GChat в настройках браузера или устройства.');
      const registration = await readyPwa();
      if (!currentSession(sid)) return;
      if (enabled) {
        await client.webPush('device.web_push', { subscription: null });
        const subscription = await registration.pushManager.getSubscription();
        if (subscription && !(await subscription.unsubscribe()))
          throw new Error('Не удалось отключить подписку браузера. Повторите попытку.');
        setEnabled(false);
      } else {
        const key = Uint8Array.from(
          atob(serverKey.replace(/-/g, '+').replace(/_/g, '/')),
          (char): number => char.charCodeAt(0),
        );
        const subscription =
          (await registration.pushManager.getSubscription()) ??
          (await registration.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: key,
          }));
        // The call client also verifies current session ownership before sending.
        if (!currentSession(sid)) return;
        await client.webPush('device.web_push', { subscription: address(subscription) });
        setEnabled(true);
      }
    } catch (cause) {
      setError(errorMessage(cause, 'Не удалось настроить уведомления.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="push-settings">
      <strong>Уведомления о звонках</strong>
      {!supported ? (
        <p>
          В этом браузере Web Push недоступен. На iPhone добавьте GChat на экран «Домой» и откройте
          его оттуда.
        </p>
      ) : (
        <>
          <p>
            {enabled
              ? 'Включены для этого браузера.'
              : 'Получайте уведомления, когда GChat закрыт. Нажмите на уведомление, чтобы открыть звонок.'}
          </p>
          {!serverKey && online && !error && <p>Web Push не включён на сервере.</p>}
          <button
            className="secondary"
            disabled={busy || !online || !serverKey}
            onClick={(): void => {
              void toggle();
            }}
          >
            {busy ? 'Настраиваем…' : enabled ? 'Отключить уведомления' : 'Включить уведомления'}
          </button>
          {!online && <p>Откройте основную вкладку GChat и дождитесь подключения.</p>}
        </>
      )}
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
    </div>
  );
}

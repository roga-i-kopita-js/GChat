import { ApiError } from '@gchat/backend-api';
import type { JSX } from 'react';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { z } from 'zod';

import { useAuth } from '../../features/auth/AuthProvider';
import { useBootstrap } from '../../shared/dialogs/context';
import { embedded, nativePlugin } from '../../shared/native/bridge';
import { nativeRuntime } from '../../shared/native/runtime';

export function NotificationIntents(): JSX.Element {
  const { runtime } = useBootstrap();
  const { user } = useAuth();
  const native = useSyncExternalStore(nativeRuntime.subscribe, nativeRuntime.getSnapshot);
  const navigate = useNavigate(),
    location = useLocation();
  const intent = useRef<{ id: string; account?: string; nativeId?: string } | null>(null);
  const [wake, setWake] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const consumed = useRef(new Set<string>());
  const running = useRef(false);

  useEffect((): (() => void) => {
    if (embedded || !('serviceWorker' in navigator)) return (): void => {};

    const receive = (event: MessageEvent<unknown>): void => {
      const value = z
        .strictObject({ type: z.literal('dialog.notification'), dialogId: z.string().uuid() })
        .safeParse(event.data);

      if (value.success) {
        intent.current = { id: value.data.dialogId, account: user?.sub };
        // Trigger a route effect without putting content or credentials into the address.
        void navigate(location.pathname + '?dialog_id=' + value.data.dialogId, { replace: true });
      }
    };

    navigator.serviceWorker.addEventListener('message', receive);

    return (): void => navigator.serviceWorker.removeEventListener('message', receive);
  }, [navigate, user?.sub, location.pathname]);
  useEffect((): void => {
    const query = new URLSearchParams(location.search),
      id = query.get('dialog_id');

    if (id) {
      if (z.string().uuid().safeParse(id).success) intent.current = { id, account: user?.sub };

      query.delete('dialog_id');
      void navigate(location.pathname + (query.size ? '?' + query.toString() : ''), {
        replace: true,
      });
    }

    if (
      native.dialogIntent &&
      !consumed.current.has(native.dialogIntent.intentId) &&
      intent.current?.nativeId !== native.dialogIntent.intentId
    )
      intent.current = {
        id: native.dialogIntent.dialogId,
        nativeId: native.dialogIntent.intentId,
        account: user?.sub,
      };

    const pending = intent.current;

    if (!pending || !runtime || !user || running.current) return;

    if (pending.account && pending.account !== user.sub) {
      intent.current = null;

      return;
    }

    running.current = true;
    void (async (): Promise<void> => {
      let path = '/dialogs';

      try {
        await runtime.metadata(pending.id);
        path += '/' + pending.id;
      } catch (cause) {
        if (!(
          cause instanceof ApiError &&
          ['NOT_FOUND', 'DIALOG_NOT_ALLOWED'].includes(cause.code ?? '')
        ))
          throw cause;
      }

      if (!runtime.signal.aborted && intent.current === pending) {
        if (pending.nativeId) {
          await nativePlugin.consumeDialogNotificationIntent({
            cycleId: native.cycleId,
            intentId: pending.nativeId,
          });
          consumed.current.add(pending.nativeId);
        }

        intent.current = null;
        setError(null);
        void navigate(path);
      }
    })()
      .catch((): void => {
        if (!runtime.signal.aborted) setError('Не удалось открыть диалог из уведомления.');
      })
      .finally((): void => {
        running.current = false;

        if (intent.current && intent.current !== pending && !runtime.signal.aborted)
          setWake((value): number => value + 1);
      });
  }, [
    runtime,
    wake,
    user?.sid,
    user?.sub,
    location.search,
    native.dialogIntent,
    native.cycleId,
    navigate,
  ]);

  return error ? (
    <div role="alert" className="error-banner">
      {error}
      <button onClick={(): void => setWake((value): number => value + 1)}>Повторить</button>
    </div>
  ) : (
    <></>
  );
}

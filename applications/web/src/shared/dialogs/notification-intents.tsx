import { ApiError } from '@gchat/backend-api';
import type { JSX } from 'react';
import { useEffect, useRef, useState } from 'react';

import { NotificationEvent, SessionEvent } from '../device';
import { useDevice, useDeviceState } from '../device/react';
import { useBootstrap } from './context';

export function NotificationIntents(): JSX.Element {
  const device = useDevice();
  const session = useDeviceState(device.session, SessionEvent.StateChanged);
  const notifications = useDeviceState(device.notifications, NotificationEvent.StateChanged);
  const { runtime } = useBootstrap();
  const pending = notifications.pendingIntent;
  const latest = useRef(pending);

  latest.current = pending;
  const running = useRef(false);
  const [wake, setWake] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect((): void => {
    if (!pending || !runtime || session.status !== 'authenticated' || running.current) {
      return;
    }

    running.current = true;
    const generation = session.generation;

    void (async (): Promise<void> => {
      let path = '/calls';

      if (pending.kind === 'dialog') {
        path = '/dialogs';

        try {
          await runtime.metadata(pending.dialogId);
          path += '/' + pending.dialogId;
        } catch (cause) {
          if (!(
            cause instanceof ApiError &&
            ['NOT_FOUND', 'DIALOG_NOT_ALLOWED'].includes(cause.code ?? '')
          )) {
            throw cause;
          }
        }
      } else {
        const calls = await device.calls.getState();

        if (calls.call?.call_id !== pending.callId) {
          path = '/calls';
        }
      }

      const current = await device.session.getState();

      if (
        runtime.signal.aborted ||
        current.generation !== generation ||
        latest.current?.id !== pending.id
      ) {
        return;
      }

      await device.navigation.navigate(path);

      if (!runtime.signal.aborted) {
        await device.notifications.acknowledge(pending.id);
        setError(null);
      }
    })()
      .catch((): void => {
        if (!runtime.signal.aborted) {
          setError('Не удалось открыть диалог из уведомления.');
        }
      })
      .finally((): void => {
        running.current = false;

        if (latest.current && latest.current.id !== pending.id && !runtime.signal.aborted) {
          setWake((value): number => value + 1);
        }
      });
  }, [pending?.id, runtime, session.generation, session.status, wake, device]);

  return error ? (
    <div role="alert" className="error-banner">
      {error}
      <button onClick={(): void => setWake((value): number => value + 1)}>Повторить</button>
    </div>
  ) : (
    <></>
  );
}

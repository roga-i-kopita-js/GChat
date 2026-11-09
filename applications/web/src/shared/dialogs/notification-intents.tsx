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

    void (async () => {
      try {
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

          const { call: callsCall } = calls;

          if (callsCall?.call_id !== pending.callId) {
            path = '/calls';
          }
        }

        const current = await device.session.getState();

        const { generation: currentGeneration } = current;

        if (
          runtime.signal.aborted ||
          currentGeneration !== generation ||
          latest.current?.id !== pending.id
        ) {
          return;
        }

        await device.navigation.navigate(path);

        if (!runtime.signal.aborted) {
          await device.notifications.acknowledge(pending.id);
          setError(null);
        }
      } catch (cause) {
        if (!runtime.signal.aborted) {
          setError('Не удалось открыть диалог из уведомления.');
        }
      } finally {
        running.current = false;

        if (latest.current && latest.current.id !== pending.id && !runtime.signal.aborted) {
          setWake((value): number => value + 1);
        }
      }
    })();
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

import type { JSX, ReactNode } from 'react';
import { useEffect, useState, useSyncExternalStore } from 'react';

import { SessionEvent, type SessionService } from '../device/api';
import { useDeviceState } from '../device/react';
import { embedded } from '../native/bridge';
import { nativeRuntime } from '../native/runtime';
import { browserTransport } from '../runtime/transport';
import { currentSession, identity, readSession, request, saveSession } from '../session/session';
import { DialogBootstrapContext as Context } from './context';
import { StorageError } from './model';
import { openNativeDialogs } from './native-storage';
import { NotificationIntents } from './notification-intents';
import { dialogError, DialogRuntime, wait } from './runtime';
import { type DialogStorage, IndexedDialogStorage } from './storage';

export function BootstrapProvider({
  children,
  session,
}: {
  children: ReactNode;
  session: SessionService<unknown>;
}): JSX.Element {
  const state = useDeviceState(session, SessionEvent.StateChanged);
  const saved = currentSession();
  const claims = saved ? identity(saved) : null;
  const user =
    state.status === 'authenticated' && state.identity && claims
      ? { sid: claims.sid, sub: state.identity.id }
      : null;
  const native = useSyncExternalStore(nativeRuntime.subscribe, nativeRuntime.getSnapshot);
  const connection = useSyncExternalStore(browserTransport.subscribe, browserTransport.getSnapshot);
  const [value, setValue] = useState<{ runtime: DialogRuntime | null; error: string | null }>({
    runtime: null,
    error: null,
  });
  const [attempt, setAttempt] = useState(0);
  const deviceId = embedded ? null : readSession()?.deviceId;

  useEffect((): (() => void) => {
    let cancelled = false;
    let runtime: DialogRuntime | null = null;
    let storage: DialogStorage | null = null;
    let previousStatus = embedded ? native.wsStatus : connection.status;
    let unsubscribe = (): void => {};

    setValue({ runtime: null, error: null });

    if (user && (embedded || deviceId)) {
      void (async (): Promise<void> => {
        try {
          const sessionId = user.sid;
          const accountId = user.sub;

          if (embedded) {
            for (let bindingAttempt = 0; ; bindingAttempt++) {
              if (cancelled) {
                return;
              }

              try {
                storage = await openNativeDialogs();
                break;
              } catch (error) {
                if (
                  !(error instanceof StorageError && error.code === 'STORAGE_STALE_CONTEXT') ||
                  bindingAttempt >= 40
                ) {
                  throw error;
                }

                await wait(250, nativeRuntime.getSignal());
              }
            }
          } else if (deviceId) {
            storage = await IndexedDialogStorage.open({
              serverOrigin: location.origin,
              accountId,
              sessionId,
              deviceId,
            });
          }

          if (!storage) {
            return;
          }

          if (cancelled || !currentSession() || identity(currentSession()!).sid !== sessionId) {
            storage.close();

            return;
          }

          runtime = new DialogRuntime(storage.scope, storage, request);
          const target = runtime;

          target.start(
            embedded
              ? (listener): (() => void) =>
                  nativeRuntime.subscribeWs((message): void => {
                    if (typeof message.type === 'string') {
                      listener(message.type, message.payload);
                    }
                  })
              : (listener): (() => void) => browserTransport.subscribeMessage(listener),
          );
          const reconnect = (): void => {
            const status = embedded
              ? nativeRuntime.getSnapshot().wsStatus
              : browserTransport.getSnapshot().status;

            if (status === 'online' && previousStatus !== 'online') {
              target.refresh();
            }

            previousStatus = status;
          };

          unsubscribe = embedded
            ? nativeRuntime.subscribe(reconnect)
            : browserTransport.subscribe(reconnect);
          setValue({ runtime: target, error: null });
        } catch (error) {
          if (!cancelled) {
            setValue({ runtime: null, error: dialogError(error) });
          }
        }
      })();
    }

    return (): void => {
      cancelled = true;
      unsubscribe();
      runtime?.stop();
      storage?.close();
    };
  }, [user?.sid, user?.sub, deviceId, embedded ? native.cycleId : '', attempt]);
  const visibleValue =
    value.runtime && value.runtime.scope.sessionId !== user?.sid
      ? { runtime: null, error: null }
      : value;

  return (
    <Context
      value={{ ...visibleValue, retry: (): void => setAttempt((previous): number => previous + 1) }}
    >
      <NotificationIntents />
      {children}
    </Context>
  );
}

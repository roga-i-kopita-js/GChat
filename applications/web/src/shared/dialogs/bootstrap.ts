import { type ApiResult, BackendApi } from '@gchat/backend-api';

import { type DeviceCore, LifecycleEvent, SessionEvent, type SessionState } from '../device/api';
import { DeviceError } from '../device/contract';
import { embedded } from '../native/bridge';
import { nativeRuntime } from '../native/runtime';
import { browserTransport } from '../runtime/transport';
import { currentSession, identity, readSession } from '../session/session';
import { StorageError } from './model';
import { openNativeDialogs } from './native-storage';
import { dialogError, DialogRuntime, wait } from './runtime';
import { type DialogStorage, IndexedDialogStorage } from './storage';

export interface DialogBootstrapSnapshot {
  runtime: DialogRuntime | null;
  error: string | null;
}

const bootstraps = new WeakMap<DeviceCore, DialogBootstrap>();

export function dialogBootstrap(device: DeviceCore): DialogBootstrap {
  let value = bootstraps.get(device);

  if (!value) {
    value = new DialogBootstrap(device);
    bootstraps.set(device, value);
  }

  return value;
}

/** One storage/runtime owner per device, available before the first React render. */
export class DialogBootstrap {
  private state: DialogBootstrapSnapshot = { runtime: null, error: null };
  private listeners = new Set<() => void>();
  private session: SessionState | null = null;
  private key: string | null = null;
  private scope = new AbortController();
  private lifetime = new AbortController();
  private storage: DialogStorage | null = null;
  private off: (() => void)[] = [];
  private previousStatus = embedded
    ? nativeRuntime.getSnapshot().wsStatus
    : browserTransport.getSnapshot().status;

  constructor(private readonly device: DeviceCore) {
    this.off.push(device.session.on(SessionEvent.StateChanged, this.acceptSession));
    this.off.push(
      device.lifecycle.on(LifecycleEvent.StateChanged, (state): void => {
        if (state.phase === 'stopped') {
          this.stop();
        }
      }),
    );
    this.off.push(
      embedded
        ? nativeRuntime.subscribe(this.connectionChanged)
        : browserTransport.subscribe(this.connectionChanged),
    );
    void (async () => {
      try {
        return await this.acceptSession(await device.session.getState());
      } catch (cause) {
        if (!this.lifetime.signal.aborted) {
          this.set({ runtime: null, error: dialogError(cause) });
        }
      }
    })();
  }

  getSnapshot = (): DialogBootstrapSnapshot => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);

    return (): void => {
      this.listeners.delete(listener);
    };
  };

  private set(value: DialogBootstrapSnapshot): void {
    this.state = value;

    for (const listener of this.listeners) {
      listener();
    }
  }

  private acceptSession = (state: SessionState): void => {
    if (this.lifetime.signal.aborted || (this.session && state.revision < this.session.revision)) {
      return;
    }

    this.session = state;
    this.reconcile();
  };

  private connectionChanged = (): void => {
    this.reconcile();
    const status = embedded
      ? nativeRuntime.getSnapshot().wsStatus
      : browserTransport.getSnapshot().status;

    if (status === 'online' && this.previousStatus !== 'online') {
      this.state.runtime?.refresh();
    }

    this.previousStatus = status;
  };

  private clear(): void {
    this.scope.abort();
    this.state.runtime?.stop();
    this.storage?.close();
    this.storage = null;
    this.scope = new AbortController();
    this.set({ runtime: null, error: null });
  }

  private reconcile(): void {
    if (this.lifetime.signal.aborted) {
      return;
    }

    const saved = currentSession();
    const claims = saved ? identity(saved) : null;
    const user = this.session?.status === 'authenticated' ? this.session.identity : null;
    const deviceId = embedded ? null : readSession()?.deviceId;
    const cycle = embedded ? nativeRuntime.getSnapshot().cycleId : '';
    const key =
      claims && user && claims.sub === user.id && (embedded || deviceId)
        ? JSON.stringify([claims.sid, user.id, deviceId, cycle])
        : null;

    if (key === this.key) {
      if (!key && user && !embedded && browserTransport.getSnapshot().error && !this.state.error) {
        this.set({
          runtime: null,
          error: 'Не удалось подготовить переписку. Проверьте соединение и повторите.',
        });
      }

      return;
    }

    this.key = key;
    this.clear();

    if (!key || !claims || !user) {
      return;
    }

    const signal = this.scope.signal;

    void (async () => {
      try {
        return await this.open(claims.sid, user.id, deviceId ?? null, signal);
      } catch (cause) {
        if (!signal.aborted) {
          this.set({ runtime: null, error: dialogError(cause) });
        }
      }
    })();
  }

  private async open(
    sessionId: string,
    accountId: string,
    deviceId: string | null,
    signal: AbortSignal,
  ): Promise<void> {
    let storage: DialogStorage;

    if (embedded) {
      for (let attempt = 0; ; attempt++) {
        signal.throwIfAborted();

        try {
          storage = await openNativeDialogs();
          break;
        } catch (cause) {
          if (
            !(cause instanceof StorageError && cause.code === 'STORAGE_STALE_CONTEXT') ||
            attempt >= 40
          ) {
            throw cause;
          }

          await wait(250, signal);
        }
      }
    } else {
      storage = await IndexedDialogStorage.open({
        serverOrigin: location.origin,
        accountId,
        sessionId,
        deviceId: deviceId!,
      });
    }

    if (signal.aborted) {
      storage.close();

      return;
    }

    this.storage = storage;
    const request = <T>(operation: (api: BackendApi) => Promise<ApiResult<T>>): Promise<T> =>
      this.device.session.run(
        async (api): Promise<T> => {
          if (!(api instanceof BackendApi)) {
            throw new DeviceError('INTEGRATION_ERROR');
          }

          const { data: resultData } = await operation(api);

          return resultData;
        },
        { signal },
      );
    const runtime = new DialogRuntime(storage.scope, storage, request);

    runtime.start(
      embedded
        ? (listener): (() => void) =>
            nativeRuntime.subscribeWs((message): void => {
              if (typeof message.type === 'string') {
                listener(message.type, message.payload);
              }
            })
        : (listener): (() => void) => browserTransport.subscribeMessage(listener),
      false,
    );
    this.set({ runtime, error: null });
  }

  retry = (): void => {
    this.key = null;
    this.reconcile();
  };

  async ready(caller: AbortSignal): Promise<DialogRuntime> {
    const session = await this.device.session.getState({ signal: caller });

    caller.throwIfAborted();
    this.acceptSession(session);

    const { status: sessionStatus } = session;

    if (sessionStatus !== 'authenticated') {
      throw new DeviceError('INVALID_STATE');
    }

    const signal = AbortSignal.any([caller, this.lifetime.signal]);

    signal.throwIfAborted();

    return new Promise((resolve, reject): void => {
      const cleanup = (): void => {
        off();
        signal.removeEventListener('abort', aborted);
      };
      const aborted = (): void => {
        cleanup();
        reject(signal.reason);
      };
      const check = (): void => {
        const { generation: sessionGeneration } = session;

        if (this.session?.generation !== sessionGeneration) {
          cleanup();
          reject(new DeviceError('CANCELLED'));
        } else if (this.state.error) {
          cleanup();
          reject(new Error(this.state.error));
        } else if (this.state.runtime) {
          cleanup();
          resolve(this.state.runtime);
        }
      };
      const off = this.subscribe(check);

      signal.addEventListener('abort', aborted, { once: true });
      check();
    });
  }

  private stop(): void {
    this.lifetime.abort();
    this.clear();

    for (const off of this.off.splice(0)) {
      off();
    }

    this.listeners.clear();
    bootstraps.delete(this.device);
  }
}

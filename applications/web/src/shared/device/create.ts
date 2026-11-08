import type { ReactElement } from 'react';
import { type RouteObject, RouterContextProvider } from 'react-router';

import { GChatClient } from '../calls/client';
import { type CallsClient, NativeCallsClient } from '../calls/native-client';
import { embedded, nativeHttp } from '../native/bridge';
import { nativeRuntime } from '../native/runtime';
import { browserTransport } from '../runtime/transport';
import { confirmRevocation } from '../session/browser-session';
import { currentSession, identity, readSession, request, saveSession } from '../session/session';
import {
  type CallOptions,
  CheckStatus,
  type DeviceCore,
  LifecycleEvent,
  type LifecycleEvents,
  type LifecycleState,
  NavigationEvent,
  type NavigationEvents,
  type NavigationService,
  SessionEvent,
} from './api';
import { CallEvent, NotificationEvent, UpdateEvent } from './api';
import { DeviceAudio } from './audio';
import { CommandBridge } from './bridge';
import { DeviceCalls } from './calls';
import { BrowserCamera } from './camera-browser';
import { NativeCamera } from './camera-native';
import { CameraStore } from './camera-store';
import { DeviceError } from './contract';
import { cancellable, Events, StateSource } from './events';
import { deviceFailure } from './failure';
import { DeviceFiles } from './files';
import { type DeviceInternals, type PresentationState, registerDevice } from './internals';
import { NativeMedia } from './media-native';
import { NavigationHost } from './navigation-host';
import { DeviceNotifications } from './notifications';
import { DeviceObserver } from './observer';
import { DevicePermissions } from './permissions';
import { deviceContext } from './router-context';
import { DeviceSession } from './session';
import { disposeStateCaches, stateCache } from './state-cache';
import { DeviceStorage } from './storage';
import { DeviceTransport } from './transport';
import { DeviceUpdates } from './updates';

export type HttpRequest = typeof globalThis.fetch;

export interface HttpClientRegistration<TOptions extends { fetch?: HttpRequest }, TClient> {
  client: new (options: TOptions) => TClient;
  options: Omit<TOptions, 'fetch'>;
}

export interface DeviceConfiguration<TOptions extends { fetch?: HttpRequest }, TClient> {
  http: HttpClientRegistration<TOptions, TClient>;
  routing: {
    basename: string;
    createRoutes(): RouteObject[];
    resolveNativeLocation(to: string): string | null;
  };
}

let documentOwner: object | null = null;

class DeviceNavigationFacade extends Events<NavigationEvents> implements NavigationService {
  private navigation: NavigationService | null = null;
  private stops: (() => void)[] = [];

  bind(navigation: NavigationService): void {
    this.navigation = navigation;
    this.stops = [
      navigation.on(NavigationEvent.Started, (value): void =>
        this.emit(NavigationEvent.Started, value),
      ),
      navigation.on(NavigationEvent.Completed, (value): void =>
        this.emit(NavigationEvent.Completed, value),
      ),
      navigation.on(NavigationEvent.LocationChanged, (value): void =>
        this.emit(NavigationEvent.LocationChanged, value),
      ),
    ];
  }

  private get(): NavigationService {
    if (!this.navigation) {
      throw new DeviceError('INVALID_STATE');
    }

    return this.navigation;
  }

  getState(options?: CallOptions): ReturnType<NavigationService['getState']> {
    return this.get().getState(options);
  }

  navigate(
    to: string,
    options?: CallOptions & { replace?: boolean },
  ): ReturnType<NavigationService['navigate']> {
    return this.get().navigate(to, options);
  }

  revalidate(options?: CallOptions): Promise<void> {
    return this.get().revalidate(options);
  }

  stop(): void {
    for (const off of this.stops.splice(0)) {
      off();
    }

    this.navigation = null;
    this.clear();
  }
}

export function createDevice<TOptions extends { fetch?: HttpRequest }, TClient>(
  config: DeviceConfiguration<TOptions, TClient>,
): DeviceCore<TClient> {
  if (
    !config?.http ||
    typeof config.http.client !== 'function' ||
    typeof config.http.options !== 'object' ||
    config.http.options === null ||
    'fetch' in config.http.options ||
    !config.routing ||
    typeof config.routing.createRoutes !== 'function' ||
    typeof config.routing.resolveNativeLocation !== 'function'
  ) {
    throw new DeviceError('INVALID_ARGUMENT');
  }

  if (!config.routing.basename.startsWith('/')) {
    throw new DeviceError('INVALID_ARGUMENT');
  }

  const lifetime = new AbortController();
  let activated = false;
  const inactive = AbortSignal.abort();
  const signal = (): AbortSignal =>
    activated ? AbortSignal.any([lifetime.signal, session.signal()]) : inactive;
  let host: NavigationHost | null = null;
  let startup: Promise<void> | null = null;
  let shutdown: Promise<void> | null = null;
  let started = false;
  let stopClient = (): void => {};
  let stopTransport = (): void => {};
  const cleanups: (() => void)[] = [];
  const state = new StateSource<LifecycleState>({
    revision: 0,
    phase: 'starting',
    visibility: document.visibilityState === 'hidden' ? 'background' : 'foreground',
    error: null,
  });
  const lifecycleEvents = new Events<LifecycleEvents>();
  const publish = (patch: Partial<LifecycleState>): void => {
    const old = state.getSnapshot();
    const next = state.set({ ...old, ...patch });

    if (next !== old) {
      lifecycleEvents.emit(LifecycleEvent.StateChanged, next);

      if (old.visibility !== next.visibility) {
        lifecycleEvents.emit(LifecycleEvent.VisibilityChanged, {
          revision: next.revision,
          visibility: next.visibility,
        });
      }
    }
  };
  const client: CallsClient = embedded ? new NativeCallsClient() : new GChatClient();
  let http: TClient;
  const session = new DeviceSession<TClient>(
    (): TClient => http,
    (): AbortSignal => lifetime.signal,
    (): Promise<void> => client.signOut(),
  );
  const fetch: HttpRequest = (input, init): Promise<Response> => {
    const requestSignal = AbortSignal.any([
      lifetime.signal,
      signal(),
      ...(init?.signal ? [init.signal] : []),
    ]);

    return (embedded ? nativeHttp.request : globalThis.fetch)(input, {
      ...init,
      cache: 'no-store',
      signal: requestSignal,
    });
  };

  http = Reflect.construct(config.http.client, [
    {
      getAccessToken: (): string | undefined => currentSession()?.access_token,
      ...config.http.options,
      fetch,
    },
  ]);
  const bridge = new CommandBridge({
    current: (): boolean => session.source.getSnapshot().status === 'authenticated',
    audioAllowed: (): boolean => {
      const value = client.getSnapshot();

      return (
        session.source.getSnapshot().status === 'authenticated' &&
        value.owner &&
        !value.busy &&
        (!value.call || value.call.state === 'ended')
      );
    },
    stopAudio: (): void => client.audioPreparation?.stop(),
    testMicrophone: (): Promise<void> =>
      client.audioPreparation?.microphone() ?? Promise.reject(new DeviceError('UNSUPPORTED')),
    testSound: (): Promise<void> =>
      client.testSound?.() ?? Promise.reject(new DeviceError('UNSUPPORTED')),
    setOutput: (id): Promise<void> =>
      client.setAudioOutput?.(id) ?? Promise.reject(new DeviceError('UNSUPPORTED')),
    pushOnline: (): boolean =>
      session.source.getSnapshot().status === 'authenticated' &&
      client.getSnapshot().owner &&
      client.getSnapshot().connection === 'online',
    push: (type, payload): Promise<unknown> =>
      client.webPush?.(type, payload) ?? Promise.reject(new DeviceError('UNSUPPORTED')),
  });
  const observer = new DeviceObserver(bridge);
  const storage = new DeviceStorage(bridge, signal);
  const files = new DeviceFiles(bridge, storage, signal);
  const permissions = new DevicePermissions(bridge, observer, signal);
  const calls = new DeviceCalls(
    client,
    (): string | null => session.source.getSnapshot().identity?.id ?? null,
    bridge,
    signal,
  );
  const transport = new DeviceTransport();
  const notifications = new DeviceNotifications(bridge, observer, signal);
  const updates = new DeviceUpdates((): boolean => {
    const call = client.getSnapshot().call;

    return !!call && call.state !== 'ended';
  }, signal);
  const media = new NativeMedia(signal);
  const audio = new DeviceAudio(bridge, observer, media, client, signal);
  const selectedCall = (): string | null => {
    const value = client.getSnapshot();

    return value.selected && value.call && value.call.state !== 'ended' ? value.call.call_id : null;
  };
  const camera = embedded
    ? new NativeCamera(media)
    : new BrowserCamera(
        new CameraStore(files, storage, (ref, mime): Promise<void> =>
          bridge.setCaptureMime(ref.id, mime),
        ),
        signal,
        selectedCall,
        (): boolean => session.source.getSnapshot().status === 'authenticated',
      );
  const navigation = new DeviceNavigationFacade();
  const presentation = new StateSource<PresentationState>({
    revision: 0,
    loginNavigation: embedded ? 'host' : 'router',
    callControls: embedded ? 'host' : 'application',
    incomingSurface: embedded ? 'host' : 'application',
    callingAvailable: !embedded,
    supportedEnvironment:
      embedded || !!(navigator.locks && navigator.mediaDevices && globalThis.BroadcastChannel),
  });
  const record: DeviceInternals = {
    client,
    observer,
    presentation,
    camera,
    provider: null,
    confirmSessionRevoked: async (generation): Promise<void> => {
      if (session.source.getSnapshot().generation !== generation) {
        return;
      }

      if (embedded) {
        nativeRuntime.clear();
        await nativeRuntime.ready();

        return;
      }

      const saved = readSession();

      if (saved) {
        await confirmRevocation(saved);
      }
    },
    render: (): ReactElement => {
      if (!host) {
        throw new DeviceError('INVALID_STATE');
      }

      return host.render();
    },
  };
  const visibility = (): void => {
    publish({ visibility: document.visibilityState === 'hidden' ? 'background' : 'foreground' });

    if (document.hidden && camera instanceof BrowserCamera) {
      void camera.resetViews();
    } else if (embedded && document.visibilityState === 'visible') {
      void nativeRuntime.ready();
    }
  };
  const startCore = async (): Promise<void> => {
    if (documentOwner && documentOwner !== device) {
      throw new DeviceError('INTEGRATION_ERROR');
    }

    documentOwner = device;
    activated = true;
    session.start();

    if (embedded) {
      await nativeRuntime.ready();
      await session.getState({ signal: lifetime.signal });

      if (nativeRuntime.getSnapshot().phase !== 'ready') {
        throw new DeviceError('BRIDGE_UNAVAILABLE');
      }
    }

    if (camera instanceof NativeCamera) {
      await camera.start();
    }

    if (lifetime.signal.aborted) {
      throw new DeviceError('CANCELLED');
    }

    if (!started) {
      started = true;

      if (!embedded) {
        browserTransport.configure({
          session: (): { sessionId: string; deviceId: string | null } | null => {
            const value = readSession();

            return value ? { sessionId: identity(value).sid, deviceId: value.deviceId } : null;
          },
          ticket: async (): Promise<string> =>
            (
              await request((api): ReturnType<typeof api.authWsTicket> =>
                api.authWsTicket({ body: {} }),
              )
            ).ticket,
          bind: (sid, deviceId): void => {
            const value = readSession();

            if (value && identity(value).sid === sid) {
              saveSession({ ...value, deviceId });
            }
          },
        });
        stopTransport = browserTransport.start();
      }

      stopClient = client.start();
      calls.start();
      transport.start();
      permissions.start();
      notifications.start();
      audio.start();
      updates.start();

      let generation = session.source.getSnapshot().generation;
      let previousAccount = session.source.getSnapshot().identity?.id ?? null;
      let cycle = embedded ? nativeRuntime.getSnapshot().cycleId : '';
      let observerReset = 0;
      let resettingObserver = false;
      const synchronize = (): void => {
        const value = session.source.getSnapshot();
        const native = nativeRuntime.getSnapshot();

        if (value.generation !== generation || (embedded && native.cycleId !== cycle)) {
          generation = value.generation;
          cycle = native.cycleId;

          if (previousAccount !== null) {
            notifications.reset();
          }

          previousAccount = value.identity?.id ?? null;
          const revision = ++observerReset;

          resettingObserver = true;
          void observer.stop().then((): void => {
            if (revision !== observerReset || lifetime.signal.aborted) {
              return;
            }

            bridge.reset();
            resettingObserver = false;

            if (session.source.getSnapshot().status === 'authenticated') {
              observer.start();
            }
          });

          if (camera instanceof BrowserCamera) {
            void camera.resetViews();
          }
        }

        if (camera instanceof NativeCamera) {
          void camera.resync().catch((): void => {});
        }

        if (!resettingObserver && value.status === 'authenticated') {
          observer.start();
        }

        if (embedded) {
          presentation.set({
            ...presentation.getSnapshot(),
            callingAvailable: native.nativeCalls === true,
          });

          if (host || native.phase !== 'ready') {
            publish({
              phase:
                native.phase === 'ready'
                  ? 'ready'
                  : native.phase === 'error'
                    ? 'error'
                    : 'starting',
              error:
                native.phase === 'error'
                  ? deviceFailure(new DeviceError('BRIDGE_UNAVAILABLE'), 'lifecycle', 'synchronize')
                  : null,
            });
          }
        }
      };

      cleanups.push(session.on(SessionEvent.StateChanged, synchronize));
      cleanups.push(
        client.subscribe((): void => {
          if (camera instanceof BrowserCamera) {
            camera.callChanged();
          }
        }),
      );
      document.addEventListener('visibilitychange', visibility);
      cleanups.push((): void => document.removeEventListener('visibilitychange', visibility));
      synchronize();
    }

    if (!host) {
      host = new NavigationHost(
        config.routing.createRoutes(),
        config.routing.basename,
        (to): string => {
          const value = config.routing.resolveNativeLocation(to);

          if (value === null) {
            throw new DeviceError('INVALID_ARGUMENT');
          }

          return value;
        },
        (): RouterContextProvider => {
          const context = new RouterContextProvider();

          context.set(deviceContext, device);

          return context;
        },
      );
      navigation.bind(host.navigation);

      if (embedded) {
        nativeRuntime.attachNavigation(host.navigation);
      }
    }

    publish({ phase: 'ready', error: null });
    await Promise.all([
      stateCache(device.lifecycle, LifecycleEvent.StateChanged).preload(),
      stateCache(device.session, SessionEvent.StateChanged).preload(),
      stateCache(device.calls, CallEvent.StateChanged).preload(),
      stateCache(device.updates, UpdateEvent.StateChanged).preload(),
      stateCache(device.notifications, NotificationEvent.StateChanged).preload(),
    ]);
  };
  const launch = (): Promise<void> => {
    if (startup) {
      return startup;
    }

    publish({ phase: 'starting', error: null });
    const promise = startCore().catch((cause): never => {
      const error = deviceFailure(cause, 'lifecycle', 'start');

      if (state.getSnapshot().phase !== 'stopped') {
        publish({ phase: 'error', error });
      }

      throw error;
    });

    startup = promise;
    void promise.then(
      (): void => {
        if (startup === promise) {
          startup = null;
        }
      },
      (): void => {
        if (startup === promise) {
          startup = null;
        }
      },
    );

    return promise;
  };
  const device: DeviceCore<TClient> = {
    http,
    session,
    transport,
    calls,
    notifications,
    updates,
    permissions,
    files,
    storage,
    camera,
    audio,
    navigation,
    lifecycle: {
      on: (event, handler): (() => void) => lifecycleEvents.on(event, handler),
      getState: (options): Promise<LifecycleState> => state.getState(options),
      start: (options): Promise<void> => {
        const phase = state.getSnapshot().phase;

        if (phase === 'stopped') {
          return Promise.reject(new DeviceError('INVALID_STATE'));
        }

        if (phase === 'error') {
          return Promise.reject(new DeviceError('INVALID_STATE'));
        }

        if (phase === 'ready') {
          return Promise.resolve();
        }

        return cancellable(launch, options, lifetime.signal);
      },
      retry: (options): Promise<void> => {
        if (state.getSnapshot().phase !== 'error') {
          return Promise.reject(new DeviceError('INVALID_STATE'));
        }

        return cancellable(launch, options, lifetime.signal);
      },
      stop: (): Promise<void> => {
        if (shutdown) {
          return shutdown;
        }

        lifetime.abort();
        publish({ phase: 'stopped', error: null });
        shutdown = (async (): Promise<void> => {
          for (const off of cleanups.splice(0)) {
            off();
          }

          const cleanupResults = await Promise.allSettled([camera.stop(), observer.stop()]);

          if (embedded && documentOwner === device) {
            nativeRuntime.stop();
          }

          permissions.stop();
          notifications.stop();
          audio.stop();
          updates.stop();
          calls.stop();
          transport.stop();
          stopClient();
          stopTransport();
          session.stop();
          navigation.stop();
          host?.dispose();
          host = null;
          cleanupResults.push(...(await Promise.allSettled([bridge.dispose()])));
          files.clear();

          for (const service of [
            device.lifecycle,
            session,
            calls,
            updates,
            notifications,
            permissions,
            transport,
            audio,
            camera,
          ]) {
            disposeStateCaches(service);
          }

          if (documentOwner === device) {
            documentOwner = null;
          }

          const failed = cleanupResults.find((result): boolean => result.status === 'rejected');

          if (failed?.status === 'rejected') {
            throw deviceFailure(failed.reason, 'lifecycle', 'stop');
          }
        })();

        return shutdown;
      },
    },
    system: {
      check: async (options): Promise<import('./api').CheckReport> => {
        if (options?.signal?.aborted) {
          throw new DeviceError('CANCELLED');
        }

        const local = state.getSnapshot();

        if (local.phase === 'stopped') {
          throw new DeviceError('INVALID_STATE');
        }

        const checks: import('./api').CheckItem[] = [
          local.error
            ? {
                service: 'system',
                check: 'runtime',
                status: CheckStatus.Failed,
                error: local.error,
              }
            : { service: 'system', check: 'runtime', status: CheckStatus.Passed },
        ];

        if (embedded && nativeRuntime.getSnapshot().phase !== 'ready') {
          checks.push({
            service: 'system',
            check: 'bridge',
            status: CheckStatus.Failed,
            error: deviceFailure(new DeviceError('BRIDGE_UNAVAILABLE'), 'system', 'check'),
          });
        }

        if (session.source.getSnapshot().status !== 'authenticated') {
          checks.push({
            service: 'permissions',
            check: 'readiness',
            status: CheckStatus.NotChecked,
            reason: 'authenticationRequired',
          });
        } else {
          checks.push(
            ...(await audio.check(options)).checks,
            ...(await files.check(undefined, options)).checks,
            ...(await camera.check(undefined, options)).checks,
          );
        }

        return { checks };
      },
    },
  };

  registerDevice(device, record);

  return Object.freeze(device);
}

import { z } from 'zod';

import { callSchema } from '../api/call';
import type { DeviceNavigation } from '../device/navigation';
import { NativeNavigationBinding } from '../device/navigation-native';
import { identity } from '../identity';
import {
  bridgeError,
  bridgeVersion,
  invoke,
  nativeHttp,
  nativePlugin,
  serverUrl,
  type WsRequest,
} from './bridge';

export const nativeCallSchema = callSchema.strict();

const runtimeSchema = z.strictObject({
  status: z.enum(['offline', 'connecting', 'online']),
  muted: z.boolean(),
  selected: z.boolean().optional(),
});
const routeSchema = z.strictObject({
  cycleId: z.string(),
  path: z.string(),
  accessToken: z.string().min(1).optional(),
  replace: z.boolean().optional(),
});
const snapshotSchema = z.strictObject({
  cycleId: z.string(),
  call: nativeCallSchema.nullable(),
  runtime: runtimeSchema,
});
const capabilitiesSchema = z.strictObject({
  bridgeVersion: z.literal(bridgeVersion),
  platform: z.literal('ios'),
  nativeAuth: z.literal(true),
  httpVersion: z.literal(1),
  navigationVersion: z.literal(1),
  nativeCalls: z.boolean(),
  webCallControls: z.literal(true).optional(),
  nativeWebSocket: z.boolean().optional(),
  mediaVersion: z.literal(1).optional(),
  dialogStorageVersion: z.literal(1).optional(),
  dialogNotificationsVersion: z.literal(1).optional(),
});

export interface NativeState {
  mediaVersion?: 1;
  dialogStorageVersion?: 1;
  dialogNotificationsVersion?: 1;
  dialogIntent?: { intentId: string; dialogId: string };
  nativeCalls: boolean | null;
  webCallControls: boolean;
  nativeWebSocket: boolean;
  wsStatus: 'offline' | 'connecting' | 'online';
  cycleId: string;
  epoch: number;
  phase: 'waiting' | 'ready' | 'error';
  error: string | null;
  route: { path: string; replace: boolean } | null;
  call: z.infer<typeof nativeCallSchema> | null;
  runtime: z.infer<typeof runtimeSchema>;
}

/** Only the HTTP transport reads the token. React snapshots never contain it. */
export class NativeRuntime {
  private state: NativeState = {
    nativeCalls: null,
    webCallControls: false,
    nativeWebSocket: false,
    wsStatus: 'offline',
    cycleId: '',
    epoch: 0,
    phase: 'waiting',
    error: null,
    route: null,
    call: null,
    runtime: { status: 'offline', muted: false },
  };
  private navigationBinding?: NativeNavigationBinding;
  private navigationCycle?: string;

  attachNavigation(navigation: DeviceNavigation): void {
    if (this.navigationBinding) {
      throw bridgeError({ code: 'VALIDATION_ERROR' });
    }

    this.navigationBinding = new NativeNavigationBinding(nativePlugin, navigation);
    this.navigationReady();
  }

  private navigationReady(): void {
    if (
      !this.navigationBinding ||
      this.navigationCycle === this.state.cycleId ||
      this.state.phase !== 'ready'
    ) {
      return;
    }

    const cycle = this.state.cycleId;

    this.navigationCycle = cycle;
    const navigationBinding = this.navigationBinding;

    void (async () => {
      try {
        return await navigationBinding.start(cycle);
      } catch (cause) {
        if (this.state.cycleId === cycle) {
          this.fail(cause);
        }
      }
    })();
  }

  private token: string | null = null;
  private listeners = new Set<() => void>();
  private wsListeners = new Set<(message: Record<string, unknown>) => void>();
  private handles: { remove(): Promise<void> }[] = [];
  private generation = 0;
  private snapshotReceived = false;
  private controller = new AbortController();
  private retiredCalls = new Set<string>();
  private deadline?: ReturnType<typeof setTimeout>;

  getSnapshot = (): NativeState => this.state;
  getToken = (): string | null => this.token;
  getSignal = (): AbortSignal => this.controller.signal;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);

    return (): void => {
      this.listeners.delete(listener);
    };
  };

  subscribeWs = (listener: (message: Record<string, unknown>) => void): (() => void) => {
    this.wsListeners.add(listener);

    return (): void => {
      this.wsListeners.delete(listener);
    };
  };

  async sendWsMessage(message: WsRequest): Promise<void> {
    const { cycleId, phase, nativeWebSocket, wsStatus } = this.state;
    const signal = this.controller.signal;

    if (phase !== 'ready' || !this.token) {
      throw bridgeError({ code: 'UNAUTHENTICATED' });
    }

    if (!nativeWebSocket || wsStatus !== 'online') {
      throw bridgeError({ code: 'BRIDGE_UNAVAILABLE' });
    }

    const parsed = z
      .strictObject({
        type: z.string().min(1).max(64),
        request_id: z.string().min(1).max(128),
        payload: z.record(z.string(), z.json()),
      })
      .safeParse(message);

    if (
      !parsed.success ||
      new TextEncoder().encode(JSON.stringify(parsed.data)).byteLength > 131072
    ) {
      throw bridgeError({ code: 'VALIDATION_ERROR' });
    }

    await invoke((): Promise<void> =>
      nativePlugin.sendWsMessage({ cycleId, message: parsed.data }),
    );

    if (signal.aborted || cycleId !== this.state.cycleId) {
      throw new DOMException('Aborted', 'AbortError');
    }
  }

  private set(patch: Partial<NativeState>): void {
    this.state = { ...this.state, ...patch };

    for (const listener of this.listeners) {
      listener();
    }

    window.dispatchEvent(new Event('gchat-session'));
  }

  clear(): void {
    clearTimeout(this.deadline);
    nativeHttp.clear();
    this.token = null;
    this.controller.abort();
    this.controller = new AbortController();
    this.snapshotReceived = false;
    this.retiredCalls.clear();
    this.set({
      epoch: this.state.epoch + 1,
      phase: 'waiting',
      route: null,
      dialogIntent: undefined,
      call: null,
      runtime: { status: 'offline', muted: false },
      wsStatus: 'offline',
    });
  }

  private fail(cause: unknown): void {
    this.generation++;
    this.clear();
    this.set({ phase: 'error', error: bridgeError(cause).message });
  }

  private acceptCall(call: NativeState['call']): void {
    const previous = this.state.call;

    if (call && this.retiredCalls.has(call.call_id)) {
      return;
    }

    if (
      previous &&
      call?.call_id === previous.call_id &&
      (call.version < previous.version || (previous.state === 'ended' && call.state !== 'ended'))
    ) {
      return;
    }

    if (previous && previous.call_id !== call?.call_id) {
      this.retiredCalls.add(previous.call_id);
    }

    this.set({ call });
  }

  private receive(name: string, value: unknown, generation: number): void {
    if (generation !== this.generation) {
      return;
    }

    const envelope = z.object({ cycleId: z.string() }).safeParse(value);

    if (!envelope.success || envelope.data.cycleId !== this.state.cycleId) {
      return;
    }

    if (name === 'dialogNotificationIntent') {
      const intent = z
        .strictObject({
          cycleId: z.string(),
          intentId: z.string().uuid(),
          dialogId: z.string().uuid(),
        })
        .safeParse(value);

      if (intent.success) {
        this.set({
          dialogIntent: { intentId: intent.data.intentId, dialogId: intent.data.dialogId },
        });
      }

      return;
    }

    if (name === 'wsMessage') {
      if (this.state.phase !== 'ready' || !this.token) {
        return;
      }

      const parsed = z
        .strictObject({ cycleId: z.string(), message: z.record(z.string(), z.json()) })
        .safeParse(value);

      if (!parsed.success || typeof parsed.data.message.type !== 'string') {
        return;
      }

      // Raw messages never enter React snapshots or call UI state.
      for (const listener of this.wsListeners) {
        listener(parsed.data.message);
      }

      return;
    }

    try {
      if (name === 'wsState') {
        const event = z
          .strictObject({
            cycleId: z.string(),
            status: z.enum(['offline', 'connecting', 'online']),
          })
          .parse(value);

        this.set({ wsStatus: this.token ? event.status : 'offline' });
      } else if (name === 'route') {
        const route = routeSchema.parse(value);
        // Decode before validating so encoded separators, control characters and URLs cannot escape the router.
        const path = decodeURIComponent(route.path);

        if (
          !/^\/(?:login|calls(?:\/[0-9a-f-]+)?|dialogs(?:\/(?:contacts|[0-9a-f-]+))?|settings(?:\/general(?:\/(?:microphone|audio|push|camera|geolocation|files))?)?|admin(?:\/users(?:\/[0-9a-f-]+)?)?)?(?:\?[^#]*)?$/.test(
            path,
          ) ||
          /[\\\s\u0000-\u001f]/.test(path)
        ) {
          throw bridgeError({ code: 'VALIDATION_ERROR' });
        }

        const url = new URL(route.path, window.location.origin);
        const selectedServer = url.searchParams.get('serverUrl');

        if (selectedServer !== null) {
          serverUrl(selectedServer);
        }

        const keys = [...url.searchParams.keys()];
        const historyRoute = /^\/calls(?:\/[0-9a-f-]+)?$/.test(url.pathname);
        const historyQuery =
          historyRoute &&
          keys.length === 1 &&
          keys[0] === 'filter' &&
          ['all', 'missed'].includes(url.searchParams.get('filter') ?? '');
        const contactsQuery =
          url.pathname === '/dialogs/contacts' &&
          keys.length === 1 &&
          keys[0] === 'group' &&
          /^(?:all|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/.test(
            url.searchParams.get('group') ?? '',
          );
        const loginQuery =
          url.pathname === '/login' && keys.length === 1 && keys[0] === 'serverUrl';

        if (url.search && !historyQuery && !contactsQuery && !loginQuery) {
          throw bridgeError({ code: 'VALIDATION_ERROR' });
        }

        if (route.accessToken) {
          const next = identity({ access_token: route.accessToken });

          if (this.token && identity({ access_token: this.token }).sid !== next.sid) {
            this.clear();
          }

          this.token = route.accessToken;
        }

        if (url.pathname === '/login' && this.token) {
          this.clear();
          this.snapshotReceived = true;
        }

        if (url.pathname !== '/login' && !this.token) {
          throw bridgeError({ code: 'UNAUTHENTICATED' });
        }

        this.set({ route: { path: route.path, replace: route.replace ?? true } });
      } else if (name === 'loggedOut') {
        z.strictObject({ cycleId: z.string() }).parse(value);
        this.clear();
        this.snapshotReceived = true;
      } else if (name === 'callSnapshot') {
        if (this.snapshotReceived) {
          return;
        }

        const snapshot = snapshotSchema.parse(value);

        this.snapshotReceived = true;
        this.set({ call: snapshot.call, runtime: snapshot.runtime });
      } else if (this.snapshotReceived && name === 'callStateChanged') {
        this.acceptCall(
          z.strictObject({ cycleId: z.string(), call: nativeCallSchema.nullable() }).parse(value)
            .call,
        );
      } else if (this.snapshotReceived && name === 'callRuntimeChanged') {
        this.set({
          runtime: z.strictObject({ cycleId: z.string(), status: runtimeSchema }).parse(value)
            .status,
        });
      }

      if (this.state.route && this.snapshotReceived) {
        clearTimeout(this.deadline);
        nativeHttp.activate(this.state.cycleId, window.location.origin, this.controller.signal);
        this.set({ phase: 'ready', error: null });
        this.navigationReady();
      }
    } catch {
      this.fail({ code: 'VALIDATION_ERROR' });
    }
  }

  async ready(): Promise<void> {
    const generation = ++this.generation;

    this.clear();
    this.set({
      cycleId: crypto.randomUUID(),
      error: null,
      nativeCalls: null,
      webCallControls: false,
      nativeWebSocket: false,
    });
    this.deadline = setTimeout((): void => {
      if (generation === this.generation) {
        this.fail({ code: 'BRIDGE_UNAVAILABLE' });
      }
    }, 15000);
    const previous = this.handles;

    this.handles = [];
    await Promise.all(
      previous.map((handle): Promise<void> =>
        (async () => {
          try {
            return await handle.remove();
          } catch (cause) {}
        })(),
      ),
    );

    try {
      const capabilities = await invoke((): Promise<unknown> => nativePlugin.getCapabilities());

      if (generation !== this.generation) {
        return;
      }

      const parsedCapabilities = capabilitiesSchema.safeParse(capabilities);

      if (!parsedCapabilities.success) {
        throw bridgeError({ code: 'UNSUPPORTED_VERSION' });
      }

      this.set({
        nativeCalls: parsedCapabilities.data.nativeCalls,
        webCallControls: parsedCapabilities.data.webCallControls === true,
        mediaVersion: parsedCapabilities.data.mediaVersion,
        dialogStorageVersion: parsedCapabilities.data.dialogStorageVersion,
        dialogNotificationsVersion: parsedCapabilities.data.dialogNotificationsVersion,
        nativeWebSocket: parsedCapabilities.data.nativeWebSocket ?? false,
      });

      for (const name of [
        'route',
        'loggedOut',
        'callSnapshot',
        'callStateChanged',
        'callRuntimeChanged',
        ...(parsedCapabilities.data.nativeWebSocket ? ['wsMessage', 'wsState'] : []),
        ...(parsedCapabilities.data.dialogNotificationsVersion ? ['dialogNotificationIntent'] : []),
      ]) {
        const handle = await invoke((): ReturnType<typeof nativePlugin.addListener> =>
          nativePlugin.addListener(name, (value): void => this.receive(name, value, generation)),
        );

        if (generation !== this.generation) {
          const { remove: handleRemove } = handle;

          await handleRemove.bind(handle)();

          return;
        }

        this.handles.push(handle);
      }

      nativeHttp.activate(this.state.cycleId, window.location.origin, this.controller.signal);

      await invoke((): Promise<void> =>
        nativePlugin.webReady({ bridgeVersion, cycleId: this.state.cycleId }),
      );
    } catch (cause) {
      if (generation === this.generation) {
        this.fail(cause);
      }
    }
  }

  stop(): void {
    this.generation++;

    for (const handle of this.handles) {
      void (async () => {
        try {
          return await handle.remove();
        } catch (cause) {}
      })();
    }

    this.handles = [];
    this.clear();
  }

  async access(forceRefresh = false): Promise<string> {
    const cycle = this.state.cycleId;
    const signal = this.controller.signal;

    if (this.state.phase !== 'ready' || !this.token) {
      throw bridgeError({ code: 'UNAUTHENTICATED' });
    }

    if (!forceRefresh) {
      return this.token;
    }

    try {
      const result = z
        .strictObject({ accessToken: z.string().min(1) })
        .parse(await invoke((): Promise<unknown> => nativePlugin.getAccessToken({ forceRefresh })));

      if (cycle !== this.state.cycleId || signal.aborted) {
        throw new DOMException('Aborted', 'AbortError');
      }

      if (
        identity({ access_token: result.accessToken }).sid !==
        identity({ access_token: this.token ?? '' }).sid
      ) {
        throw bridgeError({ code: 'SESSION_INVALID' });
      }

      this.token = result.accessToken;

      return this.token;
    } catch (cause) {
      if (
        cycle === this.state.cycleId &&
        !signal.aborted &&
        bridgeError(cause).code === 'SESSION_INVALID'
      ) {
        this.clear();
      }

      if (cause instanceof DOMException) {
        throw cause;
      }

      throw bridgeError(cause);
    }
  }
}

export const nativeRuntime = new NativeRuntime();

import { z } from 'zod';

import { callSchema } from '../api/call';
import { identity } from '../identity';
import { bridgeError, bridgeVersion, invoke, nativePlugin, serverUrl } from './bridge';

export const nativeCallSchema = callSchema.strict();

const runtimeSchema = z.strictObject({
  status: z.enum(['offline', 'connecting', 'online']),
  muted: z.boolean(),
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
  nativeCalls: z.literal(true),
});

export interface NativeState {
  cycleId: string;
  epoch: number;
  phase: 'waiting' | 'ready' | 'error';
  error: string | null;
  route: { path: string; replace: boolean } | null;
  call: z.infer<typeof nativeCallSchema> | null;
  runtime: z.infer<typeof runtimeSchema>;
}

/** Only the HTTP transport reads the token. React and Query snapshots never contain it. */
export class NativeRuntime {
  private state: NativeState = {
    cycleId: '',
    epoch: 0,
    phase: 'waiting',
    error: null,
    route: null,
    call: null,
    runtime: { status: 'offline', muted: false },
  };
  private token: string | null = null;
  private listeners = new Set<() => void>();
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

  private set(patch: Partial<NativeState>): void {
    this.state = { ...this.state, ...patch };

    for (const listener of this.listeners) listener();

    window.dispatchEvent(new Event('gchat-session'));
  }

  clear(): void {
    clearTimeout(this.deadline);
    this.token = null;
    this.controller.abort();
    this.controller = new AbortController();
    this.snapshotReceived = false;
    this.retiredCalls.clear();
    this.set({
      epoch: this.state.epoch + 1,
      phase: 'waiting',
      route: null,
      call: null,
      runtime: { status: 'offline', muted: false },
    });
  }

  private fail(cause: unknown): void {
    this.generation++;
    this.clear();
    this.set({ phase: 'error', error: bridgeError(cause).message });
  }

  private acceptCall(call: NativeState['call']): void {
    const previous = this.state.call;

    if (call && this.retiredCalls.has(call.call_id)) return;

    if (
      previous &&
      call?.call_id === previous.call_id &&
      (call.version < previous.version || (previous.state === 'ended' && call.state !== 'ended'))
    )
      return;

    if (previous && previous.call_id !== call?.call_id) this.retiredCalls.add(previous.call_id);

    this.set({ call });
  }

  private receive(name: string, value: unknown, generation: number): void {
    if (generation !== this.generation) return;

    const envelope = z.object({ cycleId: z.string() }).safeParse(value);

    if (!envelope.success || envelope.data.cycleId !== this.state.cycleId) return;

    try {
      if (name === 'route') {
        const route = routeSchema.parse(value);
        // Decode before validating so encoded separators, control characters and URLs cannot escape the router.
        const path = decodeURIComponent(route.path);

        if (
          !/^\/(?:login|calls|admin(?:\/users(?:\/[0-9a-f-]+)?)?)?(?:\?[^#]*)?$/.test(path) ||
          /[\\\s\u0000-\u001f]/.test(path)
        )
          throw bridgeError({ code: 'VALIDATION_ERROR' });

        const url = new URL(route.path, window.location.origin);
        const selectedServer = url.searchParams.get('serverUrl');

        if (selectedServer !== null) serverUrl(selectedServer);

        if (
          [...url.searchParams.keys()].some((key): boolean => key !== 'serverUrl') ||
          (url.search && url.pathname !== '/login')
        )
          throw bridgeError({ code: 'VALIDATION_ERROR' });

        if (route.accessToken) {
          const next = identity({ access_token: route.accessToken });

          if (this.token && identity({ access_token: this.token }).sid !== next.sid) this.clear();

          this.token = route.accessToken;
        }

        if (url.pathname === '/login' && this.token) {
          this.clear();
          this.snapshotReceived = true;
        }

        if (url.pathname !== '/login' && !this.token)
          throw bridgeError({ code: 'UNAUTHENTICATED' });

        this.set({ route: { path: route.path, replace: route.replace ?? true } });
      } else if (name === 'loggedOut') {
        z.strictObject({ cycleId: z.string() }).parse(value);
        this.clear();
        this.snapshotReceived = true;
      } else if (name === 'callSnapshot') {
        if (this.snapshotReceived) return;

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
        this.set({ phase: 'ready', error: null });
      }
    } catch {
      this.fail({ code: 'VALIDATION_ERROR' });
    }
  }

  async ready(): Promise<void> {
    const generation = ++this.generation;

    this.clear();
    this.set({ cycleId: crypto.randomUUID(), error: null });
    this.deadline = setTimeout((): void => {
      if (generation === this.generation) {
        this.fail({ code: 'BRIDGE_UNAVAILABLE' });
      }
    }, 15000);
    const previous = this.handles;

    this.handles = [];
    await Promise.all(
      previous.map((handle): Promise<void> => handle.remove().catch((): void => {})),
    );

    try {
      const capabilities = await invoke((): Promise<unknown> => nativePlugin.getCapabilities());

      if (generation !== this.generation) return;

      if (!capabilitiesSchema.safeParse(capabilities).success)
        throw bridgeError({ code: 'UNSUPPORTED_VERSION' });

      for (const name of [
        'route',
        'loggedOut',
        'callSnapshot',
        'callStateChanged',
        'callRuntimeChanged',
      ]) {
        const handle = await invoke((): ReturnType<typeof nativePlugin.addListener> =>
          nativePlugin.addListener(name, (value): void => this.receive(name, value, generation)),
        );

        if (generation !== this.generation) {
          await handle.remove();

          return;
        }

        this.handles.push(handle);
      }

      await invoke((): Promise<void> =>
        nativePlugin.webReady({ bridgeVersion, cycleId: this.state.cycleId }),
      );
    } catch (cause) {
      if (generation === this.generation) this.fail(cause);
    }
  }

  stop(): void {
    this.generation++;

    for (const handle of this.handles) void handle.remove().catch((): void => {});

    this.handles = [];
    this.clear();
  }

  async access(forceRefresh = false): Promise<string> {
    const cycle = this.state.cycleId;
    const signal = this.controller.signal;

    if (this.state.phase !== 'ready' || !this.token) throw bridgeError({ code: 'UNAUTHENTICATED' });

    if (!forceRefresh) return this.token;

    try {
      const result = z
        .strictObject({ accessToken: z.string().min(1) })
        .parse(await invoke((): Promise<unknown> => nativePlugin.getAccessToken({ forceRefresh })));

      if (cycle !== this.state.cycleId || signal.aborted)
        throw new DOMException('Aborted', 'AbortError');

      if (
        identity({ access_token: result.accessToken }).sid !==
        identity({ access_token: this.token ?? '' }).sid
      )
        throw bridgeError({ code: 'SESSION_INVALID' });

      this.token = result.accessToken;

      return this.token;
    } catch (cause) {
      if (
        cycle === this.state.cycleId &&
        !signal.aborted &&
        bridgeError(cause).code === 'SESSION_INVALID'
      )
        this.clear();

      if (cause instanceof DOMException) throw cause;

      throw bridgeError(cause);
    }
  }
}

export const nativeRuntime = new NativeRuntime();

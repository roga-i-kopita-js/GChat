import { embedded } from '../native/bridge';
import { nativeRuntime } from '../native/runtime';
import { currentSession, identity, login, logout, run } from '../session/session';
import { type CallOptions, SessionEvent, type SessionService, type SessionState } from './api';
import { DeviceError } from './contract';
import { cancellable, StateSource } from './events';
import { deviceFailure } from './failure';

export class DeviceSession<THttp> implements SessionService<THttp> {
  readonly source = new StateSource<SessionState>({
    revision: 0,
    status: 'starting',
    identity: null,
    generation: 0,
    error: null,
  });
  private scope: string | null = null;
  private cycle = '';
  private controller = new AbortController();
  private cleanup: (() => void) | null = null;
  private stopped = false;

  constructor(
    private readonly http: () => THttp,
    private readonly lifecycleSignal: () => AbortSignal,
    private readonly signOut: () => Promise<void> = logout,
  ) {}

  signal = (): AbortSignal => this.controller.signal;

  on(_event: SessionEvent.StateChanged, handler: (state: SessionState) => void): () => void {
    return this.source.on(handler);
  }

  start(): void {
    if (this.cleanup) {
      return;
    }

    this.stopped = false;
    window.addEventListener('gchat-session', this.sync);
    window.addEventListener('storage', this.sync);
    const off = nativeRuntime.subscribe(this.sync);

    this.cleanup = (): void => {
      window.removeEventListener('gchat-session', this.sync);
      window.removeEventListener('storage', this.sync);
      off();
    };
    this.sync();
  }

  sync = (): void => {
    if (this.stopped) {
      return;
    }

    const native = nativeRuntime.getSnapshot();
    const phase = embedded ? native.phase : 'ready';
    const cycle = embedded ? native.cycleId : '';
    const saved = phase === 'ready' ? currentSession() : null;
    const claims = saved ? identity(saved) : null;
    const scope = claims?.sid ?? null;
    const old = this.source.getSnapshot();
    // A resync aborts old work immediately but does not rotate account generation on token refresh.
    const changedScope = phase === 'ready' && scope !== this.scope;

    if (changedScope || cycle !== this.cycle || phase === 'error') {
      this.controller.abort();
      this.controller = new AbortController();
    }

    if (phase === 'ready') {
      this.scope = scope;
    }

    this.cycle = cycle;
    this.source.set({
      ...old,
      status:
        phase === 'waiting'
          ? 'starting'
          : phase === 'error'
            ? 'error'
            : claims
              ? 'authenticated'
              : 'anonymous',
      generation: old.generation + (changedScope ? 1 : 0),
      identity: claims
        ? {
            id: claims.sub,
            login: claims.login,
            displayName: claims.display_name,
            role: claims.role,
          }
        : null,
      error:
        phase === 'error'
          ? deviceFailure(new DeviceError('BRIDGE_UNAVAILABLE'), 'session', 'synchronize')
          : null,
    });
  };

  async getState(options: CallOptions = {}): Promise<SessionState> {
    this.sync();

    if (this.stopped) {
      throw new DeviceError('INVALID_STATE');
    }

    if (options.signal?.aborted) {
      throw new DeviceError('CANCELLED');
    }

    if (this.source.getSnapshot().status !== 'starting') {
      return this.source.getSnapshot();
    }

    let off = (): void => {};

    try {
      await cancellable(
        (): Promise<void> =>
          new Promise((resolve): void => {
            off = this.source.on((state): void => {
              if (state.status !== 'starting') {
                resolve();
              }
            });

            if (this.source.getSnapshot().status !== 'starting') {
              resolve();
            }
          }),
        options,
        this.lifecycleSignal(),
      );

      return this.source.getSnapshot();
    } finally {
      off();
    }
  }

  async run<T>(
    operation: (http: THttp, signal: AbortSignal) => Promise<T>,
    options: CallOptions = {},
  ): Promise<T> {
    const state = await this.getState(options);

    if (state.status === 'error') {
      throw new DeviceError('BRIDGE_UNAVAILABLE');
    }

    if (state.status !== 'authenticated') {
      throw new DeviceError('UNAUTHENTICATED');
    }

    const signal = AbortSignal.any([
      this.signal(),
      this.lifecycleSignal(),
      ...(options.signal ? [options.signal] : []),
    ]);
    const check = (): void => {
      signal.throwIfAborted();
      this.sync();

      if (this.source.getSnapshot().generation !== state.generation) {
        throw new DeviceError('CANCELLED');
      }
    };

    check();
    const result = await run(async (_unused, combined): Promise<T> => {
      check();
      const value = await operation(this.http(), combined);

      check();

      return value;
    }, signal);

    check();

    return result;
  }

  async login(
    credentials: { login: string; password: string },
    options: CallOptions = {},
  ): Promise<void> {
    try {
      await cancellable(
        (): Promise<void> => login(credentials.login, credentials.password),
        options,
        this.lifecycleSignal(),
      );
    } catch (cause) {
      throw deviceFailure(cause, 'session', 'login');
    } finally {
      this.sync();
    }
  }

  async logout(options: CallOptions = {}): Promise<void> {
    if (this.stopped) {
      throw new DeviceError('INVALID_STATE');
    }

    if (options.signal?.aborted) {
      throw new DeviceError('CANCELLED');
    }

    if ((await this.getState(options)).status === 'anonymous') {
      return;
    }

    try {
      await cancellable(this.signOut, options, this.lifecycleSignal());
    } catch (cause) {
      this.sync();

      if (this.source.getSnapshot().status !== 'anonymous') {
        throw deviceFailure(cause, 'session', 'logout');
      }
    } finally {
      this.sync();
    }
  }

  stop(): void {
    this.stopped = true;
    this.cleanup?.();
    this.cleanup = null;
    this.controller.abort();
    this.source.set({
      ...this.source.getSnapshot(),
      status: 'anonymous',
      identity: null,
      generation: this.source.getSnapshot().generation + 1,
      error: null,
    });
  }
}

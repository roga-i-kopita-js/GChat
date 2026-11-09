import type { DataRouter } from 'react-router';

import { DeviceError } from './contract';

export enum NavigationEvent {
  Started = 'started',
  Completed = 'completed',
  LocationChanged = 'locationChanged',
}

export enum NavigationOutcome {
  Committed = 'committed',
  Redirected = 'redirected',
  Blocked = 'blocked',
  Superseded = 'superseded',
  Failed = 'failed',
}

export interface DeviceLocation {
  pathname: string;
  search: string;
  hash: string;
}

export interface NavigationFailure {
  code: string;
  service: 'navigation';
  operation: 'navigate' | 'revalidate';
  message: string;
}

export interface NavigationResult {
  id: string;
  outcome: NavigationOutcome;
  location: DeviceLocation;
  error?: NavigationFailure;
}

export interface NavigationState {
  revision: number;
  location: DeviceLocation;
  status: 'idle' | 'loading' | 'submitting';
}

export interface NavigationEvents {
  [NavigationEvent.Started]: { revision: number; id: string; to: string };
  [NavigationEvent.Completed]: { revision: number; result: NavigationResult };
  [NavigationEvent.LocationChanged]: { revision: number; location: DeviceLocation };
}

export interface NavigationOptions {
  signal?: AbortSignal;
  replace?: boolean;
}

export class NavigationError extends DeviceError implements NavigationFailure {
  readonly service = 'navigation';

  constructor(
    code: string,
    readonly operation: 'navigate' | 'revalidate' = 'navigate',
  ) {
    super(code);
    let errorMessage;

    if (code === 'CANCELLED') {
      errorMessage = 'Переход отменён';
    } else if (code === 'INVALID_ARGUMENT') {
      errorMessage = 'Недопустимый адрес перехода';
    } else {
      errorMessage = 'Не удалось выполнить переход';
    }

    this.message = errorMessage;
  }
}

interface Pending {
  id: string;
  to: string;
  returned: boolean;
  blocked: boolean;
  proceeded: boolean;
  aborted: boolean;
  resolve: (result: NavigationResult) => void;
  reject: (error: NavigationError) => void;
  removeAbort: () => void;
}
type Listeners = { [E in NavigationEvent]: Set<(data: NavigationEvents[E]) => void> };
type RouterTo = Parameters<DataRouter['navigate']>[0];
type RouterOptions = Parameters<DataRouter['navigate']>[1];

/** Owns navigation over one injected Data router; it never creates a second history/runtime. */
export class DeviceNavigation {
  private snapshot: NavigationState;
  private pending?: Pending;
  private stopped = false;
  private revalidating?: Promise<void>;
  private readonly stoppedSignal = new AbortController();
  private readonly listeners: Listeners = {
    started: new Set(),
    completed: new Set(),
    locationChanged: new Set(),
  };
  private readonly unsubscribe: () => void;
  private readonly originalNavigate: DataRouter['navigate'];
  private readonly trackedNavigate: DataRouter['navigate'];
  private readonly pop = (): void => {
    this.supersede();
  };

  constructor(
    private readonly router: DataRouter,
    private readonly resolveLocation: (to: string) => string,
    private readonly basename = '',
  ) {
    this.snapshot = Object.freeze({
      revision: 0,
      location: this.location(),
      status: this.status(),
    });
    this.originalNavigate = router.navigate.bind(router);
    this.trackedNavigate = (to: number | RouterTo, options?: RouterOptions): Promise<void> => {
      this.supersede();

      return typeof to === 'number'
        ? this.originalNavigate(to)
        : this.originalNavigate(to, options);
    };
    router.navigate = this.trackedNavigate;
    this.unsubscribe = router.subscribe((): void => {
      this.update();
      this.checkPending();
    });

    if (typeof window !== 'undefined') {
      window.addEventListener('popstate', this.pop);
    }
  }

  on<E extends NavigationEvent>(
    event: E,
    handler: (data: NavigationEvents[E]) => void,
  ): () => void {
    if (this.stopped) {
      return (): void => {};
    }

    this.listeners[event].add(handler);

    return (): void => {
      this.listeners[event].delete(handler);
    };
  }

  async getState(options: { signal?: AbortSignal } = {}): Promise<NavigationState> {
    this.available(options.signal);

    return this.snapshot;
  }

  navigate(to: string, options: NavigationOptions = {}): Promise<NavigationResult> {
    return this.navigateCommand(crypto.randomUUID(), to, options);
  }

  /** Internal correlation supplied by the native adapter, never selected by UI. */
  async navigateCommand(
    id: string,
    to: string,
    options: NavigationOptions = {},
  ): Promise<NavigationResult> {
    this.available(options.signal);
    let target: string;

    try {
      target = this.resolveLocation(to);
    } catch {
      throw new NavigationError('INVALID_ARGUMENT');
    }

    this.supersede();

    return new Promise<NavigationResult>((resolve, reject): void => {
      const pending: Pending = {
        id,
        to: target,
        returned: false,
        blocked: false,
        proceeded: false,
        aborted: false,
        resolve,
        reject,
        removeAbort: (): void => {},
      };
      const aborted = (): void => {
        pending.aborted = true;
        pending.removeAbort();
        reject(new NavigationError('CANCELLED'));
      };

      if (options.signal) {
        options.signal.addEventListener('abort', aborted, { once: true });
        pending.removeAbort = (): void => options.signal?.removeEventListener('abort', aborted);
      }

      this.pending = pending;
      this.emit(NavigationEvent.Started, { revision: this.version(), id, to: target });

      try {
        void (async () => {
          try {
            await this.originalNavigate(target, {
              replace: options.replace ?? false,
            });
          } catch (rejectedCause) {
            if (this.pending === pending) {
              this.finish(NavigationOutcome.Failed);
            }

            return;
          }

          pending.returned = true;
          this.checkPending();
        })();
      } catch {
        if (this.pending === pending) {
          this.finish(NavigationOutcome.Failed);
        }
      }
    });
  }

  revalidate(options: { signal?: AbortSignal } = {}): Promise<void> {
    try {
      this.available(options.signal);
    } catch (error) {
      return Promise.reject(error);
    }

    if (!this.revalidating) {
      const current = this.router.revalidate();

      this.revalidating = current;
      void (async () => {
        try {
          await current;
        } catch (rejectedCause) {
          if (this.revalidating === current) {
            this.revalidating = undefined;
          }

          return;
        }

        if (this.revalidating === current) {
          this.revalidating = undefined;
        }
      })();
    }

    const operation = this.revalidating;

    return new Promise<void>((resolve, reject): void => {
      const clean = (): void => {
        options.signal?.removeEventListener('abort', cancelled);
        this.stoppedSignal.signal.removeEventListener('abort', cancelled);
      };
      const cancelled = (): void => {
        clean();
        reject(new NavigationError('CANCELLED', 'revalidate'));
      };

      options.signal?.addEventListener('abort', cancelled, { once: true });
      this.stoppedSignal.signal.addEventListener('abort', cancelled, { once: true });
      void (async () => {
        try {
          await operation;
        } catch (rejectedCause) {
          clean();
          reject(new NavigationError('INTEGRATION_ERROR', 'revalidate'));

          return;
        }

        clean();
        resolve();
      })();
    });
  }

  stop(): void {
    if (this.stopped) {
      return;
    }

    this.stopped = true;
    this.unsubscribe();
    this.stoppedSignal.abort();

    if (typeof window !== 'undefined') {
      window.removeEventListener('popstate', this.pop);
    }

    if (this.router.navigate === this.trackedNavigate) {
      this.router.navigate = this.originalNavigate;
    }

    if (this.pending) {
      this.pending.removeAbort();
      this.pending.reject(new NavigationError('CANCELLED'));
      this.pending = undefined;
    }

    this.router.dispose();

    for (const set of Object.values(this.listeners)) {
      set.clear();
    }
  }

  private available(signal?: AbortSignal): void {
    if (this.stopped) {
      throw new NavigationError('INVALID_STATE');
    }

    if (signal?.aborted) {
      throw new NavigationError('CANCELLED');
    }
  }

  private location(): DeviceLocation {
    const location = this.router.state.location;
    const path =
      this.basename &&
      (location.pathname === this.basename || location.pathname.startsWith(this.basename + '/'))
        ? location.pathname.slice(this.basename.length) || '/'
        : location.pathname;

    return Object.freeze({ pathname: path, search: location.search, hash: location.hash });
  }

  private status(): NavigationState['status'] {
    let navigationStatus: NavigationState['status'];

    if (this.router.state.navigation.state === 'submitting') {
      navigationStatus = 'submitting';
    } else if (
      this.router.state.navigation.state === 'loading' ||
      this.router.state.revalidation === 'loading'
    ) {
      navigationStatus = 'loading';
    } else {
      navigationStatus = 'idle';
    }

    return navigationStatus;
  }

  private version(): number {
    if (this.snapshot.revision >= Number.MAX_SAFE_INTEGER) {
      throw new NavigationError('INTEGRATION_ERROR');
    }

    this.snapshot = Object.freeze({ ...this.snapshot, revision: this.snapshot.revision + 1 });

    return this.snapshot.revision;
  }

  private update(): void {
    const location = this.location();
    const moved = this.address(location) !== this.address(this.snapshot.location);
    const status = this.status();

    if (!moved && status === this.snapshot.status) {
      return;
    }

    const revision = this.version();

    this.snapshot = Object.freeze({ revision, location, status });

    if (moved) {
      this.emit(NavigationEvent.LocationChanged, { revision, location });
    }
  }

  private checkPending(): void {
    const pending = this.pending;

    if (!pending) {
      return;
    }

    const blockers = [...this.router.state.blockers.values()];

    if (blockers.some((value): boolean => value.state === 'blocked')) {
      pending.blocked = true;

      return;
    }

    if (blockers.some((value): boolean => value.state === 'proceeding')) {
      pending.proceeded = true;

      return;
    }

    if (!pending.returned || this.status() !== 'idle' || !this.router.state.initialized) {
      return;
    }

    if (pending.blocked && !pending.proceeded) {
      this.finish(NavigationOutcome.Blocked);

      return;
    }

    if (this.router.state.errors) {
      this.finish(NavigationOutcome.Failed);

      return;
    }

    this.finish(
      this.address(this.location()) === pending.to
        ? NavigationOutcome.Committed
        : NavigationOutcome.Redirected,
    );
  }

  private supersede(): void {
    if (this.pending) {
      this.finish(NavigationOutcome.Superseded);
    }
  }

  private finish(outcome: NavigationOutcome): void {
    const pending = this.pending;

    if (!pending) {
      return;
    }

    this.pending = undefined;
    pending.removeAbort();
    const result: NavigationResult = Object.freeze({
      id: pending.id,
      outcome,
      location: this.location(),
      ...(outcome === NavigationOutcome.Failed
        ? {
            error: {
              code: 'INTEGRATION_ERROR',
              service: 'navigation',
              operation: 'navigate',
              message: 'Не удалось выполнить переход',
            } satisfies NavigationFailure,
          }
        : {}),
    });

    this.emit(NavigationEvent.Completed, { revision: this.version(), result });

    if (!pending.aborted) {
      pending.resolve(result);
    }
  }

  private address(location: DeviceLocation): string {
    return location.pathname + location.search + location.hash;
  }

  private emit<E extends NavigationEvent>(event: E, data: NavigationEvents[E]): void {
    for (const listener of this.listeners[event]) {
      try {
        listener(data);
      } catch {
        /* One subscriber cannot stop others. */
      }
    }
  }
}

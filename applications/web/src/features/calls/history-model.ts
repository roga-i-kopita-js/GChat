import { ApiError, type BackendApi, type CallHistoryItemDto } from '@gchat/backend-api';
import { z } from 'zod';

import {
  CallEvent,
  type CallsState,
  type DeviceCore,
  LifecycleEvent,
  SessionEvent,
  TransportEvent,
} from '../../shared/device';
import { Events } from '../../shared/device/events';

export type HistoryFilter = 'all' | 'missed';

export enum HistoryEvent {
  Changed = 'changed',
}

const itemSchema = z.object({
  call_id: z.uuid(),
  peer_id: z.uuid(),
  peer_display_name: z.string(),
  version: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  direction: z.enum(['incoming', 'outgoing']),
  outcome: z.enum(['completed', 'missed', 'unanswered', 'cancelled', 'rejected', 'failed']),
  created_at: z.string().datetime(),
  started_at: z.string().datetime().nullable(),
  ended_at: z.string().datetime(),
  end_reason: z.enum([
    'cancelled',
    'rejected',
    'no_answer',
    'connection_timeout',
    'hangup',
    'connection_lost',
    'session_revoked',
    'account_disabled',
  ]),
  duration_seconds: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
});
const pageSchema = z.object({
  items: z.array(itemSchema),
  next_cursor: z.string().min(1).max(2048).nullable(),
});
const detailSchema = z.object({ item: itemSchema });

interface HistoryView {
  ids: string[];
  nextCursor: string | null;
  loaded: boolean;
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
}
interface HistoryDetail {
  loading: boolean;
  missing: boolean;
  error: string | null;
}

export interface HistorySnapshot {
  revision: number;
  stopped: boolean;
  records: Record<string, CallHistoryItemDto>;
  views: Record<HistoryFilter, HistoryView>;
  details: Record<string, HistoryDetail>;
}

function emptyView(): HistoryView {
  return {
    ids: [],
    nextCursor: null,
    loaded: false,
    loading: false,
    loadingMore: false,
    error: null,
  };
}
function readError(cause: unknown): string {
  return cause instanceof ApiError && cause.status === 429
    ? 'Слишком много запросов. Повторите после паузы.'
    : 'Не удалось загрузить историю. Проверьте соединение и повторите.';
}

/** One owner of HTTP pages and details, scoped to one device/session generation. */
export class CallHistoryModel {
  private snapshot: HistorySnapshot = {
    revision: 0,
    stopped: false,
    records: {},
    views: { all: emptyView(), missed: emptyView() },
    details: {},
  };
  private readonly events = new Events<{ [HistoryEvent.Changed]: HistorySnapshot }>();
  private readonly abort = new AbortController();
  private readonly reads = new Map<string, AbortController>();
  private readonly versions = new Map<string, number>();
  private readonly off: (() => void)[] = [];
  private active: HistoryFilter | null = null;
  private foreground = true;
  private timer?: ReturnType<typeof setInterval>;
  private terminal = '';
  private online = false;
  private callRevision = -1;
  private transportRevision = -1;
  private visibilityRevision = -1;
  private detachVisible?: () => void;
  readonly scroll: Record<HistoryFilter, number> = { all: 0, missed: 0 };

  constructor(
    readonly device: DeviceCore<BackendApi>,
    readonly scope: string,
    accountId: string,
    generation: number,
  ) {
    this.off.push(
      device.session.on(SessionEvent.StateChanged, (state): void => {
        if (
          state.status !== 'authenticated' ||
          state.identity?.id !== accountId ||
          state.generation !== generation
        ) {
          this.dispose();
        }
      }),
    );
    this.off.push(
      device.lifecycle.on(LifecycleEvent.StateChanged, (state): void => {
        if (state.phase === 'stopped') {
          this.dispose();
        }
      }),
    );
  }

  getSnapshot = (): HistorySnapshot => this.snapshot;
  on = (listener: () => void): (() => void) => this.events.on(HistoryEvent.Changed, listener);

  private publish(patch: Partial<HistorySnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch, revision: this.snapshot.revision + 1 };
    this.events.emit(HistoryEvent.Changed, this.snapshot);
  }

  private view(filter: HistoryFilter, patch: Partial<HistoryView>): void {
    this.publish({
      views: { ...this.snapshot.views, [filter]: { ...this.snapshot.views[filter], ...patch } },
    });
  }

  private begin(key: string, signal?: AbortSignal): { signal: AbortSignal; current(): boolean } {
    this.reads.get(key)?.abort();
    const controller = new AbortController();

    this.reads.set(key, controller);
    const combined = AbortSignal.any([
      this.abort.signal,
      controller.signal,
      ...(signal ? [signal] : []),
    ]);

    return {
      signal: combined,
      current: (): boolean => !combined.aborted && this.reads.get(key) === controller,
    };
  }

  async head(filter: HistoryFilter, signal?: AbortSignal): Promise<void> {
    if (this.snapshot.stopped) {
      signal?.throwIfAborted();

      return;
    }

    this.reads.get('more:' + filter)?.abort();
    const request = this.begin('head:' + filter, signal);

    this.versions.set(filter, (this.versions.get(filter) ?? 0) + 1);
    this.view(filter, { loading: true, loadingMore: false, error: null });

    try {
      const { data } = await this.device.session.run(
        (api, combined): ReturnType<BackendApi['callsHistoryList']> =>
          api.callsHistoryList({ query: { filter, limit: 30 }, signal: combined }),
        { signal: request.signal },
      );
      const page = pageSchema.parse(data);

      if (!request.current()) {
        return;
      }

      const previous = this.snapshot.views[filter];
      const ids = page.items.map((item): string => item.call_id);
      const overlap = ids.some((id): boolean => previous.ids.includes(id));
      const keepTail = overlap && page.next_cursor !== null;
      const merged = keepTail
        ? [...ids, ...previous.ids.filter((id): boolean => !ids.includes(id))]
        : ids;

      if (!overlap && previous.ids.length) {
        this.scroll[filter] = 0;
      }

      const records = { ...this.snapshot.records };

      for (const item of page.items) {
        records[item.call_id] = item;
      }

      this.publish({ records });
      this.view(filter, {
        ids: merged,
        nextCursor: keepTail ? previous.nextCursor : page.next_cursor,
        loaded: true,
        loading: false,
      });
    } catch (cause) {
      signal?.throwIfAborted();

      if (request.current()) {
        this.view(filter, { loading: false, error: readError(cause) });
      }
    }
  }

  async more(filter: HistoryFilter): Promise<void> {
    const view = this.snapshot.views[filter];

    if (this.snapshot.stopped || view.loading || view.loadingMore || !view.nextCursor) {
      return;
    }

    const version = this.versions.get(filter);
    const request = this.begin('more:' + filter);

    this.view(filter, { loadingMore: true, error: null });

    try {
      const { data } = await this.device.session.run(
        (api, combined): ReturnType<BackendApi['callsHistoryList']> =>
          api.callsHistoryList({
            query: { filter, limit: 30, cursor: view.nextCursor ?? undefined },
            signal: combined,
          }),
        { signal: request.signal },
      );
      const page = pageSchema.parse(data);

      if (!request.current() || version !== this.versions.get(filter)) {
        return;
      }

      const records = { ...this.snapshot.records };

      for (const item of page.items) {
        records[item.call_id] = item;
      }

      this.publish({ records });
      this.view(filter, {
        ids: [...new Set([...view.ids, ...page.items.map((item): string => item.call_id)])],
        nextCursor: page.next_cursor,
        loadingMore: false,
      });
    } catch (cause) {
      if (request.current()) {
        this.view(filter, { loadingMore: false, error: readError(cause) });
      }
    }
  }

  async detail(id: string, signal?: AbortSignal): Promise<void> {
    if (this.snapshot.stopped) {
      signal?.throwIfAborted();

      return;
    }

    const request = this.begin('detail:' + id, signal);

    this.publish({
      details: { ...this.snapshot.details, [id]: { loading: true, missing: false, error: null } },
    });

    try {
      const { data } = await this.device.session.run(
        (api, combined): ReturnType<BackendApi['callsHistoryGet']> =>
          api.callsHistoryGet({ path: { call_id: id }, signal: combined }),
        { signal: request.signal },
      );
      const { item } = detailSchema.parse(data);

      if (item.call_id !== id) {
        throw new Error('History identity mismatch');
      }

      if (!request.current()) {
        return;
      }

      this.publish({
        records: { ...this.snapshot.records, [id]: item },
        details: {
          ...this.snapshot.details,
          [id]: { loading: false, missing: false, error: null },
        },
      });
    } catch (cause) {
      signal?.throwIfAborted();

      if (request.current()) {
        this.publish({
          details: {
            ...this.snapshot.details,
            [id]: {
              loading: false,
              missing: cause instanceof ApiError && cause.status === 404,
              error: readError(cause),
            },
          },
        });
      }
    }
  }

  private observeCall(state: CallsState): void {
    if (state.revision < this.callRevision) {
      return;
    }

    this.callRevision = state.revision;

    if (
      !this.active ||
      !this.foreground ||
      this.snapshot.stopped ||
      !state.call ||
      state.call.state !== 'ended'
    ) {
      return;
    }

    const key = state.call.call_id + ':' + state.call.version;

    if (key === this.terminal) {
      return;
    }

    this.terminal = key;
    void this.detail(state.call.call_id);

    if (this.active && this.foreground) {
      void this.head(this.active);
    }
  }

  visible(filter: HistoryFilter): () => void {
    this.detachVisible?.();
    this.active = filter;
    const refresh = (): void => {
      if (this.active && this.foreground && !this.snapshot.stopped) {
        void this.head(this.active);
      }
    };
    const off = [
      this.device.calls.on(CallEvent.StateChanged, (state): void => this.observeCall(state)),
      this.device.transport.on(TransportEvent.StateChanged, (state): void => {
        if (state.revision < this.transportRevision) {
          return;
        }

        this.transportRevision = state.revision;
        const online = state.status === 'online';

        if (online && !this.online) {
          refresh();
        }

        this.online = online;
      }),
      this.device.lifecycle.on(LifecycleEvent.VisibilityChanged, (state): void => {
        if (state.revision < this.visibilityRevision) {
          return;
        }

        this.visibilityRevision = state.revision;
        const previous = this.foreground;

        this.foreground = state.visibility === 'foreground';

        if (!previous && this.foreground) {
          refresh();
        }
      }),
    ];

    const timer = setInterval(refresh, 60000);

    this.timer = timer;
    void (async () => {
      try {
        const { visibility, revision: lifecycleRevision } = await this.device.lifecycle.getState();

        if (this.active === filter && lifecycleRevision >= this.visibilityRevision) {
          this.visibilityRevision = lifecycleRevision;
          this.foreground = visibility === 'foreground';
        }

        const { status, revision: transportRevision } = await this.device.transport.getState();

        if (this.active === filter && transportRevision >= this.transportRevision) {
          this.transportRevision = transportRevision;
          this.online = status === 'online';
        }

        const calls = await this.device.calls.getState();

        if (this.active === filter) {
          this.observeCall(calls);
        }
      } catch {
        /* Existing snapshots can become unavailable during session replacement. */
      }
    })();
    let attached = true;
    const detach = (): void => {
      if (!attached) {
        return;
      }

      attached = false;
      off.forEach((unsubscribe): void => unsubscribe());
      clearInterval(timer);

      if (this.detachVisible === detach) {
        this.active = null;
        this.detachVisible = undefined;
      }
    };

    this.detachVisible = detach;

    return detach;
  }

  dispose(): void {
    if (this.snapshot.stopped) {
      return;
    }

    this.abort.abort();
    this.detachVisible?.();
    clearInterval(this.timer);
    this.off.forEach((unsubscribe): void => unsubscribe());
    this.active = null;
    this.publish({
      stopped: true,
      records: {},
      views: { all: emptyView(), missed: emptyView() },
      details: {},
    });
  }
}

const models = new WeakMap<object, CallHistoryModel>();

export function historyModel(
  device: DeviceCore<BackendApi>,
  scope: string,
  accountId: string,
  generation: number,
): CallHistoryModel {
  let model = models.get(device);

  if (!model || model.scope !== scope || model.getSnapshot().stopped) {
    model?.dispose();
    model = new CallHistoryModel(device, scope, accountId, generation);
    models.set(device, model);
  }

  return model;
}

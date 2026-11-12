import { ApiError, type BackendApi, type CallHistoryItemDto } from '@gchat/backend-api';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  CallEvent,
  type DeviceCore,
  LifecycleEvent,
  SessionEvent,
  TransportEvent,
} from '../../shared/device';
import { Events } from '../../shared/device/events';
import { historyDay, historyDuration } from './history-format';
import { CallHistoryModel } from './history-model';

const me = '00000000-0000-4000-8000-000000000001';
const peer = '00000000-0000-4000-8000-000000000002';
const id = (number: number): string =>
  '10000000-0000-4000-8000-' + String(number).padStart(12, '0');

function item(number: number, name = 'Анна'): CallHistoryItemDto {
  return {
    call_id: id(number),
    version: 1,
    peer_id: peer,
    peer_display_name: name,
    direction: 'incoming',
    outcome: 'missed',
    created_at: '2026-11-11T12:00:00.000Z',
    started_at: null,
    ended_at: '2026-11-11T12:00:30.000Z',
    end_reason: 'no_answer',
    duration_seconds: null,
  };
}
function fixture(): {
  model: CallHistoryModel;
  list: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
  calls: Events<any>;
  transport: Events<any>;
  lifecycle: Events<any>;
  session: Events<any>;
} {
  const calls = new Events<any>();
  const transport = new Events<any>();
  const lifecycle = new Events<any>();
  const session = new Events<any>();
  const list = vi.fn().mockResolvedValue({ data: { items: [], next_cursor: null } });
  const get = vi.fn().mockResolvedValue({ data: { item: item(1) } });
  const api = { callsHistoryList: list, callsHistoryGet: get };
  const device = {
    session: {
      on: session.on.bind(session),
      run: (action: any, options: any): Promise<unknown> => action(api, options?.signal),
    },
    calls: {
      on: calls.on.bind(calls),
      getState: async (): Promise<object> => ({ revision: 0, call: null }),
    },
    transport: {
      on: transport.on.bind(transport),
      getState: async (): Promise<object> => ({ revision: 0, status: 'online' }),
    },
    lifecycle: {
      on: lifecycle.on.bind(lifecycle),
      getState: async (): Promise<object> => ({ revision: 0, visibility: 'foreground' }),
    },
  } as unknown as DeviceCore<BackendApi>;

  return {
    model: new CallHistoryModel(device, me + '/session', me, 1),
    list,
    get,
    calls,
    transport,
    lifecycle,
    session,
  };
}

afterEach((): void => {
  vi.useRealTimers();
});

describe('history runtime', (): void => {
  it('keeps one canonical record and merges overlap, pagination and same-version profile updates', async (): Promise<void> => {
    const { model, list } = fixture();

    list.mockResolvedValueOnce({ data: { items: [item(1), item(2)], next_cursor: 'page-2' } });
    await model.head('all');
    list.mockResolvedValueOnce({ data: { items: [item(2), item(3)], next_cursor: null } });
    await model.more('all');
    expect(model.getSnapshot().views.all.ids).toEqual([id(1), id(2), id(3)]);
    expect(list.mock.calls[1][0].query.cursor).toBe('page-2');
    list.mockResolvedValueOnce({
      data: { items: [item(4), item(1, 'Новое имя')], next_cursor: 'head-cursor' },
    });
    await model.head('all');
    expect(model.getSnapshot().views.all.ids).toEqual([id(4), id(1), id(2), id(3)]);
    expect(model.getSnapshot().records[id(1)].peer_display_name).toBe('Новое имя');
    expect(model.getSnapshot().views.all.nextCursor).toBeNull();
    model.dispose();
  });

  it('starts a new chain when new calls displace the old page and retains rows on pagination failure', async (): Promise<void> => {
    const { model, list } = fixture();

    list.mockResolvedValueOnce({ data: { items: [item(1)], next_cursor: 'next' } });
    await model.head('all');
    list.mockRejectedValueOnce(new TypeError('offline'));
    await model.more('all');
    expect(model.getSnapshot().views.all).toMatchObject({
      ids: [id(1)],
      nextCursor: 'next',
      loadingMore: false,
      error: expect.any(String),
    });
    model.scroll.all = 300;
    list.mockResolvedValueOnce({ data: { items: [item(9)], next_cursor: 'new-chain' } });
    await model.head('all');
    expect(model.getSnapshot().views.all).toMatchObject({
      ids: [id(9)],
      nextCursor: 'new-chain',
      error: null,
    });
    expect(model.scroll.all).toBe(0);
    model.dispose();
  });

  it('rejects late pages from a superseded chain even if the transport ignores cancellation', async (): Promise<void> => {
    const { model, list } = fixture();

    list.mockResolvedValueOnce({ data: { items: [item(1)], next_cursor: 'old' } });
    await model.head('all');
    let finish!: (value: unknown) => void;

    list.mockReturnValueOnce(
      new Promise((resolve): void => {
        finish = resolve;
      }),
    );
    const pending = model.more('all');

    list.mockResolvedValueOnce({ data: { items: [item(2)], next_cursor: 'new' } });
    await model.head('all');
    finish({ data: { items: [item(3)], next_cursor: null } });
    await pending;
    expect(model.getSnapshot().views.all.ids).toEqual([id(2)]);
    expect(model.getSnapshot().records[id(3)]).toBeUndefined();
    model.dispose();
  });

  it('clears all personal data on session replacement and ignores a late response', async (): Promise<void> => {
    const { model, list, session } = fixture();

    list.mockResolvedValueOnce({ data: { items: [item(1)], next_cursor: null } });
    await model.head('all');
    let finish!: (value: unknown) => void;

    list.mockReturnValueOnce(
      new Promise((resolve): void => {
        finish = resolve;
      }),
    );
    const pending = model.head('missed');

    session.emit(SessionEvent.StateChanged, {
      status: 'authenticated',
      identity: { id: me },
      generation: 2,
    });
    finish({ data: { items: [item(2)], next_cursor: null } });
    await pending;
    expect(model.getSnapshot()).toMatchObject({
      stopped: true,
      records: {},
      views: { all: { ids: [] }, missed: { ids: [] } },
    });
  });

  it('distinguishes 404 and network failures and validates response identity', async (): Promise<void> => {
    const { model, get } = fixture();

    get.mockRejectedValueOnce(
      new ApiError(new Response(null, { status: 404 }), { error: { code: 'NOT_FOUND' } }),
    );
    await model.detail(id(1));
    expect(model.getSnapshot().details[id(1)].missing).toBe(true);
    get.mockRejectedValueOnce(new TypeError('offline'));
    await model.detail(id(1));
    expect(model.getSnapshot().details[id(1)]).toMatchObject({
      missing: false,
      loading: false,
      error: expect.any(String),
    });
    get.mockResolvedValueOnce({ data: { item: item(2) } });
    await model.detail(id(1));
    expect(model.getSnapshot().records[id(1)]).toBeUndefined();
    model.dispose();
  });

  it('updates only in the visible section, deduplicates terminal events and restores after foreground/reconnect', async (): Promise<void> => {
    vi.useFakeTimers();
    const { model, list, get, calls, lifecycle, transport } = fixture();

    await model.head('all');
    const leave = model.visible('all');

    await vi.advanceTimersByTimeAsync(0);
    list.mockClear();
    const ended = { revision: 1, call: { call_id: id(1), version: 1, state: 'ended' } };

    calls.emit(CallEvent.StateChanged, ended);
    calls.emit(CallEvent.StateChanged, ended);
    await vi.advanceTimersByTimeAsync(0);
    expect(get).toHaveBeenCalledTimes(1);
    expect(list).toHaveBeenCalledTimes(1);
    lifecycle.emit(LifecycleEvent.VisibilityChanged, { revision: 1, visibility: 'background' });
    await vi.advanceTimersByTimeAsync(60000);
    expect(list).toHaveBeenCalledTimes(1);
    lifecycle.emit(LifecycleEvent.VisibilityChanged, { revision: 2, visibility: 'foreground' });
    await vi.advanceTimersByTimeAsync(0);
    expect(list).toHaveBeenCalledTimes(2);
    transport.emit(TransportEvent.StateChanged, { revision: 1, status: 'offline' });
    transport.emit(TransportEvent.StateChanged, { revision: 2, status: 'online' });
    await vi.advanceTimersByTimeAsync(0);
    expect(list).toHaveBeenCalledTimes(3);
    leave();
    await vi.advanceTimersByTimeAsync(60000);
    expect(list).toHaveBeenCalledTimes(3);
    model.dispose();
  });
});

it('formats local day boundaries, long durations and a zero-second conversation', (): void => {
  expect(historyDay(new Date(2026, 0, 1, 0, 1).toISOString(), new Date(2026, 0, 1, 23))).toBe(
    'Сегодня',
  );
  expect(historyDay(new Date(2025, 11, 31, 23).toISOString(), new Date(2026, 0, 1))).toBe('Вчера');
  expect(historyDuration(0)).toBe('0:00');
  expect(historyDuration(3661)).toBe('1:01:01');
});

import { afterEach, describe, expect, it, vi } from 'vitest';

import { emptyRecord, type StoredDialog } from './model';
import { openNativeDialogs } from './native-storage';

const mock = vi.hoisted(() => ({
  plugin: { dialogStorage: vi.fn(), getDialogStorageContext: vi.fn() },
  snapshot: vi.fn(),
  open: vi.fn(),
}));

vi.mock('../native/bridge', () => ({ nativePlugin: mock.plugin }));
vi.mock('../native/runtime', () => ({
  nativeRuntime: {
    getSnapshot: mock.snapshot,
    getSignal: (): AbortSignal => new AbortController().signal,
  },
}));
vi.mock('./storage', () => ({ IndexedDialogStorage: { open: mock.open }, purgeAccount: vi.fn() }));

const uuid = (n: number): string => '00000000-0000-4000-8000-' + String(n).padStart(12, '0');
const id = uuid(5);

function setup(version: 1 | 2): { saved: StoredDialog; calls: any[]; staging: any } {
  const context = {
    cycleId: uuid(1),
    accountId: uuid(2),
    sessionId: uuid(3),
    deviceId: uuid(4),
    namespaceId: 'namespace',
    epoch: 1,
    adapterEpoch: 0,
    schemaVersion: version,
    adapter: 'sqlite',
    purgePending: false,
    pendingWebPurges: [],
  };

  vi.stubGlobal('location', { origin: 'https://test.invalid' });
  mock.snapshot.mockReturnValue({ cycleId: context.cycleId, dialogStorageVersion: version });
  mock.plugin.getDialogStorageContext.mockResolvedValue(context);
  const saved: StoredDialog = { record: emptyRecord(), messages: [] };
  const calls: any[] = [];
  const staging = {
    adapter: 'indexeddb',
    close: vi.fn(),
    change: vi.fn(async (_id, _command, update): Promise<StoredDialog> => {
      update(saved);

      return saved;
    }),
    list: async (): Promise<never[]> => [],
  };

  mock.open.mockResolvedValue(staging);
  mock.plugin.dialogStorage.mockImplementation(async (envelope): Promise<unknown> => {
    calls.push(structuredClone(envelope));
    const { command, args } = envelope;
    let data: unknown = {};

    if (command === 'beginFallback') {
      data = { adapterEpoch: 1, migrationHandle: 'namespace' };
    }

    if (command === 'exportFallbackPage') {
      data = {
        entries: [{ id, record: saved.record, messages: saved.messages }],
        nextCursor: null,
        has_more: false,
      };
    }

    if (command === 'readDialog') {
      data = structuredClone(saved.record);
    }

    if (command === 'readMessages') {
      const messages = saved.messages.filter((m): boolean => m.sequence > args.after).slice(0, 20);

      data = {
        messages,
        has_more: saved.messages.some(
          (m): boolean => m.sequence > (messages.at(-1)?.sequence ?? args.after),
        ),
      };
    }

    if (command === 'commitEdits') {
      if (saved.record.revision !== args.expectedRevision) {
        throw { code: 'STORAGE_CONFLICT' };
      }

      saved.record = structuredClone(args.record);

      for (const message of args.messages) {
        const index = saved.messages.findIndex((m): boolean => m.message_id === message.message_id);

        if (index >= 0) {
          saved.messages[index] = message;
        } else {
          saved.messages.push(message);
        }
      }
    }

    return {
      version: envelope.version,
      cycleId: envelope.cycleId,
      operationId: envelope.operationId,
      data,
    };
  });

  return { saved, calls, staging };
}
afterEach((): void => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('dialog storage versions', (): void => {
  it('exports legacy native data before choosing IndexedDB and normalizes edit fields', async (): Promise<void> => {
    const f = setup(1);

    f.saved.record.draft = { text: 'keep draft', revision: 3 };
    f.saved.record.outbox = [
      {
        client_message_id: uuid(6),
        content: { kind: 'text', text: 'pending' },
        created_at: '2026-11-14T00:00:00Z',
        state: 'unknown',
        error: null,
      },
    ];
    delete (f.saved.record as any).edit_sync_sequence;
    const storage = await openNativeDialogs();
    const { adapter: storageAdapter1, close: storageClose2 } = storage;

    expect(storageAdapter1).toBe('indexeddb');
    expect(f.calls.map((call): string => call.command)).toEqual([
      'beginFallback',
      'exportFallbackPage',
      'selectIndexedDb',
    ]);
    expect(f.calls.every((call): boolean => call.version === 1)).toBe(true);
    expect(f.saved.record).toMatchObject({
      edit_sync_sequence: 0,
      draft: { text: 'keep draft', revision: 3 },
    });
    expect(f.saved.record.outbox[0]?.content).toEqual({ kind: 'text', text: 'pending' });
    storageClose2.bind(storage)();
  });
  it('does not choose an incomplete export or lose unavailable drafts', async (): Promise<void> => {
    const f = setup(1);
    const original = mock.plugin.dialogStorage.getMockImplementation()!;

    mock.plugin.dialogStorage.mockImplementation(async (envelope): Promise<unknown> => {
      if (envelope.command === 'exportFallbackPage') {
        throw { code: 'STORAGE_UNAVAILABLE' };
      }

      return original(envelope);
    });
    await expect(openNativeDialogs()).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
    expect(f.calls.some((call): boolean => call.command === 'selectIndexedDb')).toBe(false);
    expect(f.staging.close).toHaveBeenCalledOnce();
  });
  it('splits a large native commit and advances its cursor only after all messages are durable', async (): Promise<void> => {
    const f = setup(2);

    f.saved.record.ranges = [[1, 40]];
    f.saved.messages = Array.from({ length: 40 }, (_, i) => ({
      message_id: uuid(100 + i),
      dialog_id: id,
      sender_id: uuid(2),
      client_message_id: uuid(200 + i),
      sequence: i + 1,
      created_at: '2026-11-14T00:00:00Z',
      content: { kind: 'text' as const, text: '😀'.repeat(4000) },
      status: 'sent' as const,
      version: 1,
      edited_at: null,
      edit_sequence: 0,
      last_edit_id: null,
    }));
    const storage = await openNativeDialogs();
    const { change: storageChange3, close: storageClose4 } = storage;

    await storageChange3.bind(storage)(id, 'commitEdits', (value): void => {
      value.messages = value.messages.map((message, i) => ({
        ...message,
        version: 2,
        edit_sequence: i + 1,
        edited_at: '2026-11-14T01:00:00Z',
        last_edit_id: uuid(300 + i),
      }));
      value.record.edit_sync_sequence = 40;
    });
    const writes = f.calls.filter((call): boolean => call.command === 'commitEdits');

    expect(writes.length).toBeGreaterThan(1);
    expect(
      writes.slice(0, -1).every((call): boolean => call.args.record.edit_sync_sequence === 0),
    ).toBe(true);
    expect(writes.at(-1).args.record.edit_sync_sequence).toBe(40);
    expect(
      writes.every(
        (call): boolean => new TextEncoder().encode(JSON.stringify(call)).length <= 524288,
      ),
    ).toBe(true);
    expect(f.saved.messages.every((message): boolean => message.version === 2)).toBe(true);
    storageClose4.bind(storage)();
  });
});

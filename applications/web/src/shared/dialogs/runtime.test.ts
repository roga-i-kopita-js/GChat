import type { ApiResult, BackendApi } from '@gchat/backend-api';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { emptyRecord, type StoredDialog } from './model';
import { DialogRuntime } from './runtime';
import type { DialogStorage } from './storage';

function fixture(): { runtime: DialogRuntime; store: any; api: any; saved(): StoredDialog } {
  let saved: StoredDialog = { record: emptyRecord(), messages: [] };

  saved.record.permissions = { can_send: true, can_read: true };
  saved.record.draft = { text: 'Original', revision: 1 };
  const store: DialogStorage = {
    scope: {
      serverOrigin: 'https://test.invalid',
      accountId: 'account',
      deviceId: 'device',
      sessionId: 'session',
    },
    epoch: 1,
    adapter: 'sqlite',
    read: async (): Promise<StoredDialog> => structuredClone(saved),
    list: async () => (saved.record.dialog ? [structuredClone(saved.record.dialog)] : []),
    change: vi.fn(async (_id, _command, update): Promise<StoredDialog> => {
      const next = structuredClone(saved);

      update(next);
      saved = next;

      return structuredClone(saved);
    }),
    close: (): void => {},
    purge: async (): Promise<void> => {},
  };
  const api = { dialogsSendMessage: vi.fn() };
  const request = async <T>(
    operation: (client: BackendApi) => Promise<ApiResult<T>>,
  ): Promise<T> => {
    const { data: resultData } = await operation(api as unknown as BackendApi);

    return resultData;
  };
  const runtime = new DialogRuntime(store.scope, store, request);

  vi.spyOn(runtime, 'sync').mockResolvedValue();
  vi.stubGlobal('navigator', {
    locks: {
      request: async (
        _name: unknown,
        _options: unknown,
        operation: () => Promise<unknown>,
      ): Promise<unknown> => operation(),
    },
  });

  return { runtime, store, api, saved: (): StoredDialog => saved };
}
afterEach((): void => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
describe('durable dialog sends', (): void => {
  it('saves immutable UUID/content before HTTP and manually retries the same logical send', async (): Promise<void> => {
    const f = fixture();

    f.api.dialogsSendMessage.mockImplementationOnce(async ({ body }: any): Promise<never> => {
      expect(f.saved().record.outbox[0]).toMatchObject({
        client_message_id: body.client_message_id,
        content: body.content,
        state: 'sending',
      });

      throw new TypeError('network');
    });
    await expect(f.runtime.send('dialog', { kind: 'text', text: 'Original' }, 1)).rejects.toThrow(
      'network',
    );
    const pending = f.saved().record.outbox[0]!;

    expect(pending.state).toBe('unknown');
    expect(f.saved().record.draft.text).toBe('');
    expect(f.api.dialogsSendMessage).toHaveBeenCalledOnce();
    f.api.dialogsSendMessage.mockResolvedValueOnce({
      data: {
        message: {
          message_id: crypto.randomUUID(),
          dialog_id: crypto.randomUUID(),
          client_message_id: pending.client_message_id,
          sender_id: crypto.randomUUID(),
          sequence: 1,
          created_at: new Date().toISOString(),
          content: pending.content,
          status: 'sent',
        },
      },
    });
    await f.runtime.resend('dialog', pending.client_message_id);
    expect(f.api.dialogsSendMessage.mock.calls[1][0].body).toEqual(
      f.api.dialogsSendMessage.mock.calls[0][0].body,
    );
    expect(f.saved().record.outbox).toHaveLength(0);
    expect(f.saved().messages).toHaveLength(1);
    expect(f.saved().record.sync_sequence).toBe(0);
    f.runtime.stop();
  });
  it('flushes a dirty draft under its existing update lease without requesting a lock behind an updater', async (): Promise<void> => {
    const f = fixture();
    const internal: any = f.runtime;
    const flush = vi.fn(async (): Promise<void> => {
      await f.runtime.draft('dialog', 'Saved before update', 1);
    });
    const remove = f.runtime.protectDraft(flush);

    internal.prepareUpdate();
    await vi.waitFor((): void => {
      expect(f.saved().record.draft.text).toBe('Saved before update');
    });
    expect(flush).toHaveBeenCalledOnce();
    remove();
    f.runtime.stop();
  });
  it('does not duplicate a prepared send when a storage fallback repeats its mutation after an unknown local commit', async (): Promise<void> => {
    const f = fixture();
    const original = f.store.change.getMockImplementation();

    f.store.change.mockImplementationOnce(
      async (
        id: string,
        command: string,
        update: (value: StoredDialog) => void,
      ): Promise<StoredDialog> =>
        original(id, command, (value: StoredDialog): void => {
          update(value);
          update(value);
        }),
    );
    f.api.dialogsSendMessage.mockRejectedValueOnce(new TypeError('network'));
    await expect(f.runtime.send('dialog', { kind: 'text', text: 'Original' }, 1)).rejects.toThrow(
      'network',
    );
    expect(f.saved().record.outbox).toHaveLength(1);
    expect(f.saved().record.draft.revision).toBe(2);
    f.runtime.stop();
  });
  it('never sends when durable preparation fails and preserves a sticker draft', async (): Promise<void> => {
    const f = fixture();

    f.store.change.mockRejectedValueOnce(new Error('disk full'));
    await expect(f.runtime.send('dialog', { kind: 'text', text: 'Original' }, 1)).rejects.toThrow(
      'disk full',
    );
    expect(f.api.dialogsSendMessage).not.toHaveBeenCalled();
    expect(f.saved().record.draft.text).toBe('Original');
    f.api.dialogsSendMessage.mockRejectedValueOnce(new TypeError('network'));
    await expect(
      f.runtime.send('dialog', { kind: 'sticker', sticker_id: 'animal-pals-v1-cat' }),
    ).rejects.toThrow();
    expect(f.saved().record.draft).toEqual({ text: 'Original', revision: 1 });
    f.runtime.stop();
  });
});

describe('dialog list previews', (): void => {
  it('loads content with list metadata, clears denied previews and never fetches history or sends read', async (): Promise<void> => {
    const f = fixture();
    const id = crypto.randomUUID();
    const last = {
      message_id: crypto.randomUUID(),
      dialog_id: id,
      client_message_id: crypto.randomUUID(),
      sender_id: crypto.randomUUID(),
      sequence: 1,
      created_at: new Date().toISOString(),
      content: { kind: 'text', text: 'Полный текст\n😀 ' + 'т'.repeat(1000) },
      status: 'sent',
    };
    const dialog = {
      dialog_id: id,
      peer_id: last.sender_id,
      peer_display_name: 'Peer',
      created_at: last.created_at,
      last_message_at: last.created_at,
      last_message: last,
      last_sequence: 1,
      last_read_sequence: 0,
      peer_last_read_sequence: 0,
      has_unread_messages: true,
    };

    f.api.dialogsList = vi.fn().mockResolvedValue({ data: { dialogs: [dialog], has_more: false } });
    f.api.dialogsHistory = vi.fn();
    f.api.dialogsRead = vi.fn();

    try {
      await f.runtime.refreshList();
      const [preview] = await f.runtime.list();

      expect(preview?.last_message).toEqual(last);
      expect(f.saved().record.sync_sequence).toBe(0);
      f.api.dialogsList.mockResolvedValue({
        data: { dialogs: [{ ...dialog, last_message: null }], has_more: false },
      });
      await f.runtime.refreshList();
      const [cleared] = await f.runtime.list();

      expect(cleared?.last_message).toBeNull();
      expect(f.api.dialogsHistory).not.toHaveBeenCalled();
      expect(f.api.dialogsRead).not.toHaveBeenCalled();
      expect(f.saved().record.read).toBe(0);
    } finally {
      f.runtime.stop();
    }
  });
});

import { describe, expect, it } from 'vitest';

import {
  checkText,
  commitEdits,
  commitPage,
  type DialogMessage,
  dialogSchema,
  type DialogSummary,
  emptyRecord,
  mergeMessages,
  mergeMetadata,
  recordSchema,
  visibleMessages,
} from './model';

const actor = '00000000-0000-4000-8000-000000000001';
const peer = '00000000-0000-4000-8000-000000000002';

function message(sequence: number, sender_id = actor): DialogMessage {
  return {
    message_id: 'm' + sequence,
    dialog_id: 'dialog',
    client_message_id: 'c' + sequence,
    sender_id,
    sequence,
    content: { kind: 'text', text: 'message' },
    created_at: '2026-11-07T00:00:00Z',
    status: 'sent',
    version: 1,
    edited_at: null,
    edit_sequence: 0,
    last_edit_id: null,
  };
}
describe('dialog history invariants', (): void => {
  it('separates initial tail, backward pagination, fresh-tail gaps and after checkpoint', (): void => {
    const record = emptyRecord();
    let messages = commitPage(
      record,
      [],
      { messages: [message(100), message(99)], has_more: true },
      'initial',
    );

    expect(record.sync_sequence).toBe(100);
    expect(record.before_sequence).toBe(99);
    messages = commitPage(record, messages, { messages: [message(110)], has_more: true }, 'tail');
    expect(record.sync_sequence).toBe(100);
    expect(record.ranges).toEqual([
      [99, 100],
      [110, 110],
    ]);
    messages = commitPage(
      record,
      messages,
      { messages: [message(98)], has_more: true },
      'before',
      99,
    );
    expect(record.sync_sequence).toBe(100);
    expect(record.before_sequence).toBe(98);
    expect((): void => {
      commitPage(record, messages, { messages: [message(97)], has_more: true }, 'before', 99);
    }).toThrow('STORAGE_CONFLICT');
    commitPage(record, messages, { messages: [message(101)], has_more: true }, 'after', 100);
    expect(record.sync_sequence).toBe(101);
    expect((): void => {
      commitPage(record, messages, { messages: [message(102)], has_more: false }, 'after', 100);
    }).toThrow('STORAGE_CONFLICT');
  });
  it('does not advance on an invalid empty continuation or a read position', (): void => {
    const record = emptyRecord();

    expect((): void => {
      commitPage(record, [], { messages: [], has_more: true }, 'initial');
    }).toThrow('INVALID_PAGE');
    expect(record.initialized).toBe(false);
    const dialog: DialogSummary = {
      dialog_id: 'id',
      peer_id: peer,
      peer_display_name: 'Peer',
      created_at: '',
      last_message_at: null,
      last_message: null,
      last_sequence: 99,
      has_unread_messages: true,
      last_read_sequence: 99,
      peer_last_read_sequence: 99,
    };

    mergeMetadata(record, dialog);
    expect(record.sync_sequence).toBe(0);
    mergeMetadata(record, { ...dialog, last_read_sequence: 1, peer_last_read_sequence: 2 });
    expect(record.read).toBe(99);
    expect(record.peer_read).toBe(99);
  });
  it('preserves the latest preview on older snapshots and removes it on denied content', (): void => {
    const record = emptyRecord();
    const current: DialogSummary = {
      dialog_id: 'id',
      peer_id: peer,
      peer_display_name: 'Peer',
      created_at: '',
      last_message_at: '2026-11-07T00:00:00Z',
      last_message: message(2),
      last_sequence: 2,
      has_unread_messages: true,
      last_read_sequence: 0,
      peer_last_read_sequence: 0,
    };

    mergeMetadata(record, current);
    mergeMetadata(record, {
      ...current,
      last_sequence: 1,
      last_message: message(1),
      last_message_at: 'older',
    });
    expect(record.dialog?.last_message).toEqual(message(2));
    expect(record.dialog?.last_sequence).toBe(2);
    expect(record.dialog?.last_message_at).toBe(current.last_message_at);
    expect(record.sync_sequence).toBe(0);
    expect(record.read).toBe(0);
    mergeMetadata(record, { ...current, last_sequence: 1, last_message: null });
    expect(record.dialog?.last_message).toBeNull();
  });
  it('opens old cached records without a preview and preserves unknown sticker previews', (): void => {
    const legacy = {
      dialog_id: actor,
      peer_id: peer,
      peer_display_name: 'Peer',
      created_at: '',
      last_message_at: null,
      last_sequence: 0,
      has_unread_messages: false,
      last_read_sequence: 0,
      peer_last_read_sequence: 0,
    };

    expect(
      recordSchema.parse({ ...emptyRecord(), dialog: legacy }).dialog?.last_message,
    ).toBeNull();
    const sticker = {
      ...message(1),
      message_id: actor,
      dialog_id: actor,
      client_message_id: peer,
      content: { kind: 'sticker', sticker_id: 'future-sticker' },
    };

    expect(
      dialogSchema.parse({ ...legacy, last_sequence: 1, last_message: sticker }).last_message
        ?.content,
    ).toEqual(sticker.content);
  });
  it('keeps an own pending UUID when only the peer used that UUID and never downgrades read', (): void => {
    const record = emptyRecord();

    record.outbox = [
      {
        client_message_id: 'c1',
        content: { kind: 'text', text: 'own' },
        created_at: '',
        state: 'unknown',
        error: null,
      },
    ];
    const messages = commitPage(
      record,
      [],
      { messages: [message(1, peer)], has_more: false },
      'initial',
      undefined,
      actor,
    );

    expect(record.outbox).toHaveLength(1);
    commitPage(
      record,
      messages,
      { messages: [{ ...message(2), client_message_id: 'c1' }], has_more: false },
      'after',
      1,
      actor,
    );
    expect(record.outbox).toHaveLength(0);
    expect(mergeMessages([{ ...message(1), status: 'read' }], [message(1)])[0]?.status).toBe(
      'read',
    );
  });
});
describe('message text limits', (): void => {
  it('counts Unicode code points, preserves content, and rejects malformed surrogates', (): void => {
    expect(checkText('😀'.repeat(4000))).toBeNull();
    expect(checkText('😀'.repeat(4001))).not.toBeNull();
    expect(checkText(' \n ')).not.toBeNull();
    expect(checkText('\ud800')).not.toBeNull();
    expect(checkText('текст \udc00')).not.toBeNull();
    expect(checkText('  Привет\n😀  ')).toBeNull();
  });
});

describe('message edit convergence', (): void => {
  it('keeps the newest content across delayed pages and independently merges read status', (): void => {
    const original = message(1);
    const edited = {
      ...original,
      version: 2,
      edited_at: '2026-11-14T00:00:00Z',
      edit_sequence: 1,
      last_edit_id: actor,
      content: { kind: 'text' as const, text: 'edited' },
    };
    const next = mergeMessages([edited], [{ ...original, status: 'read' }]);

    expect(next[0]).toMatchObject({ version: 2, content: edited.content, status: 'read' });
    const record = emptyRecord();

    record.dialog = {
      ...dialogSchema.parse({
        dialog_id: actor,
        peer_id: peer,
        peer_display_name: 'Peer',
        has_unread_messages: false,
        last_message: {
          ...edited,
          message_id: actor,
          dialog_id: actor,
          client_message_id: peer,
          sender_id: actor,
        },
        created_at: original.created_at,
        last_message_at: original.created_at,
        last_sequence: 1,
        last_read_sequence: 0,
        peer_last_read_sequence: 0,
      }),
    };
    const newer = record.dialog.last_message;

    mergeMetadata(record, {
      ...record.dialog,
      last_message: {
        ...newer!,
        version: 1,
        edited_at: null,
        edit_sequence: 0,
        last_edit_id: null,
        content: original.content,
      },
    });
    expect(record.dialog.last_message?.version).toBe(2);
    expect((): unknown =>
      mergeMessages([edited], [{ ...edited, content: { kind: 'text', text: 'contradiction' } }]),
    ).toThrow('INVALID_MESSAGE_VERSION');
  });
});

it('commits sparse edits and their cursor without inventing history ranges', (): void => {
  const value = { record: emptyRecord(), messages: [message(50)] };

  value.record.ranges = [[50, 50]];
  const edited = {
    ...message(1),
    version: 2,
    edited_at: '2026-11-14T00:00:00Z',
    edit_sequence: 4,
    last_edit_id: actor,
  };

  commitEdits(value, { messages: [edited], next_edit_sequence: 4, has_more: true }, 0);
  expect(value.record.edit_sync_sequence).toBe(4);
  expect(value.record.sync_sequence).toBe(0);
  expect(visibleMessages(value).map((m): number => m.sequence)).toEqual([50]);
  value.messages = commitPage(
    value.record,
    value.messages,
    { messages: [message(1)], has_more: false },
    'initial',
  );
  expect(value.messages[0]?.version).toBe(2);
});
it('rejects stale edit cursors and impossible continuations without advancing', (): void => {
  const value = { record: emptyRecord(), messages: [] };

  expect((): void =>
    commitEdits(value, { messages: [], next_edit_sequence: 1, has_more: true }, 0),
  ).toThrow('INVALID_PAGE');
  expect((): void =>
    commitEdits(value, { messages: [], next_edit_sequence: 2, has_more: false }, 1),
  ).toThrow('STORAGE_CONFLICT');
  expect(value.record.edit_sync_sequence).toBe(0);
  commitEdits(value, { messages: [], next_edit_sequence: 3, has_more: false }, 0);
  expect(value.record.edit_sync_sequence).toBe(3);
});

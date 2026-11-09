import { describe, expect, it } from 'vitest';

import {
  checkText,
  commitPage,
  type DialogMessage,
  dialogSchema,
  type DialogSummary,
  emptyRecord,
  mergeMessages,
  mergeMetadata,
  recordSchema,
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

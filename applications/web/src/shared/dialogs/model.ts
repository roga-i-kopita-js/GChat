import type {
  DialogDto,
  DialogPermissionsDto,
  MessageDto,
  SendMessageDto,
  StickerContentDto,
} from '@gchat/backend-api';
import { stickerIds } from '@gchat/dialog-assets';
import { z } from 'zod';

export const contentSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('text'), text: z.string() }),
  z.strictObject({ kind: z.literal('sticker'), sticker_id: z.string() }),
]);

export function isStickerId(value: unknown): value is StickerContentDto['sticker_id'] {
  return typeof value === 'string' && stickerIds.includes(value);
}

const sendContentSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('text'), text: z.string() }),
  z.strictObject({
    kind: z.literal('sticker'),
    sticker_id: z.custom<StickerContentDto['sticker_id']>(isStickerId),
  }),
]);

export type DialogMessage = Omit<MessageDto, 'content'> & {
  content: z.infer<typeof contentSchema>;
};

const sequence = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

export const messageSchema = z.object({
  message_id: z.string().uuid(),
  dialog_id: z.string().uuid(),
  client_message_id: z.string().uuid(),
  sender_id: z.string().uuid(),
  sequence: sequence.min(1),
  created_at: z.string(),
  content: contentSchema,
  status: z.enum(['sent', 'read']),
});

export const dialogSchema = z.object({
  dialog_id: z.string().uuid(),
  peer_id: z.string().uuid(),
  peer_display_name: z.string(),
  has_unread_messages: z.boolean(),
  created_at: z.string(),
  last_message_at: z.string().nullable(),
  last_message: messageSchema.nullable().default(null),
  last_sequence: sequence,
  last_read_sequence: sequence,
  peer_last_read_sequence: sequence,
});

export type DialogSummary = Omit<DialogDto, 'last_message'> & {
  last_message: DialogMessage | null;
};

export const eventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('dialog.messages_available'),
    payload: z.object({ dialog_id: z.string().uuid(), last_sequence: sequence }),
  }),
  z.object({
    type: z.literal('dialog.read_updated'),
    payload: z.object({
      dialog_id: z.string().uuid(),
      reader_id: z.string().uuid(),
      last_read_sequence: sequence,
    }),
  }),
]);

export const outboxSchema = z.object({
  client_message_id: z.string().uuid(),
  content: sendContentSchema,
  created_at: z.string(),
  state: z.enum(['prepared', 'sending', 'unknown', 'rejected']),
  error: z.string().nullable(),
});

export type PendingMessage = z.infer<typeof outboxSchema>;

export const recordSchema = z.object({
  revision: sequence,
  dialog: dialogSchema.nullable(),
  permissions: z.object({ can_read: z.boolean(), can_send: z.boolean() }).nullable(),
  initialized: z.boolean(),
  sync_sequence: sequence,
  ranges: z.array(z.tuple([sequence, sequence])),
  before_sequence: sequence.nullable(),
  has_older: z.boolean(),
  draft: z.object({ text: z.string(), revision: sequence }),
  outbox: z.array(outboxSchema),
  read: sequence,
  peer_read: sequence,
});

export type DialogRecord = z.infer<typeof recordSchema>;

export interface Scope {
  serverOrigin: string;
  accountId: string;
  deviceId: string;
  sessionId: string;
}

export interface Page {
  messages: DialogMessage[];
  has_more: boolean;
}

export interface StoredDialog {
  record: DialogRecord;
  messages: DialogMessage[];
}

export function emptyRecord(): DialogRecord {
  return {
    revision: 0,
    dialog: null,
    permissions: null,
    initialized: false,
    sync_sequence: 0,
    ranges: [],
    before_sequence: null,
    has_older: false,
    draft: { text: '', revision: 0 },
    outbox: [],
    read: 0,
    peer_read: 0,
  };
}

export class StorageError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

export function checkText(text: string): string | null {
  if (!text.trim()) {
    return 'Введите сообщение';
  }

  if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text)) {
    return 'Текст содержит некорректный символ';
  }

  if (Array.from(text).length > 4000) {
    return 'Не больше 4000 символов';
  }

  if (
    new TextEncoder().encode(
      JSON.stringify({ client_message_id: crypto.randomUUID(), content: { kind: 'text', text } }),
    ).length > 65536
  ) {
    return 'Сообщение слишком большое';
  }

  return null;
}

export function mergeMessages(
  current: DialogMessage[],
  incoming: DialogMessage[],
): DialogMessage[] {
  const messages = new Map(
    current.map((message): [string, DialogMessage] => [message.message_id, message]),
  );

  for (const message of incoming) {
    const previous = messages.get(message.message_id);

    messages.set(message.message_id, {
      ...message,
      status: previous?.status === 'read' ? 'read' : message.status,
    });
  }

  return [...messages.values()].sort((a, b): number => a.sequence - b.sequence);
}

export function mergeMetadata(
  record: DialogRecord,
  dialog: DialogSummary,
  permissions?: DialogPermissionsDto,
): void {
  record.read = Math.max(record.read, dialog.last_read_sequence);
  record.peer_read = Math.max(record.peer_read, dialog.peer_last_read_sequence);
  const previous = record.dialog;
  const older = previous && previous.last_sequence > dialog.last_sequence;

  record.dialog = {
    ...dialog,
    ...(older
      ? {
          last_sequence: previous.last_sequence,
          last_message_at: previous.last_message_at,
          // A null response revokes the preview even when its activity snapshot is older.
          last_message: dialog.last_message === null ? null : previous.last_message,
        }
      : {}),
    last_read_sequence: record.read,
    peer_last_read_sequence: record.peer_read,
  };

  if (permissions) {
    record.permissions = permissions;
  }
}

export function commitPage(
  record: DialogRecord,
  messages: DialogMessage[],
  page: Page,
  direction: 'initial' | 'tail' | 'before' | 'after',
  cursor?: number,
  accountId?: string,
): DialogMessage[] {
  if (page.has_more && !page.messages.length) {
    throw new StorageError('INVALID_PAGE');
  }

  if (direction === 'after' && cursor !== record.sync_sequence) {
    throw new StorageError('STORAGE_CONFLICT');
  }

  if (direction === 'before' && cursor !== record.before_sequence) {
    throw new StorageError('STORAGE_CONFLICT');
  }

  if (direction === 'initial' && record.initialized) {
    throw new StorageError('STORAGE_CONFLICT');
  }

  const positions = page.messages.map((message): number => message.sequence);

  if (positions.length) {
    const first = Math.min(...positions);
    const last = Math.max(...positions);

    record.ranges.push([direction === 'after' ? (cursor ?? first) + 1 : first, last]);
    record.ranges.sort((a, b): number => a[0] - b[0]);
    record.ranges = record.ranges.reduce<[number, number][]>(
      (ranges, range): [number, number][] => {
        const previous = ranges.at(-1);

        if (previous && previous[1] + 1 >= range[0]) {
          previous[1] = Math.max(previous[1], range[1]);
        } else {
          ranges.push([...range]);
        }

        return ranges;
      },
      [],
    );

    if (direction === 'initial' || direction === 'after') {
      record.sync_sequence = last;
    }

    if (direction === 'initial' || direction === 'before') {
      record.before_sequence = first;
    }
  }

  if (direction === 'initial') {
    record.initialized = true;
  }

  if (direction === 'initial' || direction === 'before') {
    record.has_older = page.has_more;
  }

  const next = mergeMessages(messages, page.messages);

  record.outbox = record.outbox.filter(
    (pending): boolean =>
      !next.some(
        (message): boolean =>
          message.sender_id === accountId &&
          message.client_message_id === pending.client_message_id,
      ),
  );

  return next;
}

export type MessageInput = SendMessageDto['content'];

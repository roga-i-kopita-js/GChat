import { normalizeReaction, reactionEmojis } from '@gchat/dialog-assets';

import type { ErrorService } from '../error/error.service.js';
import { contentValue, type MessageContent } from './dialogs.validation.js';

export interface ForwardInfo {
  author: { id: string; display_name: string } | null;
}

export interface ReactionCell {
  user_id: string;
  emoji: string;
  selected: boolean;
  version: number;
  last_operation_id: string;
}

export interface ReplyInfo {
  message_id: string;
  sequence: number;
  version: number;
  sender_id: string;
  sender_display_name: string;
  content: MessageContent;
}

export interface MessageEnvelope {
  content: MessageContent;
  forward: ForwardInfo | null;
  reply: ReplyInfo | null;
  reaction_state: ReactionCell[];
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!isRecord(value) || Object.keys(value).sort().join() !== [...keys].sort().join()) {
    throw new Error('Invalid envelope');
  }

  return value;
}

export function envelopeValue(
  value: unknown,
  error: ErrorService,
  reactionVersion: number,
  encryptionVersion = 4,
): MessageEnvelope {
  const envelope = object(
    value,
    encryptionVersion === 3
      ? ['content', 'forward', 'reaction_state']
      : ['content', 'forward', 'reply', 'reaction_state'],
  );
  let reply: ReplyInfo | null = null;

  if (encryptionVersion >= 4 && envelope.reply !== null) {
    const item = object(envelope.reply, [
      'message_id',
      'sequence',
      'version',
      'sender_id',
      'sender_display_name',
      'content',
    ]);

    if (
      typeof item.message_id !== 'string' ||
      !uuid.test(item.message_id) ||
      typeof item.sender_id !== 'string' ||
      !uuid.test(item.sender_id) ||
      typeof item.sequence !== 'number' ||
      !Number.isSafeInteger(item.sequence) ||
      item.sequence < 1 ||
      typeof item.version !== 'number' ||
      !Number.isSafeInteger(item.version) ||
      item.version < 1 ||
      typeof item.sender_display_name !== 'string' ||
      !item.sender_display_name.trim() ||
      [...item.sender_display_name].length > 80
    ) {
      throw new Error('Invalid reply');
    }

    reply = {
      message_id: item.message_id,
      sequence: item.sequence,
      version: item.version,
      sender_id: item.sender_id,
      sender_display_name: item.sender_display_name,
      content: contentValue(item.content, error),
    };
  }

  let forward: ForwardInfo | null = null;

  if (envelope.forward !== null) {
    const item = object(envelope.forward, ['author']);

    if (item.author === null) {
      forward = { author: null };
    } else {
      const author = object(item.author, ['id', 'display_name']);

      if (
        typeof author.id !== 'string' ||
        !uuid.test(author.id) ||
        typeof author.display_name !== 'string' ||
        !author.display_name.trim() ||
        [...author.display_name].length > 80
      ) {
        throw new Error('Invalid author');
      }

      forward = { author: { id: author.id, display_name: author.display_name } };
    }
  }

  if (
    !Array.isArray(envelope.reaction_state) ||
    envelope.reaction_state.length > reactionEmojis.length * 2
  ) {
    throw new Error('Invalid reactions');
  }

  const seen = new Set<string>();
  let total = 0;
  const reaction_state = envelope.reaction_state.map((value): ReactionCell => {
    const cell = object(value, ['user_id', 'emoji', 'selected', 'version', 'last_operation_id']);

    if (
      typeof cell.user_id !== 'string' ||
      !uuid.test(cell.user_id) ||
      typeof cell.last_operation_id !== 'string' ||
      !uuid.test(cell.last_operation_id) ||
      typeof cell.emoji !== 'string' ||
      normalizeReaction(cell.emoji) !== cell.emoji ||
      typeof cell.selected !== 'boolean' ||
      typeof cell.version !== 'number' ||
      !Number.isSafeInteger(cell.version) ||
      cell.version < 1
    ) {
      throw new Error('Invalid reaction');
    }

    const key = cell.user_id + ':' + cell.emoji;

    if (seen.has(key)) {
      throw new Error('Duplicate reaction');
    }

    seen.add(key);
    total += cell.version;

    return {
      user_id: cell.user_id,
      emoji: cell.emoji,
      selected: cell.selected,
      version: cell.version,
      last_operation_id: cell.last_operation_id,
    };
  });

  if (!Number.isSafeInteger(total) || total !== reactionVersion) {
    throw new Error('Invalid reaction version');
  }

  return { content: contentValue(envelope.content, error), forward, reply, reaction_state };
}

export function sortReactions(cells: ReactionCell[]): ReactionCell[] {
  return cells.sort(
    (a, b) =>
      reactionEmojis.indexOf(a.emoji) - reactionEmojis.indexOf(b.emoji) ||
      a.user_id.localeCompare(b.user_id),
  );
}

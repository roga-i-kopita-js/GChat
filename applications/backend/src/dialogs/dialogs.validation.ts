import { stickerIds } from '@gchat/dialog-assets';

import type { ErrorService } from '../error/error.service.js';

export type MessageContent =
  { kind: 'text'; text: string } | { kind: 'sticker'; sticker_id: string };

export function contentValue(value: unknown, error: ErrorService): MessageContent {
  const fail = (field: string): never => {
    throw error.validation({ fields: [{ field, code: 'INVALID' }] });
  };

  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('content');

  if ('kind' in value && value.kind === 'text') {
    if (
      !('text' in value) ||
      typeof value.text !== 'string' ||
      !value.text.trim() ||
      [...value.text].length > 4000 ||
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value.text)
    )
      return fail('content.text');

    if (Object.keys(value).some((k): boolean => !['kind', 'text'].includes(k)))
      return fail('content');

    return { kind: 'text', text: value.text };
  }

  if ('kind' in value && value.kind === 'sticker') {
    if (
      !('sticker_id' in value) ||
      typeof value.sticker_id !== 'string' ||
      !stickerIds.includes(value.sticker_id)
    )
      return fail('content.sticker_id');

    if (Object.keys(value).some((k): boolean => !['kind', 'sticker_id'].includes(k)))
      return fail('content');

    return { kind: 'sticker', sticker_id: value.sticker_id };
  }

  return fail('content.kind');
}

export function queryInteger(
  value: unknown,
  field: string,
  fallback: number | undefined,
  error: ErrorService,
  min = 0,
  max = Number.MAX_SAFE_INTEGER,
): number | undefined {
  if (value === undefined) return fallback;

  if (
    typeof value !== 'string' ||
    !/^(0|[1-9][0-9]*)$/.test(value) ||
    !Number.isSafeInteger(Number(value)) ||
    Number(value) < min ||
    Number(value) > max
  )
    throw error.validation({ fields: [{ field, code: 'INVALID' }] });

  return Number(value);
}

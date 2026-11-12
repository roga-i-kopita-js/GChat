import { isUUID } from 'class-validator';

import type { ErrorService } from '../error/error.service.js';
import type { HistoryFilter } from './call-history.dto.js';

interface HistoryCursor {
  v: 1;
  sub: string;
  filter: HistoryFilter;
  created_at: string;
  id: string;
}

export function encodeHistoryCursor(
  sub: string,
  filter: HistoryFilter,
  createdAt: string,
  id: string,
): string {
  return Buffer.from(JSON.stringify({ v: 1, sub, filter, created_at: createdAt, id })).toString(
    'base64url',
  );
}

export function decodeHistoryCursor(
  input: string | undefined,
  sub: string,
  filter: HistoryFilter,
  error: ErrorService,
): HistoryCursor | null {
  if (input === undefined) {
    return null;
  }

  try {
    if (!input.length || input.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(input)) {
      throw new Error();
    }

    const buffer = Buffer.from(input, 'base64url');

    if (buffer.toString('base64url') !== input) {
      throw new Error();
    }

    const value: unknown = JSON.parse(buffer.toString('utf8'));

    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      Object.keys(value).sort().join(',') !== 'created_at,filter,id,sub,v' ||
      !('v' in value) ||
      value.v !== 1 ||
      !('sub' in value) ||
      value.sub !== sub ||
      !('filter' in value) ||
      value.filter !== filter ||
      !('id' in value) ||
      typeof value.id !== 'string' ||
      !isUUID(value.id) ||
      !('created_at' in value) ||
      typeof value.created_at !== 'string' ||
      !/^(?!0000)[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{6}Z$/.test(
        value.created_at,
      ) ||
      new Date(value.created_at).toISOString() !== value.created_at.slice(0, 23) + 'Z'
    ) {
      throw new Error();
    }

    return { v: 1, sub, filter, created_at: value.created_at, id: value.id.toLowerCase() };
  } catch {
    throw error.validation({ fields: [{ field: 'cursor', code: 'INVALID' }] });
  }
}

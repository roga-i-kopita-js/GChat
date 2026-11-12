import { randomUUID } from 'node:crypto';

import { jest } from '@jest/globals';

import { ErrorService } from '../error/error.service.js';
import type { RedisService } from '../redis/redis.service.js';
import { decodeHistoryCursor, encodeHistoryCursor } from './call-history.cursor.js';
import { CallHistoryLimits } from './call-history.limits.js';
import { historyOutcome } from './call-history.service.js';
import type { EndReason } from './direct-calls.dto.js';

describe('call history classification and cursor', (): void => {
  const error = new ErrorService();
  const actor = randomUUID();
  const id = randomUUID();
  const time = '2026-11-11T12:32:00.123456Z';
  const reasons: EndReason[] = [
    'cancelled',
    'rejected',
    'no_answer',
    'connection_timeout',
    'hangup',
    'connection_lost',
    'session_revoked',
    'account_disabled',
  ];

  it.each(reasons)(
    'classifies %s for both participants with and without a conversation',
    (endReason): void => {
      for (const incoming of [true, false]) {
        expect(historyOutcome({ startedAt: new Date(), endReason }, incoming)).toBe('completed');
        const results: Record<EndReason, string> = {
          rejected: 'rejected',
          no_answer: incoming ? 'missed' : 'unanswered',
          cancelled: incoming ? 'missed' : 'cancelled',
          connection_timeout: 'failed',
          hangup: 'failed',
          connection_lost: 'failed',
          session_revoked: 'failed',
          account_disabled: 'failed',
        };

        expect(historyOutcome({ startedAt: null, endReason }, incoming)).toBe(results[endReason]);
      }
    },
  );

  it('preserves database microseconds and permits only the matching account/filter', (): void => {
    const cursor = encodeHistoryCursor(actor, 'missed', time, id);

    expect(decodeHistoryCursor(cursor, actor, 'missed', error)).toEqual({
      v: 1,
      sub: actor,
      filter: 'missed',
      created_at: time,
      id,
    });
    expect(() => decodeHistoryCursor(cursor, randomUUID(), 'missed', error)).toThrow(
      expect.objectContaining({ code: 'VALIDATION_ERROR' }),
    );
    expect(() => decodeHistoryCursor(cursor, actor, 'all', error)).toThrow(
      expect.objectContaining({ code: 'VALIDATION_ERROR' }),
    );
    expect(decodeHistoryCursor(undefined, actor, 'all', error)).toBeNull();
  });

  it.each([
    '',
    '!',
    'a'.repeat(2049),
    Buffer.from('{}').toString('base64url'),
    encodeHistoryCursor(actor, 'all', '2026-02-30T12:32:00.123456Z', id),
    encodeHistoryCursor(actor, 'all', '0000-01-01T12:32:00.123456Z', id),
    encodeHistoryCursor(actor, 'all', time, 'bad'),
  ])('rejects invalid cursor %#', (cursor): void => {
    expect(() => decodeHistoryCursor(cursor, actor, 'all', error)).toThrow(
      expect.objectContaining({ status: 400, fields: [{ field: 'cursor', code: 'INVALID' }] }),
    );
  });
});

describe('call history read limit', (): void => {
  const error = new ErrorService();

  it('uses one account bucket and fails closed on dependency failures or corrupt buckets', async (): Promise<void> => {
    const evaluate = jest.fn<() => Promise<unknown>>().mockResolvedValue(0);
    const redis = {
      client: { eval: evaluate },
      key: (key: string): string => 'test:' + key,
    } as unknown as RedisService;
    const limit = new CallHistoryLimits(redis, error);

    await limit.check('account');
    expect(evaluate).toHaveBeenLastCalledWith(expect.any(String), {
      keys: ['test:direct-calls:history:rate:account'],
      arguments: ['10', '20'],
    });
    evaluate.mockResolvedValueOnce(1001);
    await expect(limit.check('account')).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      retryAfterSeconds: 2,
    });

    for (const value of ['0', -1, NaN, 0.1]) {
      evaluate.mockResolvedValueOnce(value);
      await expect(limit.check('account')).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
    }

    evaluate.mockRejectedValueOnce(new Error('unavailable'));
    await expect(limit.check('account')).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
  });
});

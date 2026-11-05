import { jest } from '@jest/globals';

import type { DatabaseService } from '../database/database.service.js';
import { ErrorService } from '../error/error.service.js';
import { NativeWebsocketPolicyService } from './native-websocket-policy.service.js';

describe('native bridge policy from PostgreSQL', (): void => {
  const limit = jest.fn<() => Promise<object[]>>();
  const database = { db: { select: (): object => ({ from: (): object => ({ limit }) }) } };
  const service = new NativeWebsocketPolicyService(
    database as unknown as DatabaseService,
    new ErrorService(),
  );

  it('preserves an intentionally empty policy and reads operator changes on each request', async (): Promise<void> => {
    limit
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ direction: 'receive', message_pattern: 'rtc.*' }]);
    expect(await service.read()).toEqual({ restrictions: [] });
    expect(await service.read()).toEqual({
      restrictions: [{ direction: 'receive', message_pattern: 'rtc.*' }],
    });
  });

  it('fails rather than returning a truncated or unavailable policy', async (): Promise<void> => {
    limit.mockResolvedValueOnce(
      Array.from({ length: 513 }, (): object => ({ direction: 'send', message_pattern: 'rtc.*' })),
    );
    await expect(service.read()).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
    limit.mockRejectedValueOnce(new Error('database unavailable'));
    await expect(service.read()).rejects.toThrow('database unavailable');
  });
});

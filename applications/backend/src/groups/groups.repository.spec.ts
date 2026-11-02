import { jest } from '@jest/globals';

import { DatabaseService } from '../database/database.service.js';
import { ErrorService } from '../error/error.service.js';
import { GroupsRepository } from './groups.repository.js';
describe('Groups dependency errors', (): void => {
  function repository(cause: Error): GroupsRepository {
    const limit = jest.fn(async (): Promise<never> => {
      throw cause;
    });
    const database = {
      db: {
        select: (): any => ({
          from: (): any => ({ innerJoin: (): any => ({ where: (): any => ({ limit }) }) }),
        }),
      },
    };

    return new GroupsRepository(database as unknown as DatabaseService, new ErrorService());
  }
  it.each(['ECONNREFUSED', '08006', '53300', '57P01', '57014'])(
    'maps expected database failure %s to 503',
    async (code): Promise<void> => {
      const cause = new Error('query failed', {
        cause: Object.assign(new Error('internal database details'), { code }),
      });

      await expect(repository(cause).hasCommonGroup('first', 'second')).rejects.toMatchObject({
        code: 'SERVICE_UNAVAILABLE',
      });
    },
  );
  it('maps a lost connection to 503 without masking a programming error', async (): Promise<void> => {
    await expect(
      repository(new Error('Connection terminated unexpectedly')).hasCommonGroup('first', 'second'),
    ).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
    const unexpected = new TypeError('timeout option is undefined in broken query code');

    await expect(repository(unexpected).hasCommonGroup('first', 'second')).rejects.toBe(unexpected);
  });
});

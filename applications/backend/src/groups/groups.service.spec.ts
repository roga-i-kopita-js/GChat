import { jest } from '@jest/globals';

import { GroupsRepository } from './groups.repository.js';
import { GroupsService } from './groups.service.js';

describe('GroupsService', (): void => {
  const hasCommonGroup = jest.fn<GroupsRepository['hasCommonGroup']>();
  const service = new GroupsService({ hasCommonGroup } as unknown as GroupsRepository);

  it('rejects a call to oneself without querying membership', async (): Promise<void> => {
    await expect(service.hasCommonGroup('same-user', 'same-user')).resolves.toBe(false);
    expect(hasCommonGroup).not.toHaveBeenCalled();
  });

  it.each([true, false])('returns membership result %s', async (result): Promise<void> => {
    hasCommonGroup.mockResolvedValueOnce(result);
    await expect(service.hasCommonGroup('first-user', 'second-user')).resolves.toBe(result);
    expect(hasCommonGroup).toHaveBeenCalledWith('first-user', 'second-user');
  });

  it('does not turn a database failure into a permission result', async (): Promise<void> => {
    const failure = new Error('database unavailable');

    hasCommonGroup.mockRejectedValueOnce(failure);
    await expect(service.hasCommonGroup('first-user', 'second-user')).rejects.toBe(failure);
  });
});

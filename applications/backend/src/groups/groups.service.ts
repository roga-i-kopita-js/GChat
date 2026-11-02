import { Injectable } from '@nestjs/common';

import { GroupsRepository } from './groups.repository.js';

@Injectable()
export class GroupsService {
  constructor(private readonly repository: GroupsRepository) {}

  /** Checks membership only, not account activity, sessions or call availability. */
  async hasCommonGroup(firstUserId: string, secondUserId: string): Promise<boolean> {
    if (firstUserId === secondUserId) return false;

    return this.repository.hasCommonGroup(firstUserId, secondUserId);
  }
}

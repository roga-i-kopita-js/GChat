import { Injectable } from '@nestjs/common';

import type { DatabaseTransaction } from '../database/database.service.js';
import type { GroupDto, GroupMemberDto } from './groups.dto.js';
import { GroupsRepository } from './groups.repository.js';

@Injectable()
export class GroupsService {
  constructor(private readonly repository: GroupsRepository) {}

  list(userId: string): Promise<GroupDto[]> {
    return this.repository.list(userId);
  }

  members(userId: string, groupId: string): Promise<GroupMemberDto[]> {
    return this.repository.members(userId, groupId);
  }

  async lockCommonGroup(
    tx: DatabaseTransaction,
    firstUserId: string,
    secondUserId: string,
  ): Promise<boolean> {
    if (firstUserId === secondUserId) return false;

    return this.repository.lockCommonGroup(tx, firstUserId, secondUserId);
  }

  /** Checks membership only, not account activity, sessions or call availability. */
  async hasCommonGroup(firstUserId: string, secondUserId: string): Promise<boolean> {
    if (firstUserId === secondUserId) return false;

    return this.repository.hasCommonGroup(firstUserId, secondUserId);
  }
}

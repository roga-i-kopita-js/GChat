import { Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';

import { DatabaseService } from '../database/database.service.js';
import { ErrorService } from '../error/error.service.js';
import { groupMembers } from './groups.schema.js';

const connectionMessages = new Set([
  'Connection terminated unexpectedly',
  'Connection terminated',
  'Connection terminated due to connection timeout',
  'Client has encountered a connection error and is not queryable',
  'timeout exceeded when trying to connect',
  'Query read timeout',
]);

function dependencyUnavailable(cause: unknown): boolean {
  if (!(cause instanceof Error)) return false;

  const failure = cause.cause instanceof Error ? cause.cause : cause;
  const code = 'code' in failure && typeof failure.code === 'string' ? failure.code : '';

  return (
    /^(08|53|57P|57014|ECONN|ETIMEDOUT|EPIPE|ENOTFOUND|EAI_AGAIN)/.test(code) ||
    connectionMessages.has(failure.message)
  );
}

@Injectable()
export class GroupsRepository {
  constructor(
    private readonly database: DatabaseService,
    private readonly error: ErrorService,
  ) {}

  async hasCommonGroup(firstUserId: string, secondUserId: string): Promise<boolean> {
    try {
      const otherMember = alias(groupMembers, 'other_member');
      const matches = await this.database.db
        .select({ groupId: groupMembers.groupId })
        .from(groupMembers)
        .innerJoin(otherMember, eq(groupMembers.groupId, otherMember.groupId))
        .where(and(eq(groupMembers.userId, firstUserId), eq(otherMember.userId, secondUserId)))
        .limit(1);

      return matches.length > 0;
    } catch (cause) {
      if (dependencyUnavailable(cause)) throw this.error.serviceUnavailable({ cause });

      throw cause;
    }
  }
}

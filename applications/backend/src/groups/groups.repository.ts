import { Injectable } from '@nestjs/common';
import { and, asc, count, eq, exists, ilike, inArray, isNull, or } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';

import { users } from '../auth/auth.schema.js';
import { isDatabaseUnavailable } from '../database/database.errors.js';
import type { DatabaseTransaction } from '../database/database.service.js';
import { DatabaseService } from '../database/database.service.js';
import { ErrorService } from '../error/error.service.js';
import type { GroupDto, GroupMemberDto } from './groups.dto.js';
import { groupMembers, groups } from './groups.schema.js';

@Injectable()
export class GroupsRepository {
  constructor(
    private readonly database: DatabaseService,
    private readonly error: ErrorService,
  ) {}

  normalizeName(value: string): string {
    if (typeof value !== 'string' || !value.trim()) {
      throw this.error.validation();
    }

    return value.trim().toLowerCase();
  }

  async assign(tx: DatabaseTransaction, userId: string, name: string): Promise<void> {
    name = this.normalizeName(name);
    const [inserted] = await tx
      .insert(groups)
      .values({ name })
      .onConflictDoNothing({ target: groups.name })
      .returning({ id: groups.id });
    const group =
      inserted ?? (await tx.select({ id: groups.id }).from(groups).where(eq(groups.name, name)))[0];

    if (!group) {
      throw this.error.serviceUnavailable();
    }

    await tx.insert(groupMembers).values({ groupId: group.id, userId }).onConflictDoNothing();
  }

  async adminList(
    tx: DatabaseTransaction,
    query: { q?: string; limit: number; offset: number },
  ): Promise<{ groups: { id: string; name: string }[]; total: number }> {
    const pattern = `%${(query.q ?? '').replace(/[\\%_]/g, '\\$&')}%`;
    const where = ilike(groups.name, pattern);
    const [{ total }] = await tx.select({ total: count() }).from(groups).where(where);
    const rows = await tx
      .select({ id: groups.id, name: groups.name })
      .from(groups)
      .where(where)
      .orderBy(asc(groups.name), asc(groups.id))
      .limit(query.limit)
      .offset(query.offset);

    return { groups: rows, total: total! };
  }

  async forAccounts(
    tx: DatabaseTransaction,
    ids: string[],
  ): Promise<{ userId: string; id: string; name: string }[]> {
    if (!ids.length) {
      return [];
    }

    return tx
      .select({ userId: groupMembers.userId, id: groups.id, name: groups.name })
      .from(groups)
      .innerJoin(groupMembers, eq(groupMembers.groupId, groups.id))
      .where(inArray(groupMembers.userId, ids))
      .orderBy(asc(groups.name), asc(groups.id));
  }

  private isActiveAdmin(userId: string): ReturnType<typeof exists> {
    return exists(
      this.database.db
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.id, userId), eq(users.role, 'admin'), isNull(users.disabledAt))),
    );
  }

  async list(userId: string): Promise<GroupDto[]> {
    try {
      return await this.database.db
        .select({ id: groups.id, name: groups.name })
        .from(groups)
        .where(
          or(
            this.isActiveAdmin(userId),
            exists(
              this.database.db
                .select({ id: groupMembers.groupId })
                .from(groupMembers)
                .where(and(eq(groupMembers.groupId, groups.id), eq(groupMembers.userId, userId))),
            ),
          ),
        )
        .orderBy(asc(groups.name), asc(groups.id));
    } catch (cause) {
      if (isDatabaseUnavailable(cause)) {
        throw this.error.serviceUnavailable({ cause });
      }

      throw cause;
    }
  }

  async members(userId: string, groupId: string): Promise<GroupMemberDto[]> {
    try {
      return await this.database.db.transaction(
        async (tx): Promise<GroupMemberDto[]> => {
          const [accessible] = await tx
            .select({ id: groups.id })
            .from(groups)
            .where(
              and(
                eq(groups.id, groupId),
                or(
                  this.isActiveAdmin(userId),
                  exists(
                    tx
                      .select({ id: groupMembers.groupId })
                      .from(groupMembers)
                      .where(
                        and(eq(groupMembers.groupId, groups.id), eq(groupMembers.userId, userId)),
                      ),
                  ),
                ),
              ),
            )
            .for('share');

          if (!accessible) {
            throw this.error.notFound();
          }

          return tx
            .select({ id: users.id, display_name: users.displayName })
            .from(groupMembers)
            .innerJoin(users, eq(users.id, groupMembers.userId))
            .where(and(eq(groupMembers.groupId, groupId), isNull(users.disabledAt)))
            .orderBy(asc(users.displayName), asc(users.id));
        },
        { isolationLevel: 'repeatable read' },
      );
    } catch (cause) {
      if (isDatabaseUnavailable(cause)) {
        throw this.error.serviceUnavailable({ cause });
      }

      throw cause;
    }
  }

  async lockCommonGroup(
    tx: DatabaseTransaction,
    firstUserId: string,
    secondUserId: string,
  ): Promise<boolean> {
    try {
      const [first, second] = [firstUserId, secondUserId].sort();
      const other = alias(groupMembers, 'other_member');
      const rows = await tx
        .select({ id: groups.id })
        .from(groups)
        .innerJoin(groupMembers, eq(groupMembers.groupId, groups.id))
        .innerJoin(other, eq(other.groupId, groups.id))
        .where(and(eq(groupMembers.userId, first!), eq(other.userId, second!)))
        .orderBy(asc(groups.id))
        .limit(1)
        .for('share');

      return rows.length > 0;
    } catch (cause) {
      if (isDatabaseUnavailable(cause)) {
        throw this.error.serviceUnavailable({ cause });
      }

      throw cause;
    }
  }

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
      if (isDatabaseUnavailable(cause)) {
        throw this.error.serviceUnavailable({ cause });
      }

      throw cause;
    }
  }
}

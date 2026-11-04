import { Injectable } from '@nestjs/common';

import { AuthAccounts, type SafeAccount } from '../auth/auth.accounts.js';
import type { AuthIdentity } from '../auth/auth.guard.js';
import { isDatabaseUnavailable } from '../database/database.errors.js';
import { DatabaseService, type DatabaseTransaction } from '../database/database.service.js';
import { ErrorService } from '../error/error.service.js';
import { GroupsService } from '../groups/groups.service.js';
import type {
  AdminCreateUserDto,
  AdminGroupDto,
  AdminGroupsQueryDto,
  AdminGroupsResponseDto,
  AdminUserDto,
  AdminUserResponseDto,
  AdminUsersQueryDto,
  AdminUsersResponseDto,
} from './backoffice.dto.js';

@Injectable()
export class BackofficeService {
  constructor(
    private readonly accounts: AuthAccounts,
    private readonly groups: GroupsService,
    private readonly database: DatabaseService,
    private readonly error: ErrorService,
  ) {}

  private async transaction<T>(
    action: (tx: DatabaseTransaction) => Promise<T>,
    read = false,
  ): Promise<T> {
    try {
      return await this.database.db.transaction(
        action,
        read ? { isolationLevel: 'repeatable read', accessMode: 'read only' } : undefined,
      );
    } catch (cause) {
      if (isDatabaseUnavailable(cause)) throw this.error.serviceUnavailable({ cause });

      throw cause;
    }
  }

  private async project(tx: DatabaseTransaction, accounts: SafeAccount[]): Promise<AdminUserDto[]> {
    const memberships = await this.groups.forAccounts(
      tx,
      accounts.map((account): string => account.id),
    );

    return accounts.map((account): AdminUserDto => ({
      id: account.id,
      login: account.login,
      display_name: account.displayName,
      role: account.role,
      status: account.disabledAt ? 'disabled' : 'active',
      disabled_at: account.disabledAt?.toISOString() ?? null,
      created_at: account.createdAt.toISOString(),
      updated_at: account.updatedAt.toISOString(),
      groups: memberships
        .filter((group): boolean => group.userId === account.id)
        .map(({ id, name }): AdminGroupDto => ({ id, name })),
    }));
  }

  list(query: AdminUsersQueryDto): Promise<AdminUsersResponseDto> {
    return this.transaction(async (tx): Promise<AdminUsersResponseDto> => {
      const page = await this.accounts.list(tx, query);

      return { users: await this.project(tx, page.accounts), total: page.total };
    }, true);
  }

  get(id: string): Promise<AdminUserResponseDto> {
    return this.transaction(
      async (tx): Promise<AdminUserResponseDto> => ({
        user: (await this.project(tx, [await this.accounts.get(tx, id)]))[0]!,
      }),
      true,
    );
  }

  listGroups(query: AdminGroupsQueryDto): Promise<AdminGroupsResponseDto> {
    return this.transaction(
      (tx): Promise<AdminGroupsResponseDto> => this.groups.adminList(tx, query),
      true,
    );
  }

  async create(actor: AuthIdentity, input: AdminCreateUserDto): Promise<AdminUserResponseDto> {
    const group = this.groups.normalizeName(input.group_name);
    const prepared = await this.accounts.prepare(input);

    return this.transaction(async (tx): Promise<AdminUserResponseDto> => {
      await this.accounts.authorize(tx, actor);
      const account = await this.accounts.create(tx, prepared, 'user');

      await this.groups.assign(tx, account.id, group);

      return { user: (await this.project(tx, [account]))[0]! };
    });
  }

  async change(
    actor: AuthIdentity,
    id: string,
    action: 'password' | 'disable' | 'enable',
    password?: string,
  ): Promise<AdminUserResponseDto> {
    if (action === 'disable' && actor.userId === id) throw this.error.forbidden();

    const hash = action === 'password' ? await this.accounts.preparePassword(password!) : undefined;

    return this.transaction(async (tx): Promise<AdminUserResponseDto> => {
      await this.accounts.authorize(tx, actor, id);
      const account = await this.accounts.change(tx, id, action, hash);

      return { user: (await this.project(tx, [account]))[0]! };
    });
  }
}

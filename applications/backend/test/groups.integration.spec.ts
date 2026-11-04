import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

import pg from 'pg';

import { DatabaseService } from '../src/database/database.service.js';
import { runMigrations } from '../src/database/migrations.js';
import { ErrorService } from '../src/error/error.service.js';
import { GroupsRepository } from '../src/groups/groups.repository.js';
import { GroupsService } from '../src/groups/groups.service.js';

const integration = process.env.GROUPS_INTEGRATION_DATABASE_URL ? describe : describe.skip;

integration('Groups with isolated PostgreSQL data', (): void => {
  const databaseName = `gchat_groups_${randomUUID().replaceAll('-', '')}`;
  let admin: pg.Pool | undefined;
  let database: pg.Pool | undefined;
  let service: GroupsService;
  let first: string;
  let second: string;
  let third: string;
  let group: string;

  beforeAll(async (): Promise<void> => {
    admin = new pg.Pool({
      connectionString: process.env.GROUPS_INTEGRATION_DATABASE_URL,
      connectionTimeoutMillis: 2000,
    });
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    const url = new URL(process.env.GROUPS_INTEGRATION_DATABASE_URL!);

    url.pathname = `/${databaseName}`;
    database = new pg.Pool({ connectionString: url.href, connectionTimeoutMillis: 2000 });
    // Simulate tables belonging to another application before installing GChat.
    await database.query('CREATE TABLE users (id integer PRIMARY KEY)');
    await database.query('CREATE TABLE groups (id integer PRIMARY KEY)');
    await database.query('CREATE TABLE group_members (id integer PRIMARY KEY)');
    await database.query('INSERT INTO users VALUES (1)');
    await runMigrations(url.href, resolve('drizzle'));
    await runMigrations(url.href, resolve('drizzle'));
    const db = new DatabaseService(database);

    service = new GroupsService(new GroupsRepository(db, new ErrorService()));
    const accounts = await database.query<{ id: string }>(
      `INSERT INTO gchat_users (login, display_name, password_hash)
       VALUES ('first', 'First', 'unused'), ('second', 'Second', 'unused'),
              ('third', 'Third', 'unused') RETURNING id`,
    );

    [first, second, third] = accounts.rows.map((row): string => row.id) as [string, string, string];
    group = (
      await database.query<{ id: string }>(
        `INSERT INTO gchat_groups (name) VALUES ('family') RETURNING id`,
      )
    ).rows[0]!.id;
    await database.query(
      'INSERT INTO gchat_group_members (group_id, user_id) VALUES ($1, $2), ($1, $3)',
      [group, first, second],
    );
  });

  afterAll(async (): Promise<void> => {
    await database?.end();

    try {
      await admin?.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
    } finally {
      await admin?.end();
    }
  });

  it('installs alongside unprefixed tables without changing their data', async (): Promise<void> => {
    expect((await database!.query('SELECT id FROM users')).rows).toEqual([{ id: 1 }]);
    expect((await database!.query('SELECT id FROM groups')).rows).toEqual([]);
    expect((await database!.query('SELECT id FROM group_members')).rows).toEqual([]);
    await expect(service.hasCommonGroup(first, second)).resolves.toBe(true);
  });

  it('allows both directions, rejects self and unrelated users', async (): Promise<void> => {
    await expect(service.hasCommonGroup(first, second)).resolves.toBe(true);
    await expect(service.hasCommonGroup(second, first)).resolves.toBe(true);
    await expect(service.hasCommonGroup(first, third)).resolves.toBe(false);
    await expect(service.hasCommonGroup(first, first)).resolves.toBe(false);
    await expect(service.hasCommonGroup(first, randomUUID())).resolves.toBe(false);
  });

  it('enforces membership uniqueness and foreign keys', async (): Promise<void> => {
    await expect(
      database!.query('INSERT INTO gchat_group_members VALUES ($1, $2)', [group, first]),
    ).rejects.toMatchObject({ code: '23505' });
    await expect(
      database!.query('INSERT INTO gchat_group_members VALUES ($1, $2)', [group, randomUUID()]),
    ).rejects.toMatchObject({ code: '23503' });
    await expect(
      database!.query('INSERT INTO gchat_group_members VALUES ($1, $2)', [randomUUID(), first]),
    ).rejects.toMatchObject({ code: '23503' });
  });

  it('lists only accessible groups and excludes disabled accounts from participants', async (): Promise<void> => {
    expect((await service.list(first)).map((item): string => item.id)).toContain(group);
    expect(await service.list(third)).toEqual([]);
    await expect(service.members(third, group)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(service.members(first, randomUUID())).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await database!.query('UPDATE gchat_users SET disabled_at=now() WHERE id=$1', [second]);

    try {
      expect((await service.members(first, group)).map((item): string => item.id)).toEqual([first]);
    } finally {
      await database!.query('UPDATE gchat_users SET disabled_at=null WHERE id=$1', [second]);
    }
  });

  it('lets an admin without membership read all groups and active members using the current role', async (): Promise<void> => {
    await database!.query("UPDATE gchat_users SET role='admin' WHERE id=$1", [third]);

    try {
      expect((await service.list(third)).map((item): string => item.id)).toContain(group);
      expect((await service.members(third, group)).map((item): string => item.id)).toEqual([
        first,
        second,
      ]);
      await expect(service.members(third, randomUUID())).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
      await database!.query('UPDATE gchat_users SET disabled_at=now() WHERE id=$1', [second]);
      expect((await service.members(third, group)).map((item): string => item.id)).toEqual([first]);
      await database!.query("UPDATE gchat_users SET role='user' WHERE id=$1", [third]);
      expect(await service.list(third)).toEqual([]);
      await expect(service.members(third, group)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    } finally {
      await database!.query(
        "UPDATE gchat_users SET role='user', disabled_at=null WHERE id=ANY($1::uuid[])",
        [[second, third]],
      );
    }
  });

  it('retains access until the last shared group is removed', async (): Promise<void> => {
    const otherGroup = (
      await database!.query<{ id: string }>(
        `INSERT INTO gchat_groups (name) VALUES ('other family') RETURNING id`,
      )
    ).rows[0]!.id;

    await database!.query('INSERT INTO gchat_group_members VALUES ($1, $2), ($1, $3)', [
      otherGroup,
      first,
      second,
    ]);
    await database!.query('DELETE FROM gchat_group_members WHERE group_id = $1 AND user_id = $2', [
      group,
      first,
    ]);
    await expect(service.hasCommonGroup(first, second)).resolves.toBe(true);
    await database!.query('DELETE FROM gchat_groups WHERE id = $1', [otherGroup]);
    await expect(service.hasCommonGroup(first, second)).resolves.toBe(false);
    const members = await database!.query('SELECT 1 FROM gchat_group_members WHERE group_id = $1', [
      otherGroup,
    ]);

    expect(members.rowCount).toBe(0);
    const account = await database!.query('SELECT 1 FROM gchat_users WHERE id = $1', [first]);

    expect(account.rowCount).toBe(1);
  });
});

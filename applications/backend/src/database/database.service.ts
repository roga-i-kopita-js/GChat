import type { OnModuleDestroy } from '@nestjs/common';
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { Pool } from 'pg';

import { DATABASE_POOL } from './database.constants.js';

@Injectable()
export class DatabaseService implements OnModuleDestroy {
  readonly db;

  constructor(@Inject(DATABASE_POOL) private readonly pool: Pool) {
    this.db = drizzle({ client: pool });
  }

  async ping(): Promise<void> {
    await this.db.execute(sql`select 1`);
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}

export type DatabaseTransaction = Parameters<
  Parameters<DatabaseService['db']['transaction']>[0]
>[0];

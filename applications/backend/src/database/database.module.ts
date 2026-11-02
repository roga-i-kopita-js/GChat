import { Logger, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import pg from 'pg';
import { DATABASE_POOL } from './database.constants.js';
import { DatabaseService } from './database.service.js';

@Module({
  imports: [ConfigModule],
  providers: [
    {
      provide: DATABASE_POOL,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const pool = new pg.Pool({
          connectionString: config.getOrThrow<string>('DATABASE_URL'),
          max: 5,
          connectionTimeoutMillis: 2000,
          query_timeout: 2000,
          statement_timeout: 2000,
        });
        // Idle-client errors must not become unhandled EventEmitter errors.
        pool.on('error', () => {
          Logger.warn('Idle PostgreSQL connection failed', 'Database');
        });
        return pool;
      },
    },
    DatabaseService,
  ],
  exports: [DatabaseService],
})
export class DatabaseModule {}

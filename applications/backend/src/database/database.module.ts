import { LoggerService } from '../logger/logger.service.js';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import pg from 'pg';
import { DATABASE_POOL } from './database.constants.js';
import { DatabaseService } from './database.service.js';

@Module({
  imports: [ConfigModule],
  providers: [
    {
      provide: DATABASE_POOL,
      inject: [ConfigService, LoggerService],
      useFactory: (config: ConfigService, logger: LoggerService) => {
        const pool = new pg.Pool({
          connectionString: config.getOrThrow<string>('DATABASE_URL'),
          max: 5,
          connectionTimeoutMillis: 2000,
          query_timeout: 2000,
          statement_timeout: 2000,
        });
        // Idle-client errors must not become unhandled EventEmitter errors.
        pool.on('error', () => {
          logger.warn('Idle PostgreSQL connection failed');
        });
        return pool;
      },
    },
    DatabaseService,
  ],
  exports: [DatabaseService],
})
export class DatabaseModule {}

import 'reflect-metadata';

import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';

import { DatabaseModule } from '../database/database.module.js';
import { DatabaseService } from '../database/database.service.js';
import { validateDatabaseUrl } from '../database/database-url.js';
import { AppError } from '../error/app.error.js';
import { ErrorModule } from '../error/error.module.js';
import { GroupsRepository } from '../groups/groups.repository.js';
import { GroupsService } from '../groups/groups.service.js';
import { LoggerModule } from '../logger/logger.module.js';
import { parseAdminArgs, readHiddenPassword } from './admin-cli.input.js';
import { AuthAccounts, type SafeAccount } from './auth.accounts.js';
import { AuthCrypto } from './auth.crypto.js';
import { AuthSessions } from './auth.sessions.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate: (env: Record<string, unknown>): Record<string, unknown> => {
        validateDatabaseUrl(env.DATABASE_URL);

        return env;
      },
    }),
    LoggerModule.forRoot(),
    ErrorModule,
    DatabaseModule,
  ],
  providers: [AuthCrypto, AuthSessions, AuthAccounts, GroupsRepository, GroupsService],
})
class AdminCliModule {}

async function main(): Promise<void> {
  const input = parseAdminArgs(process.argv.slice(2));
  const password = await readHiddenPassword();
  const app = await NestFactory.createApplicationContext(AdminCliModule, {
    logger: false,
    abortOnError: false,
  });

  try {
    const accounts = app.get(AuthAccounts);
    const groups = app.get(GroupsService);
    const group = input.group === undefined ? undefined : groups.normalizeName(input.group);
    const prepared = await accounts.prepare({ ...input, password });
    const account = await app
      .get(DatabaseService)
      .db.transaction(async (tx): Promise<SafeAccount> => {
        const account = await accounts.create(tx, prepared, 'admin');

        if (group !== undefined) {
          await groups.assign(tx, account.id, group);
        }

        return account;
      });

    process.stdout.write(`Администратор создан: ${account.login} (${account.id})\n`);
  } finally {
    await app.close();
  }
}

main().catch((error: unknown): void => {
  process.stderr.write(
    error instanceof AppError
      ? `${error.code}: ${error.message}\n`
      : 'Не удалось создать администратора. Проверьте параметры, терминал и конфигурацию. Результат записи может быть неизвестен.\n',
  );
  process.exitCode = 1;
});

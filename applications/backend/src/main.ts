import { setupSwagger } from './swagger/setup-swagger.js';
import 'reflect-metadata';
import { LoggerService } from './logger/logger.service.js';

import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { LoggerSettings } from './logger/logger-settings.js';

const bootstrapLogger = new LoggerService();

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { logger: bootstrapLogger, abortOnError: false });
  const logger = new LoggerService(app.get(LoggerSettings));
  app.useLogger(logger);
  const config = app.get(ConfigService);

  setupSwagger(app);
  app.enableShutdownHooks();
  await app.listen(config.getOrThrow<number>('PORT'), config.getOrThrow<string>('HOST'));
  logger.log('HTTP server started', { host: config.getOrThrow<string>('HOST'), port: config.getOrThrow<number>('PORT') }, 'Bootstrap');
}

bootstrap().catch((error: unknown) => {
  bootstrapLogger.error('Backend startup failed', { error }, 'Bootstrap');
  process.exitCode = 1;
});

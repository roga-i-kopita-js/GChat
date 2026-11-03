import 'reflect-metadata';

import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';

import { AppModule } from './app.module.js';
import { AuthService } from './auth/auth.service.js';
import { LoggerService } from './logger/logger.service.js';
import { LoggerSettings } from './logger/logger-settings.js';
import { SignalingAdapter } from './signaling/signaling.adapter.js';
import { setupSwagger } from './swagger/setup-swagger.js';

const bootstrapLogger = new LoggerService();

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { logger: bootstrapLogger, abortOnError: false });
  const logger = new LoggerService(app.get(LoggerSettings));

  app.useLogger(logger);
  const config = app.get(ConfigService);

  app.useWebSocketAdapter(new SignalingAdapter(app, app.get(AuthService)));
  setupSwagger(app);
  app.enableShutdownHooks();
  await app.listen(config.getOrThrow<number>('PORT'), config.getOrThrow<string>('HOST'));
  logger.log(
    'HTTP server started',
    { host: config.getOrThrow<string>('HOST'), port: config.getOrThrow<number>('PORT') },
    'Bootstrap',
  );
}

bootstrap().catch((error: unknown): void => {
  bootstrapLogger.error('Backend startup failed', { error }, 'Bootstrap');
  process.exitCode = 1;
});

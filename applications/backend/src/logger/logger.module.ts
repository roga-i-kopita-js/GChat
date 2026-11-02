import { Injectable, Module } from '@nestjs/common';
import type { DynamicModule, OnModuleInit } from '@nestjs/common';
import { LoggerService } from './logger.service.js';
import { LoggerSettings } from './logger-settings.js';
import { LoggerContext } from './logger-context.js';

@Injectable()
class LoggerInitializer implements OnModuleInit {
  constructor(private readonly registry: LoggerContext) {}
  onModuleInit(): void { this.registry.bindConsumers(LoggerService); }
}

@Module({})
export class LoggerModule {
  static forRoot(): DynamicModule {
    return {
      module: LoggerModule,
      global: true,
      providers: [LoggerService, LoggerSettings, LoggerContext, LoggerInitializer],
      exports: [LoggerService, LoggerSettings],
    };
  }
}

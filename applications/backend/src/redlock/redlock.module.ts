import type { DynamicModule } from '@nestjs/common';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { RedlockService } from './redlock.service.js';

@Module({})
export class RedlockModule {
  static forFeature(): DynamicModule {
    return {
      module: RedlockModule,
      imports: [ConfigModule],
      providers: [RedlockService],
      exports: [RedlockService],
    };
  }
}

import { Module } from '@nestjs/common';

import { DatabaseModule } from '../database/database.module.js';
import { RedlockModule } from '../redlock/redlock.module.js';
import { AuthController } from './auth.controller.js';
import { AuthCrypto } from './auth.crypto.js';
import { AuthGuard } from './auth.guard.js';
import { AuthLimits } from './auth.limits.js';
import { AuthRepository } from './auth.repository.js';
import { AuthService } from './auth.service.js';
import { AuthSessions } from './auth.sessions.js';

@Module({
  imports: [DatabaseModule, RedlockModule.forFeature()],
  controllers: [AuthController],
  providers: [AuthRepository, AuthCrypto, AuthSessions, AuthService, AuthGuard, AuthLimits],
  exports: [AuthService, AuthGuard],
})
export class AuthModule {}

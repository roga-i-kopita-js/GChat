import { Module } from '@nestjs/common';

import { DatabaseModule } from '../database/database.module.js';
import { RedlockModule } from '../redlock/redlock.module.js';
import { AuthAccounts } from './auth.accounts.js';
import { AuthCleanup } from './auth.cleanup.js';
import { AuthController } from './auth.controller.js';
import { AuthCrypto } from './auth.crypto.js';
import { AuthGuard } from './auth.guard.js';
import { AuthLimits } from './auth.limits.js';
import { AuthRepository } from './auth.repository.js';
import { AuthService } from './auth.service.js';
import { AuthSessions } from './auth.sessions.js';
import { AuthWsTickets } from './auth.ws-tickets.js';
import { BrowserOrigin } from './browser-origin.js';

@Module({
  imports: [DatabaseModule, RedlockModule.forFeature()],
  controllers: [AuthController],
  providers: [
    AuthAccounts,
    AuthCleanup,
    AuthWsTickets,
    BrowserOrigin,
    AuthRepository,
    AuthCrypto,
    AuthSessions,
    AuthService,
    AuthGuard,
    AuthLimits,
  ],
  exports: [AuthAccounts, AuthService, AuthGuard, AuthWsTickets],
})
export class AuthModule {}

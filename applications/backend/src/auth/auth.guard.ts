import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { Injectable } from '@nestjs/common';

import { ErrorService } from '../error/error.service.js';
import { AuthService } from './auth.service.js';

export interface AuthIdentity {
  userId: string;
  sessionId: string;
  login: string;
  displayName: string;
  role: 'user' | 'admin';
}

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly auth: AuthService,
    private readonly error: ErrorService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context
      .switchToHttp()
      .getRequest<{ headers: { authorization?: string }; user?: AuthIdentity }>();
    const match = /^Bearer ([^\s]+)$/i.exec(request.headers.authorization ?? '');

    if (!match) throw this.error.accessTokenInvalid();

    request.user = await this.auth.authenticate(match[1]!);

    return true;
  }
}

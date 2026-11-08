import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';

import type { AuthIdentity } from '../auth/auth.guard.js';
import { ErrorService } from '../error/error.service.js';

@Injectable()
export class AdminGuard implements CanActivate {
  constructor(private readonly error: ErrorService) {}

  canActivate(context: ExecutionContext): boolean {
    const { user } = context.switchToHttp().getRequest<{ user?: AuthIdentity }>();

    if (user?.role !== 'admin') {
      throw this.error.forbidden();
    }

    return true;
  }
}

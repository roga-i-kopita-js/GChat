import { Injectable } from '@nestjs/common';

import { DatabaseService } from '../database/database.service.js';
import { ErrorService } from '../error/error.service.js';
import { nativeWebsocketRestrictions } from './signaling.schema.js';

@Injectable()
export class NativeWebsocketPolicyService {
  constructor(
    private readonly database: DatabaseService,
    private readonly error: ErrorService,
  ) {}

  async read(): Promise<{
    restrictions: { direction: string; message_pattern: string }[];
  }> {
    const restrictions = await this.database.db
      .select({
        direction: nativeWebsocketRestrictions.direction,
        message_pattern: nativeWebsocketRestrictions.messagePattern,
      })
      .from(nativeWebsocketRestrictions)
      .limit(513);

    // Never deliver a truncated policy, which could silently remove a prohibition.
    if (restrictions.length > 512) throw this.error.serviceUnavailable();

    return { restrictions };
  }
}

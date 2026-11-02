import { Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export function parseLogRedaction(value: unknown): boolean {
  if (value === undefined || value === 'true' || value === true) return true;

  if (value === 'false' || value === false) return false;

  throw new Error('LOG_REDACTION_ENABLED must be true or false');
}

@Injectable()
export class LoggerSettings {
  readonly redactionEnabled: boolean;

  constructor(@Optional() config?: ConfigService) {
    this.redactionEnabled = parseLogRedaction(
      config?.get('LOG_REDACTION_ENABLED') ?? process.env.LOG_REDACTION_ENABLED,
    );
  }
}

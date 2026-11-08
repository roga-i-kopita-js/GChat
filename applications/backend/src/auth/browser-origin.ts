import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { ErrorService } from '../error/error.service.js';

export function parseBrowserOrigins(value: unknown): string[] {
  let origins: unknown;

  try {
    origins = JSON.parse(String(value ?? '[]'));
  } catch {
    throw new Error('SIGNALING_BROWSER_ORIGINS must be a JSON array');
  }

  if (!Array.isArray(origins)) {
    throw new Error('SIGNALING_BROWSER_ORIGINS must be a JSON array');
  }

  return origins.map((origin: unknown): string => {
    if (typeof origin !== 'string') {
      throw new Error('Invalid browser origin');
    }

    let url: URL;

    try {
      url = new URL(origin);
    } catch {
      throw new Error('Invalid browser origin');
    }

    if (
      url.origin !== origin ||
      url.username ||
      url.password ||
      (url.protocol !== 'https:' &&
        !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
    ) {
      throw new Error('Browser origins must be exact HTTPS origins or localhost');
    }

    return origin;
  });
}

@Injectable()
export class BrowserOrigin {
  constructor(
    private readonly config: ConfigService,
    private readonly error: ErrorService,
  ) {}

  assert(origin: string | undefined): string {
    const allowed = this.config.get<string[]>('SIGNALING_BROWSER_ORIGINS') ?? [];

    if (!origin || !allowed.includes(origin)) {
      throw this.error.forbidden();
    }

    return origin;
  }
}

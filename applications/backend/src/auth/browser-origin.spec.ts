import { ConfigService } from '@nestjs/config';

import { ErrorService } from '../error/error.service.js';
import { BrowserOrigin, parseBrowserOrigins } from './browser-origin.js';

describe('Browser origin allowlist', (): void => {
  it('defaults to disabled and permits only exact configured origins', (): void => {
    expect(parseBrowserOrigins(undefined)).toEqual([]);
    const origins = parseBrowserOrigins('["https://gchat.example.test","http://localhost:5173"]');
    const policy = new BrowserOrigin(
      new ConfigService({ SIGNALING_BROWSER_ORIGINS: origins }),
      new ErrorService(),
    );

    expect(policy.assert('http://localhost:5173')).toBe('http://localhost:5173');
    expect((): string => policy.assert('http://localhost:5174')).toThrow();
    expect((): string => policy.assert(undefined)).toThrow();
  });
  it.each([
    '["*"]',
    '["null"]',
    '["https://example.test/path"]',
    '["https://user:pass@example.test"]',
    '["http://example.test"]',
    '{}',
    'broken',
  ])('rejects unsafe or malformed configuration %s', (value): void => {
    expect((): string[] => parseBrowserOrigins(value)).toThrow();
  });
});

import { jest } from '@jest/globals';
import { ConfigService } from '@nestjs/config';

import { ErrorService } from '../error/error.service.js';
import { AuthLimits } from './auth.limits.js';
describe('Auth limits', (): void => {
  const config = new ConfigService({
    AUTH_LOGIN_WINDOW_MS: 300000,
    AUTH_LOGIN_MAX_FAILURES: 5,
    AUTH_REFRESH_WINDOW_MS: 60000,
    AUTH_REFRESH_MAX_OPERATIONS: 10,
  });

  afterEach((): void => {
    jest.useRealTimers();
  });
  it('counts repeated request IDs once even if the initial operation failed before persistence', (): void => {
    const limits = new AuthLimits(new ErrorService(), config);

    for (let i = 0; i < 20; i++) {
      limits.check('session', 'refresh', true, 'same-id');
    }

    for (let i = 0; i < 9; i++) {
      limits.check('session', 'refresh', true, `next-${i}`);
    }

    expect((): void => limits.check('session', 'refresh', true, 'extra')).toThrow(
      expect.objectContaining({ code: 'RATE_LIMITED' }),
    );
    expect((): void => limits.check('session', 'refresh', true, 'same-id')).not.toThrow();
  });
  it('expires failed-login attempts and separates login and session limits', (): void => {
    jest.useFakeTimers();
    const limits = new AuthLimits(new ErrorService(), config);

    for (let i = 0; i < 5; i++) {
      limits.check('user', 'login', true);
    }

    expect((): void => limits.check('user', 'login')).toThrow(
      expect.objectContaining({ retryAfterSeconds: 300 }),
    );
    expect((): void => limits.check('user', 'refresh', true, 'request')).not.toThrow();
    jest.advanceTimersByTime(300000);
    expect((): void => limits.check('user', 'login')).not.toThrow();
  });
  it('expires each attempt independently instead of resetting a fixed window', (): void => {
    jest.useFakeTimers();
    const limits = new AuthLimits(new ErrorService(), config);

    limits.check('user', 'login', true);
    jest.advanceTimersByTime(299000);

    for (let i = 0; i < 4; i++) {
      limits.check('user', 'login', true);
    }

    jest.advanceTimersByTime(1000);
    limits.check('user', 'login', true);
    expect((): void => limits.check('user', 'login')).toThrow(
      expect.objectContaining({ retryAfterSeconds: 299 }),
    );
    jest.advanceTimersByTime(299000);
    expect((): void => limits.check('user', 'login')).not.toThrow();
  });
});

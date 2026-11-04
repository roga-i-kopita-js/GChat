import { validateEnvironment } from './environment.js';

describe('JWT lifetime configuration', (): void => {
  it('defaults to 120 seconds and parses a custom integer lifetime', (): void => {
    const env = { ...process.env };

    delete env.AUTH_ACCESS_TOKEN_TTL_SECONDS;
    expect(validateEnvironment(env).AUTH_ACCESS_TOKEN_TTL_SECONDS).toBe(120);
    expect(
      validateEnvironment({ ...env, AUTH_ACCESS_TOKEN_TTL_SECONDS: '15' })
        .AUTH_ACCESS_TOKEN_TTL_SECONDS,
    ).toBe(15);
  });

  it.each(['0', '-1', '1.5', 'abc', '', 'Infinity', '2147483648'])(
    'rejects invalid AUTH_ACCESS_TOKEN_TTL_SECONDS=%s',
    (value): void => {
      expect((): unknown =>
        validateEnvironment({ ...process.env, AUTH_ACCESS_TOKEN_TTL_SECONDS: value }),
      ).toThrow('AUTH_ACCESS_TOKEN_TTL_SECONDS');
    },
  );
});

describe('Password pepper configuration', (): void => {
  it.each([
    undefined,
    '',
    'secret',
    Buffer.alloc(31).toString('base64'),
    Buffer.alloc(33).toString('base64'),
    'A'.repeat(42) + 'B=',
  ])('rejects a missing or invalid pepper without disclosing its value', (value): void => {
    expect((): unknown =>
      validateEnvironment({ ...process.env, AUTH_PASSWORD_PEPPER: value }),
    ).toThrow('AUTH_PASSWORD_PEPPER must contain 32 random bytes in canonical base64');
  });
});

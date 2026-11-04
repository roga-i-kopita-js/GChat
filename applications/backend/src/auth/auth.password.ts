import { randomBytes } from 'node:crypto';

import * as argon2 from 'argon2';

export function parsePasswordPepper(value: unknown): Buffer {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(value)) {
    throw new Error('AUTH_PASSWORD_PEPPER must contain 32 random bytes in canonical base64');
  }

  const pepper = Buffer.from(value, 'base64');

  if (pepper.length !== 32 || pepper.toString('base64') !== value) {
    throw new Error('AUTH_PASSWORD_PEPPER must contain 32 random bytes in canonical base64');
  }

  return pepper;
}

export function hashPassword(password: string | Buffer, pepper: Buffer): Promise<string> {
  return argon2.hash(password, {
    type: argon2.argon2id,
    memoryCost: 65536,
    timeCost: 3,
    parallelism: 4,
    hashLength: 32,
    salt: randomBytes(16),
    secret: pepper,
  });
}

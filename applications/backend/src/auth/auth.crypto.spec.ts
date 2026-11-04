import { createPrivateKey, randomBytes, randomUUID } from 'node:crypto';

import { ConfigService } from '@nestjs/config';
import * as argon2 from 'argon2';
import {
  decodeJwt,
  decodeProtectedHeader,
  flattenedDecrypt,
  FlattenedEncrypt,
  SignJWT,
} from 'jose';

import { ErrorService } from '../error/error.service.js';
import { AuthCrypto, parseAuthKeys, sessionId, tokenHash } from './auth.crypto.js';
import type { Account } from './auth.schema.js';
const account: Account = {
  id: randomUUID(),
  login: 'andrey',
  displayName: 'Андрей',
  passwordHash: 'unused',
  role: 'user',
  disabledAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe('Auth cryptography', (): void => {
  const crypto = new AuthCrypto(new ConfigService(process.env), new ErrorService());

  beforeAll(async (): Promise<void> => {
    await crypto.onModuleInit();
  });
  it('issues independent refresh secrets and a signed JWT with the required lifetime', async (): Promise<void> => {
    const sid = randomUUID();
    const a = await crypto.issue(account, sid);
    const b = await crypto.issue(account, sid);

    expect(a.refresh_token).not.toBe(b.refresh_token);
    expect(sessionId(a.refresh_token)).toBe(sid);
    expect(tokenHash(a.refresh_token)).toHaveLength(64);
    const jwt = decodeJwt(a.access_token);

    expect(jwt).toMatchObject({
      sub: account.id,
      sid,
      login: account.login,
      display_name: account.displayName,
      role: account.role,
      iss: 'gchat',
      aud: 'gchat-api',
    });
    expect(jwt.exp! - jwt.iat!).toBe(120);
    await expect(crypto.verifyAccess(a.access_token)).resolves.toEqual({
      userId: account.id,
      sessionId: sid,
    });
  });
  it('rejects altered signatures and reports expiration separately', async (): Promise<void> => {
    const a = await crypto.issue(account, randomUUID());
    const parts = a.access_token.split('.');

    parts[1] = Buffer.from(
      JSON.stringify({ ...decodeJwt(a.access_token), sub: randomUUID() }),
    ).toString('base64url');
    await expect(crypto.verifyAccess(parts.join('.'))).rejects.toMatchObject({
      code: 'ACCESS_TOKEN_INVALID',
    });
    const expired = await new SignJWT({
      sid: randomUUID(),
      login: account.login,
      display_name: account.displayName,
      role: account.role,
    })
      .setProtectedHeader({ alg: 'EdDSA', kid: 'test' })
      .setSubject(account.id)
      .setIssuer('gchat')
      .setAudience('gchat-api')
      .setIssuedAt(Math.floor(Date.now() / 1000) - 130)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 10)
      .sign(createPrivateKey(process.env.AUTH_JWT_PRIVATE_KEY!));

    await expect(crypto.verifyAccess(expired)).rejects.toMatchObject({
      code: 'ACCESS_TOKEN_EXPIRED',
    });
  });
  it('issues a custom lifetime and expires older tokens when the configured age limit decreases', async (): Promise<void> => {
    const short = new AuthCrypto(
      new ConfigService({ ...process.env, AUTH_ACCESS_TOKEN_TTL_SECONDS: 15 }),
      new ErrorService(),
    );
    const sid = randomUUID();
    const issued = await short.issue(account, sid);
    const jwt = decodeJwt(issued.access_token);

    expect(jwt.exp! - jwt.iat!).toBe(15);
    await expect(short.verifyAccess(issued.access_token)).resolves.toEqual({
      userId: account.id,
      sessionId: sid,
    });
    // Changing the duration must not invalidate the shape/signature of existing tokens.
    await expect(crypto.verifyAccess(issued.access_token)).resolves.toEqual({
      userId: account.id,
      sessionId: sid,
    });
    const existing = await crypto.issue(account, sid);

    await expect(short.verifyAccess(existing.access_token)).resolves.toEqual({
      userId: account.id,
      sessionId: sid,
    });
    const now = Math.floor(Date.now() / 1000);
    const old = await new SignJWT({
      sid,
      login: account.login,
      display_name: account.displayName,
      role: account.role,
    })
      .setProtectedHeader({ alg: 'EdDSA', kid: 'test' })
      .setSubject(account.id)
      .setIssuer('gchat')
      .setAudience('gchat-api')
      .setIssuedAt(now - 16)
      .setExpirationTime(now + 104)
      .sign(createPrivateKey(process.env.AUTH_JWT_PRIVATE_KEY!));

    await expect(crypto.verifyAccess(old)).resolves.toEqual({ userId: account.id, sessionId: sid });
    await expect(short.verifyAccess(old)).rejects.toMatchObject({ code: 'ACCESS_TOKEN_EXPIRED' });
    // exp still wins even if the current configuration allows a longer lifetime.
    const expired = await new SignJWT({
      role: account.role,
      sid,
      login: account.login,
      display_name: account.displayName,
    })
      .setProtectedHeader({ alg: 'EdDSA', kid: 'test' })
      .setSubject(account.id)
      .setIssuer('gchat')
      .setAudience('gchat-api')
      .setIssuedAt(now - 16)
      .setExpirationTime(now - 1)
      .sign(createPrivateKey(process.env.AUTH_JWT_PRIVATE_KEY!));

    await expect(crypto.verifyAccess(expired)).rejects.toMatchObject({
      code: 'ACCESS_TOKEN_EXPIRED',
    });
  });
  it('authenticates the encrypted result, session and request ID', async (): Promise<void> => {
    const sid = randomUUID();
    const requestId = randomUUID();
    const tokens = await crypto.issue(account, sid);
    const encrypted = await crypto.encrypt(tokens, sid, requestId);

    expect(encrypted).not.toContain(tokens.refresh_token);
    expect(await crypto.encrypt(tokens, sid, requestId)).not.toBe(encrypted);
    await expect(crypto.decrypt(encrypted, sid, requestId)).resolves.toEqual(tokens);
    await expect(crypto.decrypt(encrypted, randomUUID(), requestId)).rejects.toThrow();
    await expect(crypto.decrypt(encrypted, sid, randomUUID())).rejects.toThrow();
    const modified = JSON.parse(encrypted);

    modified.tag = Buffer.alloc(16).toString('base64url');
    await expect(crypto.decrypt(JSON.stringify(modified), sid, requestId)).rejects.toThrow();
  });
  it('uses interoperable JWE with authenticated context and restricts algorithms', async (): Promise<void> => {
    const sid = randomUUID();
    const requestId = randomUUID();
    const tokens = await crypto.issue(account, sid);
    const jwe = JSON.parse(await crypto.encrypt(tokens, sid, requestId));

    expect(decodeProtectedHeader(jwe)).toEqual({ alg: 'dir', enc: 'A256GCM', kid: 'test' });
    const key = Buffer.from(JSON.parse(process.env.AUTH_ROTATION_KEYS!).test, 'base64');
    const decrypted = await flattenedDecrypt(jwe, key);

    expect(JSON.parse(Buffer.from(decrypted.plaintext).toString())).toEqual(tokens);
    expect(Buffer.from(decrypted.additionalAuthenticatedData!).toString()).toBe(
      JSON.stringify([sid, requestId]),
    );
    const invalid = await new FlattenedEncrypt(Buffer.from(JSON.stringify(tokens)))
      .setProtectedHeader({ alg: 'dir', enc: 'A128GCM', kid: 'test' })
      .setAdditionalAuthenticatedData(Buffer.from(JSON.stringify([sid, requestId])))
      .encrypt(key.subarray(0, 16));

    await expect(crypto.decrypt(JSON.stringify(invalid), sid, requestId)).rejects.toThrow();
    const modified = {
      ...jwe,
      aad: Buffer.from(JSON.stringify([randomUUID(), requestId])).toString('base64url'),
    };

    await expect(crypto.decrypt(JSON.stringify(modified), sid, requestId)).rejects.toThrow();
  });
  it('retains old decryption keys when the active rotation key changes', async (): Promise<void> => {
    const sid = randomUUID();
    const requestId = randomUUID();
    const tokens = await crypto.issue(account, sid);
    const encrypted = await crypto.encrypt(tokens, sid, requestId);
    const keys = JSON.parse(process.env.AUTH_ROTATION_KEYS!);

    keys.next = Buffer.alloc(32, 7).toString('base64');
    const rotated = new AuthCrypto(
      new ConfigService({
        ...process.env,
        AUTH_ROTATION_ACTIVE_KID: 'next',
        AUTH_ROTATION_KEYS: JSON.stringify(keys),
      }),
      new ErrorService(),
    );

    await expect(rotated.decrypt(encrypted, sid, requestId)).resolves.toEqual(tokens);
    const next = await rotated.encrypt(tokens, sid, requestId);

    expect(decodeProtectedHeader(JSON.parse(next)).kid).toBe('next');
    await expect(crypto.decrypt(next, sid, requestId)).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
    });
  });
  it('rejects missing, mismatched and invalid key configuration without echoing secrets', (): void => {
    expect((): ReturnType<typeof parseAuthKeys> => parseAuthKeys({})).toThrow(
      'Auth signing and rotation keys must be valid',
    );
    expect((): ReturnType<typeof parseAuthKeys> =>
      parseAuthKeys({ ...process.env, AUTH_JWT_ACTIVE_KID: 'missing' }),
    ).toThrow();
    expect((): ReturnType<typeof parseAuthKeys> =>
      parseAuthKeys({ ...process.env, AUTH_ROTATION_KEYS: '{"test":"secret"}' }),
    ).toThrow(/^Auth signing/);
  });
  it('hashes with independent salts and requires the correct password and pepper', async (): Promise<void> => {
    const password = 'пароль с пробелами 🔐';
    const first = await crypto.hashPassword(password);
    const second = await crypto.hashPassword(password);

    expect(first).not.toBe(second);
    expect(first).toMatch(/^\$argon2id\$v=19\$/);
    expect(argon2.needsRehash(first, { memoryCost: 65536, timeCost: 3, parallelism: 4 })).toBe(
      false,
    );
    expect(Buffer.from(first.split('$')[4]!, 'base64')).toHaveLength(16);
    expect(Buffer.from(first.split('$')[5]!, 'base64')).toHaveLength(32);
    await expect(crypto.verifyPassword(password, first)).resolves.toBe(true);
    await expect(crypto.verifyPassword(password, second)).resolves.toBe(true);
    await expect(crypto.verifyPassword('wrong', first)).resolves.toBe(false);
    await expect(argon2.verify(first, password)).resolves.toBe(false);
    const other = new AuthCrypto(
      new ConfigService({
        ...process.env,
        AUTH_PASSWORD_PEPPER: randomBytes(32).toString('base64'),
      }),
      new ErrorService(),
    );

    await expect(other.verifyPassword(password, first)).resolves.toBe(false);
    const legacy = await argon2.hash(password);

    await expect(crypto.verifyPassword(password, legacy)).resolves.toBe(false);
  });

  it('shares the concurrency budget between hashing and verification and releases it', async (): Promise<void> => {
    const first = crypto.hashPassword('first');
    const second = crypto.hashPassword('second');

    await expect(crypto.hashPassword('third')).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
    });
    await expect(crypto.verifyPassword('third')).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
    });
    await Promise.all([first, second]);
    await expect(crypto.hashPassword('after')).resolves.toMatch(/^\$argon2id\$/);
  });

  it('performs a dummy verification for unknown accounts', async (): Promise<void> => {
    await expect(crypto.verifyPassword('a sufficiently long password')).resolves.toBe(false);
  });
});

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

    const { refresh_token: aRefreshToken } = a;
    const { refresh_token: bRefreshToken } = b;

    expect(aRefreshToken).not.toBe(bRefreshToken);
    const { refresh_token: aRefreshToken2 } = a;

    expect(sessionId(aRefreshToken2)).toBe(sid);
    const { refresh_token: aRefreshToken3 } = a;

    expect(tokenHash(aRefreshToken3)).toHaveLength(64);
    const { access_token: aAccessToken } = a;
    const jwt = decodeJwt(aAccessToken);

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
    const { access_token: aAccessToken2 } = a;

    await expect(crypto.verifyAccess(aAccessToken2)).resolves.toEqual({
      userId: account.id,
      sessionId: sid,
    });
  });
  it('rejects altered signatures and reports expiration separately', async (): Promise<void> => {
    const a = await crypto.issue(account, randomUUID());
    const { access_token: aAccessToken3 } = a;
    const parts = aAccessToken3.split('.');

    const { access_token: aAccessToken4 } = a;

    parts[1] = Buffer.from(
      JSON.stringify({ ...decodeJwt(aAccessToken4), sub: randomUUID() }),
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
    const { access_token: issuedAccessToken } = issued;
    const jwt = decodeJwt(issuedAccessToken);

    expect(jwt.exp! - jwt.iat!).toBe(15);
    const { access_token: issuedAccessToken2 } = issued;

    await expect(short.verifyAccess(issuedAccessToken2)).resolves.toEqual({
      userId: account.id,
      sessionId: sid,
    });
    // Changing the duration must not invalidate the shape/signature of existing tokens.
    const { access_token: issuedAccessToken3 } = issued;

    await expect(crypto.verifyAccess(issuedAccessToken3)).resolves.toEqual({
      userId: account.id,
      sessionId: sid,
    });
    const existing = await crypto.issue(account, sid);

    const { access_token: existingAccessToken } = existing;

    await expect(short.verifyAccess(existingAccessToken)).resolves.toEqual({
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

    const { refresh_token: tokensRefreshToken } = tokens;

    expect(encrypted).not.toContain(tokensRefreshToken);
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

    const { plaintext: decryptedPlaintext } = decrypted;

    expect(JSON.parse(Buffer.from(decryptedPlaintext).toString())).toEqual(tokens);
    const { additionalAuthenticatedData: decryptedAdditionalAuthenticatedData } = decrypted;

    expect(Buffer.from(decryptedAdditionalAuthenticatedData!).toString()).toBe(
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
    const { split: firstSplit } = first;

    expect(Buffer.from(firstSplit.bind(first)('$')[4]!, 'base64')).toHaveLength(16);
    const { split: firstSplit2 } = first;

    expect(Buffer.from(firstSplit2.bind(first)('$')[5]!, 'base64')).toHaveLength(32);
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

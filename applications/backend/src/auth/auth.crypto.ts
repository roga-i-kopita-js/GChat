import { createHash, createPrivateKey, createPublicKey, randomBytes } from 'node:crypto';

import type { OnModuleInit } from '@nestjs/common';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as argon2 from 'argon2';
import type { JWEHeaderParameters } from 'jose';
import { errors, flattenedDecrypt, FlattenedEncrypt, jwtVerify, SignJWT } from 'jose';

import { ErrorService } from '../error/error.service.js';
import type { TokensDto } from './auth.dto.js';
import type { Account } from './auth.schema.js';

export function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function sessionId(token: string): string | undefined {
  return /^v1\.([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.[A-Za-z0-9_-]{43}$/.exec(
    token,
  )?.[1];
}

export interface AuthKeys {
  jwtKid: string;
  privateKey: ReturnType<typeof createPrivateKey>;
  publicKeys: Map<string, ReturnType<typeof createPublicKey>>;
  rotationKid: string;
  rotationKeys: Map<string, Buffer>;
}

export function parseAuthKeys(env: Record<string, unknown>): AuthKeys {
  try {
    const jwtKid = String(env.AUTH_JWT_ACTIVE_KID ?? '');
    const rotationKid = String(env.AUTH_ROTATION_ACTIVE_KID ?? '');

    if (!jwtKid || !rotationKid) throw new Error();

    const privateKey = createPrivateKey(
      String(env.AUTH_JWT_PRIVATE_KEY ?? '').replace(/\\n/g, '\n'),
    );
    const publicValues: unknown = JSON.parse(String(env.AUTH_JWT_PUBLIC_KEYS ?? ''));
    const rotationValues: unknown = JSON.parse(String(env.AUTH_ROTATION_KEYS ?? ''));

    if (
      !publicValues ||
      !rotationValues ||
      Array.isArray(publicValues) ||
      Array.isArray(rotationValues)
    )
      throw new Error();

    const publicKeys = new Map(
      Object.entries(publicValues).map(
        ([kid, pem]): [string, ReturnType<typeof createPublicKey>] => [
          kid,
          createPublicKey(String(pem).replace(/\\n/g, '\n')),
        ],
      ),
    );
    const rotationKeys = new Map(
      Object.entries(rotationValues).map(([kid, value]): [string, Buffer] => {
        if (typeof value !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(value)) throw new Error();

        return [kid, Buffer.from(value, 'base64')];
      }),
    );

    if (
      privateKey.asymmetricKeyType !== 'ed25519' ||
      !publicKeys.has(jwtKid) ||
      !rotationKeys.has(rotationKid) ||
      [...publicKeys.values()].some((key): boolean => key.asymmetricKeyType !== 'ed25519') ||
      [...rotationKeys.values()].some((key): boolean => key.length !== 32) ||
      !createPublicKey(privateKey)
        .export({ type: 'spki', format: 'der' })
        .equals(publicKeys.get(jwtKid)!.export({ type: 'spki', format: 'der' }))
    )
      throw new Error();

    return { jwtKid, privateKey, publicKeys, rotationKid, rotationKeys };
  } catch {
    throw new Error(
      'Auth signing and rotation keys must be valid and include their active key IDs',
    );
  }
}

@Injectable()
export class AuthCrypto implements OnModuleInit {
  private readonly keys: AuthKeys;
  private dummyHash!: string;
  private active = 0;

  constructor(
    config: ConfigService,
    private readonly error: ErrorService,
  ) {
    this.keys = parseAuthKeys(
      Object.fromEntries(
        [
          'AUTH_JWT_ACTIVE_KID',
          'AUTH_JWT_PRIVATE_KEY',
          'AUTH_JWT_PUBLIC_KEYS',
          'AUTH_ROTATION_ACTIVE_KID',
          'AUTH_ROTATION_KEYS',
        ].map((name): [string, unknown] => [name, config.get<unknown>(name)]),
      ),
    );
  }

  async onModuleInit(): Promise<void> {
    this.dummyHash = await argon2.hash(randomBytes(32), {
      type: argon2.argon2id,
      memoryCost: 65536,
      timeCost: 3,
      parallelism: 4,
      hashLength: 32,
      salt: randomBytes(16),
    });
  }

  async verifyPassword(password: string, hash?: string): Promise<boolean> {
    if (this.active >= 2) throw this.error.serviceUnavailable();

    this.active++;

    try {
      const valid = await argon2.verify(hash ?? this.dummyHash, password);

      return Boolean(hash) && valid;
    } finally {
      this.active--;
    }
  }

  async issue(account: Account, sid: string): Promise<TokensDto> {
    const now = Math.floor(Date.now() / 1000);
    const access_token = await new SignJWT({
      sid,
      login: account.login,
      display_name: account.displayName,
    })
      .setProtectedHeader({ alg: 'EdDSA', kid: this.keys.jwtKid, typ: 'JWT' })
      .setSubject(account.id)
      .setIssuer('gchat')
      .setAudience('gchat-api')
      .setIssuedAt(now)
      .setExpirationTime(now + 120)
      .sign(this.keys.privateKey);

    return {
      access_token,
      refresh_token: `v1.${sid}.${randomBytes(32).toString('base64url')}`,
      token_type: 'Bearer',
    };
  }

  async verifyAccess(token: string): Promise<{ userId: string; sessionId: string }> {
    try {
      const { payload } = await jwtVerify(
        token,
        (header): ReturnType<typeof createPublicKey> => {
          const key = header.kid ? this.keys.publicKeys.get(header.kid) : undefined;

          if (!key) throw this.error.accessTokenInvalid();

          return key;
        },
        {
          algorithms: ['EdDSA'],
          issuer: 'gchat',
          audience: 'gchat-api',
          maxTokenAge: 120,
          requiredClaims: ['sub', 'sid', 'iat', 'exp', 'login', 'display_name'],
        },
      );
      const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

      if (
        typeof payload.sub !== 'string' ||
        !uuid.test(payload.sub) ||
        typeof payload.sid !== 'string' ||
        !uuid.test(payload.sid) ||
        typeof payload.login !== 'string' ||
        typeof payload.display_name !== 'string' ||
        typeof payload.iat !== 'number' ||
        typeof payload.exp !== 'number' ||
        payload.exp - payload.iat !== 120
      )
        throw new Error();

      return { userId: payload.sub, sessionId: payload.sid };
    } catch (cause) {
      if (cause instanceof errors.JWTExpired) throw this.error.accessTokenExpired();

      throw this.error.accessTokenInvalid();
    }
  }

  async encrypt(tokens: TokensDto, sid: string, requestId: string): Promise<string> {
    const encrypted = await new FlattenedEncrypt(Buffer.from(JSON.stringify(tokens)))
      .setProtectedHeader({ alg: 'dir', enc: 'A256GCM', kid: this.keys.rotationKid })
      .setAdditionalAuthenticatedData(Buffer.from(JSON.stringify([sid, requestId])))
      .encrypt(this.keys.rotationKeys.get(this.keys.rotationKid)!);

    return JSON.stringify(encrypted);
  }

  async decrypt(value: string, sid: string, requestId: string): Promise<TokensDto> {
    const { plaintext, additionalAuthenticatedData } = await flattenedDecrypt(
      JSON.parse(value),
      (header: JWEHeaderParameters | undefined): Buffer => {
        const key = header?.kid ? this.keys.rotationKeys.get(header.kid) : undefined;

        if (!key) throw this.error.serviceUnavailable();

        return key;
      },
      { keyManagementAlgorithms: ['dir'], contentEncryptionAlgorithms: ['A256GCM'] },
    );
    const expectedContext = Buffer.from(JSON.stringify([sid, requestId]));

    if (!additionalAuthenticatedData || !expectedContext.equals(additionalAuthenticatedData)) {
      throw new Error('Invalid rotation result context');
    }

    return JSON.parse(Buffer.from(plaintext).toString('utf8'));
  }
}

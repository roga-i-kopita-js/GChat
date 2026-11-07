import { createPrivateKey, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { ClientHttp2Session } from 'node:http2';
import { connect } from 'node:http2';

import type { OnModuleDestroy } from '@nestjs/common';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SignJWT } from 'jose';

export interface PushResult {
  status: number;
  reason?: string;
  timestamp?: number;
  retryAfterSeconds: number;
}

@Injectable()
export class PushClient implements OnModuleDestroy {
  private session?: ClientHttp2Session;
  private signing?: { token: string; expires: number };
  private readonly key?: KeyObject;

  constructor(private readonly config: ConfigService) {
    if (!this.config.get<boolean>('APNS_ENABLED', true)) return;

    this.key = createPrivateKey(
      readFileSync(this.config.getOrThrow<string>('APNS_PRIVATE_KEY_FILE')),
    );

    if (
      this.key.asymmetricKeyType !== 'ec' ||
      this.key.asymmetricKeyDetails?.namedCurve !== 'prime256v1'
    )
      throw new Error('APNS_PRIVATE_KEY_FILE must contain an ES256 private key');
  }

  private async token(): Promise<string> {
    if (!this.key) throw new Error('APNs is disabled');

    if (this.signing && this.signing.expires > Date.now()) return this.signing.token;

    const token = await new SignJWT({})
      .setProtectedHeader({ alg: 'ES256', kid: this.config.getOrThrow<string>('APNS_KEY_ID') })
      .setIssuer(this.config.getOrThrow<string>('APNS_TEAM_ID'))
      .setIssuedAt()
      .sign(this.key);

    this.signing = { token, expires: Date.now() + 50 * 60000 };

    return token;
  }

  async send(
    id: string,
    token: string,
    payload: object,
    deadline: Date,
    kind: 'voip' | 'alert' = 'voip',
  ): Promise<PushResult> {
    const authorization = await this.token();
    const timeout = Math.min(5000, deadline.getTime() - Date.now());

    if (timeout <= 0) return { status: 410, reason: 'ExpiredCall', retryAfterSeconds: 0 };

    if (!this.session || this.session.closed || this.session.destroyed) {
      this.session = connect(
        this.config.getOrThrow<string>('APNS_ENVIRONMENT') === 'production'
          ? 'https://api.push.apple.com'
          : 'https://api.sandbox.push.apple.com',
      );
      this.session.on('error', (): void => {});
    }

    const session = this.session;

    return new Promise((resolve, reject): void => {
      const request = session.request({
        ':method': 'POST',
        ':path': '/3/device/' + encodeURIComponent(token),
        authorization: 'bearer ' + authorization,
        'apns-id': id,
        'apns-push-type': kind,
        'apns-topic':
          this.config.getOrThrow<string>('APNS_BUNDLE_ID') + (kind === 'voip' ? '.voip' : ''),
        'apns-priority': '10',
        'apns-expiration': '0',
        'content-type': 'application/json',
      });
      let completed = false;
      let status = 0;
      let body = '';
      let retryAfterSeconds = 0;
      const timer = setTimeout((): void => {
        request.destroy(new Error('APNs request deadline exceeded'));
      }, timeout);

      request.setEncoding('utf8');
      request.on('response', (headers): void => {
        status = Number(headers[':status']);
        const retry = String(headers['retry-after'] ?? '0');

        retryAfterSeconds = /^\d+$/.test(retry)
          ? Number(retry)
          : Math.max(0, (Date.parse(retry) - Date.now()) / 1000) || 0;
      });
      request.on('data', (chunk: string): void => {
        body += chunk;

        if (body.length > 16384) request.destroy(new Error('APNs response exceeded limit'));
      });
      request.on('error', (cause: Error): void => {
        clearTimeout(timer);
        reject(cause);
      });
      request.on('close', (): void => {
        clearTimeout(timer);

        if (!completed) reject(new Error('APNs stream closed before response completed'));
      });
      request.on('end', (): void => {
        completed = true;
        clearTimeout(timer);
        let parsed: unknown;

        try {
          parsed = body ? JSON.parse(body) : {};
        } catch {
          reject(new Error('Invalid APNs response'));

          return;
        }

        const reason =
          parsed &&
          typeof parsed === 'object' &&
          'reason' in parsed &&
          typeof parsed.reason === 'string'
            ? parsed.reason
            : undefined;
        const timestamp =
          parsed &&
          typeof parsed === 'object' &&
          'timestamp' in parsed &&
          typeof parsed.timestamp === 'number'
            ? parsed.timestamp
            : undefined;

        if (reason === 'ExpiredProviderToken') this.signing = undefined;

        resolve({ status, reason, timestamp, retryAfterSeconds });
      });
      request.end(JSON.stringify(payload));
    });
  }

  onModuleDestroy(): void {
    this.session?.destroy();
  }
}

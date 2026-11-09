import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import webPush from 'web-push';

import { validWebPushAddress, type WebPushAddress } from '../devices/web-push.validation.js';

export interface WebPushResult {
  status: number;
  retryAfterSeconds?: number;
}

@Injectable()
export class WebPushClient {
  constructor(private readonly config: ConfigService) {}

  async send(address: WebPushAddress, callId: string, deadline: string): Promise<WebPushResult> {
    return this.sendPayload(
      address,
      { call_id: callId, ringing_deadline: deadline },
      deadline,
      false,
    );
  }

  async sendPayload(
    address: WebPushAddress,
    payload: object,
    deadline: string,
    dialog = true,
  ): Promise<WebPushResult> {
    const remaining = Date.parse(deadline) - Date.now();

    if (remaining <= 0 || !validWebPushAddress(address)) {
      return { status: 410 };
    }

    try {
      const { statusCode: resultStatusCode } = await webPush.sendNotification(
        { endpoint: address.endpoint, keys: { p256dh: address.p256dh, auth: address.auth } },
        JSON.stringify(payload),
        {
          vapidDetails: {
            subject: this.config.getOrThrow<string>('WEB_PUSH_SUBJECT'),
            publicKey: this.config.getOrThrow<string>('WEB_PUSH_PUBLIC_KEY'),
            privateKey: this.config.getOrThrow<string>('WEB_PUSH_PRIVATE_KEY'),
          },
          TTL: dialog ? 0 : Math.max(0, Math.floor(remaining / 1000)),
          contentEncoding: 'aes128gcm',
          urgency: 'high',
          timeout: Math.min(5000, remaining),
        },
      );

      return { status: resultStatusCode };
    } catch (cause) {
      if (cause instanceof webPush.WebPushError) {
        const value = cause.headers['retry-after'];
        const raw = typeof value === 'string' ? value : '';
        const seconds = /^\d+$/.test(raw)
          ? Number(raw)
          : Math.ceil((Date.parse(raw) - Date.now()) / 1000);

        return {
          status: cause.statusCode,
          retryAfterSeconds: Number.isFinite(seconds) ? Math.max(0, seconds) : 0,
        };
      }

      throw new Error('Web Push delivery unavailable');
    }
  }
}

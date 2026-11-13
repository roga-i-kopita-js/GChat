import { createECDH } from 'node:crypto';

import { jest } from '@jest/globals';
import { ConfigService } from '@nestjs/config';
import webPush from 'web-push';

import { WebPushClient } from './web-push.client.js';

describe('Call Web Push payload', (): void => {
  it.each(['Андрей', undefined])(
    'serializes the optional caller name for the push provider (%s)',
    async (name): Promise<void> => {
      const key = createECDH('prime256v1');
      const address = {
        endpoint: 'https://web.push.apple.com/test',
        p256dh: key.generateKeys().toString('base64url'),
        auth: Buffer.alloc(16, 1).toString('base64url'),
      };
      const deadline = new Date(Date.now() + 60000).toISOString();
      const send = jest.spyOn(webPush, 'sendNotification').mockResolvedValue({
        statusCode: 201,
        body: '',
        headers: {},
      });
      const client = new WebPushClient(
        new ConfigService({
          WEB_PUSH_SUBJECT: 'mailto:test@example.com',
          WEB_PUSH_PUBLIC_KEY: 'public',
          WEB_PUSH_PRIVATE_KEY: 'private',
        }),
      );

      try {
        await expect(client.send(address, 'call', deadline, name)).resolves.toEqual({
          status: 201,
        });
        expect(send).toHaveBeenCalledTimes(1);
        const [, raw, options] = send.mock.calls[0]!;

        expect(JSON.parse(raw as string)).toEqual({
          call_id: 'call',
          ringing_deadline: deadline,
          ...(name ? { caller_display_name: name } : {}),
        });
        expect(options).toMatchObject({ urgency: 'high', TTL: expect.any(Number) });
        expect(options!.TTL).toBeGreaterThan(0);
      } finally {
        send.mockRestore();
      }
    },
  );
});

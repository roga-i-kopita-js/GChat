import { createECDH, randomBytes } from 'node:crypto';

import { validWebPushAddress } from './web-push.validation.js';

describe('Web Push addresses', (): void => {
  const pair = createECDH('prime256v1');

  pair.generateKeys();
  const address = {
    endpoint: 'https://fcm.googleapis.com/fcm/send/test',
    p256dh: pair.getPublicKey().toString('base64url'),
    auth: randomBytes(16).toString('base64url'),
  };

  it('accepts valid browser keys and supported providers', (): void => {
    for (const host of [
      'fcm.googleapis.com',
      'updates.push.services.mozilla.com',
      'web.push.apple.com',
      's1.push.apple.com',
    ]) {
      expect(validWebPushAddress({ ...address, endpoint: `https://${host}/test` })).toBe(true);
    }
  });
  it('rejects arbitrary destinations, credentials, ports and invalid encryption keys', (): void => {
    for (const endpoint of [
      'https://127.0.0.1/test',
      'http://fcm.googleapis.com/test',
      'https://fcm.googleapis.com.evil.test/',
      'https://fcm.googleapis.com:8443/',
      'https://user:pass@fcm.googleapis.com/',
      'https://push.apple.com.evil.test/',
    ]) {
      expect(validWebPushAddress({ ...address, endpoint })).toBe(false);
    }

    expect(
      validWebPushAddress({ ...address, p256dh: Buffer.alloc(65).toString('base64url') }),
    ).toBe(false);
    expect(validWebPushAddress({ ...address, auth: '' })).toBe(false);
  });
});

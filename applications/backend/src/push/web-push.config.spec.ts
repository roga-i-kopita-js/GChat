import webPush from 'web-push';

import { validateWebPushConfig } from './web-push.config.js';

describe('Web Push configuration', (): void => {
  it('is optional and independent of APNs', (): void => {
    expect(validateWebPushConfig({})).toBe(false);
    expect((): void => {
      validateWebPushConfig({ WEB_PUSH_ENABLED: 'yes' });
    }).toThrow();
  });
  it('requires matching VAPID keys and contact details when enabled', (): void => {
    const keys = webPush.generateVAPIDKeys();
    const env = {
      WEB_PUSH_ENABLED: true,
      WEB_PUSH_SUBJECT: 'mailto:admin@example.com',
      WEB_PUSH_PUBLIC_KEY: keys.publicKey,
      WEB_PUSH_PRIVATE_KEY: keys.privateKey,
    };

    expect(validateWebPushConfig(env)).toBe(true);
    expect((): void => {
      validateWebPushConfig({
        ...env,
        WEB_PUSH_PRIVATE_KEY: webPush.generateVAPIDKeys().privateKey,
      });
    }).toThrow();
    expect((): void => {
      validateWebPushConfig({ ...env, WEB_PUSH_SUBJECT: '' });
    }).toThrow();
  });
});

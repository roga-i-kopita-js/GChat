import { createECDH } from 'node:crypto';

export function validateWebPushConfig(env: Record<string, unknown>): boolean {
  const enabled = String(env.WEB_PUSH_ENABLED ?? 'false');

  if (!['true', 'false'].includes(enabled)) {
    throw new Error('WEB_PUSH_ENABLED must be true or false');
  }

  if (enabled === 'false') {
    return false;
  }

  try {
    const subject = new URL(String(env.WEB_PUSH_SUBJECT ?? ''));

    if (!['mailto:', 'https:'].includes(subject.protocol)) {
      throw new Error();
    }

    const publicKey = String(env.WEB_PUSH_PUBLIC_KEY ?? '');
    const privateKey = String(env.WEB_PUSH_PRIVATE_KEY ?? '');

    if (!/^[A-Za-z0-9_-]{87}$/.test(publicKey) || !/^[A-Za-z0-9_-]{43}$/.test(privateKey)) {
      throw new Error();
    }

    const pair = createECDH('prime256v1');

    pair.setPrivateKey(Buffer.from(privateKey, 'base64url'));

    if (pair.getPublicKey().toString('base64url') !== publicKey) {
      throw new Error();
    }
  } catch {
    throw new Error('Web Push requires a valid WEB_PUSH_SUBJECT and matching VAPID keys');
  }

  return true;
}

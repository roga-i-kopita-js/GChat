import { ECDH } from 'node:crypto';

export interface WebPushAddress {
  endpoint: string;
  p256dh: string;
  auth: string;
}

/** Push addresses are client input: never turn the sender into an arbitrary HTTPS proxy. */
export function validWebPushAddress(address: WebPushAddress): boolean {
  try {
    const url = new URL(address.endpoint);
    const allowed = [
      'fcm.googleapis.com',
      'updates.push.services.mozilla.com',
      'web.push.apple.com',
    ];
    if (
      url.protocol !== 'https:' ||
      url.port ||
      url.username ||
      url.password ||
      url.hash ||
      !(allowed.includes(url.hostname) || url.hostname.endsWith('.push.apple.com'))
    )
      return false;
    if (!/^[A-Za-z0-9_-]{87}$/.test(address.p256dh) || !/^[A-Za-z0-9_-]{22}$/.test(address.auth))
      return false;
    const key = Buffer.from(address.p256dh, 'base64url');
    return (
      key.length === 65 &&
      key[0] === 4 &&
      ECDH.convertKey(key, 'prime256v1').length === 65 &&
      Buffer.from(address.auth, 'base64url').length === 16
    );
  } catch {
    return false;
  }
}

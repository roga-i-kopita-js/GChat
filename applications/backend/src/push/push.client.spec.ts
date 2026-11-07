import { generateKeyPairSync } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { jest } from '@jest/globals';
import { ConfigService } from '@nestjs/config';
import { jwtVerify } from 'jose';

import { PushClient } from './push.client.js';

describe('Disabled APNs', (): void => {
  it('does not read a key and refuses sending when disabled', async (): Promise<void> => {
    const client = new PushClient(
      new ConfigService({ APNS_ENABLED: false, APNS_PRIVATE_KEY_FILE: '/nonexistent/key.p8' }),
    );

    await expect(client.send('job', 'device', {}, new Date(Date.now() + 1000))).rejects.toThrow(
      'APNs is disabled',
    );
    client.onModuleDestroy();
  });
});

describe('APNs HTTP/2 requests', (): void => {
  let folder: string;
  let client: PushClient;
  let stream: EventEmitter & {
    setEncoding: jest.Mock;
    end: jest.Mock;
    destroy: jest.Mock<(cause: Error) => void>;
  };
  let headers: Record<string, string>;
  let requested: Promise<void>;
  let requestStarted: () => void;
  const keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });

  beforeEach(async (): Promise<void> => {
    folder = await mkdtemp(join(tmpdir(), 'gchat-apns-'));
    const file = join(folder, 'key.p8');

    await writeFile(file, keys.privateKey.export({ type: 'pkcs8', format: 'pem' }));
    client = new PushClient(
      new ConfigService({
        APNS_PRIVATE_KEY_FILE: file,
        APNS_TEAM_ID: 'team',
        APNS_KEY_ID: 'key',
        APNS_BUNDLE_ID: 'invalid.test.gchat',
        APNS_ENVIRONMENT: 'sandbox',
      }),
    );
    requested = new Promise<void>((resolve): void => {
      requestStarted = resolve;
    });
    stream = Object.assign(new EventEmitter(), {
      setEncoding: jest.fn(),
      end: jest.fn(),
      destroy: jest.fn((cause: Error): void => {
        stream.emit('error', cause);
      }),
    });
    (client as any).session = {
      closed: false,
      destroyed: false,
      request: jest.fn((input: Record<string, string>): typeof stream => {
        headers = input;
        requestStarted();

        return stream;
      }),
      destroy: jest.fn(),
    };
  });
  afterEach(async (): Promise<void> => {
    client.onModuleDestroy();
    await rm(folder, { recursive: true, force: true });
  });

  it('sends the outbox UUID, voip headers and a signed ES256 authorization', async (): Promise<void> => {
    const sent = client.send(
      'job-id',
      'aabb',
      { aps: {}, call_id: 'call' },
      new Date(Date.now() + 10000),
    );

    await requested;
    expect(headers).toMatchObject({
      'apns-id': 'job-id',
      'apns-push-type': 'voip',
      'apns-topic': 'invalid.test.gchat.voip',
      'apns-priority': '10',
      'apns-expiration': '0',
      ':path': '/3/device/aabb',
    });
    expect(
      (await jwtVerify(headers.authorization.slice(7), keys.publicKey, { algorithms: ['ES256'] }))
        .payload.iss,
    ).toBe('team');
    expect(stream.end).toHaveBeenCalledWith(JSON.stringify({ aps: {}, call_id: 'call' }));
    stream.emit('response', { ':status': 200 });
    stream.emit('end');
    await expect(sent).resolves.toMatchObject({ status: 200 });
  });

  it('uses ordinary alert headers without a VoIP topic or collapse ID for dialogs', async (): Promise<void> => {
    const sent = client.send(
      'message-id',
      'aabb',
      { aps: { alert: { title: 'GChat', body: 'hello' } } },
      new Date(Date.now() + 10000),
      'alert',
    );

    await requested;
    expect(headers).toMatchObject({
      'apns-id': 'message-id',
      'apns-push-type': 'alert',
      'apns-topic': 'invalid.test.gchat',
      'apns-priority': '10',
      'apns-expiration': '0',
    });
    expect(headers['apns-collapse-id']).toBeUndefined();
    stream.emit('response', { ':status': 200 });
    stream.emit('end');
    await expect(sent).resolves.toMatchObject({ status: 200 });
  });

  it('preserves provider timestamp and Retry-After for safe invalidation and retries', async (): Promise<void> => {
    const sent = client.send('job', 'aabb', {}, new Date(Date.now() + 10000));

    await requested;
    stream.emit('response', { ':status': 410, 'retry-after': '17' });
    stream.emit('data', JSON.stringify({ reason: 'Unregistered', timestamp: 123456 }));
    stream.emit('end');
    await expect(sent).resolves.toEqual({
      status: 410,
      reason: 'Unregistered',
      timestamp: 123456,
      retryAfterSeconds: 17,
    });
  });

  it('does not start an APNs request after the ringing deadline', async (): Promise<void> => {
    await expect(client.send('job', 'aabb', {}, new Date(Date.now() - 1))).resolves.toMatchObject({
      reason: 'ExpiredCall',
    });
    expect(stream.end).not.toHaveBeenCalled();
  });
});

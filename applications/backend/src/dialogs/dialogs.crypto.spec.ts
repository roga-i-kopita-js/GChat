import { randomBytes, randomUUID } from 'node:crypto';

import { ConfigService } from '@nestjs/config';

import type { DatabaseService } from '../database/database.service.js';
import { ErrorService } from '../error/error.service.js';
import { LoggerService } from '../logger/logger.service.js';
import { DialogsCrypto, messageAad, parseDialogKeys } from './dialogs.crypto.js';
import type { MessageRow } from './dialogs.schema.js';
const error = new ErrorService();

function setup(): {
  crypto: DialogsCrypto;
  row: Omit<MessageRow, 'iv' | 'ciphertext' | 'authTag'>;
} {
  const crypto = new DialogsCrypto(
    new ConfigService({
      DIALOGS_ACTIVE_KEY_ID: 'one',
      DIALOGS_ENCRYPTION_KEYS: JSON.stringify({ one: randomBytes(32).toString('base64') }),
    }),
    {} as DatabaseService,
    error,
    new LoggerService(),
  );
  const row = {
    id: randomUUID(),
    dialogId: randomUUID(),
    senderId: randomUUID(),
    senderDeviceId: randomUUID(),
    clientMessageId: randomUUID(),
    sequence: 1,
    createdAt: new Date('2026-11-07T01:02:03.004Z'),
    encryptionVersion: 1,
    encryptionKeyId: 'one',
  };

  return { crypto, row };
}
describe('Dialog encryption', (): void => {
  it('binds canonical metadata and round trips exact Unicode whitespace', (): void => {
    const { crypto, row } = setup();

    expect(messageAad(row).toString()).toBe(
      JSON.stringify([
        'gchat.dialog.message',
        1,
        'one',
        row.id,
        row.dialogId,
        row.senderId,
        row.senderDeviceId,
        row.clientMessageId,
        '1',
        '2026-11-07T01:02:03.004Z',
      ]),
    );
    const content = { kind: 'text' as const, text: '  Привет 👩‍💻\n' };
    const encrypted = crypto.encrypt(row, content);

    expect(encrypted.iv.length).toBe(12);
    expect(encrypted.authTag.length).toBe(16);
    expect(encrypted.ciphertext.includes(Buffer.from('Привет'))).toBe(false);
    expect(crypto.decrypt({ ...row, ...encrypted })).toEqual(content);
    expect(crypto.encrypt(row, content).iv.equals(encrypted.iv)).toBe(false);
  });
  it.each([
    'id',
    'dialogId',
    'senderId',
    'senderDeviceId',
    'clientMessageId',
    'sequence',
    'createdAt',
  ] as const)('rejects tampering with %s', (field): void => {
    const { crypto, row } = setup();
    const encrypted = crypto.encrypt(row, { kind: 'sticker', sticker_id: 'animal-pals-v1-cat' });
    let tamperedValue;

    if (field === 'sequence') {
      tamperedValue = 2;
    } else if (field === 'createdAt') {
      tamperedValue = new Date(0);
    } else {
      tamperedValue = randomUUID();
    }

    const modified = {
      ...row,
      ...encrypted,
      [field]: tamperedValue,
    };

    expect((): unknown => crypto.decrypt(modified)).toThrow(
      expect.objectContaining({ code: 'INTERNAL_ERROR' }),
    );
  });
  it('fails closed on missing key, bad tag, ciphertext or version', (): void => {
    const { crypto, row } = setup();
    const encrypted = crypto.encrypt(row, { kind: 'text', text: 'secret' });

    for (const change of [
      { authTag: randomBytes(16) },
      { ciphertext: randomBytes(12) },
      { encryptionVersion: 2 },
      { iv: randomBytes(11) },
    ]) {
      expect((): unknown => crypto.decrypt({ ...row, ...encrypted, ...change })).toThrow(
        expect.objectContaining({ code: 'INTERNAL_ERROR' }),
      );
    }

    expect((): unknown =>
      crypto.decrypt({ ...row, ...encrypted, encryptionKeyId: 'missing' }),
    ).toThrow(expect.objectContaining({ code: 'SERVICE_UNAVAILABLE' }));
  });
  it('rejects malformed keyrings, aliases and noncanonical base64', (): void => {
    const key = randomBytes(32).toString('base64');

    for (const raw of [
      undefined,
      '{}',
      'null',
      '[]',
      'invalid',
      JSON.stringify({ one: key, two: key }),
      JSON.stringify({ 'bad key': key }),
      JSON.stringify({ one: key.slice(0, -1) }),
      JSON.stringify({ one: Buffer.alloc(31).toString('base64') }),
    ]) {
      expect((): unknown => parseDialogKeys(raw, 'one')).toThrow('Invalid DIALOGS');
    }

    expect(parseDialogKeys(JSON.stringify({ one: key }), 'one').get('one')?.length).toBe(32);
  });
});

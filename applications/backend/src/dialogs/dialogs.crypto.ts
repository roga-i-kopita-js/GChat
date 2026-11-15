import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

import type { OnModuleInit } from '@nestjs/common';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, eq, lt, sql } from 'drizzle-orm';

import { DatabaseService } from '../database/database.service.js';
import { AppError } from '../error/app.error.js';
import { ErrorService } from '../error/error.service.js';
import { LoggerService } from '../logger/logger.service.js';
import { envelopeValue, type MessageEnvelope } from './dialogs.envelope.js';
import { dialogEncryptionKeys, type MessageRow } from './dialogs.schema.js';
import { contentValue, type MessageContent } from './dialogs.validation.js';

export function parseDialogKeys(raw: unknown, active: unknown): Map<string, Buffer> {
  const fail = (): never => {
    throw new Error('Invalid DIALOGS_ENCRYPTION_KEYS / DIALOGS_ACTIVE_KEY_ID');
  };

  if (typeof raw !== 'string' || typeof active !== 'string') {
    return fail();
  }

  let obj: unknown;

  try {
    obj = JSON.parse(raw);
  } catch {
    return fail();
  }

  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return fail();
  }

  const keys = new Map<string, Buffer>();
  const values = new Set<string>();

  for (const [id, encoded] of Object.entries(obj)) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id) || typeof encoded !== 'string') {
      return fail();
    }

    const key = Buffer.from(encoded, 'base64');

    if (key.length !== 32 || key.toString('base64') !== encoded || values.has(encoded)) {
      return fail();
    }

    keys.set(id, key);
    values.add(encoded);
  }

  if (!keys.has(active)) {
    return fail();
  }

  return keys;
}

export function messageAad(row: Omit<MessageRow, 'iv' | 'ciphertext' | 'authTag'>): Buffer {
  return Buffer.from(
    JSON.stringify([
      'gchat.dialog.message',
      row.encryptionVersion,
      row.encryptionKeyId,
      row.id.toLowerCase(),
      row.dialogId.toLowerCase(),
      row.senderId.toLowerCase(),
      row.senderDeviceId.toLowerCase(),
      row.clientMessageId.toLowerCase(),
      String(row.sequence),
      row.createdAt.toISOString(),
      ...(row.encryptionVersion >= 2
        ? [
            String(row.version),
            row.editedAt?.toISOString() ?? null,
            String(row.editSequence),
            row.lastEditId?.toLowerCase() ?? null,
          ]
        : []),
      ...(row.encryptionVersion >= 3
        ? [String(row.reactionVersion), String(row.reactionSequence)]
        : []),
    ]),
    'utf8',
  );
}

@Injectable()
export class DialogsCrypto implements OnModuleInit {
  private readonly keys: Map<string, Buffer>;
  readonly active: string;

  constructor(
    config: ConfigService,
    private readonly database: DatabaseService,
    private readonly error: ErrorService,
    private readonly logger: LoggerService,
  ) {
    this.active = config.getOrThrow<string>('DIALOGS_ACTIVE_KEY_ID');
    this.keys = parseDialogKeys(config.get('DIALOGS_ENCRYPTION_KEYS'), this.active);
  }

  async onModuleInit(): Promise<void> {
    try {
      await this.database.db.transaction(async (tx): Promise<void> => {
        for (const [id, key] of this.keys) {
          const fingerprint = createHash('sha256').update(key).digest();

          await tx
            .insert(dialogEncryptionKeys)
            .values({ keyId: id, fingerprint })
            .onConflictDoNothing({ target: dialogEncryptionKeys.keyId });

          const [row] = await tx
            .select()
            .from(dialogEncryptionKeys)
            .where(eq(dialogEncryptionKeys.keyId, id));

          if (!row || !row.fingerprint.equals(fingerprint)) {
            throw new Error();
          }
        }
      });
    } catch {
      throw new Error('Dialogs key registry initialization failed');
    }
  }

  async reserve(): Promise<boolean> {
    try {
      const row = await this.database.db.transaction(
        async (tx): Promise<{ attempts: number } | undefined> => {
          const { [0]: returningResultFirst } = await tx
            .update(dialogEncryptionKeys)
            .set({ attempts: sql`${dialogEncryptionKeys.attempts}+1` })
            .where(
              and(
                eq(dialogEncryptionKeys.keyId, this.active),
                lt(dialogEncryptionKeys.attempts, 16777216),
              ),
            )
            .returning({
              attempts: dialogEncryptionKeys.attempts,
            });

          return returningResultFirst;
        },
      );

      const { attempts: rowAttempts } = row ?? {};

      if (rowAttempts !== undefined && rowAttempts >= Math.floor(16777216 * 0.9)) {
        this.logger.warn('Dialogs encryption key budget low', {
          keyId: this.active,
          attempts: rowAttempts,
        });
      }

      return !!row;
    } catch {
      throw this.error.serviceUnavailable();
    }
  }

  encrypt(
    row: Omit<MessageRow, 'iv' | 'ciphertext' | 'authTag'>,
    content: MessageContent,
    envelope?: Omit<MessageEnvelope, 'reply'> & { reply?: MessageEnvelope['reply'] },
  ): Pick<MessageRow, 'iv' | 'ciphertext' | 'authTag'> {
    const key = this.keys.get(row.encryptionKeyId);

    if (!key) {
      throw this.error.serviceUnavailable();
    }

    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });

    cipher.setAAD(messageAad(row));
    const ciphertext = Buffer.concat([
      cipher.update(
        JSON.stringify(
          row.encryptionVersion >= 3
            ? {
                content,
                forward: envelope?.forward ?? null,
                ...(row.encryptionVersion >= 4 ? { reply: envelope?.reply ?? null } : {}),
                reaction_state: envelope?.reaction_state ?? [],
              }
            : content,
        ),
        'utf8',
      ),
      cipher.final(),
    ]);

    return { iv, ciphertext, authTag: cipher.getAuthTag() };
  }

  decrypt(row: MessageRow): MessageContent {
    return this.decryptEnvelope(row).content;
  }

  decryptEnvelope(row: MessageRow): MessageEnvelope {
    const key = this.keys.get(row.encryptionKeyId);

    if (!key) {
      throw this.error.serviceUnavailable();
    }

    try {
      if (
        ![1, 2, 3, 4].includes(row.encryptionVersion) ||
        (row.encryptionVersion < 3 && (row.reactionVersion !== 0 || row.reactionSequence !== 0)) ||
        (row.encryptionVersion === 1 &&
          (row.version !== 1 ||
            row.editSequence !== 0 ||
            row.editedAt !== null ||
            row.lastEditId !== null)) ||
        row.iv.length !== 12 ||
        row.authTag.length !== 16
      ) {
        throw new Error();
      }

      const decipher = createDecipheriv('aes-256-gcm', key, row.iv, { authTagLength: 16 });

      decipher.setAAD(messageAad(row));
      decipher.setAuthTag(row.authTag);
      const plaintext = Buffer.concat([decipher.update(row.ciphertext), decipher.final()]);
      const parsed: unknown = JSON.parse(plaintext.toString('utf8'));

      if (row.encryptionVersion >= 3) {
        const envelope = envelopeValue(
          parsed,
          this.error,
          row.reactionVersion,
          row.encryptionVersion,
        );
        const canonical =
          row.encryptionVersion === 3
            ? {
                content: envelope.content,
                forward: envelope.forward,
                reaction_state: envelope.reaction_state,
              }
            : envelope;

        if (
          envelope.reply &&
          (envelope.reply.sequence >= row.sequence || envelope.reply.message_id === row.id)
        ) {
          throw new Error();
        }

        if (!Buffer.from(JSON.stringify(canonical)).equals(plaintext)) {
          throw new Error();
        }

        return envelope;
      }

      const content = contentValue(parsed, this.error);

      if (!Buffer.from(JSON.stringify(content)).equals(plaintext)) {
        throw new Error();
      }

      return { content, forward: null, reply: null, reaction_state: [] };
    } catch (cause) {
      if (cause instanceof AppError && cause.code === 'SERVICE_UNAVAILABLE') {
        throw cause;
      }

      throw this.error.internal();
    }
  }
}

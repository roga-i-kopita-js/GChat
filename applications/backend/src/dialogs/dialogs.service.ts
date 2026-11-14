import { randomUUID } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { and, asc, desc, eq, gt, lt, lte, or, sql } from 'drizzle-orm';

import type { AuthIdentity } from '../auth/auth.guard.js';
import { users } from '../auth/auth.schema.js';
import { AuthService } from '../auth/auth.service.js';
import { isDatabaseUnavailable } from '../database/database.errors.js';
import { DatabaseService, type DatabaseTransaction } from '../database/database.service.js';
import { DevicesService } from '../devices/devices.service.js';
import { AppError } from '../error/app.error.js';
import { ErrorService } from '../error/error.service.js';
import { GroupsService } from '../groups/groups.service.js';
import { DialogsCrypto } from './dialogs.crypto.js';
import type {
  DialogDto,
  DialogListResponseDto,
  EditMessageDto,
  HistoryResponseDto,
  MessageDto,
  MessageEditsResponseDto,
  PermissionsResponseDto,
  SendMessageDto,
} from './dialogs.dto.js';
import { DialogsEvents } from './dialogs.events.js';
import { DialogsLimits } from './dialogs.limits.js';
import { dialogMessages, type DialogRow, dialogs, type MessageRow } from './dialogs.schema.js';
import { contentValue } from './dialogs.validation.js';

@Injectable()
export class DialogsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly auth: AuthService,
    private readonly devices: DevicesService,
    private readonly groups: GroupsService,
    private readonly crypto: DialogsCrypto,
    private readonly limits: DialogsLimits,
    private readonly error: ErrorService,
    private readonly events: DialogsEvents,
  ) {}

  private async transaction<T>(work: (tx: DatabaseTransaction) => Promise<T>): Promise<T> {
    try {
      return await this.database.db.transaction(work, { isolationLevel: 'read committed' });
    } catch (cause) {
      if (cause instanceof AppError) {
        throw cause;
      }

      if (isDatabaseUnavailable(cause)) {
        throw this.error.serviceUnavailable();
      }

      throw this.error.internal();
    }
  }

  private member(actor: string): ReturnType<typeof or> {
    return or(eq(dialogs.participantLowId, actor), eq(dialogs.participantHighId, actor));
  }

  private async own(
    tx: DatabaseTransaction,
    actor: string,
    id: string,
    lock = false,
  ): Promise<DialogRow> {
    const query = tx
      .select()
      .from(dialogs)
      .where(and(eq(dialogs.id, id), this.member(actor)));
    const [row] = await (lock ? query.for('update') : query);

    if (!row) {
      throw this.error.notFound();
    }

    return row;
  }

  private peer(row: DialogRow, actor: string): string {
    return row.participantLowId === actor ? row.participantHighId : row.participantLowId;
  }

  private async metadata(
    tx: DatabaseTransaction,
    actor: AuthIdentity,
    limit: number,
    offset = 0,
    id?: string,
  ): Promise<DialogDto[]> {
    // Join the exact last sequence in the same statement as metadata/read positions.
    const rows = await tx
      .select({
        row: dialogs,
        name: users.displayName,
        message: dialogMessages,
        unread: sql<boolean>`exists (
          select 1 from ${dialogMessages}
          where ${dialogMessages.dialogId} = ${dialogs.id}
            and ${dialogMessages.senderId} <> ${actor.userId}
            and ${dialogMessages.sequence} > case
              when ${dialogs.participantLowId} = ${actor.userId} then ${dialogs.lowRead}
              else ${dialogs.highRead} end
        )`,
      })
      .from(dialogs)
      .innerJoin(
        users,
        eq(
          users.id,
          sql`case when ${dialogs.participantLowId} = ${actor.userId}
        then ${dialogs.participantHighId} else ${dialogs.participantLowId} end`,
        ),
      )
      .leftJoin(
        dialogMessages,
        and(
          eq(dialogMessages.dialogId, dialogs.id),
          eq(dialogMessages.sequence, dialogs.lastSequence),
        ),
      )
      .where(and(this.member(actor.userId), id ? eq(dialogs.id, id) : undefined))
      .orderBy(desc(sql`coalesce(${dialogs.lastMessageAt},${dialogs.createdAt})`), desc(dialogs.id))
      .limit(limit)
      .offset(offset);

    // Acquire account locks in one stable order before checking individual read permissions.
    const { map: rowsMap } = rows;
    const peers = rowsMap.bind(rows)(({ row }): string => this.peer(row, actor.userId));

    await this.auth.lockAccountStates(tx, [actor.userId, ...peers]);
    await this.access(tx, actor);
    const result: DialogDto[] = [];

    for (const { row, name, unread, message } of rows) {
      const { can_read } = await this.access(tx, actor, this.peer(row, actor.userId), true);

      if (can_read && row.lastSequence > 0 && !message) {
        throw this.error.internal();
      }

      result.push({
        dialog_id: row.id,
        peer_id: this.peer(row, actor.userId),
        peer_display_name: name,
        has_unread_messages: unread,
        last_message: can_read && message ? this.message(message, row) : null,
        created_at: row.createdAt.toISOString(),
        last_message_at: row.lastMessageAt?.toISOString() ?? null,
        last_sequence: row.lastSequence,
        last_read_sequence: row.participantLowId === actor.userId ? row.lowRead : row.highRead,
        peer_last_read_sequence: row.participantLowId === actor.userId ? row.highRead : row.lowRead,
      });
    }

    return result;
  }

  private message(row: MessageRow, dialog: DialogRow): MessageDto {
    const read = row.senderId === dialog.participantLowId ? dialog.highRead : dialog.lowRead;

    return {
      message_id: row.id,
      dialog_id: row.dialogId,
      client_message_id: row.clientMessageId,
      sequence: row.sequence,
      sender_id: row.senderId,
      created_at: row.createdAt.toISOString(),
      version: row.version,
      edited_at: row.editedAt?.toISOString() ?? null,
      edit_sequence: row.editSequence,
      last_edit_id: row.lastEditId,
      content: this.crypto.decrypt(row),
      status: read >= row.sequence ? 'read' : 'sent',
    };
  }

  private denied(): never {
    throw this.error.create({
      status: 403,
      code: 'DIALOG_NOT_ALLOWED',
      message: 'Диалог недоступен.',
    });
  }

  private async access(
    tx: DatabaseTransaction,
    actor: Pick<AuthIdentity, 'userId' | 'sessionId'>,
    peerId?: string,
    readingOnly = false,
  ): Promise<{ deviceId: string; can_read: boolean; can_send: boolean }> {
    const accounts = await this.auth.lockAccountStates(
      tx,
      peerId ? [actor.userId, peerId] : [actor.userId],
    );
    const { find: accountsFind } = accounts;
    const me = accountsFind.bind(accounts)((a): boolean => a.id === actor.userId);

    if (!me || me.disabledAt) {
      throw this.error.sessionInvalid();
    }

    await this.auth.lockSession(tx, actor.userId, actor.sessionId);
    const { deviceId } = await this.devices.lockSessionBinding(tx, actor.userId, actor.sessionId);

    if (!peerId) {
      return { deviceId, can_read: false, can_send: false };
    }

    const { find: accountsFind2 } = accounts;
    const peer = accountsFind2.bind(accounts)((a): boolean => a.id === peerId);

    if (!peer) {
      return { deviceId, can_read: false, can_send: false };
    }

    const meAdmin = me.role === 'admin';
    const peerAdmin = peer.role === 'admin' && !peer.disabledAt;
    // Membership is still needed to distinguish an ordinary user's reply to an admin.
    const common =
      meAdmin || (readingOnly && peerAdmin)
        ? false
        : await this.groups.lockCommonGroup(tx, actor.userId, peerId);

    return {
      deviceId,
      can_read: meAdmin || peerAdmin || common,
      can_send: !peer.disabledAt && (meAdmin || common),
    };
  }

  async create(
    actor: AuthIdentity,
    peerId: string,
  ): Promise<{ dialog: DialogDto; created: boolean }> {
    await this.limits.check(actor.userId, 'create');

    if (peerId === actor.userId) {
      this.denied();
    }

    return this.transaction(async (tx): Promise<{ dialog: DialogDto; created: boolean }> => {
      const access = await this.access(tx, actor, peerId);

      const { can_send: accessCanSend } = access ?? {};

      if (!accessCanSend) {
        this.denied();
      }

      const [low, high] = [actor.userId, peerId].sort();
      const [inserted] = await tx
        .insert(dialogs)
        .values({ participantLowId: low!, participantHighId: high! })
        .onConflictDoNothing({ target: [dialogs.participantLowId, dialogs.participantHighId] })
        .returning();
      const { [0]: whereResultFirst } = await tx
        .select()
        .from(dialogs)
        .where(and(eq(dialogs.participantLowId, low!), eq(dialogs.participantHighId, high!)));
      const row = inserted ?? whereResultFirst;

      if (!row) {
        throw this.error.internal();
      }

      const [dialog] = await this.metadata(tx, actor, 1, 0, row.id);

      if (!dialog) {
        throw this.error.internal();
      }

      return { dialog, created: !!inserted };
    });
  }

  async list(actor: AuthIdentity, limit: number, offset: number): Promise<DialogListResponseDto> {
    await this.limits.check(actor.userId, 'get');

    return this.transaction(async (tx): Promise<DialogListResponseDto> => {
      const rows = await this.metadata(tx, actor, limit + 1, offset);

      const { slice: rowsSlice, length: rowsLength } = rows;

      return { dialogs: rowsSlice.bind(rows)(0, limit), has_more: rowsLength > limit };
    });
  }

  async get(actor: AuthIdentity, id: string): Promise<{ dialog: DialogDto }> {
    await this.limits.check(actor.userId, 'get');

    return this.transaction(async (tx): Promise<{ dialog: DialogDto }> => {
      await this.own(tx, actor.userId, id);

      const [dialog] = await this.metadata(tx, actor, 1, 0, id);

      if (!dialog) {
        throw this.error.notFound();
      }

      return { dialog };
    });
  }

  async permissions(actor: AuthIdentity, id: string): Promise<PermissionsResponseDto> {
    await this.limits.check(actor.userId, 'get');

    return this.transaction(async (tx): Promise<PermissionsResponseDto> => {
      const row = await this.own(tx, actor.userId, id);
      const { can_read: rightsCanRead, can_send: rightsCanSend } = await this.access(
        tx,
        actor,
        this.peer(row, actor.userId),
      );

      return { dialogs: { can_read: rightsCanRead, can_send: rightsCanSend } };
    });
  }

  async history(
    actor: AuthIdentity,
    id: string,
    limit: number,
    after?: number,
    before?: number,
  ): Promise<HistoryResponseDto> {
    await this.limits.check(actor.userId, 'get');

    return this.transaction(async (tx): Promise<HistoryResponseDto> => {
      const row = await this.own(tx, actor.userId, id);

      const { can_read: accessResultCanRead } = await this.access(
        tx,
        actor,
        this.peer(row, actor.userId),
        true,
      );

      if (!accessResultCanRead) {
        this.denied();
      }

      // One statement snapshots messages and read positions together.
      let sequenceFilter;

      if (after !== undefined) {
        sequenceFilter = gt(dialogMessages.sequence, after);
      } else if (before !== undefined) {
        sequenceFilter = lt(dialogMessages.sequence, before);
      } else {
        sequenceFilter = undefined;
      }

      const rows = await tx
        .select({ message: dialogMessages, dialog: dialogs })
        .from(dialogMessages)
        .innerJoin(dialogs, eq(dialogs.id, dialogMessages.dialogId))
        .where(and(eq(dialogMessages.dialogId, id), sequenceFilter))
        .orderBy(after !== undefined ? asc(dialogMessages.sequence) : desc(dialogMessages.sequence))
        .limit(limit + 1);
      const messages: MessageDto[] = [];

      const { slice: rowsSlice2 } = rows;

      for (const { message, dialog } of rowsSlice2.bind(rows)(0, limit)) {
        const dto = this.message(message, dialog);
        const candidate = { messages: [...messages, dto], has_more: true };

        if (Buffer.byteLength(JSON.stringify(candidate)) > 524288) {
          if (!messages.length) {
            throw this.error.internal();
          }

          break;
        }

        messages.push(dto);
      }

      const { length: rowsLength2 } = rows;

      return { messages, has_more: rowsLength2 > messages.length };
    });
  }

  async send(
    actor: AuthIdentity,
    id: string,
    input: SendMessageDto,
  ): Promise<{ message: MessageDto; created: boolean }> {
    const content = contentValue(input.content, this.error);

    await this.limits.check(actor.userId, 'send');
    // Reservation completes before any business locks or transaction acquire a connection.
    const reserved = await this.crypto.reserve();
    const result = await this.transaction(
      async (tx): Promise<{ message: MessageDto; created: boolean; users: string[] }> => {
        const initial = await this.own(tx, actor.userId, id);
        const access = await this.access(tx, actor, this.peer(initial, actor.userId));

        const { can_send: accessCanSend2 } = access ?? {};

        if (!accessCanSend2) {
          this.denied();
        }

        const dialog = await this.own(tx, actor.userId, id, true);
        const [existing] = await tx
          .select()
          .from(dialogMessages)
          .where(
            and(
              eq(dialogMessages.dialogId, id),
              eq(dialogMessages.senderId, actor.userId),
              eq(dialogMessages.clientMessageId, input.client_message_id),
            ),
          );
        const {
          participantLowId: dialogParticipantLowId,
          participantHighId: dialogParticipantHighId,
        } = dialog;
        const users = [dialogParticipantLowId, dialogParticipantHighId];

        if (existing) {
          return { message: this.message(existing, dialog), created: false, users };
        }

        if (!reserved) {
          throw this.error.serviceUnavailable();
        }

        const { lastSequence: dialogLastSequence } = dialog;

        if (dialogLastSequence >= Number.MAX_SAFE_INTEGER) {
          throw this.error.internal();
        }

        const [clock] = await tx
          .select({
            now: sql<Date>`date_trunc('milliseconds',clock_timestamp())`.mapWith(dialogs.createdAt),
          })
          .from(dialogs)
          .where(eq(dialogs.id, id));

        if (!clock) {
          throw this.error.internal();
        }

        const { deviceId: accessDeviceId } = access;
        const { lastSequence: dialogLastSequence2 } = dialog;
        const metadata = {
          id: randomUUID(),
          dialogId: id,
          senderId: actor.userId,
          senderDeviceId: accessDeviceId,
          clientMessageId: input.client_message_id,
          sequence: dialogLastSequence2 + 1,
          createdAt: clock.now,
          encryptionVersion: 2,
          version: 1,
          editedAt: null,
          editSequence: 0,
          lastEditId: null,
          encryptionKeyId: this.crypto.active,
        };
        const encrypted = this.crypto.encrypt(metadata, content);
        const [message] = await tx
          .insert(dialogMessages)
          .values({ ...metadata, ...encrypted })
          .returning();

        if (!message) {
          throw this.error.internal();
        }

        await tx
          .update(dialogs)
          .set({ lastSequence: metadata.sequence, lastMessageAt: metadata.createdAt })
          .where(eq(dialogs.id, id));

        return { message: this.message(message, dialog), created: true, users };
      },
    );

    const { created: resultCreated } = result;

    if (resultCreated) {
      const { users: resultUsers, message: resultMessage } = result;

      this.events.publish({
        users: resultUsers,
        message: resultMessage,
        event: {
          type: 'dialog.messages_available',
          payload: { dialog_id: id, last_sequence: resultMessage.sequence },
        },
      });
    }

    const { message: resultMessage2, created: resultCreated2 } = result;

    return { message: resultMessage2, created: resultCreated2 };
  }

  private async readable(
    tx: DatabaseTransaction,
    actor: AuthIdentity,
    id: string,
  ): Promise<DialogRow> {
    const initial = await this.own(tx, actor.userId, id);
    const rights = await this.access(tx, actor, this.peer(initial, actor.userId), true);
    const { can_read: rightsCan_read1 } = rights;

    if (!rightsCan_read1) {
      this.denied();
    }

    // Hold the dialog snapshot stable while fetching its edits and read positions.
    return this.own(tx, actor.userId, id, true);
  }

  async messageGet(
    actor: AuthIdentity,
    id: string,
    messageId: string,
  ): Promise<{ message: MessageDto }> {
    await this.limits.check(actor.userId, 'get');

    return this.transaction(async (tx): Promise<{ message: MessageDto }> => {
      const dialog = await this.readable(tx, actor, id);
      const [row] = await tx
        .select()
        .from(dialogMessages)
        .where(and(eq(dialogMessages.dialogId, id), eq(dialogMessages.id, messageId)));

      if (!row) {
        throw this.error.notFound();
      }

      return { message: this.message(row, dialog) };
    });
  }

  async edit(
    actor: AuthIdentity,
    id: string,
    messageId: string,
    input: EditMessageDto,
  ): Promise<{ message: MessageDto }> {
    const content = contentValue(input.content, this.error);

    if (content.kind !== 'text') {
      throw this.error.validation();
    }

    await this.limits.check(actor.userId, 'send');
    // Reserve independently before acquiring business locks, as with initial sends.
    const reserved = await this.crypto.reserve();
    const result = await this.transaction(
      async (tx): Promise<{ message: MessageDto; changed: boolean; users: string[] }> => {
        const initial = await this.own(tx, actor.userId, id);
        const rights = await this.access(tx, actor, this.peer(initial, actor.userId));
        const { can_send: rightsCan_send2 } = rights;

        if (!rightsCan_send2) {
          this.denied();
        }

        const dialog = await this.own(tx, actor.userId, id, true);
        const {
          participantLowId: dialogParticipantLowId3,
          participantHighId: dialogParticipantHighId4,
          lastEditSequence: dialogLastEditSequence5,
        } = dialog;

        const [row] = await tx
          .select()
          .from(dialogMessages)
          .where(and(eq(dialogMessages.dialogId, id), eq(dialogMessages.id, messageId)));

        if (!row) {
          throw this.error.notFound();
        }

        const current = this.message(row, dialog);

        if (row.senderId !== actor.userId || current.content.kind !== 'text') {
          throw this.error.forbidden();
        }

        const users = [dialogParticipantLowId3, dialogParticipantHighId4];

        if (row.lastEditId === input.client_edit_id && row.version === input.expected_version + 1) {
          return { message: current, changed: false, users };
        }

        if (row.version !== input.expected_version) {
          throw this.error.create({
            status: 409,
            code: 'MESSAGE_VERSION_CONFLICT',
            message: 'Сообщение уже изменено. Обновите его перед сохранением.',
          });
        }

        if (current.content.text === content.text) {
          return { message: current, changed: false, users };
        }

        if (
          !reserved ||
          row.version >= Number.MAX_SAFE_INTEGER ||
          dialogLastEditSequence5 >= Number.MAX_SAFE_INTEGER
        ) {
          throw this.error.serviceUnavailable();
        }

        const [clock] = await tx
          .select({
            now: sql<Date>`date_trunc('milliseconds',clock_timestamp())`.mapWith(dialogs.createdAt),
          })
          .from(dialogs)
          .where(eq(dialogs.id, id));

        if (!clock) {
          throw this.error.internal();
        }

        const metadata = {
          ...row,
          version: row.version + 1,
          editSequence: dialogLastEditSequence5 + 1,
          editedAt: clock.now,
          lastEditId: input.client_edit_id,
          encryptionVersion: 2,
          encryptionKeyId: this.crypto.active,
        };
        const encrypted = this.crypto.encrypt(metadata, content);
        const [updated] = await tx
          .update(dialogMessages)
          .set({ ...metadata, ...encrypted })
          .where(eq(dialogMessages.id, messageId))
          .returning();

        if (!updated) {
          throw this.error.internal();
        }

        await tx
          .update(dialogs)
          .set({ lastEditSequence: metadata.editSequence })
          .where(eq(dialogs.id, id));

        return { message: this.message(updated, dialog), changed: true, users };
      },
    );
    const { changed: resultChanged6, users: resultUsers7, message: resultMessage8 } = result;

    if (resultChanged6) {
      this.events.publish({
        users: resultUsers7,
        event: {
          type: 'dialog.message_edits_available',
          payload: { dialog_id: id, last_edit_sequence: resultMessage8.edit_sequence },
        },
      });
    }

    return { message: resultMessage8 };
  }

  async edits(
    actor: AuthIdentity,
    id: string,
    after: number,
    limit: number,
  ): Promise<MessageEditsResponseDto> {
    await this.limits.check(actor.userId, 'get');

    return this.transaction(async (tx): Promise<MessageEditsResponseDto> => {
      const dialog = await this.readable(tx, actor, id);
      const { lastEditSequence: dialogLastEditSequence9 } = dialog;

      const upper = dialogLastEditSequence9;

      if (after > upper) {
        throw this.error.validation({
          fields: [{ field: 'after_edit_sequence', code: 'INVALID' }],
        });
      }

      const rows = await tx
        .select()
        .from(dialogMessages)
        .where(
          and(
            eq(dialogMessages.dialogId, id),
            gt(dialogMessages.editSequence, after),
            lte(dialogMessages.editSequence, upper),
          ),
        )
        .orderBy(asc(dialogMessages.editSequence))
        .limit(limit + 1);
      const { slice: rowsSlice10, length: rowsLength11 } = rows;

      const messages: MessageDto[] = [];

      for (const row of rowsSlice10.bind(rows)(0, limit)) {
        const dto = this.message(row, dialog);

        if (
          Buffer.byteLength(
            JSON.stringify({
              messages: [...messages, dto],
              next_edit_sequence: upper,
              has_more: false,
            }),
          ) > 524288
        ) {
          if (!messages.length) {
            throw this.error.internal();
          }

          break;
        }

        messages.push(dto);
      }

      const hasMore = rowsLength11 > messages.length;

      return {
        messages,
        has_more: hasMore,
        next_edit_sequence: hasMore ? messages[messages.length - 1]!.edit_sequence : upper,
      };
    });
  }

  async read(
    actor: AuthIdentity,
    id: string,
    sequence: number,
  ): Promise<{ last_read_sequence: number }> {
    await this.limits.check(actor.userId, 'read');
    const result = await this.transaction(
      async (tx): Promise<{ sequence: number; changed: boolean; users: string[] }> => {
        const initial = await this.own(tx, actor.userId, id);

        const { can_read: accessResultCanRead2 } = await this.access(
          tx,
          actor,
          this.peer(initial, actor.userId),
          true,
        );

        if (!accessResultCanRead2) {
          this.denied();
        }

        const row = await this.own(tx, actor.userId, id, true);

        const { lastSequence: rowLastSequence } = row;

        if (sequence > rowLastSequence) {
          throw this.error.validation({ fields: [{ field: 'sequence', code: 'INVALID' }] });
        }

        const { participantLowId: rowParticipantLowId } = row;
        const low = rowParticipantLowId === actor.userId;
        const { lowRead: rowLowRead, highRead: rowHighRead } = row;
        const previous = low ? rowLowRead : rowHighRead;
        const maximum = Math.max(sequence, previous);

        if (maximum > previous) {
          await tx
            .update(dialogs)
            .set(low ? { lowRead: maximum } : { highRead: maximum })
            .where(eq(dialogs.id, id));
        }

        const { participantLowId: rowParticipantLowId2, participantHighId: rowParticipantHighId } =
          row;

        return {
          sequence: maximum,
          changed: maximum > previous,
          users: [rowParticipantLowId2, rowParticipantHighId],
        };
      },
    );

    const { changed: resultChanged } = result;

    if (resultChanged) {
      const { users: resultUsers2, sequence: resultSequence } = result;

      this.events.publish({
        users: resultUsers2,
        event: {
          type: 'dialog.read_updated',
          payload: { dialog_id: id, reader_id: actor.userId, last_read_sequence: resultSequence },
        },
      });
    }

    const { sequence: resultSequence2 } = result;

    return { last_read_sequence: resultSequence2 };
  }

  /** Reauthorize each notification destination; no Redis bucket is consumed for delivery. */
  async canDeliver(
    userId: string,
    sessionId: string,
    deviceId: string,
    id: string,
  ): Promise<boolean> {
    try {
      return await this.transaction(async (tx): Promise<boolean> => {
        const row = await this.own(tx, userId, id);
        const { deviceId: rightsDeviceId, can_read: rightsCanRead2 } = await this.access(
          tx,
          { userId, sessionId },
          this.peer(row, userId),
          true,
        );

        return rightsDeviceId === deviceId && rightsCanRead2;
      });
    } catch {
      return false;
    }
  }
}

import { z } from 'zod';

import { nativePlugin } from '../native/bridge';
import { nativeRuntime } from '../native/runtime';
import type { DialogSummary } from './model';
import type { DialogMessage } from './model';
import {
  dialogSchema,
  messageSchema,
  recordSchema,
  type Scope,
  StorageError,
  type StoredDialog,
} from './model';
import { type DialogStorage, IndexedDialogStorage, purgeAccount } from './storage';

const contextSchema = z.strictObject({
  cycleId: z.string().uuid(),
  accountId: z.string().uuid(),
  sessionId: z.string().uuid(),
  deviceId: z.string().uuid(),
  namespaceId: z.string(),
  epoch: z.number().int().nonnegative(),
  adapterEpoch: z.number().int().nonnegative(),
  schemaVersion: z.union([z.literal(1), z.literal(2)]),
  adapter: z.enum(['sqlite', 'indexeddb']),
  purgePending: z.boolean(),
  pendingWebPurges: z.array(z.string().uuid()),
});

type NativeContext = z.infer<typeof contextSchema>;
const nativeErrors = z.object({ code: z.string() });

class NativeDialogStorage implements DialogStorage {
  readonly scope: Scope;
  readonly epoch: number;
  private fallback: IndexedDialogStorage | null = null;
  private switching: Promise<void> | null = null;
  warning?: string;
  private closed = false;
  private known = new Map<string, StoredDialog>();

  constructor(private context: NativeContext) {
    this.epoch = context.epoch;

    if (context.purgePending) {
      this.warning = 'Очистка прежнего локального кеша ещё не завершена.';
    }

    this.scope = {
      serverOrigin: location.origin,
      accountId: context.accountId,
      sessionId: context.sessionId,
      deviceId: context.deviceId,
    };
  }

  get adapter(): 'sqlite' | 'indexeddb' {
    return this.fallback ? 'indexeddb' : 'sqlite';
  }

  private check(): void {
    if (
      this.closed ||
      nativeRuntime.getSnapshot().cycleId !== this.context.cycleId ||
      nativeRuntime.getSignal().aborted
    ) {
      throw new StorageError('STORAGE_STALE_CONTEXT');
    }
  }

  private async command(command: string, args: unknown): Promise<unknown> {
    this.check();

    const operationId = crypto.randomUUID();

    try {
      const value = await nativePlugin.dialogStorage({
        version: this.context.schemaVersion,
        cycleId: this.context.cycleId,
        operationId,
        namespaceId: this.context.namespaceId,
        epoch: this.context.epoch,
        adapterEpoch: this.context.adapterEpoch,
        command,
        args,
      });

      this.check();
      const response = z
        .strictObject({
          version: z.literal(this.context.schemaVersion),
          cycleId: z.literal(this.context.cycleId),
          operationId: z.literal(operationId),
          data: z.unknown(),
        })
        .parse(value);

      return response.data;
    } catch (cause) {
      if (cause instanceof z.ZodError) {
        throw new StorageError('STORAGE_INVALID_ARGUMENT');
      }

      const parsed = nativeErrors.safeParse(cause);

      throw new StorageError(
        parsed.success && parsed.data.code.startsWith('STORAGE_')
          ? parsed.data.code
          : 'STORAGE_UNAVAILABLE',
      );
    }
  }

  private async use<T>(operation: () => Promise<T>, fallback: () => Promise<T>): Promise<T> {
    this.check();

    if (this.switching) {
      await this.switching;
    }

    if (this.fallback) {
      return fallback();
    }

    try {
      return await operation();
    } catch (error) {
      if (!(
        error instanceof StorageError &&
        ['STORAGE_UNAVAILABLE', 'STORAGE_FULL'].includes(error.code)
      )) {
        throw error;
      }

      if (!this.switching) {
        this.switching = (async () => {
          try {
            return await this.switchToIndexedDb();
          } finally {
            this.switching = null;
          }
        })();
      }

      await this.switching;

      return fallback();
    }
  }

  async switchToIndexedDb(): Promise<void> {
    const transition = z
      .object({ adapterEpoch: z.number().int(), migrationHandle: z.string().nullable() })
      .parse(await this.command('beginFallback', {}));

    this.context.adapterEpoch = transition.adapterEpoch;
    const staging = await IndexedDialogStorage.open(this.scope, this.epoch);
    const { close: stagingClose1 } = staging;

    try {
      if (!transition.migrationHandle) {
        throw new StorageError('STORAGE_UNAVAILABLE');
      }

      if (transition.migrationHandle) {
        let cursor: string | null = null;

        do {
          const page = z
            .object({
              entries: z.array(
                z.object({
                  id: z.string().uuid(),
                  record: recordSchema,
                  messages: z.array(messageSchema),
                }),
              ),
              nextCursor: z.string().nullable(),
              has_more: z.boolean(),
            })
            .parse(
              await this.command('exportFallbackPage', {
                migrationHandle: transition.migrationHandle,
                cursor,
                limit: 30,
              }),
            );

          for (const entry of page.entries) {
            const { change: stagingChange } = staging;

            await stagingChange.bind(staging)(entry.id, 'commitPage', (value): void => {
              value.record = entry.record;
              value.messages = [
                ...value.messages,
                ...entry.messages.filter(
                  (message): boolean =>
                    !value.messages.some((old): boolean => old.message_id === message.message_id),
                ),
              ];
            });
          }

          cursor = page.nextCursor;

          if (!page.has_more) {
            break;
          }

          if (!cursor) {
            throw new StorageError('STORAGE_UNAVAILABLE');
          }
        } while (!this.closed);
      }
    } catch (cause) {
      stagingClose1.bind(staging)();

      throw cause;
    }

    const { list: stagingList2 } = staging;

    for (const dialog of await stagingList2.bind(staging)()) {
      const { change: stagingChange4 } = staging;

      await stagingChange4.bind(staging)(dialog.dialog_id, 'markAttempt', ({ record }): void => {
        for (const pending of record.outbox) {
          if (pending.state === 'sending') {
            pending.state = 'unknown';
          }
        }
      });
    }

    try {
      await this.command('selectIndexedDb', {});
      this.check();
      this.fallback = staging;
      this.warning = 'Переписка хранится в WebView.';
    } catch (error) {
      const { close: stagingClose } = staging;

      stagingClose.bind(staging)();

      throw error;
    }
  }

  async read(id: string): Promise<StoredDialog> {
    return this.use(
      async (): Promise<StoredDialog> => {
        const record = recordSchema.parse(await this.command('readDialog', { id }));
        const messages: DialogMessage[] = [];
        let after = 0;

        while (true) {
          const page = z
            .object({ messages: z.array(messageSchema), has_more: z.boolean() })
            .parse(await this.command('readMessages', { id, after, limit: 100 }));

          messages.push(...page.messages);

          if (!page.has_more) {
            break;
          }

          const next = page.messages.at(-1)?.sequence;

          if (!next || next <= after) {
            throw new StorageError('STORAGE_UNAVAILABLE');
          }

          after = next;
        }

        const value = { record, messages };

        this.known.set(id, value);

        return value;
      },
      async (): Promise<StoredDialog> => this.fallback!.read(id),
    );
  }

  async list(): Promise<DialogSummary[]> {
    return this.use(
      async (): Promise<DialogSummary[]> => {
        const dialogs: DialogSummary[] = [];
        let offset = 0;

        while (true) {
          const page = z
            .object({
              dialogs: z.array(dialogSchema),
              has_more: z.boolean(),
              nextOffset: z.number().int().nonnegative(),
            })
            .parse(await this.command('readDialogs', { limit: 100, offset }));

          dialogs.push(...page.dialogs);

          if (!page.has_more) {
            return dialogs;
          }

          if (page.nextOffset <= offset) {
            throw new StorageError('STORAGE_UNAVAILABLE');
          }

          offset = page.nextOffset;
        }
      },
      async (): Promise<DialogSummary[]> => this.fallback!.list(),
    );
  }

  async change(
    id: string,
    command: string,
    update: (value: StoredDialog) => void,
  ): Promise<StoredDialog> {
    return this.use(
      async (): Promise<StoredDialog> => {
        for (let attempt = 0; attempt < 4; attempt++) {
          const value = await this.read(id);
          const { record: valueRecord } = value;
          const expectedRevision = valueRecord.revision;
          const originalRecord = structuredClone(valueRecord);
          const { messages: valueMessages } = value;
          const previous = new Map(
            valueMessages.map((message): [string, string] => [
              message.message_id,
              JSON.stringify(message),
            ]),
          );

          update(value);
          const { record: valueRecord2 } = value;

          valueRecord2.revision++;

          try {
            const { record: valueRecord3, messages: valueMessages2 } = value;

            const patches = valueMessages2.filter(
              (message): boolean => previous.get(message.message_id) !== JSON.stringify(message),
            );
            const fits = (record: typeof valueRecord3, messages: DialogMessage[]): boolean =>
              messages.length <= 100 &&
              new TextEncoder().encode(
                JSON.stringify({
                  version: this.context.schemaVersion,
                  cycleId: this.context.cycleId,
                  operationId: '00000000-0000-4000-8000-000000000000',
                  namespaceId: this.context.namespaceId,
                  epoch: this.context.epoch,
                  adapterEpoch: this.context.adapterEpoch,
                  command,
                  args: { id, expectedRevision: record.revision - 1, record, messages },
                }),
              ).length <= 500000;

            if (fits(valueRecord3, patches)) {
              await this.command(command, {
                id,
                expectedRevision,
                record: valueRecord3,
                messages: patches,
              });
            } else {
              let revision = expectedRevision;
              let batch: DialogMessage[] = [];
              const flush = async (): Promise<void> => {
                if (!batch.length) {
                  return;
                }

                const record = { ...originalRecord, revision: revision + 1 };

                if (!fits(record, batch)) {
                  throw new StorageError('STORAGE_FULL');
                }

                await this.command(command, {
                  id,
                  expectedRevision: revision,
                  record,
                  messages: batch,
                });
                revision++;
                batch = [];
              };

              for (const message of patches) {
                if (!fits({ ...originalRecord, revision: revision + 1 }, [...batch, message])) {
                  await flush();
                }

                batch.push(message);
              }

              await flush();
              valueRecord3.revision = revision + 1;

              if (!fits(valueRecord3, [])) {
                throw new StorageError('STORAGE_FULL');
              }

              await this.command(command, {
                id,
                expectedRevision: revision,
                record: valueRecord3,
                messages: [],
              });
            }

            this.known.set(id, value);

            return value;
          } catch (error) {
            if (!(error instanceof StorageError && error.code === 'STORAGE_CONFLICT')) {
              throw error;
            }
          }
        }

        throw new StorageError('STORAGE_CONFLICT');
      },
      async (): Promise<StoredDialog> => this.fallback!.change(id, command, update),
    );
  }

  close(): void {
    this.closed = true;
    this.fallback?.close();
    this.known.clear();
  }

  async purge(): Promise<void> {
    await this.command('purge', {});
    await this.fallback?.purge();
    this.close();
  }
}

export async function openNativeDialogs(): Promise<DialogStorage> {
  const state = nativeRuntime.getSnapshot();

  if (!state.dialogStorageVersion) {
    throw new StorageError('STORAGE_VERSION_UNSUPPORTED');
  }

  const context = contextSchema.parse(
    await nativePlugin.getDialogStorageContext({ cycleId: state.cycleId }),
  );

  if (context.cycleId !== nativeRuntime.getSnapshot().cycleId) {
    throw new StorageError('STORAGE_STALE_CONTEXT');
  }

  const scope = {
    serverOrigin: location.origin,
    accountId: context.accountId,
    sessionId: context.sessionId,
    deviceId: context.deviceId,
  };

  let purgePending = context.purgePending;

  if (context.purgePending) {
    for (const accountId of context.pendingWebPurges) {
      await purgeAccount({ serverOrigin: location.origin, accountId });
    }

    const cleaned = await IndexedDialogStorage.open(scope, context.epoch);

    const { close: cleanedClose } = cleaned;

    cleanedClose.bind(cleaned)();
    const response = z.object({ data: z.object({ purgePending: z.boolean() }) }).parse(
      await nativePlugin.dialogStorage({
        version: context.schemaVersion,
        cycleId: context.cycleId,
        operationId: crypto.randomUUID(),
        namespaceId: context.namespaceId,
        epoch: context.epoch,
        adapterEpoch: context.adapterEpoch,
        command: 'completeIndexedDbPurge',
        args: { accounts: context.pendingWebPurges },
      }),
    );

    purgePending = response.data.purgePending;
  }

  if (context.adapter === 'indexeddb') {
    const storage = await IndexedDialogStorage.open(scope, context.epoch);

    if (purgePending) {
      Object.assign(storage, { warning: 'Очистка прежнего локального кеша ещё не завершена.' });
    }

    return storage;
  }

  const storage = new NativeDialogStorage({ ...context, purgePending });

  if (context.schemaVersion === 1) {
    await storage.switchToIndexedDb();
  }

  return storage;
}

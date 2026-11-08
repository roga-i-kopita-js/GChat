import type { DialogDto } from '@gchat/backend-api';

import type { DialogMessage } from './model';
import {
  type DialogRecord,
  emptyRecord,
  messageSchema,
  recordSchema,
  type Scope,
  StorageError,
  type StoredDialog,
} from './model';

export interface DialogStorage {
  warning?: string;
  scope: Scope;
  epoch: number;
  adapter: 'indexeddb' | 'sqlite';
  read(id: string): Promise<StoredDialog>;
  list(): Promise<DialogDto[]>;
  change(id: string, command: string, update: (value: StoredDialog) => void): Promise<StoredDialog>;
  close(): void;
  purge(): Promise<void>;
}

interface Row {
  key: string;
  namespace: string;
  account: string;
  dialogId: string;
  epoch: number;
  record: DialogRecord;
}
interface HistoryRow {
  key: string;
  namespace: string;
  account: string;
  dialogId: string;
  epoch: number;
  message: DialogMessage;
}
interface Control {
  key: string;
  epoch: number;
  sessionId: string;
  nextReadAt?: number;
}
const databaseName = 'gchat-dialogs-v1';

function result<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject): void => {
    request.onsuccess = (): void => resolve(request.result);
    request.onerror = (): void =>
      reject(
        new StorageError(
          request.error?.name === 'VersionError'
            ? 'STORAGE_VERSION_UNSUPPORTED'
            : 'STORAGE_UNAVAILABLE',
        ),
      );
  });
}
function completed(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject): void => {
    tx.oncomplete = (): void => resolve();
    tx.onabort = tx.onerror = (): void =>
      reject(
        new StorageError(
          tx.error?.name === 'QuotaExceededError' ? 'STORAGE_FULL' : 'STORAGE_UNAVAILABLE',
        ),
      );
  });
}
async function database(): Promise<IDBDatabase> {
  const request = indexedDB.open(databaseName, 1);

  request.onupgradeneeded = (): void => {
    const db = request.result;

    db.createObjectStore('control', { keyPath: 'key' });

    for (const name of ['records', 'messages']) {
      const store = db.createObjectStore(name, { keyPath: 'key' });

      store.createIndex('namespace', 'namespace');
      store.createIndex('account', 'account');

      if (name === 'messages') {
        store.createIndex('dialog', ['namespace', 'dialogId']);
      }
    }
  };
  request.onblocked = (): void => {
    request.transaction?.abort();
  };
  const db = await result(request);

  db.onversionchange = (): void => db.close();

  return db;
}
function accountKey(scope: Pick<Scope, 'serverOrigin' | 'accountId'>): string {
  return JSON.stringify([scope.serverOrigin, scope.accountId]);
}

export async function purgeAccount(
  scope: Pick<Scope, 'serverOrigin' | 'accountId'>,
): Promise<void> {
  const db = await database();

  try {
    await navigator.locks.request(
      'gchat-dialog-account:' + accountKey(scope),
      async (): Promise<void> => {
        const tx = db.transaction(['control', 'records', 'messages'], 'readwrite');
        const done = completed(tx);
        const key = accountKey(scope);
        const control: Control | undefined = await result(tx.objectStore('control').get(key));

        tx.objectStore('control').put({ key, epoch: (control?.epoch ?? 0) + 1, sessionId: '' });

        for (const name of ['records', 'messages']) {
          const store = tx.objectStore(name);
          const keys = await result(store.index('account').getAllKeys(key));

          for (const id of keys) {
            store.delete(id);
          }
        }

        await done;
      },
    );
  } finally {
    db.close();
  }
}

export class IndexedDialogStorage implements DialogStorage {
  readonly adapter = 'indexeddb';
  warning?: string;
  private closed = false;

  private constructor(
    readonly scope: Scope,
    readonly epoch: number,
    private db: IDBDatabase,
  ) {}

  private get namespace(): string {
    return JSON.stringify([
      this.scope.serverOrigin,
      this.scope.accountId,
      this.scope.deviceId,
      this.epoch,
    ]);
  }

  static async open(scope: Scope, forcedEpoch?: number): Promise<IndexedDialogStorage> {
    const db = await database();

    try {
      return await navigator.locks.request(
        'gchat-dialog-account:' + accountKey(scope),
        async (): Promise<IndexedDialogStorage> => {
          const tx = db.transaction(['control', 'records', 'messages'], 'readwrite');
          const done = completed(tx);
          const key = accountKey(scope);
          let control: Control | undefined = await result(tx.objectStore('control').get(key));

          // A new authenticated session cannot reopen cache left behind by a revoked one.
          if (
            !control ||
            control.sessionId !== scope.sessionId ||
            (forcedEpoch !== undefined && forcedEpoch !== control.epoch)
          ) {
            for (const name of ['records', 'messages']) {
              const store = tx.objectStore(name);

              for (const id of await result(store.index('account').getAllKeys(key))) {
                store.delete(id);
              }
            }

            control = {
              key,
              epoch: forcedEpoch ?? (control?.epoch ?? 0) + 1,
              sessionId: scope.sessionId,
            };
            tx.objectStore('control').put(control);
          }

          await done;

          return new IndexedDialogStorage(scope, control.epoch, db);
        },
      );
    } catch (error) {
      db.close();

      throw error;
    }
  }

  private async check(tx: IDBTransaction): Promise<void> {
    if (this.closed) {
      throw new StorageError('STORAGE_STALE_CONTEXT');
    }

    const control: Control | undefined = await result(
      tx.objectStore('control').get(accountKey(this.scope)),
    );

    if (control?.epoch !== this.epoch || control.sessionId !== this.scope.sessionId) {
      throw new StorageError('STORAGE_STALE_CONTEXT');
    }
  }

  private async load(tx: IDBTransaction, id: string): Promise<StoredDialog> {
    const row: Row | undefined = await result(
      tx.objectStore('records').get(this.namespace + ':' + id),
    );
    const history: HistoryRow[] = await result(
      tx.objectStore('messages').index('dialog').getAll([this.namespace, id]),
    );

    return {
      record: row ? recordSchema.parse(row.record) : emptyRecord(),
      messages: history
        .map((entry): DialogMessage => messageSchema.parse(entry.message))
        .sort((a, b): number => a.sequence - b.sequence),
    };
  }

  async read(id: string): Promise<StoredDialog> {
    const tx = this.db.transaction(['control', 'records', 'messages']);
    const done = completed(tx);

    await this.check(tx);
    const value = await this.load(tx, id);

    await done;

    return value;
  }

  async list(): Promise<DialogDto[]> {
    const tx = this.db.transaction(['control', 'records']);
    const done = completed(tx);

    await this.check(tx);
    const rows: Row[] = await result(
      tx.objectStore('records').index('namespace').getAll(this.namespace),
    );

    await done;

    return rows.flatMap((row): DialogDto[] => {
      const record = recordSchema.parse(row.record);

      return record.dialog ? [record.dialog] : [];
    });
  }

  async change(
    id: string,
    _command: string,
    update: (value: StoredDialog) => void,
  ): Promise<StoredDialog> {
    return navigator.locks.request(
      'gchat-dialog-storage:' + this.namespace,
      async (): Promise<StoredDialog> => {
        if (this.closed) {
          throw new StorageError('STORAGE_STALE_CONTEXT');
        }

        const tx = this.db.transaction(['control', 'records', 'messages'], 'readwrite');
        const done = completed(tx);

        try {
          await this.check(tx);
          const value = await this.load(tx, id);

          update(value);
          value.record.revision++;
          recordSchema.parse(value.record);
          const common = {
            namespace: this.namespace,
            account: accountKey(this.scope),
            dialogId: id,
            epoch: this.epoch,
          };

          tx.objectStore('records').put({
            ...common,
            key: this.namespace + ':' + id,
            record: value.record,
          });

          for (const message of value.messages) {
            tx.objectStore('messages').put({
              ...common,
              key: this.namespace + ':' + message.message_id,
              message,
            });
          }

          await done;

          return value;
        } catch (error) {
          tx.abort();
          await done.catch((): void => {});

          throw error;
        }
      },
    );
  }

  close(): void {
    this.closed = true;
    this.db.close();
  }

  async purge(): Promise<void> {
    this.close();
    await purgeAccount(this.scope);
  }
}

/** Shared read pacing contains no content and is scoped to the current authorized generation. */
export async function readDeadline(storage: DialogStorage, next?: number): Promise<number> {
  const db = await database();

  try {
    const tx = db.transaction('control', next === undefined ? 'readonly' : 'readwrite');
    const done = completed(tx);
    const key = accountKey(storage.scope);
    const control: Control | undefined = await result(tx.objectStore('control').get(key));

    if (
      !control ||
      control.epoch !== storage.epoch ||
      control.sessionId !== storage.scope.sessionId
    ) {
      throw new StorageError('STORAGE_STALE_CONTEXT');
    }

    if (next !== undefined) {
      tx.objectStore('control').put({ ...control, nextReadAt: next });
    }

    await done;

    return next ?? control.nextReadAt ?? 0;
  } finally {
    db.close();
  }
}

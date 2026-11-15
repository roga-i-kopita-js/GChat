import { expect, test } from '@playwright/test';

for (const schemaVersion of [1, 2, 3]) {
  test(
    'dialog cache v' + schemaVersion + ' upgrades with drafts, pending sends and history intact',
    async ({ page }) => {
      await page.goto('/tests/device-harness.html');
      const result = await page.evaluate(async (schemaVersion) => {
        const modelPath = '/src/shared/dialogs/model.ts';
        const storagePath = '/src/shared/dialogs/storage.ts';
        const { emptyRecord } = await import(modelPath);
        const { IndexedDialogStorage } = await import(storagePath);
        const uuid = (n: number): string =>
          '00000000-0000-4000-8000-' + n.toString().padStart(12, '0');
        const scope = {
          serverOrigin: location.origin,
          accountId: uuid(1),
          deviceId: uuid(2),
          sessionId: uuid(3),
        };
        const account = JSON.stringify([scope.serverOrigin, scope.accountId]);
        const namespace = JSON.stringify([scope.serverOrigin, scope.accountId, scope.deviceId, 1]);
        const id = uuid(4);
        const message = {
          message_id: uuid(5),
          dialog_id: id,
          sender_id: uuid(1),
          client_message_id: uuid(6),
          sequence: 1,
          created_at: '2026-11-14T00:00:00Z',
          content: { kind: 'text', text: 'saved history' },
          status: 'sent',
          version: 1,
          edited_at: null,
          edit_sequence: 0,
          last_edit_id: null,
          actions_verified: true,
        };
        const record = {
          ...emptyRecord(),
          draft: { text: 'keep draft', revision: 7 },
          initialized: true,
          sync_sequence: 1,
          ranges: [[1, 1]],
          outbox: [
            {
              client_message_id: uuid(7),
              content: { kind: 'text', text: 'pending' },
              created_at: '2026-11-14T00:00:00Z',
              state: 'unknown',
              error: null,
            },
          ],
        };

        Reflect.deleteProperty(record, 'reaction_sync_sequence');
        const db = await new Promise<IDBDatabase>((resolve, reject) => {
          const request = indexedDB.open('gchat-dialogs-v1', schemaVersion);

          request.onupgradeneeded = () => {
            request.result.createObjectStore('control', { keyPath: 'key' });

            for (const name of ['records', 'messages']) {
              const store = request.result.createObjectStore(name, { keyPath: 'key' });

              store.createIndex('namespace', 'namespace');
              store.createIndex('account', 'account');

              if (name === 'messages') {
                store.createIndex('dialog', ['namespace', 'dialogId']);
              }
            }
          };
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        const { transaction: dbTransaction141 } = db;

        const { close: dbClose142 } = db;

        const tx = dbTransaction141.bind(db)(['control', 'records', 'messages'], 'readwrite');
        const done = new Promise<void>((resolve, reject) => {
          tx.oncomplete = () => resolve();
          tx.onabort = () => reject(tx.error);
        });
        const common = { namespace, account, dialogId: id, epoch: 1 };

        tx.objectStore('control').put({ key: account, epoch: 1, sessionId: scope.sessionId });
        tx.objectStore('records').put({ ...common, key: namespace + ':' + id, record });
        tx.objectStore('messages').put({
          ...common,
          key: namespace + ':' + message.message_id,
          message,
        });
        await done;
        dbClose142.bind(db)();
        const storage = await IndexedDialogStorage.open(scope);
        const { read: storageRead143 } = storage;

        const { close: storageClose144 } = storage;

        const saved = await storageRead143.bind(storage)(id);

        storageClose144.bind(storage)();

        return saved;
      }, schemaVersion);
      const { record: resultRecord145 } = result;

      const { record: resultRecord146 } = result;

      const { record: resultRecord147 } = result;

      const { record: resultRecord148 } = result;

      const { messages: resultMessages149 } = result;

      expect(resultRecord145.draft).toEqual({ text: 'keep draft', revision: 7, reply_to: null });
      expect(resultRecord146.outbox[0]).toMatchObject({
        operation: 'send',
        content: { text: 'pending' },
        state: 'unknown',
      });
      expect(resultRecord147.reaction_sync_sequence).toBe(0);
      expect(resultRecord148.ranges).toEqual([[1, 1]]);
      expect(resultMessages149[0]).toMatchObject({
        content: { text: 'saved history' },
        actions_verified: false,
        forward: null,
        reply: null,
        reaction_version: 0,
        reactions: [],
      });
    },
  );
}

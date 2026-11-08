import { ApiError, type ApiResult, type BackendApi, type DialogDto } from '@gchat/backend-api';
import { z } from 'zod';

import { retryAfter } from '../api/client';
import { prepareUpdate, updateChannel, updateLock, updateRequested } from '../pwa-update';
import { DialogModels } from './live-models';
import type { DialogMessage } from './model';
import {
  commitPage,
  dialogSchema,
  eventSchema,
  mergeMessages,
  mergeMetadata,
  type MessageInput,
  messageSchema,
  type PendingMessage,
  type Scope,
  StorageError,
  type StoredDialog,
} from './model';
import { type DialogStorage, readDeadline } from './storage';

export interface DialogSnapshot {
  revision: number;
  status: 'starting' | 'ready' | 'error' | 'stopped';
  error: string | null;
  storageWarning: string | null;
}

export interface DialogView extends StoredDialog {
  error: string | null;
  syncing: boolean;
}

type Request = <T>(operation: (api: BackendApi) => Promise<ApiResult<T>>) => Promise<T>;
interface Selection {
  id: string;
  atBottom: boolean;
  openRead: boolean;
  shown: number;
}

export function dialogError(error: unknown): string {
  if (error instanceof StorageError) {
    if (error.code === 'STORAGE_CONFLICT') {
      return 'Данные изменились в другой вкладке. Обновите и повторите.';
    }

    if (error.code === 'STORAGE_VERSION_UNSUPPORTED') {
      return 'Обновите приложение для доступа к переписке.';
    }

    return 'Не удалось сохранить переписку на устройстве. Повторите попытку.';
  }

  if (error instanceof ApiError) {
    if (error.code === 'DIALOG_NOT_ALLOWED') {
      return 'Действие недоступно по текущим правам.';
    }

    if (error.code === 'NOT_FOUND') {
      return 'Диалог недоступен.';
    }

    if (error.status === 429) {
      return 'Слишком много запросов. Повторите после паузы.';
    }

    if (error.code === 'VALIDATION_ERROR') {
      return 'Проверьте сообщение: до 4000 символов.';
    }
  }

  return 'Не удалось обновить переписку. Проверьте соединение и повторите.';
}

export function wait(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();

  return new Promise((resolve, reject): void => {
    const abort = (): void => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    const timer = setTimeout(
      (): void => {
        signal.removeEventListener('abort', abort);
        resolve();
      },
      Math.max(0, ms),
    );

    signal.addEventListener('abort', abort, { once: true });
  });
}

/** One session cycle, independent of route mounting. No socket or refresh-token ownership. */
export class DialogRuntime {
  private readonly models = new DialogModels(this);

  listModel(): DialogModels['list'] {
    return this.models.list;
  }

  conversationModel(id: string): ReturnType<DialogModels['conversation']> {
    return this.models.conversation(id);
  }

  private state: DialogSnapshot = {
    revision: 0,
    status: 'starting',
    error: null,
    storageWarning: null,
  };
  private listeners = new Set<() => void>();
  private controller = new AbortController();
  private networkController = new AbortController();
  private selected: Selection | null = null;
  private visibleSection = false;
  private channel?: BroadcastChannel;
  private busy = new Set<string>();
  private dirty = new Set<string>();
  private errors = new Map<string, string>();
  private metadataVersions = new Map<string, number>();
  private opening = new Map<string, Promise<string>>();
  private updating = false;
  private draftFlushers = new Map<() => Promise<void>, { held: boolean; release?: () => void }>();
  private listTask?: Promise<void>;
  private tasks = new Set<Promise<unknown>>();
  private nextGet = 0;
  private activeGets = 0;
  private getFinished = new Set<() => void>();
  private getQueue: Promise<void> = Promise.resolve();
  private nextRead = 0;
  private reading = false;
  private sendUntil = 0;
  private createUntil = 0;
  private getUntil = 0;
  private timer?: ReturnType<typeof setInterval>;
  private updateMonitor?: ReturnType<typeof setInterval>;
  private updates?: BroadcastChannel;
  private retries = new Map<string, ReturnType<typeof setTimeout>>();
  private retryCounts = new Map<string, number>();
  private stops: (() => void)[] = [];
  readonly positions = new Map<string, { index: number; offset: number; messageId?: string }>();
  listScroll = 0;

  constructor(
    readonly scope: Scope,
    readonly storage: DialogStorage,
    private readonly request: Request,
  ) {}

  private get networkSignal(): AbortSignal {
    return AbortSignal.any([this.controller.signal, this.networkController.signal]);
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  getSnapshot = (): DialogSnapshot => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);

    return (): void => {
      this.listeners.delete(listener);
    };
  };

  private changed(error?: string | null): void {
    if (this.signal.aborted) {
      return;
    }

    this.state = {
      ...this.state,
      revision: this.state.revision + 1,
      storageWarning: this.storage.warning ?? null,
      ...(error !== undefined ? { error } : {}),
    };

    for (const listener of this.listeners) {
      listener();
    }
  }

  isUpdating(): boolean {
    return this.updating;
  }

  protectDraft(flush: () => Promise<void>): () => void {
    const lease: { held: boolean; release?: () => void } = { held: false };

    this.draftFlushers.set(flush, lease);
    this.acquireDraftLease(flush, lease);

    return (): void => {
      this.draftFlushers.delete(flush);
      lease.release?.();
    };
  }

  private acquireDraftLease(
    flush: () => Promise<void>,
    lease: { held: boolean; release?: () => void },
  ): void {
    void navigator.locks
      .request(updateLock, { mode: 'shared', signal: this.signal }, async (): Promise<void> => {
        if (!this.draftFlushers.has(flush)) {
          return;
        }

        lease.held = true;
        await new Promise<void>((resolve): void => {
          lease.release = resolve;
        });
        lease.held = false;
      })
      .catch((): void => {});
  }

  private prepareUpdate = (): void => {
    this.updating = true;
    this.networkController.abort();
    this.changed();

    for (const [flush, lease] of this.draftFlushers) {
      if (!lease.held) {
        continue;
      }

      void flush()
        .then((): void => {
          lease.release?.();
        })
        .catch((): void => {
          this.changed('Не удалось сохранить черновик перед обновлением. Повторите сохранение.');
        });
    }
  };

  private active(): boolean {
    return document.visibilityState === 'visible' && document.hasFocus();
  }

  private publish(id?: string): void {
    this.models.committed(id);
    this.changed();
    this.channel?.postMessage({
      type: 'changed',
      scope: this.scope,
      epoch: this.storage.epoch,
      id,
    });
  }

  private async tracked<T>(operation: () => Promise<T>): Promise<T> {
    const task = navigator.locks.request(
      updateLock,
      { mode: 'shared', signal: this.signal },
      async (): Promise<T> => {
        this.signal.throwIfAborted();

        if (this.updating) {
          throw new DOMException('Updating', 'AbortError');
        }

        return operation();
      },
    );

    this.tasks.add(task);
    void task
      .finally((): void => {
        this.tasks.delete(task);
      })
      .catch((): void => {});

    return task;
  }

  start(subscribe: (listener: (type: string, payload: unknown) => void) => () => void): void {
    this.channel = new BroadcastChannel('gchat-dialog-events');
    this.channel.onmessage = (event: MessageEvent<unknown>): void => {
      const envelope = z
        .object({
          type: z.string(),
          scope: z.object({
            serverOrigin: z.string(),
            accountId: z.string(),
            sessionId: z.string(),
            deviceId: z.string(),
          }),
          epoch: z.number(),
          id: z.string().optional(),
          until: z.number().optional(),
          group: z.string().optional(),
          event: z.unknown().optional(),
        })
        .safeParse(event.data);

      if (!envelope.success) {
        return;
      }

      const message = envelope.data;
      const scope = message.scope;

      if (
        scope.serverOrigin !== this.scope.serverOrigin ||
        scope.accountId !== this.scope.accountId ||
        scope.sessionId !== this.scope.sessionId ||
        scope.deviceId !== this.scope.deviceId ||
        message.epoch !== this.storage.epoch
      ) {
        return;
      }

      if (message.type === 'event') {
        this.event(message.event);
      } else if (message.type === 'cooldown' && message.until) {
        if (message.group === 'get') {
          this.getUntil = Math.max(this.getUntil, message.until);
        }

        if (message.group === 'read') {
          this.nextRead = Math.max(this.nextRead, message.until);
        }
      } else {
        this.models.committed(message.id);
        this.changed();
      }
    };
    this.stops.push(
      subscribe((type, payload): void => {
        const event = eventSchema.safeParse({ type, payload });

        if (!event.success) {
          return;
        }

        this.channel?.postMessage({
          type: 'event',
          scope: this.scope,
          epoch: this.storage.epoch,
          event: event.data,
        });
        this.event(event.data);
      }),
    );
    const foreground = (): void => {
      if (document.visibilityState === 'visible') {
        this.refresh();
      }

      if (!this.active() && this.selected) {
        this.selected.openRead = false;
      }

      if (this.active()) {
        void this.flushRead();
      }
    };
    const prepare = this.prepareUpdate;
    const finished = (): void => {
      this.updating = false;
      this.networkController = new AbortController();

      for (const [flush, lease] of this.draftFlushers) {
        if (!lease.held) {
          this.acquireDraftLease(flush, lease);
        }
      }

      this.refresh();
    };

    this.updates = new BroadcastChannel(updateChannel);
    this.updates.onmessage = (event: MessageEvent<unknown>): void => {
      if (event.data === 'prepare') {
        this.prepareUpdate();
      }
    };
    this.updateMonitor = setInterval((): void => {
      if (this.updating) {
        void updateRequested()
          .then((pending): void => {
            if (!pending) {
              finished();
            }
          })
          .catch((): void => {});
      }
    }, 1000);

    document.addEventListener('visibilitychange', foreground);
    window.addEventListener('focus', foreground);
    window.addEventListener('blur', foreground);
    window.addEventListener(prepareUpdate, prepare);
    window.addEventListener('gchat-update-finished', finished);
    this.stops.push((): void => {
      document.removeEventListener('visibilitychange', foreground);
      window.removeEventListener('focus', foreground);
      window.removeEventListener('blur', foreground);
      window.removeEventListener(prepareUpdate, prepare);
      window.removeEventListener('gchat-update-finished', finished);
    });
    this.timer = setInterval((): void => {
      if (this.visibleSection && document.visibilityState === 'visible') {
        this.refresh();
      }
    }, 30000);
    this.state = { ...this.state, status: 'ready', storageWarning: this.storage.warning ?? null };
    this.refresh();
  }

  refresh(): void {
    if (this.signal.aborted || this.updating) {
      return;
    }

    void this.refreshList().catch((): void => {});

    if (this.selected) {
      void this.sync(this.selected.id).catch((): void => {});
    }
  }

  section(visible: boolean): void {
    this.visibleSection = visible;

    if (visible) {
      this.refresh();
    }
  }

  select(id: string | null): void {
    if (this.selected?.id === id) {
      return;
    }

    this.selected = id ? { id, atBottom: true, openRead: true, shown: 0 } : null;

    if (id) {
      void this.sync(id, true).catch((): void => {});
    }
  }

  shown(id: string, sequence: number, atBottom: boolean): void {
    if (this.selected?.id !== id) {
      return;
    }

    this.selected.atBottom = atBottom;
    this.selected.shown = sequence;
    void this.flushRead();
  }

  private event(value: unknown): void {
    const parsed = eventSchema.safeParse(value);

    if (!parsed.success || this.signal.aborted) {
      return;
    }

    const event = parsed.data;
    const id = event.payload.dialog_id;

    this.metadataVersions.set(id, (this.metadataVersions.get(id) ?? 0) + 1);

    if (event.type === 'dialog.read_updated') {
      void this.tracked(async (): Promise<void> => {
        await this.storage.change(id, 'confirmRead', ({ record }): void => {
          if (event.payload.reader_id === this.scope.accountId) {
            record.read = Math.max(record.read, event.payload.last_read_sequence);
          } else if (record.dialog?.peer_id === event.payload.reader_id) {
            record.peer_read = Math.max(record.peer_read, event.payload.last_read_sequence);
          }
        });
        this.publish(id);
      }).catch((): void => {});
    }

    if (this.selected?.id === id) {
      void this.sync(id).catch((): void => {});
    } else {
      void this.metadata(id).catch((): void => {});
    }

    void this.refreshList().catch((): void => {});
  }

  private async get<T>(operation: (api: BackendApi) => Promise<ApiResult<T>>): Promise<T> {
    const previous = this.getQueue;
    let release!: () => void;

    this.getQueue = new Promise<void>((resolve): void => {
      release = resolve;
    });
    await previous;

    try {
      while (this.activeGets >= 2) {
        await new Promise<void>((resolve): void => {
          this.getFinished.add(resolve);
        });
      }

      await wait(Math.max(this.nextGet, this.getUntil) - Date.now(), this.networkSignal);
      this.activeGets++;
      this.nextGet = Date.now() + 250;
    } finally {
      release();
    }

    this.signal.throwIfAborted();

    try {
      return await this.request(operation);
    } catch (error) {
      if (error instanceof ApiError && error.status === 429) {
        this.getUntil = Date.now() + Math.max(1, retryAfter(error)) * 1000;
        this.channel?.postMessage({
          type: 'cooldown',
          scope: this.scope,
          epoch: this.storage.epoch,
          group: 'get',
          until: this.getUntil,
        });
      }

      throw error;
    } finally {
      this.activeGets--;

      for (const finished of this.getFinished) {
        finished();
      }

      this.getFinished.clear();
    }
  }

  async list(): Promise<DialogDto[]> {
    const list = await this.storage.list();

    this.signal.throwIfAborted();

    return list.sort(
      (a, b): number =>
        (b.last_message_at ?? b.created_at).localeCompare(a.last_message_at ?? a.created_at) ||
        b.dialog_id.localeCompare(a.dialog_id),
    );
  }

  async view(id: string): Promise<DialogView> {
    const value = await this.storage.read(id);

    this.signal.throwIfAborted();

    return { ...value, syncing: this.busy.has(id), error: this.errors.get(id) ?? null };
  }

  private async storeMetadata(dialog: DialogDto, version: number): Promise<void> {
    const value = await this.storage.change(
      dialog.dialog_id,
      'commitMetadata',
      ({ record }): void => {
        const stale =
          record.read > dialog.last_read_sequence ||
          version !== (this.metadataVersions.get(dialog.dialog_id) ?? 0);
        const previous = record.dialog;

        mergeMetadata(record, dialog);

        if (stale && previous && record.dialog) {
          record.dialog.has_unread_messages = previous.has_unread_messages;
        }
      },
    );

    if (value.record.read > dialog.last_read_sequence) {
      this.dirty.add(dialog.dialog_id);
    }
  }

  async refreshList(offset = 0): Promise<void> {
    if (this.listTask) {
      return this.listTask;
    }

    this.listTask = this.tracked(async (): Promise<void> => {
      const versions = new Map(this.metadataVersions);
      const page = await this.get((api): ReturnType<typeof api.dialogsList> =>
        api.dialogsList({ query: { limit: 30, offset }, signal: this.networkSignal }),
      );

      for (const input of page.dialogs) {
        const dialog = dialogSchema.parse(input);

        await this.storeMetadata(dialog, versions.get(dialog.dialog_id) ?? 0);
      }

      this.listHasMore = page.has_more;
      this.listOffset = offset + page.dialogs.length;
      this.changed(null);
      this.publish();
    })
      .catch((error): never => {
        this.changed(dialogError(error));
        this.retry('list', (): void => {
          void this.refreshList().catch((): void => {});
        });

        throw error;
      })
      .finally((): void => {
        this.listTask = undefined;
      });

    return this.listTask;
  }

  listHasMore = false;
  listOffset = 0;

  async metadata(id: string): Promise<void> {
    return this.tracked((): Promise<void> => this.metadataWork(id));
  }

  private async metadataWork(id: string): Promise<void> {
    const version = this.metadataVersions.get(id) ?? 0;
    const result = await this.get((api): ReturnType<typeof api.dialogsGet> =>
      api.dialogsGet({ path: { dialog_id: id }, signal: this.networkSignal }),
    );

    await this.storeMetadata(dialogSchema.parse(result.dialog), version);
    this.publish(id);
  }

  private retry(key: string, callback: () => void): void {
    if (
      this.retries.has(key) ||
      this.signal.aborted ||
      !this.visibleSection ||
      document.visibilityState !== 'visible'
    ) {
      return;
    }

    const attempt = this.retryCounts.get(key) ?? 0;

    this.retryCounts.set(key, attempt + 1);
    this.retries.set(
      key,
      setTimeout(
        (): void => {
          this.retries.delete(key);

          if (
            !this.signal.aborted &&
            this.visibleSection &&
            document.visibilityState === 'visible'
          ) {
            callback();
          }
        },
        [1000, 2000, 5000, 10000][attempt] ?? 30000,
      ),
    );
  }

  async sync(id: string, tail = false): Promise<void> {
    if (this.busy.has(id)) {
      this.dirty.add(id);

      return;
    }

    this.busy.add(id);
    this.models.conversationChanged(id);
    this.changed();

    try {
      await this.tracked(async (): Promise<void> => {
        await this.metadataWork(id);
        const rights = await this.get((api): ReturnType<typeof api.dialogsPermissions> =>
          api.dialogsPermissions({ path: { dialog_id: id }, signal: this.networkSignal }),
        );

        await this.storage.change(id, 'commitMetadata', ({ record }): void => {
          record.permissions = rights.dialogs;
        });

        if (!rights.dialogs.can_read) {
          return;
        }

        await navigator.locks.request(
          'gchat-dialog-sync:' + JSON.stringify(this.scope) + ':' + id,
          { signal: this.signal },
          async (): Promise<void> => {
            let value = await this.storage.read(id);

            if (!value.record.initialized || tail) {
              const page = await this.history(id);

              await this.savePage(id, page, value.record.initialized ? 'tail' : 'initial');
            }

            do {
              this.dirty.delete(id);
              value = await this.storage.read(id);
              const cursor = value.record.sync_sequence;
              const page = await this.history(id, { after_sequence: cursor });

              await this.savePage(id, page, 'after', cursor);

              if (this.updating || (!page.has_more && !this.dirty.has(id))) {
                break;
              }
            } while (!this.signal.aborted);
          },
        );
      });
      this.errors.delete(id);
      this.retryCounts.delete(id);
    } catch (error) {
      if (!this.signal.aborted) {
        this.errors.set(id, dialogError(error));

        if (error instanceof ApiError && error.code === 'DIALOG_NOT_ALLOWED') {
          await this.storage
            .change(id, 'commitMetadata', ({ record }): void => {
              record.permissions = null;
            })
            .catch((): void => {});
        } else if (!(error instanceof ApiError && error.code === 'NOT_FOUND')) {
          this.retry(id, (): void => {
            void this.sync(id).catch((): void => {});
          });
        }
      }
    } finally {
      this.busy.delete(id);
      this.models.conversationChanged(id);
      this.changed();
    }
  }

  private async history(
    id: string,
    query?: { before_sequence?: number; after_sequence?: number },
  ): Promise<{ messages: DialogMessage[]; has_more: boolean }> {
    const page = await this.get((api): ReturnType<typeof api.dialogsHistory> =>
      api.dialogsHistory({
        path: { dialog_id: id },
        query: { limit: 30, ...query },
        signal: this.networkSignal,
      }),
    );

    return {
      messages: page.messages.map((message): DialogMessage => messageSchema.parse(message)),
      has_more: page.has_more,
    };
  }

  private async savePage(
    id: string,
    page: { messages: DialogMessage[]; has_more: boolean },
    direction: 'initial' | 'tail' | 'before' | 'after',
    cursor?: number,
  ): Promise<void> {
    await this.storage.change(id, 'commitPage', (value): void => {
      value.messages = commitPage(
        value.record,
        value.messages,
        page,
        direction,
        cursor,
        this.scope.accountId,
      );
    });
    this.publish(id);
  }

  async older(id: string): Promise<void> {
    return this.tracked(async (): Promise<void> => {
      const value = await this.storage.read(id);

      if (
        !value.record.permissions?.can_read ||
        !value.record.has_older ||
        value.record.before_sequence === null
      ) {
        return;
      }

      const page = await this.history(id, { before_sequence: value.record.before_sequence });

      await this.savePage(id, page, 'before', value.record.before_sequence);
    });
  }

  async openPeer(peer: string): Promise<string> {
    const existing = this.opening.get(peer);

    if (existing) {
      return existing;
    }

    const task = this.tracked(async (): Promise<string> => {
      if (Date.now() < this.createUntil) {
        throw new Error('RATE_LIMITED');
      }

      try {
        const result = await this.request((api): ReturnType<typeof api.dialogsCreate> =>
          api.dialogsCreate({ body: { peer_id: peer }, signal: this.networkSignal }),
        );
        const dialog = dialogSchema.parse(result.dialog);

        await this.storeMetadata(dialog, 0);
        this.publish();

        return dialog.dialog_id;
      } catch (error) {
        this.createUntil = Date.now() + retryAfter(error) * 1000;

        throw error;
      }
    });

    this.opening.set(peer, task);
    void task
      .finally((): void => {
        this.opening.delete(peer);
      })
      .catch((): void => {});

    return task;
  }

  async draft(id: string, text: string, expectedRevision: number): Promise<number> {
    const operation = (): Promise<StoredDialog> =>
      this.storage.change(id, 'saveDraft', ({ record }): void => {
        if (record.draft.revision !== expectedRevision) {
          throw new StorageError('STORAGE_CONFLICT');
        }

        record.draft = { text, revision: expectedRevision + 1 };
      });

    this.signal.throwIfAborted();
    const hasLease = [...this.draftFlushers.values()].some((lease): boolean => lease.held);
    const value = await (hasLease ? operation() : this.tracked(operation));

    this.publish(id);

    return value.record.draft.revision;
  }

  async send(id: string, content: MessageInput, draftRevision?: number): Promise<void> {
    await this.tracked(async (): Promise<void> => {
      const pending: PendingMessage = {
        client_message_id: crypto.randomUUID(),
        content,
        state: 'prepared',
        error: null,
        created_at: new Date().toISOString(),
      };

      await this.storage.change(id, 'prepareSend', ({ record }): void => {
        const prepared = record.outbox.find(
          (item): boolean => item.client_message_id === pending.client_message_id,
        );

        if (prepared) {
          if (JSON.stringify(prepared.content) !== JSON.stringify(pending.content)) {
            throw new StorageError('STORAGE_CONFLICT');
          }

          return;
        }

        if (!record.permissions?.can_send) {
          throw new Error('FORBIDDEN');
        }

        if (content.kind === 'text') {
          if (record.draft.revision !== draftRevision) {
            throw new StorageError('STORAGE_CONFLICT');
          }

          record.draft = { text: '', revision: record.draft.revision + 1 };
        }

        record.outbox.push(pending);
      });
      this.publish(id);
      await this.attempt(id, pending);
    });
  }

  async resend(id: string, clientId: string): Promise<void> {
    await this.tracked(async (): Promise<void> => {
      const { record } = await this.storage.read(id);
      const pending = record.outbox.find((value): boolean => value.client_message_id === clientId);

      if (pending) {
        await this.attempt(id, pending);
      }
    });
  }

  private sending = new Set<string>();

  private async attempt(id: string, pending: PendingMessage): Promise<void> {
    if (this.sending.has(pending.client_message_id)) {
      return;
    }

    this.sending.add(pending.client_message_id);

    try {
      if (Date.now() < this.sendUntil) {
        throw new Error('RATE_LIMITED');
      }

      await this.storage.change(id, 'markAttempt', ({ record }): void => {
        const stored = record.outbox.find(
          (value): boolean => value.client_message_id === pending.client_message_id,
        );

        if (!stored) {
          throw new StorageError('STORAGE_CONFLICT');
        }

        stored.state = 'sending';
        stored.error = null;
      });
      this.publish(id);
      const result = await this.request((api): ReturnType<typeof api.dialogsSendMessage> =>
        api.dialogsSendMessage({
          path: { dialog_id: id },
          body: { client_message_id: pending.client_message_id, content: pending.content },
          signal: this.networkSignal,
        }),
      );
      const message = messageSchema.parse(result.message);

      await this.storage.change(id, 'commitSent', (value): void => {
        value.messages = mergeMessages(value.messages, [message]);
        value.record.outbox = value.record.outbox.filter(
          (item): boolean => item.client_message_id !== message.client_message_id,
        );
      });
      this.publish(id);
      void this.sync(id).catch((): void => {});
    } catch (error) {
      this.sendUntil = Date.now() + retryAfter(error) * 1000;
      await this.storage
        .change(id, 'markAttempt', ({ record }): void => {
          const stored = record.outbox.find(
            (value): boolean => value.client_message_id === pending.client_message_id,
          );

          if (stored) {
            stored.state = error instanceof ApiError && error.status < 500 ? 'rejected' : 'unknown';
            stored.error = dialogError(error);
          }
        })
        .catch((): void => {});
      this.publish(id);

      throw error;
    } finally {
      this.sending.delete(pending.client_message_id);
    }
  }

  private async flushRead(): Promise<void> {
    if (this.reading || !this.selected || !this.active() || this.updating || this.signal.aborted) {
      return;
    }

    const selected = this.selected;

    if (!(selected.atBottom || selected.openRead) || !selected.shown) {
      return;
    }

    this.reading = true;
    let confirmed = 0;

    try {
      await this.tracked(async (): Promise<void> => {
        await navigator.locks.request(
          'gchat-dialog-read:' +
            JSON.stringify([this.scope.serverOrigin, this.scope.accountId, this.scope.deviceId]),
          { signal: this.signal },
          async (): Promise<void> => {
            const deadline =
              this.storage.adapter === 'indexeddb'
                ? await readDeadline(this.storage)
                : this.nextRead;

            await wait(Math.max(this.nextRead, deadline) - Date.now(), this.networkSignal);

            if (
              this.selected !== selected ||
              !this.active() ||
              !(selected.atBottom || selected.openRead)
            ) {
              return;
            }

            const { record } = await this.storage.read(selected.id);

            if (!record.permissions?.can_read || record.read >= selected.shown) {
              selected.openRead = false;

              return;
            }

            const sequence = selected.shown;

            this.nextRead = Date.now() + 250;

            if (this.storage.adapter === 'indexeddb') {
              await readDeadline(this.storage, this.nextRead);
            }

            const result = await this.request((api): ReturnType<typeof api.dialogsRead> =>
              api.dialogsRead({
                path: { dialog_id: selected.id },
                body: { sequence },
                signal: this.networkSignal,
              }),
            );

            await this.storage.change(selected.id, 'confirmRead', ({ record: next }): void => {
              next.read = Math.max(next.read, result.last_read_sequence);
            });
            selected.openRead = false;
            confirmed = result.last_read_sequence;
            this.metadataVersions.set(
              selected.id,
              (this.metadataVersions.get(selected.id) ?? 0) + 1,
            );
            this.publish(selected.id);
            await this.metadataWork(selected.id);
          },
        );
      });
    } catch (error) {
      if (!this.signal.aborted) {
        this.nextRead = Date.now() + Math.max(1, retryAfter(error)) * 1000;
        this.channel?.postMessage({
          type: 'cooldown',
          scope: this.scope,
          epoch: this.storage.epoch,
          group: 'read',
          until: this.nextRead,
        });
        this.retry('read', (): void => {
          void this.flushRead();
        });
      }
    } finally {
      this.reading = false;

      if (confirmed && selected === this.selected && selected.shown > confirmed) {
        void this.flushRead();
      }
    }
  }

  stop(): void {
    this.models.stop();

    if (this.signal.aborted) {
      return;
    }

    this.controller.abort();

    for (const finished of this.getFinished) {
      finished();
    }

    this.getFinished.clear();

    for (const lease of this.draftFlushers.values()) {
      lease.release?.();
    }

    this.draftFlushers.clear();
    this.storage.close();
    this.channel?.close();
    clearInterval(this.timer);
    clearInterval(this.updateMonitor);
    this.updates?.close();

    for (const timer of this.retries.values()) {
      clearTimeout(timer);
    }

    for (const stop of this.stops) {
      stop();
    }

    this.state = { ...this.state, status: 'stopped' };
  }
}

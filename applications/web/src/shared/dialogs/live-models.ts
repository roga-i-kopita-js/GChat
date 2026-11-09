import type { DialogSummary } from './model';
import type { DialogRuntime, DialogView } from './runtime';
import { dialogError } from './runtime';

export enum DialogModelEvent {
  ListChanged = 'listChanged',
  ConversationChanged = 'conversationChanged',
}

export interface DialogListState {
  revision: number;
  status: 'starting' | 'ready' | 'error';
  items: readonly DialogSummary[];
  hasMore: boolean;
  error: string | null;
  storageWarning: string | null;
}

export interface DialogConversationState {
  revision: number;
  dialogId: string;
  status: 'starting' | 'ready' | 'error';
  view: Readonly<DialogView> | null;
  error: string | null;
}

/** A committed-storage model, not a second server cache. Reads are serialized and revision guarded. */
export class DialogModel<
  T extends { revision: number; status: string; error: string | null },
  E extends DialogModelEvent,
> {
  private state: T;
  private listeners = new Set<(state: T) => void>();
  private dirty = false;
  private running?: Promise<void>;
  private stopped = false;

  constructor(
    initial: T,
    private readonly event: E,
    private readonly read: () => Promise<Omit<T, 'revision'>>,
    private readonly idle: () => void = (): void => {},
  ) {
    this.state = Object.freeze(initial);
  }

  get hasSubscribers(): boolean {
    return this.listeners.size > 0;
  }

  getSnapshot = (): T => this.state;

  on(event: E, listener: (state: T) => void): () => void {
    if (event !== this.event || this.stopped) {
      return (): void => {};
    }

    this.listeners.add(listener);

    if (this.state.status === 'starting') {
      this.invalidate();
    }

    return (): void => {
      this.listeners.delete(listener);

      if (!this.listeners.size) {
        this.idle();
      }
    };
  }

  async getState(): Promise<T> {
    if (this.state.status === 'starting') {
      this.invalidate();
    }

    await this.running;

    return this.state;
  }

  invalidate(): void {
    if (this.stopped) {
      return;
    }

    this.dirty = true;

    if (this.running) {
      return;
    }

    this.running = (async () => {
      try {
        return await this.refresh();
      } finally {
        this.running = undefined;

        if (this.dirty && !this.stopped) {
          this.invalidate();
        }
      }
    })();
  }

  private async refresh(): Promise<void> {
    while (this.dirty && !this.stopped) {
      this.dirty = false;
      let next: T;

      try {
        const value = await this.read();

        next = { ...this.state, ...value, revision: this.state.revision + 1 };
      } catch (error) {
        next = {
          ...this.state,
          revision: this.state.revision + 1,
          status: 'error',
          error: dialogError(error),
        };
      }

      if (this.stopped || this.dirty) {
        continue;
      }

      this.state = Object.freeze(next);

      for (const listener of this.listeners) {
        try {
          listener(this.state);
        } catch {
          /* Consumer isolation. */
        }
      }
    }
  }

  stop(): void {
    this.stopped = true;
    this.listeners.clear();
  }
}

export class DialogModels {
  readonly list: DialogModel<DialogListState, DialogModelEvent.ListChanged>;
  private readonly rooms = new Map<
    string,
    DialogModel<DialogConversationState, DialogModelEvent.ConversationChanged>
  >();

  constructor(private readonly runtime: DialogRuntime) {
    this.list = new DialogModel(
      {
        revision: 0,
        status: 'starting',
        items: [],
        hasMore: false,
        error: null,
        storageWarning: null,
      },
      DialogModelEvent.ListChanged,
      async (): Promise<Omit<DialogListState, 'revision'>> => {
        const itemsValue = await runtime.list();

        return {
          status: 'ready',
          items: itemsValue,
          hasMore: runtime.listHasMore,
          error: null,
          storageWarning: runtime.getSnapshot().storageWarning,
        };
      },
    );
  }

  conversation(
    id: string,
  ): DialogModel<DialogConversationState, DialogModelEvent.ConversationChanged> {
    let model = this.rooms.get(id);

    if (!model) {
      model = new DialogModel(
        { revision: 0, dialogId: id, status: 'starting', view: null, error: null },
        DialogModelEvent.ConversationChanged,
        async (): Promise<Omit<DialogConversationState, 'revision'>> => {
          const viewValue = await this.runtime.view(id);

          return {
            dialogId: id,
            status: 'ready',
            view: viewValue,
            error: null,
          };
        },
        (): void => {
          queueMicrotask((): void => {
            if (!model?.hasSubscribers) {
              this.rooms.delete(id);
              model?.stop();
            }
          });
        },
      );
      this.rooms.set(id, model);
    }

    return model;
  }

  committed(id?: string): void {
    this.list.invalidate();

    if (id) {
      this.rooms.get(id)?.invalidate();
    } else {
      for (const model of this.rooms.values()) {
        model.invalidate();
      }
    }
  }

  conversationChanged(id: string): void {
    this.rooms.get(id)?.invalidate();
  }

  stop(): void {
    this.list.stop();

    for (const model of this.rooms.values()) {
      model.stop();
    }

    this.rooms.clear();
  }
}

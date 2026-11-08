import { z } from 'zod';

import { embedded, nativePlugin } from '../native/bridge';
import { nativeRuntime } from '../native/runtime';
import {
  type CallOptions,
  NotificationEvent,
  type NotificationEvents,
  type NotificationIntent,
  type NotificationsService,
  type NotificationsState,
} from './api';
import { type DeviceBridge, DeviceError } from './contract';
import { cancellable, Events } from './events';
import type { DeviceObserver } from './observer';

export class DeviceNotifications
  extends Events<NotificationEvents>
  implements NotificationsService
{
  private state: NotificationsState = {
    revision: 0,
    settings: {
      permission: 'unknown',
      alert: 'unknown',
      sound: 'unknown',
      badge: 'unknown',
      delivery: 'unavailable',
    },
    pendingIntent: null,
  };
  private consumed = new Set<string>();
  private stops: (() => void)[] = [];

  constructor(
    private readonly bridge: DeviceBridge,
    private readonly observer: DeviceObserver,
    private readonly signal: () => AbortSignal,
  ) {
    super();
    Object.freeze(this.state.settings);
    Object.freeze(this.state);
  }

  private set(patch: Partial<NotificationsState>): void {
    const next = { ...this.state, ...patch, revision: this.state.revision };

    if (JSON.stringify(next) === JSON.stringify(this.state)) {
      return;
    }

    this.state = Object.freeze({ ...next, revision: this.state.revision + 1 });
    this.emit(NotificationEvent.StateChanged, this.state);
  }

  getState(options: CallOptions = {}): Promise<NotificationsState> {
    if (options.signal?.aborted) {
      return Promise.reject(new DeviceError('CANCELLED'));
    }

    return Promise.resolve(this.state);
  }

  receive(intent: NotificationIntent): void {
    if (this.consumed.has(intent.id) || this.state.pendingIntent?.id === intent.id) {
      return;
    }

    this.set({ pendingIntent: Object.freeze({ ...intent }) });
    this.emit(NotificationEvent.IntentReceived, {
      revision: this.state.revision,
      intent: this.state.pendingIntent!,
    });
  }

  start(): void {
    if (this.stops.length) {
      return;
    }

    if (!embedded) {
      const url = new URL(window.location.href);
      const id = url.searchParams.get('dialog_id');

      if (id) {
        if (z.string().uuid().safeParse(id).success) {
          this.receive({ id: crypto.randomUUID(), kind: 'dialog', dialogId: id });
        }

        url.searchParams.delete('dialog_id');
        window.history.replaceState(window.history.state, '', url.pathname + url.search + url.hash);
      }
    }

    this.stops.push(
      this.observer.source.on(({ value }): void => {
        if (value) {
          this.set({ settings: Object.freeze({ ...value.push }) });
        }
      }),
    );

    if (embedded) {
      const sync = (): void => {
        const value = nativeRuntime.getSnapshot().dialogIntent;

        if (value) {
          this.receive({ id: value.intentId, kind: 'dialog', dialogId: value.dialogId });
        }
      };

      this.stops.push(nativeRuntime.subscribe(sync));
      sync();
    } else if ('serviceWorker' in navigator) {
      const receive = (event: MessageEvent<unknown>): void => {
        const input = z
          .strictObject({ type: z.literal('dialog.notification'), dialogId: z.string().uuid() })
          .safeParse(event.data);

        if (input.success) {
          if (
            this.state.pendingIntent?.kind === 'dialog' &&
            this.state.pendingIntent.dialogId === input.data.dialogId
          ) {
            return;
          }

          this.receive({ id: crypto.randomUUID(), kind: 'dialog', dialogId: input.data.dialogId });
        }
      };

      navigator.serviceWorker.addEventListener('message', receive);
      this.stops.push((): void => navigator.serviceWorker.removeEventListener('message', receive));
    }
  }

  async enable(options?: CallOptions): Promise<void> {
    const value = await cancellable(
      (): Promise<unknown> => this.bridge.execute({ command: 'push.enable', args: {} }),
      options,
      this.signal(),
    );

    await this.observer.refresh();
    void value;
  }

  async disable(options?: CallOptions): Promise<void> {
    await cancellable(
      (): Promise<unknown> => this.bridge.execute({ command: 'push.disable', args: {} }),
      options,
      this.signal(),
    );
    await this.observer.refresh();
  }

  async acknowledge(id: string, options?: CallOptions): Promise<void> {
    if (options?.signal?.aborted) {
      throw new DeviceError('CANCELLED');
    }

    if (this.state.pendingIntent?.id !== id) {
      return;
    }

    if (embedded) {
      const native = nativeRuntime.getSnapshot();

      await cancellable(
        (): Promise<void> =>
          nativePlugin.consumeDialogNotificationIntent({ cycleId: native.cycleId, intentId: id }),
        options,
        this.signal(),
      );
    }

    this.consumed.add(id);

    if (this.consumed.size > 128) {
      this.consumed.delete(this.consumed.values().next().value!);
    }

    if (this.state.pendingIntent?.id === id) {
      this.set({ pendingIntent: null });
    }
  }

  reset(): void {
    this.set({ pendingIntent: null });
  }

  stop(): void {
    for (const stop of this.stops.splice(0)) {
      stop();
    }

    this.reset();
    this.clear();
  }
}

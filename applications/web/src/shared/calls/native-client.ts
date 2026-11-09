import { z } from 'zod';

import { errorMessage } from '../api/client';
import { embedded, invoke, nativePlugin } from '../native/bridge';
import { bridgeError } from '../native/bridge';
import { nativeRuntime } from '../native/runtime';
import { logout } from '../session/session';
import type { ClientState, GChatClient } from './client';

export type CallsClient = Pick<
  GChatClient,
  | 'getLastFailure'
  | 'getSnapshot'
  | 'subscribe'
  | 'start'
  | 'dial'
  | 'signOut'
  | 'clearError'
  | 'dismiss'
  | 'activate'
  | 'enableRingtone'
  | 'playAudio'
  | 'accept'
  | 'end'
  | 'mute'
> & {
  webPush?: GChatClient['webPush'];
  audioPreparation?: GChatClient['audioPreparation'];
  setAudioOutput?: GChatClient['setAudioOutput'];
  testSound?: GChatClient['testSound'];
};

/** Contains no browser signaling, audio, locks, device registration or session storage. */
export class NativeCallsClient implements CallsClient {
  private state: ClientState = {
    owner: true,
    connection: 'offline',
    call: null,
    selected: true,
    muted: false,
    busy: false,
    error: null,
    audioBlocked: false,
    screenWakeLockWarning: false,
    audible: true,
    media: 'native',
    stats: { relay: false, sent: 0, received: 0 },
  };
  private listeners = new Set<() => void>();
  private lastFailure: unknown = null;

  getLastFailure(): unknown {
    return this.lastFailure;
  }

  private epoch = -1;

  getSnapshot = (): ClientState => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);

    return (): void => {
      this.listeners.delete(listener);
    };
  };

  private set(patch: Partial<ClientState>): void {
    this.state = { ...this.state, ...patch };

    for (const listener of this.listeners) {
      listener();
    }
  }

  start(): () => void {
    const sync = (): void => {
      const snapshot = nativeRuntime.getSnapshot();

      if (this.epoch !== snapshot.epoch) {
        this.epoch = snapshot.epoch;
        this.set({ busy: false, error: null });
      }

      this.set({
        call: snapshot.call,
        connection: snapshot.nativeCalls === false ? 'offline' : snapshot.runtime.status,
        muted: snapshot.runtime.muted,
      });
    };

    sync();

    return nativeRuntime.subscribe(sync);
  }

  async dial(peerId: string): Promise<void> {
    if (
      !embedded ||
      this.state.busy ||
      this.state.connection !== 'online' ||
      (this.state.call && this.state.call.state !== 'ended')
    ) {
      return;
    }

    const signal = nativeRuntime.getSignal();

    this.set({ busy: true, error: null });

    try {
      if (!z.string().uuid().safeParse(peerId).success) {
        throw bridgeError({ code: 'VALIDATION_ERROR' });
      }

      // Acknowledgement is not a call DTO. Unknown results are never retried.
      await invoke((): Promise<void> => nativePlugin.placeCall({ peerId }));
    } catch (cause) {
      this.lastFailure = cause;

      if (!signal.aborted) {
        this.set({ error: errorMessage(cause, 'Не удалось начать звонок') });
      }
    } finally {
      if (!signal.aborted) {
        this.set({ busy: false });
      }
    }
  }

  async signOut(): Promise<void> {
    await logout();
  }

  clearError(): void {
    this.set({ error: null });
  }

  dismiss(): void {
    if (this.state.call?.state === 'ended') {
      this.set({ call: null });
    }
  }

  activate(): void {}

  async enableRingtone(): Promise<void> {}

  async playAudio(): Promise<void> {}

  async accept(): Promise<void> {}

  async end(): Promise<void> {}

  mute(): void {}
}

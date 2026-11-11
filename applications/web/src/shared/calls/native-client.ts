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
  setMuted?(muted: boolean): Promise<void>;
};

/** Contains no browser signaling, audio, locks, device registration or session storage. */
export class NativeCallsClient implements CallsClient {
  private state: ClientState = {
    owner: true,
    connection: 'offline',
    call: null,
    selected: false,
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
  private controlToken: symbol | null = null;

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

      if (this.epoch !== snapshot.epoch || this.state.call?.call_id !== snapshot.call?.call_id) {
        this.epoch = snapshot.epoch;
        this.controlToken = null;
        this.lastFailure = null;
        this.set({ busy: false, error: null });
      }

      this.set({
        call: snapshot.call,
        connection: snapshot.nativeCalls === false ? 'offline' : snapshot.runtime.status,
        muted: snapshot.runtime.muted,
        selected: snapshot.runtime.selected ?? false,
      });
    };

    sync();

    return nativeRuntime.subscribe(sync);
  }

  async dial(peerId: string): Promise<void> {
    if (
      !embedded ||
      !nativeRuntime.getSnapshot().webCallControls ||
      this.state.busy ||
      this.state.connection !== 'online' ||
      (this.state.call && this.state.call.state !== 'ended')
    ) {
      return;
    }

    const signal = nativeRuntime.getSignal();
    const token = Symbol();

    this.controlToken = token;
    const current = (): boolean => !signal.aborted && this.controlToken === token;

    this.set({ busy: true, error: null });

    try {
      if (!z.string().uuid().safeParse(peerId).success) {
        throw bridgeError({ code: 'VALIDATION_ERROR' });
      }

      // Acknowledgement is not a call DTO. Unknown results are never retried.
      await invoke((): Promise<void> => nativePlugin.placeCall({ peerId }));
    } catch (cause) {
      if (current()) {
        this.lastFailure = cause;
        this.set({ error: errorMessage(cause, 'Не удалось начать звонок') });
      }
    } finally {
      if (current()) {
        this.controlToken = null;
        this.set({ busy: false });
      }
    }
  }

  async signOut(): Promise<void> {
    await logout();
  }

  clearError(): void {
    this.lastFailure = null;
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

  private async control(
    operation: (options: { cycleId: string; callId: string }) => Promise<void>,
  ): Promise<void> {
    const snapshot = nativeRuntime.getSnapshot();
    const call = this.state.call;

    if (!snapshot.webCallControls) {
      throw bridgeError({ code: 'UNSUPPORTED_VERSION' });
    }

    if (this.state.busy) {
      throw bridgeError({ code: 'BUSY' });
    }

    if (!call || call.state === 'ended' || snapshot.phase !== 'ready') {
      throw bridgeError({ code: 'INVALID_STATE' });
    }

    const signal = nativeRuntime.getSignal();
    const token = Symbol();

    this.controlToken = token;
    const current = (): boolean =>
      !signal.aborted && this.controlToken === token && this.state.call?.call_id === call.call_id;

    this.set({ busy: true, error: null });

    try {
      await invoke(() => operation({ cycleId: snapshot.cycleId, callId: call.call_id }));
    } catch (cause) {
      if (current() && this.state.call?.state !== 'ended') {
        this.lastFailure = cause;
        this.set({ error: errorMessage(cause, 'Не удалось выполнить действие звонка') });

        throw cause;
      }
    } finally {
      if (current()) {
        this.controlToken = null;
        this.set({ busy: false });
      }
    }
  }

  async accept(): Promise<void> {
    await this.control((options) => nativePlugin.acceptCall(options));
  }

  async end(): Promise<void> {
    await this.control((options) => nativePlugin.endCall(options));
  }

  async setMuted(muted: boolean): Promise<void> {
    if (this.state.muted !== muted) {
      await this.control((options) => nativePlugin.setCallMuted({ ...options, muted }));
    }
  }

  mute(): void {}
}

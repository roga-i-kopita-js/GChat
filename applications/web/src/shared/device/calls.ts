import { z } from 'zod';

import type { CallsClient } from '../calls/native-client';
import { embedded } from '../native/bridge';
import { nativeRuntime } from '../native/runtime';
import {
  CallEvent,
  type CallOptions,
  type CallsService,
  type CallsState,
  type SessionService,
} from './api';
import { type DeviceBridge, DeviceError } from './contract';
import { cancellable, StateSource } from './events';
import { deviceFailure } from './failure';

export class DeviceCalls implements CallsService {
  readonly source = new StateSource<CallsState>({
    revision: 0,
    call: null,
    control: 'unavailable',
    muted: false,
    busy: false,
    audioBlocked: false,
    error: null,
  });
  private acting = false;
  private commandFailure: DeviceError | null = null;
  private off: (() => void) | null = null;
  private nativeEpoch = -1;
  private nativeCallId: string | undefined;
  private actionToken: symbol | null = null;

  constructor(
    readonly client: CallsClient,
    private readonly identityId: () => string | null,
    private readonly bridge: DeviceBridge,
    private readonly signal: () => AbortSignal,
  ) {}

  on(_event: CallEvent.StateChanged, handler: (state: CallsState) => void): () => void {
    return this.source.on(handler);
  }

  getState(options?: CallOptions): Promise<CallsState> {
    return this.source.getState(options);
  }

  sync = (): void => {
    const state = this.client.getSnapshot();
    const native = nativeRuntime.getSnapshot();

    if (
      embedded &&
      (this.nativeEpoch !== native.epoch || this.nativeCallId !== state.call?.call_id)
    ) {
      this.nativeEpoch = native.epoch;
      this.nativeCallId = state.call?.call_id;
      this.actionToken = null;
      this.acting = false;
      this.commandFailure = null;
    }

    let controlValue: CallsState['control'];

    if (!state.owner) {
      controlValue = 'otherWindow';
    } else if (embedded && (native.nativeCalls !== true || !native.webCallControls)) {
      controlValue = 'unavailable';
    } else if (
      state.call &&
      state.call.state !== 'ended' &&
      state.call.state !== 'ringing' &&
      !state.selected
    ) {
      controlValue = 'unavailable';
    } else {
      controlValue = 'available';
    }

    const control = controlValue;

    this.source.set({
      ...this.source.getSnapshot(),
      call: state.call ? structuredClone(state.call) : null,
      control,
      muted: state.muted,
      busy: state.busy || this.acting,
      audioBlocked: state.audioBlocked,
      error: state.error
        ? deviceFailure(this.client.getLastFailure(), 'calls', 'runtime')
        : this.commandFailure,
    });
  };

  start(): void {
    if (this.off) {
      return;
    }

    this.off = this.client.subscribe(this.sync);
    this.sync();
  }

  stop(): void {
    this.off?.();
    this.off = null;
  }

  private guard(options?: CallOptions): void {
    if (this.signal().aborted || options?.signal?.aborted) {
      throw new DeviceError('CANCELLED');
    }

    const state = this.client.getSnapshot();

    if (embedded && nativeRuntime.getSnapshot().nativeCalls !== true) {
      throw new DeviceError('UNSUPPORTED');
    }

    if (embedded && !nativeRuntime.getSnapshot().webCallControls) {
      throw new DeviceError('UNSUPPORTED_VERSION');
    }

    if (!state.owner || state.busy || this.acting) {
      throw new DeviceError('BUSY');
    }

    if (state.connection !== 'online') {
      throw new DeviceError('NETWORK_ERROR');
    }
  }

  private async action(
    operation: string,
    run: () => Promise<void>,
    options?: CallOptions,
  ): Promise<void> {
    let acquired = false;
    const token = Symbol();
    const signal = this.signal();
    const epoch = nativeRuntime.getSnapshot().epoch;
    const callId = this.client.getSnapshot().call?.call_id;
    const current = (): boolean =>
      !signal.aborted &&
      (!embedded || epoch === nativeRuntime.getSnapshot().epoch) &&
      (operation === 'dial' || callId === this.client.getSnapshot().call?.call_id);

    try {
      this.guard(options);
      this.acting = true;
      acquired = true;
      this.actionToken = token;
      this.sync();
      this.commandFailure = null;
      this.client.clearError();
      await cancellable(run, options, this.signal());

      if (this.client.getSnapshot().error) {
        throw deviceFailure(this.client.getLastFailure(), 'calls', operation);
      }
    } catch (cause) {
      const error = deviceFailure(cause, 'calls', operation);

      if (current()) {
        this.commandFailure = error;
        this.source.set({ ...this.source.getSnapshot(), error });
      }

      throw error;
    } finally {
      if (acquired && this.actionToken === token) {
        this.actionToken = null;
        this.acting = false;
        this.sync();
      }
    }
  }

  dial(peerId: string, options?: CallOptions): Promise<void> {
    return this.action(
      'dial',
      async (): Promise<void> => {
        if (!z.string().uuid().safeParse(peerId).success) {
          throw new DeviceError('INVALID_ARGUMENT');
        }

        const call = this.client.getSnapshot().call;

        if (call && call.state !== 'ended') {
          throw new DeviceError('BUSY');
        }

        const { outcome: preparedOutcome } = await this.bridge.execute({
          command: 'call.prepareOutgoing',
          args: {},
        });

        if (preparedOutcome === 'cancelled') {
          throw new DeviceError('CANCELLED');
        }

        if (options?.signal?.aborted || this.signal().aborted) {
          throw new DeviceError('CANCELLED');
        }

        await this.client.dial(peerId);
      },
      options,
    );
  }

  accept(options?: CallOptions): Promise<void> {
    return this.action(
      'accept',
      async (): Promise<void> => {
        const call = this.client.getSnapshot().call;

        if (!call || call.state !== 'ringing' || call.recipient_id !== this.identityId()) {
          throw new DeviceError('INVALID_STATE');
        }

        await this.client.accept();
      },
      options,
    );
  }

  end(options?: CallOptions): Promise<void> {
    return this.action(
      'end',
      async (): Promise<void> => {
        const call = this.client.getSnapshot().call;

        if (!call || call.state === 'ended') {
          throw new DeviceError('INVALID_STATE');
        }

        await this.client.end(call.state === 'ringing' && call.recipient_id === this.identityId());
      },
      options,
    );
  }

  setMuted(muted: boolean, options?: CallOptions): Promise<void> {
    return this.action(
      'setMuted',
      async (): Promise<void> => {
        const state = this.client.getSnapshot();

        if (!state.call || state.call.state === 'ended' || !state.selected) {
          throw new DeviceError('INVALID_STATE');
        }

        if (state.muted !== muted) {
          if (this.client.setMuted) {
            await this.client.setMuted(muted);
          } else {
            this.client.mute();
          }
        }
      },
      options,
    );
  }

  async activateAudio(options?: CallOptions): Promise<void> {
    if (embedded) {
      throw new DeviceError('UNSUPPORTED');
    }

    await cancellable(
      async (): Promise<void> => {
        await this.client.enableRingtone();
        await this.client.playAudio();

        if (this.client.getSnapshot().audioBlocked) {
          throw new DeviceError('DEVICE_UNAVAILABLE');
        }
      },
      options,
      this.signal(),
    );
  }

  async takeControl(options?: CallOptions): Promise<void> {
    if (embedded) {
      throw new DeviceError('UNSUPPORTED');
    }

    if (options?.signal?.aborted || this.signal().aborted) {
      throw new DeviceError('CANCELLED');
    }

    const state = this.client.getSnapshot();

    if (state.call && state.call.state !== 'ended') {
      throw new DeviceError('BUSY');
    }

    this.client.activate();
  }

  async dismissEnded(options?: CallOptions): Promise<void> {
    if (options?.signal?.aborted || this.signal().aborted) {
      throw new DeviceError('CANCELLED');
    }

    const call = this.client.getSnapshot().call;

    if (call && call.state !== 'ended') {
      throw new DeviceError('INVALID_STATE');
    }

    this.client.dismiss();
  }

  clearError(): void {
    this.commandFailure = null;
    this.client.clearError();
    this.source.set({ ...this.source.getSnapshot(), error: null });
  }
}

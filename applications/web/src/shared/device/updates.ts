import { embedded } from '../native/bridge';
import {
  applyUpdate,
  startUpdates,
  stopUpdates,
  subscribeUpdate,
  updateSnapshot,
} from '../pwa-update';
import { type CallOptions, UpdateEvent, type UpdatesService, type UpdatesState } from './api';
import { DeviceError } from './contract';
import { StateSource } from './events';
import { deviceFailure } from './failure';

export class DeviceUpdates implements UpdatesService {
  readonly source = new StateSource<UpdatesState>({
    revision: 0,
    status: embedded ? 'unsupported' : 'idle',
    error: null,
  });
  private off: (() => void) | null = null;

  constructor(
    private readonly busy: () => boolean,
    private readonly signal: () => AbortSignal,
  ) {}

  on(_event: UpdateEvent.StateChanged, handler: (state: UpdatesState) => void): () => void {
    return this.source.on(handler);
  }

  getState(options?: CallOptions): Promise<UpdatesState> {
    return this.source.getState(options);
  }

  private sync = (): void => {
    if (embedded) {
      return;
    }

    const value = updateSnapshot();

    let statusValue: UpdatesState['status'];

    if (value.error) {
      statusValue = 'error';
    } else if (value.applying) {
      statusValue = 'applying';
    } else if (value.pending) {
      statusValue = 'waiting';
    } else if (value.available) {
      statusValue = 'available';
    } else {
      statusValue = 'idle';
    }

    this.source.set({
      ...this.source.getSnapshot(),
      status: statusValue,
      error: value.error ? deviceFailure(new DeviceError('IO_ERROR'), 'updates', 'prepare') : null,
    });
  };

  start(): void {
    if (embedded || this.off) {
      return;
    }

    this.off = subscribeUpdate(this.sync);
    startUpdates();
    this.sync();
  }

  async apply(options?: CallOptions): Promise<{ outcome: 'scheduled' | 'deferred' }> {
    if (this.signal().aborted || options?.signal?.aborted) {
      throw new DeviceError('CANCELLED');
    }

    if (embedded) {
      throw new DeviceError('UNSUPPORTED');
    }

    const value = updateSnapshot();

    if (!value.available && !value.pending) {
      throw new DeviceError('INVALID_STATE');
    }

    if (!value.pending) {
      void (async () => {
        try {
          return await applyUpdate();
        } catch (cause) {
          this.source.set({
            ...this.source.getSnapshot(),
            status: 'error',
            error: deviceFailure(cause, 'updates', 'apply'),
          });
        }
      })();
    }

    return { outcome: this.busy() || value.pending ? 'deferred' : 'scheduled' };
  }

  stop(): void {
    if (!this.off) {
      return;
    }

    this.off();
    this.off = null;

    if (!embedded) {
      stopUpdates();
    }
  }
}

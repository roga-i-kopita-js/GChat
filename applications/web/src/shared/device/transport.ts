import { embedded } from '../native/bridge';
import { nativeRuntime } from '../native/runtime';
import { browserTransport } from '../runtime/transport';
import {
  type CallOptions,
  TransportEvent,
  type TransportService,
  type TransportState,
} from './api';
import { StateSource } from './events';
import { deviceFailure } from './failure';

export class DeviceTransport implements TransportService {
  readonly source = new StateSource<TransportState>({
    revision: 0,
    status: 'offline',
    owner: false,
    error: null,
  });
  private off: (() => void) | null = null;

  on(_event: TransportEvent.StateChanged, handler: (state: TransportState) => void): () => void {
    return this.source.on(handler);
  }

  getState(options?: CallOptions): Promise<TransportState> {
    return this.source.getState(options);
  }

  private sync = (): void => {
    const state = embedded ? nativeRuntime.getSnapshot() : browserTransport.getSnapshot();
    const native = nativeRuntime.getSnapshot();
    const browser = browserTransport.getSnapshot();

    this.source.set({
      ...this.source.getSnapshot(),
      status: embedded ? native.wsStatus : browser.status,
      owner: embedded ? true : browser.owner,
      error: state.error ? deviceFailure(state.error, 'transport', 'connect') : null,
    });
  };

  start(): void {
    if (this.off) {
      return;
    }

    this.off = embedded
      ? nativeRuntime.subscribe(this.sync)
      : browserTransport.subscribe(this.sync);
    this.sync();
  }

  stop(): void {
    this.off?.();
    this.off = null;
    this.source.set({ ...this.source.getSnapshot(), status: 'offline', owner: false, error: null });
  }
}

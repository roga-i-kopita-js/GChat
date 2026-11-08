import { type DeviceBridge, DeviceError, type DeviceState } from './contract';
import { StateSource } from './events';

/** The single long poll belongs to the adapter, regardless of the number of UI subscribers. */
export class DeviceObserver {
  readonly source = new StateSource<{
    revision: number;
    value: DeviceState | null;
    error: DeviceError | null;
  }>({ revision: 0, value: null, error: null });
  private generation = 0;
  private running = false;

  constructor(readonly bridge: DeviceBridge) {}

  start(): void {
    if (this.running) {
      return;
    }

    this.running = true;
    const generation = ++this.generation;
    const read = async (): Promise<void> => {
      try {
        let afterRevision = 0;

        while (generation === this.generation) {
          const value = await this.bridge.execute({ command: 'device.state.read', args: {} });

          if (generation !== this.generation) {
            return;
          }

          this.source.set({ ...this.source.getSnapshot(), value, error: null });
          afterRevision = value.revision;
          const change = await this.bridge.execute({
            command: 'device.changes.wait',
            args: { afterRevision, timeoutMs: 30000 },
          });

          if (generation !== this.generation) {
            return;
          }

          afterRevision = change.revision;
        }
      } catch (cause) {
        if (generation === this.generation) {
          this.running = false;
          this.source.set({
            ...this.source.getSnapshot(),
            error: cause instanceof DeviceError ? cause : new DeviceError('IO_ERROR'),
          });
        }
      }
    };

    void read();
  }

  async refresh(): Promise<DeviceState> {
    const generation = this.generation;
    const value = await this.bridge.execute({ command: 'device.state.read', args: {} });

    if (generation !== this.generation) {
      throw new DeviceError('CANCELLED');
    }

    this.source.set({ ...this.source.getSnapshot(), value, error: null });

    return value;
  }

  async stop(): Promise<void> {
    this.generation++;
    this.running = false;
    this.source.set({ ...this.source.getSnapshot(), value: null, error: null });
    await this.bridge.execute({ command: 'device.changes.cancel', args: {} }).catch((): void => {});
  }
}

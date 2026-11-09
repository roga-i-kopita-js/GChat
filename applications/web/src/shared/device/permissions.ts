import {
  type CallOptions,
  PermissionEvent,
  type PermissionEvents,
  type PermissionReading,
  type PermissionsService,
} from './api';
import { type DeviceBridge, type Resource } from './contract';
import { cancellable, Events } from './events';
import type { DeviceObserver } from './observer';

export class DevicePermissions extends Events<PermissionEvents> implements PermissionsService {
  private revision = 0;
  private previous = new Map<Resource, string>();
  private off: (() => void) | null = null;

  constructor(
    private readonly bridge: DeviceBridge,
    private readonly observer: DeviceObserver,
    private readonly signal: () => AbortSignal,
  ) {
    super();
  }

  start(): void {
    if (this.off) {
      return;
    }

    this.off = this.observer.source.on(({ value }): void => {
      if (!value) {
        return;
      }

      for (const resource of ['microphone', 'camera', 'geolocation'] satisfies Resource[]) {
        const state = value[resource];
        const key = JSON.stringify(state);

        if (this.previous.get(resource) === key) {
          continue;
        }

        this.previous.set(resource, key);
        this.emit(PermissionEvent.Changed, {
          revision: ++this.revision,
          resource,
          state: Object.freeze({ ...state }),
        });
      }
    });
  }

  read(resource: Resource, options?: CallOptions): Promise<PermissionReading> {
    return cancellable(
      (): Promise<PermissionReading> =>
        this.bridge.execute({ command: 'permission.read', args: { resource } }),
      options,
      this.signal(),
    );
  }

  async request(resource: Resource, options?: CallOptions): Promise<PermissionReading> {
    const value = await cancellable(
      (): Promise<{ state: PermissionReading }> =>
        this.bridge.execute({ command: 'permission.request', args: { resource } }),
      options,
      this.signal(),
    );

    await this.observer.refresh();

    const { state: valueState } = value;

    return valueState;
  }

  async openSettings(options?: CallOptions): Promise<void> {
    await cancellable(
      (): Promise<unknown> => this.bridge.execute({ command: 'device.settings.open', args: {} }),
      options,
      this.signal(),
    );
  }

  stop(): void {
    this.off?.();
    this.off = null;
    this.previous.clear();
    this.clear();
  }
}

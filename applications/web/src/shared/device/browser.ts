import { z } from 'zod';

import { pwaSupported, readyPwa } from '../pwa';
import { matchesVapid, pushConfig, syncWebPush } from '../web-push';
import { BrowserFiles } from './browser-files';
import { type Block, DeviceChanges } from './changes';
import {
  argsSchemas,
  DeviceError,
  type DeviceState,
  failure,
  type PermissionState,
  type Resource,
} from './contract';

export interface BrowserDeviceHost {
  current(): boolean;
  audioAllowed(): boolean;
  stopAudio(): void;
  testMicrophone(): Promise<void>;
  testSound(): Promise<void>;
  setOutput(id: string): Promise<void>;
  push(type: 'device.web_push_config' | 'device.web_push', payload: object): Promise<unknown>;
  pushOnline(): boolean;
}

interface OutputDevices extends MediaDevices {
  selectAudioOutput(): Promise<MediaDeviceInfo>;
}
function canOutput(devices: MediaDevices): devices is OutputDevices {
  return 'selectAudioOutput' in devices && typeof devices.selectAudioOutput === 'function';
}
const done = { outcome: 'completed' };

export class BrowserDevice {
  private changes = new DeviceChanges();
  private files = new BrowserFiles((): void => this.changes.touch('files'));
  private test: DeviceState['audio']['test'] = null;
  private routeName: string | null = null;
  private statuses = new Map<Resource, { status: PermissionStatus; changed: () => void }>();
  private previous = '';
  private epoch = 0;
  private prompting = false;
  private testTimer?: ReturnType<typeof setTimeout>;

  private readonly cleanups: (() => void)[] = [];

  constructor(private host: BrowserDeviceHost) {
    const changed = (): void => {
      this.stop();
      this.routeName = null;
      this.changes.touch('audio');
    };
    const visibility = (): void => {
      if (document.hidden) {
        this.epoch++;
        this.stop();
        this.test = null;
        this.changes.touch('audio');
      } else {
        this.changes.touch('microphone', 'camera', 'geolocation', 'audio', 'push', 'files');
      }
    };
    const pagehide = (event: PageTransitionEvent): void => {
      if (!event.persisted) {
        void (async () => {
          try {
            return await this.files.stop();
          } catch (cause) {}
        })();
      }
    };
    const focus = (): void =>
      this.changes.touch('microphone', 'camera', 'geolocation', 'audio', 'push', 'files');

    navigator.mediaDevices?.addEventListener('devicechange', changed);
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('pagehide', pagehide);
    window.addEventListener('focus', focus);
    this.cleanups.push(
      (): void => navigator.mediaDevices?.removeEventListener('devicechange', changed),
      (): void => document.removeEventListener('visibilitychange', visibility),
      (): void => window.removeEventListener('pagehide', pagehide),
      (): void => window.removeEventListener('focus', focus),
    );
  }

  setCaptureMime(id: string, mime: string): Promise<void> {
    return this.files.setCaptureMime(id, mime);
  }

  async readPermission(resource: Resource): Promise<PermissionState> {
    try {
      const status = await navigator.permissions.query({ name: resource });
      const previous = this.statuses.get(resource);

      // Safari may not update an old PermissionStatus after a settings change.
      if (previous?.status !== status) {
        previous?.status.removeEventListener('change', previous.changed);
        const changed = (): void => this.changes.touch(resource);

        const { addEventListener: statusAddEventListener } = status;

        statusAddEventListener.bind(status)('change', changed);
        this.statuses.set(resource, { status, changed });
      }

      const { state: statusState } = status;

      return {
        permission: statusState,
        settingsHint: 'siteSettings',
      };
    } catch {
      return { permission: 'unknown', settingsHint: 'siteSettings' };
    }
  }

  private async request(resource: Resource): Promise<PermissionState> {
    if (this.prompting) {
      throw new DeviceError('BUSY');
    }

    this.prompting = true;
    const epoch = this.epoch;

    try {
      if (resource === 'geolocation') {
        if (!navigator.geolocation) {
          throw new DeviceError('UNSUPPORTED');
        }

        await new Promise<void>((resolve, reject): void =>
          navigator.geolocation.getCurrentPosition(
            (): void => resolve(),
            (error): void => {
              let geolocationErrorCode;

              if (error.code === 1) {
                geolocationErrorCode = 'PERMISSION_DENIED';
              } else if (error.code === 3) {
                geolocationErrorCode = 'TIMEOUT';
              } else {
                geolocationErrorCode = 'DEVICE_UNAVAILABLE';
              }

              return reject(new DeviceError(geolocationErrorCode));
            },
            { enableHighAccuracy: false, maximumAge: 0, timeout: 10000 },
          ),
        );
      } else {
        if (!navigator.mediaDevices?.getUserMedia) {
          throw new DeviceError('UNSUPPORTED');
        }

        const stream = await navigator.mediaDevices.getUserMedia({
          audio: resource === 'microphone',
          video: resource === 'camera',
        });

        const { getTracks: streamGetTracks } = stream;

        for (const track of streamGetTracks.bind(stream)()) {
          track.stop();
        }
      }

      if (epoch !== this.epoch || !this.host.current()) {
        throw new DeviceError('CANCELLED');
      }

      return { permission: 'granted', settingsHint: 'siteSettings' };
    } catch (error) {
      if (epoch !== this.epoch || !this.host.current()) {
        throw new DeviceError('CANCELLED');
      }

      const cause = failure(error);

      if (cause.code === 'PERMISSION_DENIED') {
        return { permission: 'denied', settingsHint: 'siteSettings' };
      }

      const { permission: readPermissionResultPermission } = await this.readPermission(resource);

      if (resource === 'geolocation' && readPermissionResultPermission === 'granted') {
        return { permission: 'granted', settingsHint: 'siteSettings' };
      }

      throw cause;
    } finally {
      this.prompting = false;
      this.changes.touch(resource);
    }
  }

  private async pushState(): Promise<DeviceState['push']> {
    let permissionValue: DeviceState['push']['permission'];

    if (typeof Notification === 'undefined') {
      permissionValue = 'unknown';
    } else if (Notification.permission === 'default') {
      permissionValue = 'prompt';
    } else {
      permissionValue = Notification.permission;
    }

    const permission = permissionValue;
    const state: DeviceState['push'] = {
      permission,
      alert: 'unknown',
      sound: 'unknown',
      badge: 'unknown',
      delivery: 'unavailable',
    };

    if (!pwaSupported() || !('PushManager' in window)) {
      return state;
    }

    state.delivery = 'disabled';

    if (!this.host.pushOnline()) {
      return state;
    }

    try {
      const config = pushConfig.parse(await this.host.push('device.web_push_config', {}));

      if (!config.public_key) {
        state.delivery = 'unavailable';

        return state;
      }

      const { pushManager: registrationPushManager } = await readyPwa();
      const subscription = await registrationPushManager.getSubscription();

      state.delivery =
        subscription && matchesVapid(subscription, config.public_key) && permission === 'granted'
          ? 'enabled'
          : 'disabled';
    } catch {
      state.delivery = 'error';
    }

    return state;
  }

  private async state(): Promise<DeviceState> {
    const [microphone, camera, location, push, retainedCount] = await Promise.all([
      this.readPermission('microphone'),
      this.readPermission('camera'),
      this.readPermission('geolocation'),
      this.pushState(),
      this.files.count(),
    ]);
    const content = {
      microphone,
      camera,
      geolocation: { ...location, accuracy: 'unknown', service: 'unknown' },
      audio: { routeName: this.routeName, test: this.test },
      push,
      files: { retainedCount },
    };
    const current = JSON.stringify(content);

    if (this.previous && this.previous !== current) {
      this.changes.touch('microphone', 'camera', 'geolocation', 'audio', 'push', 'files');
    }

    this.previous = current;

    return {
      revision: this.changes.revision,
      ...content,
      geolocation: { ...location, accuracy: 'unknown', service: 'unknown' },
    };
  }

  private startTest(kind: 'microphone' | 'sound'): { testId: string } {
    if (!this.host.audioAllowed() || this.test?.status === 'running') {
      throw new DeviceError('BUSY');
    }

    const testId = crypto.randomUUID();

    this.test = { id: testId, kind, status: 'running', errorCode: null };
    this.changes.touch('audio');
    // Start sound synchronously in the user's gesture. Permission is checked by the
    // microphone path without converting a settings test into an implicit prompt.
    const operation =
      kind === 'sound'
        ? this.host.testSound()
        : (async () => {
            const permission = await this.readPermission('microphone');

            const { permission: permissionPermission } = permission;

            if (permissionPermission !== 'granted') {
              throw new DeviceError('PERMISSION_DENIED');
            }

            if (this.test?.id !== testId || this.test.status !== 'running') {
              throw new DeviceError('CANCELLED');
            }

            await this.host.testMicrophone();
          })();

    void (async () => {
      try {
        await operation;

        if (this.test?.id !== testId || this.test.status !== 'running') {
          return;
        }

        this.testTimer = setTimeout(
          (): void => {
            if (this.test?.id === testId && this.test.status === 'running') {
              this.host.stopAudio();
              this.test.status = 'completed';
              this.changes.touch('audio');
            }
          },
          kind === 'sound' ? 1000 : 0,
        );
      } catch (cause) {
        const error: unknown = cause;

        if (this.test?.id === testId && this.test.status === 'running') {
          this.host.stopAudio();
          this.test.status = 'failed';
          this.test.errorCode = failure(error).code;
          this.changes.touch('audio');
        }
      }
    })();

    return { testId };
  }

  stop(): void {
    clearTimeout(this.testTimer);
    this.host.stopAudio();

    if (this.test?.status === 'running') {
      this.test.status = 'cancelled';
      this.changes.touch('audio');
    }
  }

  reset(): void {
    this.epoch++;
    this.stop();
    this.changes.reset();
    this.previous = '';
    this.test = null;
    this.files.reset();
  }

  async dispose(): Promise<void> {
    for (const stop of this.cleanups.splice(0)) {
      stop();
    }

    this.reset();
    await this.files.stop();

    for (const value of this.statuses.values()) {
      value.status.removeEventListener('change', value.changed);
    }

    this.statuses.clear();
  }

  async execute(command: string, raw: unknown): Promise<unknown> {
    if (
      command.startsWith('file.') ||
      command.startsWith('directory.') ||
      command.startsWith('storage.')
    ) {
      try {
        return await this.files.execute(command, raw);
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') {
          return command === 'file.pick'
            ? { outcome: 'cancelled', entries: [] }
            : { outcome: 'cancelled', entry: null };
        }

        throw error;
      }
    }

    switch (command) {
      case 'device.state.read':
        return this.state();
      case 'device.changes.wait': {
        const a = argsSchemas[command].parse(raw);

        return this.changes.wait(a.afterRevision, a.timeoutMs);
      }
      case 'device.changes.cancel':
        this.changes.cancel();

        return done;
      case 'permission.read': {
        const a = argsSchemas[command].parse(raw);
        const state = await this.readPermission(a.resource);

        return a.resource === 'geolocation'
          ? { ...state, accuracy: 'unknown', service: 'unknown' }
          : state;
      }
      case 'permission.request': {
        const a = argsSchemas[command].parse(raw);
        const state = await this.request(a.resource);

        return {
          ...done,
          state:
            a.resource === 'geolocation'
              ? { ...state, accuracy: 'unknown', service: 'unknown' }
              : state,
        };
      }
      case 'device.settings.open':
        throw new DeviceError('UNSUPPORTED', { settingsHint: 'siteSettings' });
      case 'audio.test.start':
        return this.startTest(argsSchemas[command].parse(raw).kind);
      case 'audio.test.stop': {
        const { testId } = argsSchemas[command].parse(raw);

        if (this.test?.id === testId) {
          this.stop();
        }

        return done;
      }
      case 'audio.output.select': {
        if (!this.host.audioAllowed()) {
          throw new DeviceError('BUSY');
        }

        if (!navigator.mediaDevices || !canOutput(navigator.mediaDevices)) {
          throw new DeviceError('UNSUPPORTED');
        }

        const device = await navigator.mediaDevices.selectAudioOutput();

        const { deviceId: deviceDeviceId } = device;

        await this.host.setOutput(deviceDeviceId);
        const { label: deviceLabel } = device;

        this.routeName = deviceLabel || 'Выбранный выход';
        this.test = null;
        this.changes.touch('audio');

        return { ...done, routeName: this.routeName };
      }
      case 'call.prepareOutgoing': {
        if (!this.host.audioAllowed()) {
          throw new DeviceError('BUSY');
        }

        this.stop();
        const epoch = this.epoch;
        let microphone = await this.readPermission('microphone');

        if (microphone.permission === 'unknown' || microphone.permission === 'prompt') {
          microphone = await this.request('microphone');
        }

        if (epoch !== this.epoch || !this.host.current()) {
          throw new DeviceError('CANCELLED');
        }

        if (!this.host.audioAllowed()) {
          throw new DeviceError('BUSY');
        }

        if (microphone.permission !== 'granted') {
          throw new DeviceError('PERMISSION_DENIED', { settingsHint: 'siteSettings' });
        }

        return { ...done, microphone };
      }
      case 'push.enable':
      case 'push.disable': {
        if (!pwaSupported() || !('PushManager' in window) || typeof Notification === 'undefined') {
          throw new DeviceError('UNSUPPORTED');
        }

        if (!this.host.pushOnline()) {
          throw new DeviceError('NETWORK_ERROR');
        }

        const permission =
          command === 'push.enable'
            ? await Notification.requestPermission()
            : Notification.permission;

        if (command === 'push.enable' && permission !== 'granted') {
          throw new DeviceError('PERMISSION_DENIED', { settingsHint: 'siteSettings' });
        }

        const epoch = this.epoch;
        const current = (): boolean =>
          epoch === this.epoch && this.host.current() && this.host.pushOnline();

        if (command === 'push.enable') {
          const config = pushConfig.parse(await this.host.push('device.web_push_config', {}));

          if (!config.public_key) {
            throw new DeviceError('PUSH_UNAVAILABLE');
          }

          await syncWebPush(
            config.public_key,
            current,
            (subscription): Promise<unknown> => this.host.push('device.web_push', { subscription }),
            true,
          );
        } else {
          await navigator.locks.request('gchat-web-push', async (): Promise<void> => {
            if (!current()) {
              throw new DeviceError('CANCELLED');
            }

            await this.host.push('device.web_push', { subscription: null });
            const { pushManager: resultPushManager } = await readyPwa();
            const subscription = await resultPushManager.getSubscription();

            if (!current()) {
              throw new DeviceError('CANCELLED');
            }

            const { unsubscribe: subscriptionUnsubscribe } = subscription ?? {};

            if (subscription && !(await subscriptionUnsubscribe?.bind(subscription)())) {
              throw new DeviceError('NETWORK_ERROR');
            }
          });
        }

        if (!current()) {
          throw new DeviceError('CANCELLED');
        }

        this.changes.touch('push');

        const pushValue = await this.pushState();

        return { ...done, push: pushValue };
      }
      default:
        throw new DeviceError('INVALID_ARGUMENT');
    }
  }
}

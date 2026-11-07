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

  constructor(private host: BrowserDeviceHost) {
    navigator.mediaDevices?.addEventListener('devicechange', (): void => {
      this.stop();
      this.routeName = null;
      this.changes.touch('audio');
    });
    document.addEventListener('visibilitychange', (): void => {
      if (document.hidden) this.reset();
      else this.changes.touch('microphone', 'camera', 'geolocation', 'audio', 'push', 'files');
    });
    window.addEventListener('focus', (): void =>
      this.changes.touch('microphone', 'camera', 'geolocation', 'audio', 'push', 'files'),
    );
  }

  async readPermission(resource: Resource): Promise<PermissionState> {
    try {
      const status = await navigator.permissions.query({ name: resource });
      const previous = this.statuses.get(resource);

      // Safari may not update an old PermissionStatus after a settings change.
      if (previous?.status !== status) {
        previous?.status.removeEventListener('change', previous.changed);
        const changed = (): void => this.changes.touch(resource);

        status.addEventListener('change', changed);
        this.statuses.set(resource, { status, changed });
      }

      return {
        permission: status.state,
        settingsHint: 'siteSettings',
      };
    } catch {
      return { permission: 'unknown', settingsHint: 'siteSettings' };
    }
  }

  private async request(resource: Resource): Promise<PermissionState> {
    if (this.prompting) throw new DeviceError('BUSY');

    this.prompting = true;
    const epoch = this.epoch;

    try {
      if (resource === 'geolocation') {
        if (!navigator.geolocation) throw new DeviceError('UNSUPPORTED');

        await new Promise<void>((resolve, reject): void =>
          navigator.geolocation.getCurrentPosition(
            (): void => resolve(),
            (error): void =>
              reject(
                new DeviceError(
                  error.code === 1
                    ? 'PERMISSION_DENIED'
                    : error.code === 3
                      ? 'TIMEOUT'
                      : 'DEVICE_UNAVAILABLE',
                ),
              ),
            { enableHighAccuracy: false, maximumAge: 0, timeout: 10000 },
          ),
        );
      } else {
        if (!navigator.mediaDevices?.getUserMedia) throw new DeviceError('UNSUPPORTED');

        const stream = await navigator.mediaDevices.getUserMedia({
          audio: resource === 'microphone',
          video: resource === 'camera',
        });

        for (const track of stream.getTracks()) track.stop();
      }

      if (epoch !== this.epoch || !this.host.current()) throw new DeviceError('CANCELLED');

      return { permission: 'granted', settingsHint: 'siteSettings' };
    } catch (error) {
      if (epoch !== this.epoch || !this.host.current()) throw new DeviceError('CANCELLED');

      const cause = failure(error);

      if (cause.code === 'PERMISSION_DENIED')
        return { permission: 'denied', settingsHint: 'siteSettings' };

      if (
        resource === 'geolocation' &&
        (await this.readPermission(resource)).permission === 'granted'
      )
        return { permission: 'granted', settingsHint: 'siteSettings' };

      throw cause;
    } finally {
      this.prompting = false;
      this.changes.touch(resource);
    }
  }

  private async pushState(): Promise<DeviceState['push']> {
    const permission =
      typeof Notification === 'undefined'
        ? 'unknown'
        : Notification.permission === 'default'
          ? 'prompt'
          : Notification.permission;
    const state: DeviceState['push'] = {
      permission,
      alert: 'unknown',
      sound: 'unknown',
      badge: 'unknown',
      delivery: 'unavailable',
    };

    if (!pwaSupported() || !('PushManager' in window)) return state;

    state.delivery = 'disabled';

    if (!this.host.pushOnline()) return state;

    try {
      const config = pushConfig.parse(await this.host.push('device.web_push_config', {}));

      if (!config.public_key) {
        state.delivery = 'unavailable';

        return state;
      }

      const registration = await readyPwa();
      const subscription = await registration.pushManager.getSubscription();

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

    if (this.previous && this.previous !== current)
      this.changes.touch('microphone', 'camera', 'geolocation', 'audio', 'push', 'files');

    this.previous = current;

    return {
      revision: this.changes.revision,
      ...content,
      geolocation: { ...location, accuracy: 'unknown', service: 'unknown' },
    };
  }

  private startTest(kind: 'microphone' | 'sound'): { testId: string } {
    if (!this.host.audioAllowed() || this.test?.status === 'running') throw new DeviceError('BUSY');

    const testId = crypto.randomUUID();

    this.test = { id: testId, kind, status: 'running', errorCode: null };
    this.changes.touch('audio');
    // Start sound synchronously in the user's gesture. Permission is checked by the
    // microphone path without converting a settings test into an implicit prompt.
    const operation =
      kind === 'sound'
        ? this.host.testSound()
        : this.readPermission('microphone').then(async (permission): Promise<void> => {
            if (permission.permission !== 'granted') throw new DeviceError('PERMISSION_DENIED');

            if (this.test?.id !== testId || this.test.status !== 'running')
              throw new DeviceError('CANCELLED');

            await this.host.testMicrophone();
          });

    void operation
      .then((): void => {
        if (this.test?.id !== testId || this.test.status !== 'running') return;

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
      })
      .catch((error: unknown): void => {
        if (this.test?.id === testId && this.test.status === 'running') {
          this.host.stopAudio();
          this.test.status = 'failed';
          this.test.errorCode = failure(error).code;
          this.changes.touch('audio');
        }
      });

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

  async execute(command: string, raw: unknown): Promise<unknown> {
    if (command.startsWith('file.') || command.startsWith('directory.')) {
      try {
        return await this.files.execute(command, raw);
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError')
          return command === 'file.pick'
            ? { outcome: 'cancelled', entries: [] }
            : { outcome: 'cancelled', entry: null };

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

        if (this.test?.id === testId) this.stop();

        return done;
      }
      case 'audio.output.select': {
        if (!this.host.audioAllowed()) throw new DeviceError('BUSY');

        if (!navigator.mediaDevices || !canOutput(navigator.mediaDevices))
          throw new DeviceError('UNSUPPORTED');

        const device = await navigator.mediaDevices.selectAudioOutput();

        await this.host.setOutput(device.deviceId);
        this.routeName = device.label || 'Выбранный выход';
        this.test = null;
        this.changes.touch('audio');

        return { ...done, routeName: this.routeName };
      }
      case 'call.prepareOutgoing': {
        if (!this.host.audioAllowed()) throw new DeviceError('BUSY');

        this.stop();
        const epoch = this.epoch;
        let microphone = await this.readPermission('microphone');

        if (microphone.permission === 'unknown' || microphone.permission === 'prompt')
          microphone = await this.request('microphone');

        if (epoch !== this.epoch || !this.host.current()) throw new DeviceError('CANCELLED');

        if (!this.host.audioAllowed()) throw new DeviceError('BUSY');

        if (microphone.permission !== 'granted')
          throw new DeviceError('PERMISSION_DENIED', { settingsHint: 'siteSettings' });

        return { ...done, microphone };
      }
      case 'push.enable':
      case 'push.disable': {
        if (!pwaSupported() || !('PushManager' in window) || typeof Notification === 'undefined')
          throw new DeviceError('UNSUPPORTED');

        if (!this.host.pushOnline()) throw new DeviceError('NETWORK_ERROR');

        const permission =
          command === 'push.enable'
            ? await Notification.requestPermission()
            : Notification.permission;

        if (command === 'push.enable' && permission !== 'granted')
          throw new DeviceError('PERMISSION_DENIED', { settingsHint: 'siteSettings' });

        const epoch = this.epoch;
        const current = (): boolean =>
          epoch === this.epoch && this.host.current() && this.host.pushOnline();

        if (command === 'push.enable') {
          const config = pushConfig.parse(await this.host.push('device.web_push_config', {}));

          if (!config.public_key) throw new DeviceError('PUSH_UNAVAILABLE');

          await syncWebPush(
            config.public_key,
            current,
            (subscription): Promise<unknown> => this.host.push('device.web_push', { subscription }),
            true,
          );
        } else
          await navigator.locks.request('gchat-web-push', async (): Promise<void> => {
            if (!current()) throw new DeviceError('CANCELLED');

            await this.host.push('device.web_push', { subscription: null });
            const subscription = await (await readyPwa()).pushManager.getSubscription();

            if (!current()) throw new DeviceError('CANCELLED');

            if (subscription && !(await subscription.unsubscribe()))
              throw new DeviceError('NETWORK_ERROR');
          });

        if (!current()) throw new DeviceError('CANCELLED');

        this.changes.touch('push');

        return { ...done, push: await this.pushState() };
      }
      default:
        throw new DeviceError('INVALID_ARGUMENT');
    }
  }
}

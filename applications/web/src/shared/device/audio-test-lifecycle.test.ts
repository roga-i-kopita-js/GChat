import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CallsClient } from '../calls/native-client';
import { AudioEvent, type DeviceCore } from './api';
import { DeviceAudio } from './audio';
import { type DeviceBridge, DeviceError, type DeviceState } from './contract';
import { type DeviceInternals, registerDevice } from './internals';
import { loadDeviceSettings } from './load-settings';
import type { NativeMedia } from './media-native';
import { DeviceObserver } from './observer';
import { disposeStateCaches, stateCache } from './state-cache';

function state(): DeviceState {
  const permission = { permission: 'granted', settingsHint: 'appSettings' } as const;

  return {
    revision: 1,
    microphone: permission,
    camera: permission,
    geolocation: { ...permission, accuracy: 'full', service: 'enabled' },
    audio: { routeName: null, test: null },
    push: {
      permission: 'denied',
      alert: 'disabled',
      sound: 'disabled',
      badge: 'disabled',
      delivery: 'unavailable',
    },
    files: { retainedCount: 0 },
  };
}
const observers: DeviceObserver[] = [];

afterEach(async () => {
  for (const observer of observers.splice(0)) {
    await observer.stop();
  }

  vi.unstubAllGlobals();
});

function fixture(options: { cancelledWait?: boolean; discardTest?: boolean } = {}): {
  audio: DeviceAudio;
  observer: DeviceObserver;
  commands: string[];
  complete(): void;
} {
  let current = state();
  let cancelWait = options.cancelledWait ?? false;
  let pending: { resolve(value: unknown): void; reject(cause: unknown): void } | null = null;
  const commands: string[] = [];
  const touch = (): void => {
    current.revision++;
    const waiter = pending;

    pending = null;
    waiter?.resolve({ revision: current.revision, changed: ['audio'], timedOut: false });
  };
  const bridge = {
    execute: async ({
      command,
      args,
    }: {
      command: string;
      args: Record<string, unknown>;
    }): Promise<unknown> => {
      commands.push(command);

      if (command === 'device.state.read') {
        return structuredClone(current);
      }

      if (command === 'device.changes.wait') {
        if (cancelWait) {
          cancelWait = false;

          throw new DeviceError('CANCELLED');
        }

        if (Number(args.afterRevision) < current.revision) {
          return { revision: current.revision, changed: ['audio'], timedOut: false };
        }

        return new Promise((resolve, reject) => {
          pending = { resolve, reject };
        });
      }

      if (command === 'device.changes.cancel') {
        pending?.reject(new DeviceError('CANCELLED'));
        pending = null;

        return { outcome: 'completed' };
      }

      if (command === 'audio.test.start') {
        const testId = crypto.randomUUID();

        current.audio.test = options.discardTest
          ? null
          : { id: testId, kind: 'sound', status: 'running', errorCode: null };
        touch();

        return { testId };
      }

      if (command === 'audio.test.stop') {
        const test = current.audio.test;

        if (test && test.id === args.testId) {
          test.status = 'cancelled';
          touch();
        }

        return { outcome: 'completed' };
      }

      throw new Error(command);
    },
  } as unknown as DeviceBridge;
  const observer = new DeviceObserver(bridge);

  observers.push(observer);
  const audio = new DeviceAudio(
    bridge,
    observer,
    {} as NativeMedia,
    { getSnapshot: () => ({ call: null }) } as CallsClient,
    () => new AbortController().signal,
  );

  return {
    audio,
    observer,
    commands,
    complete: (): void => {
      if (current.audio.test) {
        current.audio.test.status = 'completed';
        touch();
      }
    },
  };
}

describe('audio test completion and device observation', () => {
  it('refreshes outputs during settings revalidation while its audio cache remains subscribed', async () => {
    let devices: object[] = [];

    vi.stubGlobal('navigator', {
      mediaDevices: {
        enumerateDevices: async (): Promise<object[]> => devices,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      },
    });
    const { audio, observer } = fixture();
    const device = { audio } as unknown as DeviceCore;

    registerDevice(device, { observer } as DeviceInternals);
    audio.start();
    const cache = stateCache(audio, AudioEvent.StateChanged);
    const off = cache.subscribe(vi.fn());

    try {
      await loadDeviceSettings(device, new AbortController().signal);
      expect(cache.getSnapshot()).toMatchObject({ status: 'ready', value: { outputs: [] } });
      devices = [{ deviceId: 'headset', kind: 'audiooutput', label: 'Гарнитура' }];
      // No devicechange or permission/test revision change reaches the existing observer.
      await loadDeviceSettings(device, new AbortController().signal);
      expect(cache.getSnapshot()).toMatchObject({
        status: 'ready',
        value: { outputs: [{ id: 'headset', name: 'Гарнитура' }] },
      });
    } finally {
      off();
      audio.stop();
      disposeStateCaches(audio);
    }
  });

  it('keeps observing asynchronous test completion after a cancelled platform wait', async () => {
    const { audio, observer, complete, commands } = fixture({ cancelledWait: true });

    observer.start();
    const report = audio.test({ kind: 'sound' });

    await vi.waitFor(() =>
      expect(observer.source.getSnapshot().value?.audio.test?.status).toBe('running'),
    );
    complete();
    await expect(report).resolves.toMatchObject({
      checks: [{ check: 'hearing', status: 'notChecked' }],
    });
    expect(commands.filter((command) => command === 'device.changes.wait').length).toBeGreaterThan(
      1,
    );
    expect(observer.source.getSnapshot().error).toBeNull();
  });

  it('manual stop refreshes the final state even if the watcher was not started', async () => {
    const { audio, observer, commands } = fixture();
    const controller = new AbortController();
    const report = audio.test({ kind: 'sound' }, { signal: controller.signal });
    const settled = (async (): Promise<unknown> => {
      try {
        await report;
      } catch (cause) {
        return cause;
      }
    })();

    await vi.waitFor(() =>
      expect(observer.source.getSnapshot().value?.audio.test?.status).toBe('running'),
    );
    controller.abort();
    await expect(settled).resolves.toMatchObject({ code: 'CANCELLED' });
    expect(observer.source.getSnapshot().value?.audio.test?.status).toBe('cancelled');
    expect(commands.filter((command) => command === 'audio.test.stop')).toHaveLength(1);
  });

  it('a removed test is cancelled rather than leaving an unfinished promise', async () => {
    const { audio, commands } = fixture({ discardTest: true });

    await expect(audio.test({ kind: 'sound' })).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(commands).toContain('audio.test.stop');
  });

  it('explicit observer stop does not restart the cancelled wait', async () => {
    const { observer, commands } = fixture();

    observer.start();
    await vi.waitFor(() => expect(commands).toContain('device.changes.wait'));
    await observer.stop();
    const reads = commands.filter((command) => command === 'device.state.read').length;

    await Promise.resolve();
    expect(commands.filter((command) => command === 'device.state.read')).toHaveLength(reads);
  });

  it('a late read cannot overwrite a newer completed test state', async () => {
    const old = state();
    const latest = { ...state(), revision: 2 };
    let release!: (value: DeviceState) => void;
    let reads = 0;
    const observer = new DeviceObserver({
      execute: async (): Promise<unknown> => {
        reads++;

        if (reads === 1) {
          return new Promise<DeviceState>((resolve) => {
            release = resolve;
          });
        }

        return latest;
      },
    } as unknown as DeviceBridge);
    const first = observer.refresh();

    await observer.refresh();
    release(old);
    await expect(first).resolves.toMatchObject({ revision: 2 });
    expect(observer.source.getSnapshot().value?.revision).toBe(2);
  });
});

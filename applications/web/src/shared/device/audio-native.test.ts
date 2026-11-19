import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CallsClient } from '../calls/native-client';
import { AudioEvent, AudioOutputKind } from './api';
import { DeviceAudio } from './audio';
import type { DeviceBridge } from './contract';
import { StateSource } from './events';
import { NativeMedia } from './media-native';
import type { DeviceObserver } from './observer';

const host = vi.hoisted(() => ({
  cycle: '00000000-0000-4000-8000-000000000001',
  signal: new AbortController(),
  listener: null as ((event: unknown) => void) | null,
  commands: [] as { command: string; args: unknown }[],
  selected: 'receiver',
  outputs: ['receiver', 'speaker'],
  error: null as string | null,
  barrier: null as Promise<void> | null,
  preferred: null as string | null,
}));

vi.mock('../native/runtime', () => ({
  nativeRuntime: {
    getSnapshot: () => ({ phase: 'ready', cycleId: host.cycle, mediaVersion: 1 }),
    getToken: () => 'test-token',
    getSignal: () => host.signal.signal,
  },
}));
vi.mock('../native/bridge', () => ({
  embedded: true,
  nativePlugin: {
    addListener: async (_name: string, listener: (event: unknown) => void) => {
      host.listener = listener;

      return { remove: async () => {} };
    },
    mediaCommand: async (request: {
      cycleId: string;
      requestId: string;
      command: string;
      args: { outputId?: string };
    }): Promise<object> => {
      host.commands.push({ command: request.command, args: request.args });
      const output = (id: string): object => ({ id, name: id, kind: id });
      let result: object;

      if (request.command === 'selectAudioDevice') {
        if (host.error) {
          return {
            cycleId: request.cycleId,
            requestId: request.requestId,
            mediaVersion: 1,
            error: { code: host.error },
          };
        }

        host.selected = request.args.outputId!;
        result = { outcome: 'completed' };
      } else if (request.command === 'audio.setup.begin') {
        result = { setupId: '00000000-0000-4000-8000-000000000099' };
        await host.barrier;
      } else if (request.command === 'audio.setup.end') {
        result = { outcome: 'completed' };
      } else if (request.command === 'audio.preference.set') {
        host.preferred = request.args.outputId ?? null;
        result = { outcome: 'completed' };
      } else if (request.command === 'cancel') {
        result = { outcome: 'completed' };
      } else {
        result = {
          preference: host.preferred
            ? {
                mode: 'device',
                kind: host.preferred,
                name: host.preferred,
                availability: 'available',
              }
            : { mode: 'system' },
          output: output(host.selected),
          outputs: host.outputs.map(output),
          ...(request.command === 'audio.state' ? { volume: { level: 0.5 } } : {}),
        };
        await host.barrier;
      }

      return { cycleId: request.cycleId, requestId: request.requestId, mediaVersion: 1, result };
    },
  },
}));

function fixture(): DeviceAudio {
  return new DeviceAudio(
    {} as DeviceBridge,
    { source: new StateSource({ revision: 0, value: null }) } as unknown as DeviceObserver,
    new NativeMedia(() => host.signal.signal),
    {} as CallsClient,
    () => host.signal.signal,
  );
}

beforeEach(() => {
  host.cycle = '00000000-0000-4000-8000-000000000001';
  host.signal = new AbortController();
  host.listener = null;
  host.commands = [];
  host.selected = 'receiver';
  host.outputs = ['receiver', 'speaker'];
  host.error = null;
  host.barrier = null;
  host.preferred = null;
  vi.stubGlobal('navigator', {
    mediaDevices: {
      enumerateDevices: vi.fn(() => {
        throw new Error('Native must not enumerate browser devices');
      }),
      selectAudioOutput: vi.fn(() => {
        throw new Error('Native must not use the browser picker');
      }),
    },
  });
});
afterEach(() => vi.unstubAllGlobals());

describe('native audio devices', () => {
  it('lists native routes and selects through the native bridge', async () => {
    const audio = fixture();

    expect(audio.getOutputSupport()).toEqual({
      pick: false,
      select: true,
      setup: true,
      preference: true,
    });
    await expect(audio.outputs.list()).resolves.toEqual([
      { id: 'receiver', name: 'receiver', kind: AudioOutputKind.Receiver },
      { id: 'speaker', name: 'speaker', kind: AudioOutputKind.Speaker },
    ]);
    await audio.outputs.select('speaker');
    expect(host.commands.map(({ command }) => command)).toEqual([
      'getAudioDevices',
      'selectAudioDevice',
      'audio.state',
    ]);
    const { output } = await audio.getState();

    expect(output?.id).toBe('speaker');
    expect(navigator.mediaDevices.enumerateDevices).not.toHaveBeenCalled();
  });

  it('keeps the actual route when native rejects an unavailable device', async () => {
    const audio = fixture();
    const changed = vi.fn();

    audio.on(AudioEvent.OutputChanged, changed);
    await audio.getState();
    changed.mockClear();
    host.error = 'DEVICE_UNAVAILABLE';
    await expect(audio.outputs.select('missing')).rejects.toMatchObject({
      code: 'DEVICE_UNAVAILABLE',
    });
    expect(changed).not.toHaveBeenCalled();
    const { output } = await audio.getState();

    expect(output?.id).toBe('receiver');
    await expect(audio.outputs.select('')).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });

  it('updates routes from current-cycle native events and ignores events from an old cycle', async () => {
    const audio = fixture();
    const changed = vi.fn();

    audio.on(AudioEvent.OutputsChanged, changed);
    audio.start();
    await vi.waitFor(() => expect(host.listener).toBeTypeOf('function'));
    await audio.getState();
    changed.mockClear();
    host.outputs = ['receiver'];
    host.listener?.({ mediaVersion: 1, cycleId: 'old', kind: 'audioChanged' });
    expect(changed).not.toHaveBeenCalled();
    host.listener?.({ mediaVersion: 1, cycleId: host.cycle, kind: 'audioChanged' });
    await vi.waitFor(() => expect(changed).toHaveBeenCalledOnce());
    audio.stop();
  });

  it.each(['cancel', 'cycle', 'newer read'])(
    'does not publish a late native read after %s',
    async (reason) => {
      const audio = fixture();
      const changed = vi.fn();
      const controller = new AbortController();
      let release!: () => void;

      audio.on(AudioEvent.StateChanged, changed);
      host.barrier = new Promise<void>((resolve) => {
        release = resolve;
      });
      const reading = audio.outputs.list({ signal: controller.signal });
      // Attach a rejection observer before aborting the request.
      const settled = (async (): Promise<unknown> => {
        try {
          await reading;

          return null;
        } catch (cause) {
          return cause;
        }
      })();

      if (reason === 'cancel') {
        controller.abort();
      }

      if (reason === 'cycle') {
        host.cycle = '00000000-0000-4000-8000-000000000002';
      }

      if (reason === 'newer read') {
        host.barrier = null;
        host.selected = 'speaker';
        await audio.getState();
        changed.mockClear();
      }

      release();
      const result = await settled;

      if (reason !== 'newer read') {
        expect(result).toMatchObject({ code: 'CANCELLED' });
      }

      expect(changed).not.toHaveBeenCalled();
    },
  );
});

describe('native audio setup lifetime', () => {
  it('closes a late permission result when its requesting panel has already closed', async () => {
    const audio = fixture();
    const controller = new AbortController();
    let release!: () => void;

    host.barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pending = audio.outputs.beginSetup({ signal: controller.signal });

    controller.abort();
    host.barrier = null;
    release();
    await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
    await vi.waitFor(() =>
      expect(host.commands.some(({ command }) => command === 'audio.setup.end')).toBe(true),
    );
    expect(host.commands.some(({ command }) => command === 'cancel')).toBe(true);
  });

  it('saves preferences through native and closes a setup handle only once', async () => {
    const audio = fixture();
    const { close } = await audio.outputs.beginSetup();

    await audio.outputs.setPreferred('speaker');
    const { preference } = await audio.getState();

    expect(preference).toMatchObject({ mode: 'device', kind: 'speaker' });
    await close();
    await close();
    expect(host.commands.filter(({ command }) => command === 'audio.setup.end')).toHaveLength(1);
    await audio.outputs.setPreferred(null);
    const { preference: resetPreference } = await audio.getState();

    expect(resetPreference).toEqual({ mode: 'system' });
  });
});

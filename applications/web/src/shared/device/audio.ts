import type { PluginListenerHandle } from '@capacitor/core';
import { z } from 'zod';

import type { CallsClient } from '../calls/native-client';
import { embedded, nativePlugin } from '../native/bridge';
import { nativeRuntime } from '../native/runtime';
import {
  AudioEvent,
  type AudioEvents,
  type AudioOutput,
  AudioOutputKind,
  type AudioOutputSetup,
  type AudioService,
  type AudioState,
  type CallOptions,
  type CheckReport,
  CheckStatus,
  type Selection,
} from './api';
import { type DeviceBridge, DeviceError } from './contract';
import { cancellable, Events, StateSource } from './events';
import { deviceFailure } from './failure';
import { mediaDone, type NativeMedia } from './media-native';
import type { DeviceObserver } from './observer';

const output = z.strictObject({
  id: z.string(),
  name: z.string().nullable(),
  kind: z.nativeEnum(AudioOutputKind),
});
const preference = z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('system') }),
  z.strictObject({
    mode: z.literal('device'),
    kind: z.nativeEnum(AudioOutputKind),
    name: z.string().nullable(),
    availability: z.enum(['available', 'unavailable', 'unknown']),
  }),
]);
const nativeAudio = z.strictObject({
  preference,
  volume: z.strictObject({ level: z.number().min(0).max(1).nullable() }),
  output: output.nullable(),
  outputs: z.array(output).nullable(),
});
const nativeDevices = z.strictObject({
  preference,
  output: output.nullable(),
  outputs: z.array(output).nullable(),
});

interface OutputDevices extends MediaDevices {
  selectAudioOutput(): Promise<MediaDeviceInfo>;
}
function canPick(value: MediaDevices): value is OutputDevices {
  return 'selectAudioOutput' in value && typeof value.selectAudioOutput === 'function';
}

export class DeviceAudio extends Events<AudioEvents> implements AudioService {
  private readonly source = new StateSource<AudioState>({
    revision: 0,
    volume: { level: null },
    output: null,
    outputs: null,
    preference: null,
  });
  private off: (() => void) | null = null;
  private mediaHandle: PluginListenerHandle | null = null;
  private generation = 0;
  private loading: Promise<AudioState> | null = null;
  private outputId: string | null = null;
  private nativeRead = 0;
  private readonly setups = new Set<() => Promise<void>>();

  constructor(
    private readonly bridge: DeviceBridge,
    private readonly observer: DeviceObserver,
    private readonly media: NativeMedia,
    private readonly client: CallsClient,
    private readonly signal: () => AbortSignal,
  ) {
    super();
  }

  getOutputSupport(): { pick: boolean; select: boolean; setup: boolean; preference: boolean } {
    const select =
      !embedded &&
      typeof this.client.setAudioOutput === 'function' &&
      typeof HTMLMediaElement !== 'undefined' &&
      typeof HTMLMediaElement.prototype.setSinkId === 'function';

    return {
      pick: !embedded && select && !!navigator.mediaDevices && canPick(navigator.mediaDevices),
      select: embedded || select,
      setup:
        embedded ||
        (select && !!navigator.mediaDevices?.getUserMedia && !!this.client.audioPreparation),
      preference: embedded,
    };
  }

  readonly volume = {
    showControl: async (options?: CallOptions): Promise<void> => {
      if (!embedded) {
        throw new DeviceError('UNSUPPORTED');
      }

      await this.media.request('audio.volume', {}, mediaDone, options);
    },
  };
  readonly outputs = {
    beginSetup: async (options?: CallOptions): Promise<AudioOutputSetup> => {
      if (!embedded) {
        return this.beginBrowserSetup(options);
      }

      if (options?.signal?.aborted) {
        throw new DeviceError('CANCELLED');
      }

      // Cancellation reaches native while a late successful lease is still released by ID.
      const { setupId } = await this.media.request(
        'audio.setup.begin',
        {},
        z.strictObject({ setupId: z.uuid() }),
        options,
        async ({ setupId }): Promise<void> => {
          await this.media.request('audio.setup.end', { setupId }, mediaDone);
        },
      );
      let closed = false;
      const close = async (): Promise<void> => {
        if (closed) {
          return;
        }

        closed = true;
        this.setups.delete(close);
        options?.signal?.removeEventListener('abort', abort);
        await this.media.request('audio.setup.end', { setupId }, mediaDone);
        await this.refresh();
      };
      const abort = (): void => {
        void (async (): Promise<void> => {
          try {
            await close();
          } catch {}
        })();
      };

      this.setups.add(close);
      options?.signal?.addEventListener('abort', abort, { once: true });

      try {
        if (options?.signal?.aborted || this.signal().aborted) {
          throw new DeviceError('CANCELLED');
        }

        await this.refresh(options);

        return { close };
      } catch (cause) {
        try {
          await close();
        } catch {}

        throw cause;
      }
    },
    setPreferred: async (outputId: string | null, options?: CallOptions): Promise<void> => {
      if (!embedded) {
        throw new DeviceError('UNSUPPORTED');
      }

      if (outputId !== null && (typeof outputId !== 'string' || !outputId)) {
        throw new DeviceError('INVALID_ARGUMENT');
      }

      await this.media.request('audio.preference.set', { outputId }, mediaDone, options);
      await this.refresh(options);
    },
    list: async (options?: CallOptions): Promise<AudioOutput[] | null> => {
      if (options?.signal?.aborted) {
        throw new DeviceError('CANCELLED');
      }

      const { outputs: refreshResultOutputs } = embedded
        ? await this.refreshNative(true, options)
        : await this.refresh(options);

      return refreshResultOutputs;
    },
    pick: async (options?: CallOptions): Promise<Selection<AudioOutput>> => {
      if (embedded) {
        throw new DeviceError('UNSUPPORTED');
      }

      if (options?.signal?.aborted || this.signal().aborted) {
        throw new DeviceError('CANCELLED');
      }

      if (!this.getOutputSupport().pick || !canPick(navigator.mediaDevices)) {
        throw new DeviceError('UNSUPPORTED');
      }

      const devices = navigator.mediaDevices;
      let selected: MediaDeviceInfo;

      try {
        selected = await cancellable(
          (): Promise<MediaDeviceInfo> => devices.selectAudioOutput(),
          options,
          this.signal(),
        );
      } catch (cause) {
        if (cause instanceof DOMException && cause.name === 'NotAllowedError') {
          return { outcome: 'cancelled' };
        }

        throw deviceFailure(cause, 'audio', 'pick');
      }

      await this.outputs.select(selected.deviceId, options);

      return {
        outcome: 'completed',
        value: {
          id: selected.deviceId,
          name: selected.label || null,
          kind: AudioOutputKind.Unknown,
        },
      };
    },
    select: async (outputId: string, options?: CallOptions): Promise<void> => {
      if (typeof outputId !== 'string' || !outputId) {
        throw new DeviceError('INVALID_ARGUMENT');
      }

      if (embedded) {
        await this.media.request('selectAudioDevice', { outputId }, mediaDone, options);
        await this.refresh(options);

        return;
      }

      if (!this.getOutputSupport().select) {
        throw new DeviceError('UNSUPPORTED');
      }

      // The displayed list is already loaded. Re-enumerating here would leave
      // the selecting user gesture before WebKit receives setSinkId.
      if (!this.source.getSnapshot().outputs?.some((entry): boolean => entry.id === outputId)) {
        const { outputs } = await this.refresh(options);

        if (!outputs?.some((entry): boolean => entry.id === outputId)) {
          throw new DeviceError('DEVICE_UNAVAILABLE');
        }
      }

      await cancellable(
        (): Promise<void> => this.client.setAudioOutput!(outputId),
        options,
        this.signal(),
      );
      this.outputId = outputId;
      await this.refresh(options);
    },
  };

  private async beginBrowserSetup(options?: CallOptions): Promise<AudioOutputSetup> {
    const owner = this.client.audioPreparation;

    if (!this.getOutputSupport().setup || !owner) {
      throw new DeviceError('UNSUPPORTED');
    }

    const context = AbortSignal.any([this.signal(), ...(options?.signal ? [options.signal] : [])]);
    let released: { close(): void; signal: AbortSignal };

    try {
      released = await owner.beginSetup(context);
    } catch (cause) {
      throw deviceFailure(cause, 'audio', 'beginSetup');
    }

    const { close: release, signal } = released;
    let closed = false;
    const lost = (): void => {
      closed = true;
      this.setups.delete(close);
      this.publish({ ...this.source.getSnapshot(), output: null, outputs: null });
    };
    const close = async (): Promise<void> => {
      if (closed) {
        return;
      }

      closed = true;
      this.setups.delete(close);
      signal.removeEventListener('abort', lost);
      release();
      await this.refresh();
    };

    this.setups.add(close);
    signal.addEventListener('abort', lost, { once: true });

    try {
      if (this.loading) {
        await cancellable((): Promise<AudioState> => this.loading!, { signal });
      }

      await this.refresh({ signal });

      if (signal.aborted) {
        throw new DeviceError('CANCELLED');
      }

      return { close };
    } catch (cause) {
      await close();

      throw deviceFailure(cause, 'audio', 'beginSetup');
    }
  }

  private async refreshNative(devicesOnly: boolean, options?: CallOptions): Promise<AudioState> {
    const read = ++this.nativeRead;
    const value = devicesOnly
      ? await this.media.request('getAudioDevices', {}, nativeDevices, options)
      : await this.media.request('audio.state', {}, nativeAudio, options);

    if (options?.signal?.aborted || this.signal().aborted) {
      throw new DeviceError('CANCELLED');
    }

    if (read !== this.nativeRead) {
      return this.source.getSnapshot();
    }

    return this.publish({ ...this.source.getSnapshot(), ...value });
  }

  private publish(value: Omit<AudioState, 'revision'>): AudioState {
    const old = this.source.getSnapshot();
    const next = this.source.set({ ...value, revision: old.revision });

    if (next === old) {
      return next;
    }

    this.emit(AudioEvent.StateChanged, next);

    if (next.volume.level !== old.volume.level) {
      this.emit(AudioEvent.VolumeChanged, { revision: next.revision, level: next.volume.level });
    }

    if (JSON.stringify(next.output) !== JSON.stringify(old.output)) {
      this.emit(AudioEvent.OutputChanged, { revision: next.revision, output: next.output });
    }

    if (JSON.stringify(next.outputs) !== JSON.stringify(old.outputs)) {
      this.emit(AudioEvent.OutputsChanged, { revision: next.revision, outputs: next.outputs });
    }

    return next;
  }

  private refresh(options?: CallOptions): Promise<AudioState> {
    if (embedded) {
      return this.refreshNative(false, options);
    }

    if (this.loading) {
      return cancellable((): Promise<AudioState> => this.loading!, options, this.signal());
    }

    const task = async (): Promise<AudioState> => {
      if (!navigator.mediaDevices?.enumerateDevices) {
        return this.publish({
          volume: { level: null },
          output: null,
          outputs: null,
          preference: null,
        });
      }

      const values = await navigator.mediaDevices.enumerateDevices();
      const { filter: valuesFilter } = values;
      const outputs = valuesFilter
        .bind(values)((item): boolean => item.kind === 'audiooutput')
        .map((item): AudioOutput => ({
          id: item.deviceId,
          name: item.label || null,
          kind: AudioOutputKind.Unknown,
        }));

      if (this.outputId && !outputs.some((value): boolean => value.id === this.outputId)) {
        this.outputId = null;

        try {
          await this.client.setAudioOutput?.('');
        } catch (cause) {
          this.emit(AudioEvent.Error, {
            revision: this.source.getSnapshot().revision,
            error: deviceFailure(cause, 'audio', 'resetOutput'),
          });
        }
      }

      return this.publish({
        volume: { level: null },
        output: outputs.find((item): boolean => item.id === this.outputId) ?? null,
        outputs,
        preference: null,
      });
    };
    const pending = task();

    this.loading = pending;
    void (async () => {
      try {
        await pending;
      } catch (rejectedCause) {
        if (this.loading === pending) {
          this.loading = null;
        }

        return;
      }

      if (this.loading === pending) {
        this.loading = null;
      }
    })();

    return cancellable((): Promise<AudioState> => pending, options, this.signal());
  }

  async getState(options?: CallOptions): Promise<AudioState> {
    return this.refresh(options);
  }

  start(): void {
    if (this.off) {
      return;
    }

    const refresh = (): void => {
      void (async () => {
        try {
          return await this.refresh();
        } catch (cause) {
          return this.emit(AudioEvent.Error, {
            revision: this.source.getSnapshot().revision,
            error: deviceFailure(cause, 'audio', 'read'),
          });
        }
      })();
    };

    if (embedded) {
      const generation = ++this.generation;

      void (async () => {
        try {
          const handle = await nativePlugin.addListener('mediaEvent', (raw): void => {
            const event = z
              .object({
                mediaVersion: z.literal(1),
                cycleId: z.string(),
                kind: z.literal('audioChanged'),
              })
              .safeParse(raw);

            if (
              event.success &&
              event.data.cycleId === nativeRuntime.getSnapshot().cycleId &&
              generation === this.generation
            ) {
              refresh();
            }
          });

          if (generation === this.generation) {
            this.mediaHandle = handle;
          } else {
            const { remove: handleRemove } = handle;

            void handleRemove.bind(handle)();
          }
        } catch (cause) {}
      })();
    }

    const stop = this.observer.source.on(({ value }): void => {
      if (value) {
        refresh();
      }
    });

    if (!embedded) {
      navigator.mediaDevices?.addEventListener('devicechange', refresh);
    }

    this.off = (): void => {
      stop();

      if (!embedded) {
        navigator.mediaDevices?.removeEventListener('devicechange', refresh);
      }
    };
  }

  async check(options?: CallOptions): Promise<CheckReport> {
    if (options?.signal?.aborted) {
      throw new DeviceError('CANCELLED');
    }

    const state = this.client.getSnapshot();

    if (state.call && state.call.state !== 'ended') {
      return {
        checks: [
          {
            service: 'audio',
            check: 'playback',
            status: CheckStatus.NotChecked,
            reason: 'resourceInUse',
          },
        ],
      };
    }

    return {
      checks: [
        {
          service: 'audio',
          check: 'playback',
          status: CheckStatus.NotChecked,
          reason: 'userConfirmationRequired',
        },
      ],
    };
  }

  async test(
    test: { kind: 'microphone' | 'sound' },
    options: CallOptions = {},
  ): Promise<CheckReport> {
    if (test.kind !== 'microphone' && test.kind !== 'sound') {
      throw new DeviceError('INVALID_ARGUMENT');
    }

    let id: string | undefined;
    let terminal = false;
    let off = (): void => {};
    const context = AbortSignal.any([this.signal(), ...(options.signal ? [options.signal] : [])]);

    try {
      const call = this.client.getSnapshot().call;

      if (call && call.state !== 'ended') {
        throw new DeviceError('BUSY');
      }

      const { testId: startedTestId } = await cancellable(
        (): Promise<{ testId: string }> =>
          this.bridge.execute({ command: 'audio.test.start', args: test }),
        { signal: context },
      );

      id = startedTestId;
      await this.observer.refresh();

      return await cancellable(
        (): Promise<CheckReport> =>
          new Promise((resolve, reject): void => {
            const inspect = (): void => {
              const snapshot = this.observer.source.getSnapshot();

              if (snapshot.error) {
                reject(snapshot.error);

                return;
              }

              const value = snapshot.value?.audio.test;

              if (!value || value.id !== id) {
                reject(new DeviceError('CANCELLED'));

                return;
              }

              if (value.status === 'running') {
                return;
              }

              terminal = true;

              if (value.status === 'cancelled') {
                reject(new DeviceError('CANCELLED'));

                return;
              }

              if (value.status === 'failed') {
                resolve({
                  checks: [
                    {
                      service: 'audio',
                      check: test.kind,
                      status: CheckStatus.Failed,
                      error: deviceFailure(
                        new DeviceError(value.errorCode ?? 'DEVICE_UNAVAILABLE'),
                        'audio',
                        'test',
                      ),
                    },
                  ],
                });

                return;
              }

              resolve({
                checks: [
                  test.kind === 'sound'
                    ? {
                        service: 'audio',
                        check: 'hearing',
                        status: CheckStatus.NotChecked,
                        reason: 'userConfirmationRequired',
                      }
                    : { service: 'audio', check: 'microphone', status: CheckStatus.Passed },
                ],
              });
            };

            off = this.observer.source.on(inspect);
            inspect();
          }),
        { signal: context },
      );
    } catch (cause) {
      const error = deviceFailure(cause, 'audio', 'test');

      if (error.code === 'CANCELLED' || error.code === 'INVALID_ARGUMENT') {
        throw error;
      }

      return {
        checks: [{ service: 'audio', check: test.kind, status: CheckStatus.Failed, error }],
      };
    } finally {
      off();

      if (id && (context.aborted || !terminal)) {
        try {
          await this.bridge.execute({ command: 'audio.test.stop', args: { testId: id } });
          await this.observer.refresh();
        } catch {
          /* Session teardown can make the final read unavailable. */
        }
      }
    }
  }

  stop(): void {
    this.generation++;
    this.nativeRead++;

    for (const close of this.setups) {
      void (async (): Promise<void> => {
        try {
          await close();
        } catch {}
      })();
    }

    void this.mediaHandle?.remove();
    this.mediaHandle = null;
    this.off?.();
    this.off = null;
    this.clear();
  }
}

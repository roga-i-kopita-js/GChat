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
const nativeAudio = z.strictObject({
  volume: z.strictObject({ level: z.number().min(0).max(1).nullable() }),
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
  });
  private off: (() => void) | null = null;
  private mediaHandle: PluginListenerHandle | null = null;
  private generation = 0;
  private loading: Promise<AudioState> | null = null;
  private outputId: string | null = null;

  constructor(
    private readonly bridge: DeviceBridge,
    private readonly observer: DeviceObserver,
    private readonly media: NativeMedia,
    private readonly client: CallsClient,
    private readonly signal: () => AbortSignal,
  ) {
    super();
  }

  getOutputSupport(): { pick: boolean; select: boolean } {
    const select =
      !embedded &&
      typeof this.client.setAudioOutput === 'function' &&
      typeof HTMLMediaElement !== 'undefined' &&
      typeof HTMLMediaElement.prototype.setSinkId === 'function' &&
      typeof AudioContext !== 'undefined' &&
      typeof Reflect.get(AudioContext.prototype, 'setSinkId') === 'function';

    return {
      pick: embedded || (select && !!navigator.mediaDevices && canPick(navigator.mediaDevices)),
      select,
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
    list: async (options?: CallOptions): Promise<AudioOutput[] | null> => {
      if (options?.signal?.aborted) {
        throw new DeviceError('CANCELLED');
      }

      const { outputs: refreshResultOutputs } = await this.refresh(options);

      return refreshResultOutputs;
    },
    pick: async (options?: CallOptions): Promise<Selection<AudioOutput>> => {
      if (embedded) {
        const value = await this.media.request(
          'audio.pick',
          {},
          z.strictObject({
            outcome: z.enum(['completed', 'cancelled']),
            output: output.nullable(),
          }),
          options,
        );

        await this.refresh(options);

        const { outcome: valueOutcome } = value;

        if (valueOutcome === 'cancelled') {
          return { outcome: 'cancelled' };
        }

        const { output: valueOutput } = value ?? {};

        if (!valueOutput) {
          throw new DeviceError('DEVICE_UNAVAILABLE');
        }

        const { output: valueOutput2 } = value;

        return { outcome: 'completed', value: valueOutput };
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
      if (embedded) {
        throw new DeviceError('UNSUPPORTED');
      }

      if (typeof outputId !== 'string' || !outputId) {
        throw new DeviceError('INVALID_ARGUMENT');
      }

      if (!this.getOutputSupport().select) {
        throw new DeviceError('UNSUPPORTED');
      }

      const devices = await this.refresh(options);

      const { outputs: devicesOutputs } = devices ?? {};

      if (!devicesOutputs?.some((entry): boolean => entry.id === outputId)) {
        throw new DeviceError('DEVICE_UNAVAILABLE');
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
    if (this.loading) {
      return cancellable((): Promise<AudioState> => this.loading!, options, this.signal());
    }

    const task = async (): Promise<AudioState> => {
      if (embedded) {
        return this.publish(await this.media.request('audio.state', {}, nativeAudio));
      }

      if (!navigator.mediaDevices?.enumerateDevices) {
        return this.publish({ volume: { level: null }, output: null, outputs: null });
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
              const value = this.observer.source.getSnapshot().value?.audio.test;

              if (!value || value.id !== id || value.status === 'running') {
                return;
              }

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

      if (id && context.aborted) {
        await (async () => {
          try {
            return await this.bridge.execute({ command: 'audio.test.stop', args: { testId: id } });
          } catch (cause) {}
        })();
      }
    }
  }

  stop(): void {
    this.generation++;
    void this.mediaHandle?.remove();
    this.mediaHandle = null;
    this.off?.();
    this.off = null;
    this.clear();
  }
}

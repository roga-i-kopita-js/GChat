import type { PluginListenerHandle } from '@capacitor/core';
import { z } from 'zod';

import { nativePlugin } from '../native/bridge';
import { nativeRuntime } from '../native/runtime';
import {
  type CallOptions,
  CameraEvent,
  type CameraEvents,
  CameraFacing,
  CameraLifetime,
  type CameraService,
  type CameraSession,
  type CameraState,
  type CameraStreamRef,
  type CheckReport,
  CheckStatus,
  type RecordingSession,
} from './api';
import type { CallCameraPreviewState } from './camera-preview';
import { DeviceError, type FileRef, refSchema } from './contract';
import { cancellable, Events, StateSource } from './events';
import { deviceFailure } from './failure';
import { mediaDone, type NativeMedia } from './media-native';

const cameraState = z.strictObject({
  revision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  facing: z.nativeEnum(CameraFacing),
  status: z.enum(['starting', 'streaming', 'interrupted', 'error', 'released']),
  recording: z.enum(['idle', 'recording', 'stopping']),
  format: z
    .strictObject({
      width: z.number().positive(),
      height: z.number().positive(),
      frameRate: z.number().positive(),
    })
    .nullable(),
  error: z.strictObject({ code: z.string() }).nullable(),
});
const opened = z.strictObject({
  sessionId: z.string().uuid(),
  sourceId: z.string().uuid(),
  state: cameraState,
  call: z.boolean().optional(),
});
const mediaEvent = z.strictObject({
  mediaVersion: z.literal(1),
  cycleId: z.string().uuid(),
  sourceId: z.string().uuid(),
  call: z.boolean().optional(),
  kind: z.enum(['stateChanged', 'recordingSaved', 'interrupted', 'pip']),
  state: cameraState.optional(),
  file: refSchema.optional(),
  reason: z
    .enum(['background', 'resourceBusy', 'systemPressure', 'permissionLost', 'unknown'])
    .optional(),
  pip: z.enum(['inactive', 'starting', 'active', 'suspended', 'error']).optional(),
});

export class NativeCamera implements CameraService {
  readonly callPreview = new StateSource<CallCameraPreviewState>({
    revision: 0,
    source: null,
    status: 'released',
  });
  private isCall = false;
  private nativeCycle = '';
  private nativeRevision = -1;

  private accepts(raw: z.infer<typeof cameraState>): boolean {
    const cycle = nativeRuntime.getSnapshot().cycleId;

    if (cycle !== this.nativeCycle) {
      this.nativeCycle = cycle;
      this.nativeRevision = -1;
    }

    if (raw.revision === undefined) {
      return true;
    }

    if (raw.revision < this.nativeRevision) {
      return false;
    }

    this.nativeRevision = raw.revision;

    return true;
  }

  private synchronization = 0;

  private publishPreview(): void {
    this.callPreview.set({
      revision: 0,
      source: this.isCall && this.sourceId ? { id: this.sourceId } : null,
      status: this.state.getSnapshot().status,
    });
  }

  async resync(): Promise<void> {
    const snapshot = nativeRuntime.getSnapshot();
    const synchronization = ++this.synchronization;

    if (snapshot.phase !== 'ready' || snapshot.mediaVersion !== 1 || !nativeRuntime.getToken()) {
      this.sourceId = null;
      this.isCall = false;
      this.update({
        facing: this.state.getSnapshot().facing,
        status: 'released',
        recording: 'idle',
        format: null,
        error: null,
      });
      this.events.clear();

      return;
    }

    const value = await this.media.request(
      'camera.current',
      {},
      z.strictObject({
        sourceId: z.string().uuid().nullable(),
        call: z.boolean(),
        state: cameraState,
      }),
    );

    if (synchronization !== this.synchronization) {
      return;
    }

    const { state: valueState } = value;

    if (!this.accepts(valueState)) {
      return;
    }

    const { sourceId: valueSourceId } = value;

    if (this.sourceId !== valueSourceId) {
      this.events.clear();
    }

    const { sourceId: valueSourceId2 } = value;

    this.sourceId = valueSourceId2;
    const { call: valueCall } = value;

    this.isCall = valueCall;
    const { state: valueState2 } = value;

    this.update(valueState2);
    this.publishPreview();
  }

  private events = new Events<CameraEvents>();
  private state = new StateSource<CameraState>({
    revision: 0,
    facing: CameraFacing.Front,
    status: 'released',
    recording: 'idle',
    format: null,
    error: null,
  });
  private handle: PluginListenerHandle | null = null;
  private generation = 0;
  private sourceId: string | null = null;

  constructor(private readonly media: NativeMedia) {}

  private update(raw: z.infer<typeof cameraState>): CameraState {
    if (!this.accepts(raw)) {
      return this.state.getSnapshot();
    }

    const previous = this.state.getSnapshot();
    const next = this.state.set({
      ...raw,
      revision: previous.revision,
      error: raw.error ? deviceFailure(new DeviceError(raw.error.code), 'camera', 'capture') : null,
    });

    if (raw.status === 'released') {
      this.sourceId = null;
      this.isCall = false;
    }

    this.publishPreview();

    if (next !== previous) {
      this.events.emit(CameraEvent.StateChanged, next);
    }

    return next;
  }

  async start(): Promise<void> {
    if (this.handle) {
      return;
    }

    const generation = ++this.generation;
    const handle = await nativePlugin.addListener('mediaEvent', (input): void => {
      const value = mediaEvent.safeParse(input);

      if (
        !value.success ||
        value.data.cycleId !== nativeRuntime.getSnapshot().cycleId ||
        generation !== this.generation ||
        value.data.sourceId !== this.sourceId
      ) {
        return;
      }

      const fresh = !value.data.state || this.accepts(value.data.state);

      if (fresh) {
        this.isCall = value.data.call ?? this.isCall;

        if (value.data.state) {
          this.update(value.data.state);
        }
      }

      const revision = this.state.getSnapshot().revision;

      if (value.data.kind === 'recordingSaved' && value.data.file) {
        this.events.emit(CameraEvent.RecordingSaved, { revision, file: value.data.file });
      }

      if (value.data.kind === 'interrupted') {
        this.events.emit(CameraEvent.StreamInterrupted, {
          revision,
          reason: value.data.reason ?? 'unknown',
        });
      }

      if (fresh && value.data.kind === 'pip' && value.data.pip) {
        this.events.emit(CameraEvent.PictureInPictureChanged, { revision, status: value.data.pip });
      }

      if (fresh && value.data.state?.error) {
        this.events.emit(CameraEvent.Error, {
          revision,
          error: deviceFailure(new DeviceError(value.data.state.error.code), 'camera', 'capture'),
        });
      }
    });

    if (generation !== this.generation) {
      const { remove: handleRemove } = handle;

      await handleRemove.bind(handle)();

      return;
    }

    this.handle = handle;
    await this.resync();
  }

  async check(
    facing: CameraFacing = CameraFacing.Front,
    options?: CallOptions,
  ): Promise<CheckReport> {
    if (nativeRuntime.getSnapshot().mediaVersion !== 1) {
      return {
        checks: [
          {
            service: 'camera',
            check: 'capture',
            status: CheckStatus.NotChecked,
            reason: 'unsupported',
          },
        ],
      };
    }

    const checks = await this.media.request(
      'camera.check',
      { facing },
      z.strictObject({
        checks: z.array(
          z.strictObject({
            check: z.enum(['capture', 'pictureInPicture', 'multitasking']),
            status: z.enum(['notChecked', 'passed']),
            reason: z
              .enum([
                'permissionRequired',
                'resourceInUse',
                'unsupported',
                'userConfirmationRequired',
              ])
              .optional(),
          }),
        ),
      }),
      options,
    );

    const { checks: checksChecks } = checks;

    return {
      checks: checksChecks.map((value): CheckReport['checks'][number] =>
        value.status === 'passed'
          ? { service: 'camera', check: value.check, status: CheckStatus.Passed }
          : {
              service: 'camera',
              check: value.check,
              status: CheckStatus.NotChecked,
              reason: value.reason ?? 'userConfirmationRequired',
            },
      ),
    };
  }

  async test(facing: CameraFacing, options?: CallOptions): Promise<CheckReport> {
    try {
      await this.media.request('camera.test', { facing }, mediaDone, options);

      return { checks: [{ service: 'camera', check: 'capture', status: CheckStatus.Passed }] };
    } catch (cause) {
      const error = deviceFailure(cause, 'camera', 'test');

      if (error.code === 'CANCELLED' || error.code === 'INVALID_ARGUMENT') {
        throw error;
      }

      return {
        checks: [{ service: 'camera', check: 'capture', status: CheckStatus.Failed, error }],
      };
    }
  }

  async open(
    camera: { facing: CameraFacing; lifetime?: CameraLifetime },
    options?: CallOptions,
  ): Promise<CameraSession> {
    const cycle = nativeRuntime.getSnapshot().cycleId;
    const result = await this.media.request(
      'camera.open',
      { facing: camera.facing, lifetime: camera.lifetime ?? CameraLifetime.View },
      opened,
      options,
    );

    const { sourceId: resultSourceId } = result;

    if (this.sourceId !== resultSourceId) {
      this.events.clear();
    }

    const { sourceId: resultSourceId2 } = result;

    this.sourceId = resultSourceId2;
    const { call: resultCall } = result;

    this.isCall = resultCall ?? camera.lifetime === CameraLifetime.Call;
    const { state: resultState } = result;

    this.update(resultState);
    let released = false;
    const valid = (): void => {
      const { sourceId: resultSourceId3 } = result;

      if (
        released ||
        this.sourceId !== resultSourceId3 ||
        this.state.getSnapshot().status === 'released'
      ) {
        throw new DeviceError('INVALID_STATE');
      }

      if (cycle !== nativeRuntime.getSnapshot().cycleId) {
        throw new DeviceError('CANCELLED');
      }
    };

    return {
      getState: async (callOptions): Promise<CameraState> => {
        valid();

        const { sessionId: resultSessionId } = result;

        return this.update(
          await this.media.request(
            'camera.state',
            { sessionId: resultSessionId },
            cameraState,
            callOptions,
          ),
        );
      },
      getStream: async (callOptions): Promise<CameraStreamRef> => {
        valid();

        if (callOptions?.signal?.aborted) {
          throw new DeviceError('CANCELLED');
        }

        const { sourceId: resultSourceId4 } = result;

        return Object.freeze({ id: resultSourceId4 });
      },
      on: (event, handler): (() => void) => {
        valid();

        return this.events.on(event, (value): void => {
          if (!released && cycle === nativeRuntime.getSnapshot().cycleId) {
            handler(value);
          }
        });
      },
      setFacing: async (facing, callOptions): Promise<void> => {
        valid();
        const { sessionId: resultSessionId2 } = result;

        this.update(
          await this.media.request(
            'camera.facing',
            { sessionId: resultSessionId2, facing },
            cameraState,
            callOptions,
          ),
        );
      },
      takePhoto: async (callOptions): Promise<FileRef> => {
        valid();

        const { sessionId: resultSessionId3 } = result;

        return this.media.request(
          'camera.photo',
          { sessionId: resultSessionId3 },
          refSchema,
          callOptions,
        );
      },
      startRecording: async (callOptions): Promise<RecordingSession> => {
        valid();
        const { sessionId: resultSessionId4 } = result;
        const recording = await this.media.request(
          'camera.record',
          { sessionId: resultSessionId4 },
          z.strictObject({ recordingId: z.string().uuid() }),
          callOptions,
        );
        let stopping: Promise<FileRef> | null = null;

        return {
          stop: (stopOptions): Promise<FileRef> => {
            if (stopOptions?.signal?.aborted) {
              return Promise.reject(new DeviceError('CANCELLED'));
            }

            if (!stopping) {
              valid();
            }

            const { recordingId: recordingRecordingId } = recording;

            stopping ??= this.media.request(
              'camera.stopRecording',
              { recordingId: recordingRecordingId },
              refSchema,
            );

            return cancellable((): Promise<FileRef> => stopping!, stopOptions);
          },
        };
      },
      release: async (): Promise<void> => {
        if (released) {
          return;
        }

        released = true;

        if (cycle !== nativeRuntime.getSnapshot().cycleId) {
          return;
        }

        const { sessionId: resultSessionId5 } = result;

        await this.media.request('camera.release', { sessionId: resultSessionId5 }, mediaDone);
      },
    };
  }

  async close(options?: CallOptions): Promise<void> {
    await this.media.request('camera.close', {}, mediaDone, options);
    this.sourceId = null;
    this.update({
      facing: this.state.getSnapshot().facing,
      status: 'released',
      recording: 'idle',
      format: null,
      error: null,
    });
    this.events.clear();
  }

  private binding = Promise.resolve();
  private bindingSequence = 0;
  private bindingRevisions = new Map<string, number>();

  bind(
    source: CameraStreamRef,
    rect: { x: number; y: number; width: number; height: number },
    visible: boolean,
    previewId: string,
    priority: 'view' | 'call' = 'view',
  ): Promise<void> {
    const revision = ++this.bindingSequence;

    this.bindingRevisions.set(previewId, revision);
    const pending = (async () => {
      await (async () => {
        try {
          return await this.binding;
        } catch (cause) {}
      })();

      if (this.bindingRevisions.get(previewId) !== revision) {
        return;
      }

      await this.media.request(
        'camera.preview',
        { sourceId: source.id, previewId, rect, visible, priority },
        mediaDone,
      );

      if (!visible && this.bindingRevisions.get(previewId) === revision) {
        this.bindingRevisions.delete(previewId);
      }
    })();

    this.binding = pending;

    return pending;
  }

  async stop(): Promise<void> {
    this.generation++;
    this.synchronization++;
    this.callPreview.set({ revision: 0, source: null, status: 'released' });

    await (async () => {
      try {
        return await this.binding;
      } catch (cause) {}
    })();
    this.bindingRevisions.clear();

    if (this.handle) {
      await (async () => {
        try {
          return await this.media.releaseViews();
        } catch (cause) {}
      })();
    }

    await this.handle?.remove();
    this.handle = null;
    this.events.clear();
  }
}

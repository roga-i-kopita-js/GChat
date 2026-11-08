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

    if (!this.accepts(value.state)) {
      return;
    }

    if (this.sourceId !== value.sourceId) {
      this.events.clear();
    }

    this.sourceId = value.sourceId;
    this.isCall = value.call;
    this.update(value.state);
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
      await handle.remove();

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

    return {
      checks: checks.checks.map((value): CheckReport['checks'][number] =>
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

    if (this.sourceId !== result.sourceId) {
      this.events.clear();
    }

    this.sourceId = result.sourceId;
    this.isCall = result.call ?? camera.lifetime === CameraLifetime.Call;
    this.update(result.state);
    let released = false;
    const valid = (): void => {
      if (
        released ||
        this.sourceId !== result.sourceId ||
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

        return this.update(
          await this.media.request(
            'camera.state',
            { sessionId: result.sessionId },
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

        return Object.freeze({ id: result.sourceId });
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
        this.update(
          await this.media.request(
            'camera.facing',
            { sessionId: result.sessionId, facing },
            cameraState,
            callOptions,
          ),
        );
      },
      takePhoto: async (callOptions): Promise<FileRef> => {
        valid();

        return this.media.request(
          'camera.photo',
          { sessionId: result.sessionId },
          refSchema,
          callOptions,
        );
      },
      startRecording: async (callOptions): Promise<RecordingSession> => {
        valid();
        const recording = await this.media.request(
          'camera.record',
          { sessionId: result.sessionId },
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

            stopping ??= this.media.request(
              'camera.stopRecording',
              { recordingId: recording.recordingId },
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

        await this.media.request('camera.release', { sessionId: result.sessionId }, mediaDone);
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
    const pending = this.binding
      .catch((): void => {})
      .then(async (): Promise<void> => {
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
      });

    this.binding = pending;

    return pending;
  }

  async stop(): Promise<void> {
    this.generation++;
    this.synchronization++;
    this.callPreview.set({ revision: 0, source: null, status: 'released' });

    await this.binding.catch((): void => {});
    this.bindingRevisions.clear();

    if (this.handle) {
      await this.media.releaseViews().catch((): void => {});
    }

    await this.handle?.remove();
    this.handle = null;
    this.events.clear();
  }
}

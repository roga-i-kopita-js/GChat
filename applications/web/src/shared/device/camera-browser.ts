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
import type { CameraStore } from './camera-store';
import { DeviceError, type FileRef } from './contract';
import { cancellable, Events, StateSource } from './events';
import { deviceFailure } from './failure';

interface Recording {
  recorder: MediaRecorder;
  result: Promise<FileRef>;
  stop(): void;
}
interface Source {
  id: string;
  stream: MediaStream;
  facing: CameraFacing;
  holds: Set<string>;
  call: string | null;
  opening: boolean;
  recording: Recording | null;
  recordingStarting: boolean;
}

/** Owns one video-only source, outside React; mounting a preview never acquires a device. */
export class BrowserCamera implements CameraService {
  readonly callPreview = new StateSource<CallCameraPreviewState>({
    revision: 0,
    source: null,
    status: 'released',
  });

  private publishPreview(): void {
    this.callPreview.set({
      revision: 0,
      source: this.source?.call ? { id: this.source.id } : null,
      status: this.state.getSnapshot().status,
    });
  }

  private source: Source | null = null;
  private opening: Promise<void> | null = null;
  private epoch = 0;
  private closing: Promise<void> | null = null;
  private events = new Events<CameraEvents>();
  private state = new StateSource<CameraState>({
    revision: 0,
    facing: CameraFacing.Front,
    status: 'released',
    recording: 'idle',
    format: null,
    error: null,
  });
  private stopped = false;
  private preview = new Set<HTMLVideoElement>();

  constructor(
    private readonly store: CameraStore,
    private readonly signal: () => AbortSignal,
    private readonly selectedCall: () => string | null,
    private readonly authenticated: () => boolean,
  ) {}

  private set(patch: Partial<CameraState>): void {
    const before = this.state.getSnapshot();
    const next = this.state.set({ ...before, ...patch });

    if (next !== before) {
      this.events.emit(CameraEvent.StateChanged, next);
      this.publishPreview();
    }
  }

  private guard(options?: CallOptions): void {
    if (this.stopped) {
      throw new DeviceError('INVALID_STATE');
    }

    if (options?.signal?.aborted || this.signal().aborted) {
      throw new DeviceError('CANCELLED');
    }

    if (!this.authenticated()) {
      throw new DeviceError('UNAUTHENTICATED');
    }
  }

  async check(
    facing: CameraFacing = CameraFacing.Front,
    options?: CallOptions,
  ): Promise<CheckReport> {
    this.guard(options);

    if (!Object.values(CameraFacing).includes(facing)) {
      throw new DeviceError('INVALID_ARGUMENT');
    }

    if (!navigator.mediaDevices?.getUserMedia) {
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

    if (this.source) {
      return {
        checks: [
          {
            service: 'camera',
            check: 'capture',
            status: CheckStatus.NotChecked,
            reason: 'resourceInUse',
          },
        ],
      };
    }

    return {
      checks: [
        {
          service: 'camera',
          check: 'capture',
          status: CheckStatus.NotChecked,
          reason: 'permissionRequired',
        },
      ],
    };
  }

  async test(facing: CameraFacing, options?: CallOptions): Promise<CheckReport> {
    this.guard(options);

    if (this.source) {
      return {
        checks: [
          {
            service: 'camera',
            check: 'capture',
            status: CheckStatus.Failed,
            error: deviceFailure(new DeviceError('BUSY'), 'camera', 'test'),
          },
        ],
      };
    }

    let session: CameraSession | undefined;

    try {
      session = await this.open({ facing }, options);

      return { checks: [{ service: 'camera', check: 'capture', status: CheckStatus.Passed }] };
    } catch (cause) {
      const error = deviceFailure(cause, 'camera', 'test');

      if (error.code === 'CANCELLED' || error.code === 'INVALID_ARGUMENT') {
        throw error;
      }

      return {
        checks: [{ service: 'camera', check: 'capture', status: CheckStatus.Failed, error }],
      };
    } finally {
      await session?.release();
    }
  }

  private async capture(source: Source, facing: CameraFacing): Promise<void> {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new DeviceError('UNSUPPORTED');
    }

    if (!navigator.mediaDevices.getSupportedConstraints().facingMode) {
      throw new DeviceError('DEVICE_UNAVAILABLE');
    }

    const epoch = this.epoch;
    const captured = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: { exact: facing === CameraFacing.Front ? 'user' : 'environment' },
        width: { ideal: 1280 },
        height: { ideal: 720 },
        frameRate: { ideal: 30 },
      },
    });

    if (epoch !== this.epoch || this.source !== source) {
      const { getTracks: capturedGetTracks } = captured;

      for (const track of capturedGetTracks.bind(captured)()) {
        track.stop();
      }

      throw new DeviceError('CANCELLED');
    }

    const { getVideoTracks: capturedGetVideoTracks } = captured;
    const track = capturedGetVideoTracks.bind(captured)()[0];

    if (!track) {
      const { getTracks: capturedGetTracks2 } = captured;

      for (const item of capturedGetTracks2.bind(captured)()) {
        item.stop();
      }

      throw new DeviceError('DEVICE_UNAVAILABLE');
    }

    const actual = track.getSettings();

    if (
      actual.facingMode &&
      actual.facingMode !== (facing === CameraFacing.Front ? 'user' : 'environment')
    ) {
      const { getTracks: capturedGetTracks3 } = captured;

      for (const item of capturedGetTracks3.bind(captured)()) {
        item.stop();
      }

      throw new DeviceError('DEVICE_UNAVAILABLE');
    }

    for (const old of source.stream.getTracks()) {
      old.stop();
      source.stream.removeTrack(old);
    }

    const { getVideoTracks: capturedGetVideoTracks2 } = captured;

    for (const item of capturedGetVideoTracks2.bind(captured)()) {
      source.stream.addTrack(item);
    }

    source.facing = facing;
    source.opening = false;
    track.addEventListener(
      'ended',
      (): void => {
        if (this.source !== source || source.stream.getVideoTracks()[0] !== track) {
          return;
        }

        this.set({
          status: 'interrupted',
          error: deviceFailure(new DeviceError('DEVICE_UNAVAILABLE'), 'camera', 'capture'),
        });
        this.events.emit(CameraEvent.StreamInterrupted, {
          revision: this.state.getSnapshot().revision,
          reason: 'unknown',
        });
        source.recording?.stop();
      },
      { once: true },
    );
    this.set({
      facing,
      status: 'streaming',
      format: {
        width: actual.width ?? 1280,
        height: actual.height ?? 720,
        frameRate: actual.frameRate ?? 30,
      },
      error: null,
    });

    for (const video of this.preview) {
      video.srcObject = source.stream;
      void (async () => {
        try {
          return await video.play();
        } catch (cause) {}
      })();
    }
  }

  async open(
    camera: { facing: CameraFacing; lifetime?: CameraLifetime },
    options?: CallOptions,
  ): Promise<CameraSession> {
    this.guard(options);

    if (this.closing) {
      throw new DeviceError('BUSY');
    }

    if (
      !Object.values(CameraFacing).includes(camera.facing) ||
      (camera.lifetime && !Object.values(CameraLifetime).includes(camera.lifetime))
    ) {
      throw new DeviceError('INVALID_ARGUMENT');
    }

    const call = camera.lifetime === CameraLifetime.Call ? this.selectedCall() : null;

    if (camera.lifetime === CameraLifetime.Call && !call) {
      throw new DeviceError('INVALID_STATE');
    }

    let source = this.source;

    if (source && source.facing !== camera.facing) {
      throw new DeviceError('BUSY');
    }

    if (!source) {
      this.events.clear();
      source = {
        id: crypto.randomUUID(),
        stream: new MediaStream(),
        facing: camera.facing,
        holds: new Set(),
        call: null,
        opening: true,
        recording: null,
        recordingStarting: false,
      };
      this.source = source;
      this.set({
        facing: camera.facing,
        status: 'starting',
        recording: 'idle',
        format: null,
        error: null,
      });
      const value = source;

      this.opening = (async () => {
        try {
          return await this.capture(value, camera.facing);
        } catch (cause) {
          if (this.source === value) {
            this.source = null;
            this.set({ status: 'error', error: deviceFailure(cause, 'camera', 'open') });
          }

          throw cause;
        }
      })();
    }

    const current = source;
    const hold = crypto.randomUUID();

    current.holds.add(hold);

    try {
      if (this.opening) {
        await cancellable((): Promise<void> => this.opening!, options, this.signal());
      }
    } catch (cause) {
      current.holds.delete(hold);

      if (this.source === current && !current.holds.size && !current.call) {
        await this.close();
      }

      throw deviceFailure(cause, 'camera', 'open');
    }

    if (this.source !== current) {
      throw new DeviceError('CANCELLED');
    }

    if (call) {
      current.call = call;
      this.publishPreview();
    }

    const context = this.signal();
    let released = false;
    const valid = (callOptions?: CallOptions): void => {
      if (released || this.source !== current || !current.holds.has(hold)) {
        throw new DeviceError('INVALID_STATE');
      }

      if (context.aborted || callOptions?.signal?.aborted) {
        throw new DeviceError('CANCELLED');
      }
    };

    return {
      getState: async (callOptions): Promise<CameraState> => {
        valid(callOptions);

        return this.state.getSnapshot();
      },
      getStream: async (callOptions): Promise<CameraStreamRef> => {
        valid(callOptions);

        return Object.freeze({ id: current.id });
      },
      on: (event, handler): (() => void) => {
        valid();

        return this.events.on(event, (value): void => {
          if (!released && !context.aborted) {
            handler(value);
          }
        });
      },
      setFacing: async (facing, callOptions): Promise<void> => {
        valid(callOptions);

        if (!Object.values(CameraFacing).includes(facing)) {
          throw new DeviceError('INVALID_ARGUMENT');
        }

        if (current.recording || current.recordingStarting || current.opening) {
          throw new DeviceError('BUSY');
        }

        if (facing === current.facing && this.state.getSnapshot().status === 'streaming') {
          return;
        }

        for (const track of current.stream.getTracks()) {
          track.stop();
        }

        current.opening = true;
        current.facing = facing;
        this.set({ status: 'starting' });
        const pending = this.capture(current, facing);

        void (async () => {
          try {
            await pending;
          } catch (rejectedCause) {
            current.opening = false;

            return;
          }

          current.opening = false;
        })();

        try {
          await cancellable((): Promise<void> => pending, callOptions, context);
        } catch (cause) {
          const error = deviceFailure(cause, 'camera', 'setFacing');

          if (this.source === current && error.code !== 'CANCELLED') {
            this.set({ status: 'error', error });
          }

          throw error;
        }
      },
      takePhoto: async (callOptions): Promise<FileRef> => {
        valid(callOptions);

        return cancellable((): Promise<FileRef> => this.photo(current), callOptions, context);
      },
      startRecording: async (callOptions): Promise<RecordingSession> => {
        valid(callOptions);

        return this.record(current, callOptions);
      },
      release: async (): Promise<void> => {
        if (released) {
          return;
        }

        released = true;
        current.holds.delete(hold);

        if (this.source === current && !current.holds.size && !current.call) {
          await this.close();
        }
      },
    };
  }

  private async photo(source: Source): Promise<FileRef> {
    if (this.source !== source || this.state.getSnapshot().status !== 'streaming') {
      throw new DeviceError('INVALID_STATE');
    }

    const video = document.createElement('video');

    video.muted = true;
    video.playsInline = true;
    video.srcObject = source.stream;

    try {
      await video.play();

      if (!video.videoWidth || !video.videoHeight) {
        throw new DeviceError('DEVICE_UNAVAILABLE');
      }

      const canvas = document.createElement('canvas');

      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const context = canvas.getContext('2d');

      if (!context) {
        throw new DeviceError('UNSUPPORTED');
      }

      context.drawImage(video, 0, 0);
      const blob = await new Promise<Blob>((resolve, reject): void =>
        canvas.toBlob(
          (value): void => {
            if (value) {
              resolve(value);
            } else {
              reject(new DeviceError('IO_ERROR'));
            }
          },
          'image/jpeg',
          0.9,
        ),
      );

      if (this.source !== source) {
        throw new DeviceError('CANCELLED');
      }

      return await this.store.photo(blob);
    } finally {
      video.pause();
      video.srcObject = null;
    }
  }

  private async record(source: Source, options?: CallOptions): Promise<RecordingSession> {
    if (source.recording || source.recordingStarting || source.opening) {
      throw new DeviceError('BUSY');
    }

    source.recordingStarting = true;

    try {
      if (typeof MediaRecorder === 'undefined') {
        throw new DeviceError('UNSUPPORTED');
      }

      const type = ['video/mp4;codecs=avc1.42E01E', 'video/webm;codecs=vp8', 'video/webm'].find(
        (value): boolean => MediaRecorder.isTypeSupported(value),
      );
      const recorder = new MediaRecorder(source.stream, type ? { mimeType: type } : undefined);
      const mime = recorder.mimeType || type || 'video/webm';
      let extension;

      if (mime.includes('mp4')) {
        extension = 'mp4';
      } else if (mime.includes('webm')) {
        extension = 'webm';
      } else {
        extension = 'video';
      }

      const staged = await this.store.begin(extension, mime);

      if (this.source !== source || options?.signal?.aborted) {
        const { abort: stagedAbort } = staged;

        await stagedAbort.bind(staged)();

        throw new DeviceError('CANCELLED');
      }

      let resolve!: (file: FileRef) => void;
      let reject!: (error: unknown) => void;
      const result = new Promise<FileRef>((yes, no): void => {
        resolve = yes;
        reject = no;
      });

      void (async () => {
        try {
          return await result;
        } catch (cause) {}
      })();
      let queue: Promise<void> = Promise.resolve();
      let queued = 0;
      let size = 0;
      let failed: unknown = null;
      let stopped = false;
      let timer: ReturnType<typeof setTimeout>;
      const stop = (): void => {
        if (stopped) {
          return;
        }

        stopped = true;
        clearTimeout(timer);
        this.set({ recording: 'stopping' });

        if (recorder.state !== 'inactive') {
          recorder.stop();
        }
      };
      const fail = (cause: unknown): void => {
        failed = cause;
        stop();
      };

      recorder.addEventListener('dataavailable', (event): void => {
        if (!event.data.size) {
          return;
        }

        size += event.data.size;
        queued += event.data.size;

        if (queued > 8 * 1024 * 1024) {
          fail(new DeviceError('IO_ERROR'));

          return;
        }

        queue = (async () => {
          try {
            await queue;

            if (!failed) {
              const { write: stagedWrite } = staged;

              await stagedWrite.bind(staged)(event.data);
            }

            queued -= event.data.size;
          } catch (cause) {
            return fail(cause);
          }
        })();

        if (size >= 256 * 1024 * 1024) {
          stop();
        }
      });
      recorder.addEventListener('error', (): void => fail(new DeviceError('DEVICE_UNAVAILABLE')));
      recorder.addEventListener(
        'stop',
        (): void => {
          clearTimeout(timer);
          void (async () => {
            try {
              await queue;

              if (failed) {
                const { abort: stagedAbort2 } = staged;

                await stagedAbort2.bind(staged)();

                throw failed;
              }

              const { commit: stagedCommit } = staged;
              const file = await stagedCommit.bind(staged)();

              this.events.emit(CameraEvent.RecordingSaved, {
                revision: this.state.getSnapshot().revision,
                file,
              });
              resolve(file);
            } catch (cause) {
              const { abort: stagedAbort3 } = staged;

              await stagedAbort3.bind(staged)();
              reject(deviceFailure(cause, 'camera', 'record'));
            } finally {
              if (source.recording?.recorder === recorder) {
                source.recording = null;
              }

              if (this.source === source) {
                this.set({ recording: 'idle' });
              }
            }
          })();
        },
        { once: true },
      );
      source.recording = { recorder, result, stop };

      try {
        recorder.start(1000);
        this.set({ recording: 'recording' });
        timer = setTimeout(stop, 5 * 60 * 1000);
      } catch (cause) {
        source.recording = null;
        const { abort: stagedAbort4 } = staged;

        await stagedAbort4.bind(staged)();

        throw deviceFailure(cause, 'camera', 'startRecording');
      }

      return {
        stop: (callOptions): Promise<FileRef> => {
          if (callOptions?.signal?.aborted) {
            return Promise.reject(new DeviceError('CANCELLED'));
          }

          stop();

          return cancellable((): Promise<FileRef> => result, callOptions);
        },
      };
    } finally {
      source.recordingStarting = false;
    }
  }

  attach(source: CameraStreamRef, video: HTMLVideoElement): () => void {
    const current = this.source;

    if (!current || current.id !== source.id) {
      throw new DeviceError('INVALID_STATE');
    }

    video.muted = true;
    video.playsInline = true;
    video.srcObject = current.stream;
    this.preview.add(video);
    void (async () => {
      try {
        return await video.play();
      } catch (cause) {}
    })();

    return (): void => {
      this.preview.delete(video);
      video.pause();
      video.srcObject = null;
    };
  }

  close(options?: CallOptions): Promise<void> {
    if (options?.signal?.aborted) {
      return Promise.reject(new DeviceError('CANCELLED'));
    }

    if (this.closing) {
      return cancellable((): Promise<void> => this.closing!, options);
    }

    const source = this.source;

    this.epoch++;
    this.source = null;
    this.publishPreview();
    this.opening = null;

    if (!source) {
      return Promise.resolve();
    }

    source.holds.clear();
    source.call = null;
    source.recording?.stop();

    for (const track of source.stream.getTracks()) {
      track.stop();
    }

    for (const video of this.preview) {
      video.pause();
      video.srcObject = null;
    }

    this.preview.clear();
    const pending = (async (): Promise<void> => {
      try {
        await ((async () => {
          try {
            return await source.recording?.result;
          } catch (cause) {}
        })() ?? Promise.resolve());
      } finally {
        this.set({ status: 'released', recording: 'idle', format: null, error: null });
        this.events.clear();
        this.closing = null;
      }
    })();

    this.closing = pending;

    return cancellable((): Promise<void> => pending, options);
  }

  async resetViews(): Promise<void> {
    const source = this.source;

    if (!source) {
      return;
    }

    source.holds.clear();

    if (!source.call) {
      await this.close();
    }
  }

  callChanged(): void {
    if (this.source?.call && this.source.call !== this.selectedCall()) {
      void this.close();
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.close();
    this.events.clear();
  }
}

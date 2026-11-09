import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CameraEvent, CameraFacing, CameraLifetime } from './api';
import { NativeCamera } from './camera-native';
import { NativeMedia } from './media-native';

interface NativeCameraHost {
  cycle: string;
  phase: string;
  source: string;
  session: string;
  state: {
    revision: number;
    facing: string;
    status: string;
    recording: string;
    format: { width: number; height: number; frameRate: number };
    error: null;
  };
  readBarrier: Promise<void> | null;
  token: boolean;
  signal: AbortController;
  listener: ((event: unknown) => void) | null;
  commands: { command: string; args: unknown }[];
}
const host = vi.hoisted((): NativeCameraHost => {
  const state = {
    revision: 1,
    facing: 'front',
    status: 'streaming',
    recording: 'idle',
    format: { width: 720, height: 1280, frameRate: 30 },
    error: null,
  };

  return {
    cycle: '00000000-0000-4000-8000-000000000001',
    phase: 'ready',
    source: '00000000-0000-4000-8000-000000000002',
    session: '00000000-0000-4000-8000-000000000003',
    state,
    readBarrier: null,
    token: true,
    signal: new AbortController(),
    listener: null as ((event: unknown) => void) | null,
    commands: [] as { command: string; args: unknown }[],
  };
});

vi.mock('../native/runtime', (): object => ({
  nativeRuntime: {
    getSnapshot: (): object => ({ phase: host.phase, cycleId: host.cycle, mediaVersion: 1 }),
    getToken: (): string | null => (host.token ? 'test-token' : null),
    getSignal: (): AbortSignal => host.signal.signal,
  },
}));
vi.mock('../native/bridge', (): object => ({
  nativePlugin: {
    addListener: async (
      _name: string,
      callback: (value: unknown) => void,
    ): Promise<{ remove(): Promise<void> }> => {
      host.listener = callback;

      return {
        remove: async (): Promise<void> => {
          host.listener = null;
        },
      };
    },
    mediaCommand: async (request: {
      command: string;
      args: unknown;
      requestId: string;
      cycleId: string;
    }): Promise<object> => {
      host.commands.push({ command: request.command, args: request.args });
      let resultValue;

      if (request.command === 'camera.state') {
        resultValue = { ...host.state };
      } else if (request.command === 'camera.current') {
        resultValue = { sourceId: host.source, call: true, state: { ...host.state } };
      } else if (request.command === 'camera.open') {
        resultValue = {
          sourceId: host.source,
          sessionId: host.session,
          call: true,
          state: { ...host.state },
        };
      } else {
        resultValue = { outcome: 'completed' };
      }

      const result = resultValue;

      if (request.command === 'camera.current' && host.readBarrier) {
        await host.readBarrier;
      }

      return { mediaVersion: 1, cycleId: request.cycleId, requestId: request.requestId, result };
    },
  },
}));
beforeEach((): void => {
  host.cycle = '00000000-0000-4000-8000-000000000001';
  host.phase = 'ready';
  host.source = '00000000-0000-4000-8000-000000000002';
  host.state.revision = 1;
  host.readBarrier = null;
  host.token = true;
  host.signal = new AbortController();
  host.commands = [];
  host.listener = null;
});
function camera(): NativeCamera {
  return new NativeCamera(new NativeMedia((): AbortSignal => host.signal.signal));
}

describe('native call camera resynchronization', (): void => {
  it('restores the same native source after a Web cycle and never resets the public revision', async (): Promise<void> => {
    const value = camera();

    await value.start();
    const session = await value.open({ facing: CameraFacing.Front, lifetime: CameraLifetime.Call });
    const { getStream: sessionGetStream } = session;
    const before = await sessionGetStream.bind(session)();
    const { getState: sessionGetState } = session;
    const { revision: resultRevision } = await sessionGetState.bind(session)();
    const revision = resultRevision;
    const changed = vi.fn();

    const { on: sessionOn } = session;

    sessionOn.bind(session)(CameraEvent.StateChanged, changed);
    host.phase = 'waiting';
    await value.resync();
    expect(value.callPreview.getSnapshot().source).toBeNull();
    host.cycle = '00000000-0000-4000-8000-000000000004';
    host.phase = 'ready';
    await value.resync();
    const { id: beforeId } = before;

    expect(value.callPreview.getSnapshot().source?.id).toBe(beforeId);
    const next = await value.open({ facing: CameraFacing.Front, lifetime: CameraLifetime.Call });

    const { getState: nextGetState } = next;
    const { revision: resultRevision2 } = await nextGetState.bind(next)();

    expect(resultRevision2).toBeGreaterThan(revision);
    const count = changed.mock.calls.length;

    host.listener?.({
      mediaVersion: 1,
      cycleId: host.cycle,
      sourceId: host.source,
      kind: 'stateChanged',
      call: true,
      state: { ...host.state, revision: 2, status: 'interrupted' },
    });
    expect(changed).toHaveBeenCalledTimes(count);
    const { getStream: sessionGetStream2 } = session;

    await expect(sessionGetStream2.bind(session)()).rejects.toMatchObject({ code: 'CANCELLED' });
    await value.stop();
  });
  it('ignores an older native snapshot even when its response arrives after a newer camera open', async (): Promise<void> => {
    const value = camera();

    await value.start();
    let release!: () => void;

    host.readBarrier = new Promise<void>((done): void => {
      release = done;
    });
    const pending = value.resync();

    host.source = '00000000-0000-4000-8000-000000000005';
    host.state.revision = 2;
    await value.open({ facing: CameraFacing.Front, lifetime: CameraLifetime.Call });
    release();
    await pending;
    host.readBarrier = null;
    expect(value.callPreview.getSnapshot().source?.id).toBe(host.source);
    await value.stop();
  });
  it('delivers a confirmed RecordingSaved event without replacing newer camera state', async (): Promise<void> => {
    const value = camera();

    await value.start();
    const session = await value.open({ facing: CameraFacing.Front, lifetime: CameraLifetime.Call });
    const saved = vi.fn();

    const { on: sessionOn2 } = session;

    sessionOn2.bind(session)(CameraEvent.RecordingSaved, saved);
    host.listener?.({
      mediaVersion: 1,
      cycleId: host.cycle,
      sourceId: host.source,
      kind: 'stateChanged',
      call: true,
      state: { ...host.state, revision: 3 },
    });
    host.listener?.({
      mediaVersion: 1,
      cycleId: host.cycle,
      sourceId: host.source,
      kind: 'recordingSaved',
      call: true,
      state: { ...host.state, revision: 2, recording: 'stopping' },
      file: {
        id: '00000000-0000-4000-8000-000000000006',
        name: 'camera.mp4',
        kind: 'file',
        persistence: 'persistent',
      },
    });
    expect(saved).toHaveBeenCalledTimes(1);
    const { getState: sessionGetState2 } = session;
    const { recording: resultRecording } = await sessionGetState2.bind(session)();

    expect(resultRecording).toBe('idle');
    await value.stop();
  });
  it('hides old call preview state immediately when the native session is unavailable', async (): Promise<void> => {
    const value = camera();

    await value.start();
    expect(value.callPreview.getSnapshot().source?.id).toBe(host.source);
    host.token = false;
    await value.resync();
    expect(value.callPreview.getSnapshot().source).toBeNull();
    await value.stop();
  });
  it('coalesces stale layout updates while keeping a previous owner release before the next preview', async (): Promise<void> => {
    const value = camera();

    await value.start();
    const ref = { id: host.source };
    const rect = { x: 0, y: 0, width: 120, height: 180 };

    await Promise.all([
      value.bind(ref, rect, true, 'old', 'call'),
      value.bind(ref, rect, false, 'old', 'call'),
      value.bind(ref, rect, true, 'new', 'view'),
    ]);
    expect(
      host.commands
        .filter((entry): boolean => entry.command === 'camera.preview')
        .map((entry): unknown => entry.args),
    ).toEqual([
      { sourceId: host.source, previewId: 'old', rect, visible: false, priority: 'call' },
      { sourceId: host.source, previewId: 'new', rect, visible: true, priority: 'view' },
    ]);
    await value.stop();
    expect(host.commands.at(-1)?.command).toBe('document.dispose');
  });
});

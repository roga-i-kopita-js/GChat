import { afterEach, expect, it, vi } from 'vitest';

import { DeviceCalls } from '../device/calls';
import { GChatClient } from './client';

vi.mock('../runtime/transport', () => ({
  browserTransport: { changed: vi.fn(), isUpdating: () => false },
}));

function fixture(): any {
  class Stream {
    stop = vi.fn();
    getTracks = (): { stop: () => void }[] => [{ stop: this.stop }];
  }

  const audios: any[] = [];

  class Audio {
    srcObject: unknown = null;
    muted = false;
    play = vi.fn(async (): Promise<void> => {});
    pause = vi.fn();
    setSinkId = vi.fn(async (): Promise<void> => {});

    constructor() {
      audios.push(this);
    }
  }

  // Platform support is a prototype API; the recorded boundary above is per renderer.
  Audio.prototype.setSinkId = vi.fn(async (): Promise<void> => {});
  const source = { connect: vi.fn(), disconnect: vi.fn() };
  const destination = { stream: new Stream() };
  const context = {
    state: 'running',
    resume: vi.fn(async (): Promise<void> => {}),
    close: vi.fn(async (): Promise<void> => {}),
    createMediaStreamDestination: vi.fn(() => destination),
    createMediaStreamSource: vi.fn(() => source),
  };

  vi.stubGlobal('MediaStream', Stream);
  vi.stubGlobal('Audio', Audio);
  vi.stubGlobal('HTMLMediaElement', Audio);
  vi.stubGlobal(
    'AudioContext',
    class {
      constructor() {
        return context;
      }
    },
  );
  const client: any = new GChatClient();

  client.state = { ...client.getSnapshot(), owner: true, connection: 'online' };
  const raw = new Audio();
  const remote = new Stream();

  raw.muted = true;
  raw.srcObject = remote;
  client.audio = raw;
  client.bridgeRemoteAudio = true;

  return { client, raw, remote, audios, context, source, destination };
}

afterEach(() => vi.unstubAllGlobals());

it('renders the decoded stream once and routes only the shared output on repeated selections', async () => {
  const { client, raw, remote, audios, context, source, destination } = fixture();

  await client.preparePlayback();
  let finish!: () => void;

  raw.play.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const playing = client.playAudio();

  expect(context.createMediaStreamSource).not.toHaveBeenCalled();
  finish();
  await playing;
  expect(context.createMediaStreamSource).toHaveBeenCalledExactlyOnceWith(remote);
  expect(source.connect).toHaveBeenCalledWith(destination);
  await client.playAudio();
  expect(context.createMediaStreamSource).toHaveBeenCalledOnce();

  for (let index = 0; index < 10; index++) {
    await client.setAudioOutput(index % 2 ? 'receiver' : 'speaker');
  }

  expect(raw.setSinkId).not.toHaveBeenCalled();
  expect(audios[1].setSinkId).toHaveBeenCalledTimes(10);
  client.disposeMedia();
  expect(source.disconnect).toHaveBeenCalledOnce();
  expect(raw.srcObject).toBeNull();
  expect(audios[1].srcObject).toBeNull();
  expect(audios[1].pause).toHaveBeenCalled();
  expect(destination.stream.stop).not.toHaveBeenCalled();
  expect(remote.stop).not.toHaveBeenCalled();
  client.releaseRingtone();
  expect(audios[1].srcObject).toBeNull();
  expect(destination.stream.stop).toHaveBeenCalledOnce();
  expect(context.close).toHaveBeenCalledOnce();
});

it.each(['resolved', 'rejected'])(
  'ignores a %s renderer result from the ended call',
  async (outcome) => {
    const { client, raw, context, audios } = fixture();
    let resolve!: () => void;
    let reject!: (error: Error) => void;

    raw.play.mockImplementationOnce(
      () =>
        new Promise<void>((ok, fail) => {
          resolve = ok;
          reject = fail;
        }),
    );
    const pending = client.playAudio();

    client.disposeMedia();
    client.state = { ...client.getSnapshot(), audioBlocked: false };

    if (outcome === 'resolved') {
      resolve();
    } else {
      reject(new Error('Old playback failed'));
    }

    await pending;
    expect(context.createMediaStreamSource).not.toHaveBeenCalled();
    expect(audios[1].srcObject).toBeNull();
    expect(client.getSnapshot().audioBlocked).toBe(false);
    client.releaseRingtone();
  },
);

it('reports blocked playback without attaching a source when the renderer rejects', async () => {
  const { client, raw, context } = fixture();

  raw.play.mockRejectedValueOnce(new DOMException('Blocked', 'NotAllowedError'));
  await client.playAudio();
  expect(client.getSnapshot().audioBlocked).toBe(true);
  expect(context.createMediaStreamSource).not.toHaveBeenCalled();
  client.disposeMedia();
  client.releaseRingtone();
});

it('reconnects the paused output for an incoming ringtone after a call ends', async () => {
  const { client, context, audios, destination } = fixture();

  await client.preparePlayback();
  await client.playAudio();
  client.disposeMedia();
  expect(audios[1].srcObject).toBeNull();
  client.state = { ...client.getSnapshot(), call: { call_id: 'incoming', state: 'ringing' } };
  client.isCaller = () => false;
  context.currentTime = 0;
  context.createOscillator = () => ({
    frequency: { value: 0 },
    connect: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    disconnect: vi.fn(),
  });
  context.createGain = () => ({
    gain: { setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn() },
    connect: vi.fn(),
    disconnect: vi.fn(),
  });
  client.tone();
  expect(audios[1].srcObject).toBe(destination.stream);
  await Promise.resolve();
  client.disposeMedia();
  client.releaseRingtone();
});

it('applies an output selected before creation to the newly prepared graph', async () => {
  const { client, audios } = fixture();

  client.bridgeRemoteAudio = false;
  client.audio = undefined;
  await client.setAudioOutput('receiver');
  await client.preparePlayback();
  expect(audios[1].setSinkId).toHaveBeenCalledWith('receiver');
  client.releaseRingtone();
});

it('prepares browser playback before outgoing microphone preparation resolves', async () => {
  const { client } = fixture();
  let grant!: (value: object) => void;
  const execute = vi.fn(
    () =>
      new Promise<object>((resolve) => {
        grant = resolve;
      }),
  );
  const prepare = vi.spyOn(client, 'preparePlayback');
  const dial = vi.spyOn(client, 'dial').mockResolvedValue(undefined);
  const controller = new AbortController();
  const calls = new DeviceCalls(
    client,
    () => 'caller',
    { execute } as any,
    () => controller.signal,
  );
  const pending = calls.dial('00000000-0000-4000-8000-000000000002');

  expect(prepare).toHaveBeenCalledOnce();
  expect(execute).toHaveBeenCalledOnce();
  expect(dial).not.toHaveBeenCalled();
  grant({ outcome: 'completed' });
  await pending;
  expect(dial).toHaveBeenCalledOnce();
  client.releaseRingtone();
});

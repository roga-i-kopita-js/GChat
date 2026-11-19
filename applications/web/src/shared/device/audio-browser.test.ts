import { afterEach, describe, expect, it, vi } from 'vitest';

import { GChatClient } from '../calls/client';
import { AudioEvent } from './api';
import { DeviceAudio } from './audio';
import type { DeviceBridge } from './contract';
import { StateSource } from './events';
import type { NativeMedia } from './media-native';
import type { DeviceObserver } from './observer';

vi.mock('../runtime/transport', () => ({
  browserTransport: { changed: vi.fn(), isUpdating: () => false },
}));

class Track extends EventTarget {
  readyState = 'live';
  stop = vi.fn((): void => {
    this.readyState = 'ended';
  });
}

function fixture(): {
  audio: DeviceAudio;
  client: GChatClient;
  tracks: Track[];
  getUserMedia: ReturnType<typeof vi.fn<() => Promise<MediaStream>>>;
  stream(): MediaStream;
} {
  const tracks: Track[] = [];
  const stream = (): MediaStream => {
    const track = new Track();

    tracks.push(track);

    return { getTracks: () => [track] } as unknown as MediaStream;
  };
  const getUserMedia = vi.fn<() => Promise<MediaStream>>(async () => stream());

  vi.stubGlobal('navigator', {
    mediaDevices: {
      getUserMedia,
      enumerateDevices: async (): Promise<object[]> =>
        tracks.some((track) => track.readyState === 'live')
          ? [
              { deviceId: 'speaker', kind: 'audiooutput', label: 'Динамик' },
              { deviceId: 'receiver', kind: 'audiooutput', label: 'Телефон' },
            ]
          : [],
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    },
  });
  vi.stubGlobal(
    'HTMLMediaElement',
    class {
      async setSinkId(): Promise<void> {}
    },
  );
  const client = new GChatClient();

  Reflect.set(client, 'state', { ...client.getSnapshot(), owner: true, connection: 'online' });
  const audio = new DeviceAudio(
    {} as DeviceBridge,
    { source: new StateSource({ revision: 0, value: null }) } as unknown as DeviceObserver,
    {} as NativeMedia,
    client,
    () => new AbortController().signal,
  );

  return { audio, client, tracks, getUserMedia, stream };
}

afterEach(() => vi.unstubAllGlobals());

describe('browser output setup', () => {
  it('opens capture only on setup, rereads outputs, and retains capture across output selection and signal stop', async () => {
    const { audio, client, tracks, getUserMedia } = fixture();

    expect(audio.getOutputSupport()).toMatchObject({ setup: true, preference: false });
    await expect(audio.outputs.list()).resolves.toEqual([]);
    expect(getUserMedia).not.toHaveBeenCalled();
    const { close } = await audio.outputs.beginSetup();

    await expect(audio.outputs.list()).resolves.toMatchObject([
      { id: 'speaker' },
      { id: 'receiver' },
    ]);
    await audio.outputs.select('receiver');
    client.audioPreparation.stopSound();
    expect(tracks[0].stop).not.toHaveBeenCalled();
    expect(getUserMedia).toHaveBeenCalledOnce();
    await close();
    await close();
    expect(tracks[0].stop).toHaveBeenCalledOnce();
  });

  it('rejects concurrent setup and a stale close cannot release the next setup', async () => {
    const { audio, tracks } = fixture();
    const { close: first } = await audio.outputs.beginSetup();

    await expect(audio.outputs.beginSetup()).rejects.toMatchObject({ code: 'BUSY' });
    await first();
    const { close: second } = await audio.outputs.beginSetup();

    await first();
    expect(tracks[1].stop).not.toHaveBeenCalled();
    await second();
    expect(tracks[1].stop).toHaveBeenCalledOnce();
  });

  it('cancels a pending grant immediately and disposes its late stream without closing a newer setup', async () => {
    const { audio, getUserMedia, stream, tracks } = fixture();
    let grant!: (stream: MediaStream) => void;

    getUserMedia.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          grant = resolve;
        }),
    );
    const controller = new AbortController();
    const pending = audio.outputs.beginSetup({ signal: controller.signal });
    const rejected = expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });

    controller.abort();
    await rejected;
    const { close } = await audio.outputs.beginSetup();
    const late = stream();

    grant(late);
    await vi.waitFor(() => expect(tracks[1].stop).toHaveBeenCalledOnce());
    expect(tracks[0].stop).not.toHaveBeenCalled();
    await close();
  });

  it('reports permission denial and allows retry without leaving a reserved setup', async () => {
    const { audio, getUserMedia } = fixture();

    getUserMedia.mockRejectedValueOnce(new DOMException('Denied', 'NotAllowedError'));
    await expect(audio.outputs.beginSetup()).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    const { close } = await audio.outputs.beginSetup();

    await close();
  });

  it.each([{ owner: false }, { busy: true }, { call: { call_id: 'incoming', state: 'ringing' } }])(
    'the call owner preempts setup synchronously on %j',
    async (patch) => {
      const { audio, client, tracks } = fixture();
      const values: (object[] | null)[] = [];

      audio.on(AudioEvent.OutputsChanged, ({ outputs }) => values.push(outputs));
      const { close } = await audio.outputs.beginSetup();

      Reflect.get(client, 'set').call(client, patch);
      expect(tracks[0].stop).toHaveBeenCalledOnce();
      expect(values.at(-1)).toBeNull();
      await close();
      expect(tracks[0].stop).toHaveBeenCalledOnce();
    },
  );

  it('releases capture when the platform ends its track', async () => {
    const { audio, tracks } = fixture();
    const { close } = await audio.outputs.beginSetup();

    tracks[0].dispatchEvent(new Event('ended'));
    expect(tracks[0].stop).toHaveBeenCalledOnce();
    await close();
  });
});

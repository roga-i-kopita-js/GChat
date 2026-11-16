import { afterEach, expect, it, vi } from 'vitest';

import { AudioPreparation } from './audio-preparation';
import { ContextOutput } from './context-output';

function fixture(direct = false): {
  context: Record<string, unknown>;
  audios: { srcObject: unknown; play: ReturnType<typeof vi.fn>; pause: ReturnType<typeof vi.fn> }[];
  selected: string[];
  stop: ReturnType<typeof vi.fn>;
  destination: { stream: { getTracks(): { stop: ReturnType<typeof vi.fn> }[] } };
  connect: ReturnType<typeof vi.fn>;
} {
  const audios: OutputAudio[] = [];
  const selected: string[] = [];

  class OutputAudio {
    srcObject: unknown = null;

    constructor() {
      audios.push(this);
    }

    play = vi.fn(async (): Promise<void> => {});
    pause = vi.fn();

    async setSinkId(id: string): Promise<void> {
      if (id === 'disconnected') {
        throw new DOMException('Disconnected', 'NotFoundError');
      }

      selected.push(id);
    }
  }

  vi.stubGlobal('Audio', OutputAudio);
  vi.stubGlobal('HTMLMediaElement', OutputAudio);
  const stop = vi.fn();
  const destination = { stream: { getTracks: () => [{ stop }] } };
  const connect = vi.fn();
  const oscillator = {
    frequency: { value: 0 },
    connect: vi.fn(),
    disconnect: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    onended: null,
  };
  const context = {
    destination: {},
    state: 'running',
    currentTime: 0,
    resume: vi.fn(async (): Promise<void> => {}),
    close: vi.fn(async (): Promise<void> => {}),
    createMediaStreamDestination: vi.fn(() => destination),
    createOscillator: () => oscillator,
    createGain: () => ({
      connect,
      disconnect: vi.fn(),
      gain: { setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn() },
    }),
    ...(direct ? { setSinkId: vi.fn(async (): Promise<void> => {}) } : {}),
  };

  return { context, audios, selected, stop, destination, connect };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

it('routes Web Audio through a media element when only HTMLMediaElement supports output selection', async () => {
  const { context, audios, selected, destination, stop } = fixture();
  const output = new ContextOutput(context as unknown as AudioContext);
  const [audio] = audios;
  const start = output.start();

  expect(context.resume).toHaveBeenCalledOnce();
  expect(audio.play).toHaveBeenCalledOnce();
  await start;
  await output.select('headset');
  expect(output.destination).toBe(destination);
  expect(audio.srcObject).toBe(destination.stream);
  expect(selected).toEqual(['headset']);
  await expect(output.select('disconnected')).rejects.toMatchObject({ name: 'NotFoundError' });
  output.dispose();
  expect(audio.pause).toHaveBeenCalledOnce();
  expect(audio.srcObject).toBeNull();
  expect(stop).toHaveBeenCalledOnce();
});

it('keeps direct context routing without adding a media stream renderer', async () => {
  const { context, audios } = fixture(true);
  const output = new ContextOutput(context as unknown as AudioContext);

  await output.start();
  await output.select('headset');
  expect(context.setSinkId).toHaveBeenCalledWith('headset');
  expect(context.createMediaStreamDestination).not.toHaveBeenCalled();
  expect(output.destination).toBe(context.destination);
  expect(audios).toHaveLength(0);
});

it('detaches the idle renderer and reconnects the retained stream for the next sound', async () => {
  const { context, audios, destination, stop } = fixture();
  const output = new ContextOutput(context as unknown as AudioContext);
  const [audio] = audios;

  await output.start();
  output.pause();
  expect(audio.pause).toHaveBeenCalledOnce();
  expect(audio.srcObject).toBeNull();
  expect(stop).not.toHaveBeenCalled();
  await output.start();
  expect(audio.srcObject).toBe(destination.stream);
  output.dispose();
  await expect(output.start()).rejects.toMatchObject({ name: 'AbortError' });
  expect(audio.srcObject).toBeNull();
});

it.each([false, true])(
  'a late start preserves the current idle or restarted state (restart: %s)',
  async (restart) => {
    const { context, audios, destination } = fixture();
    const output = new ContextOutput(context as unknown as AudioContext);
    const [audio] = audios;
    let complete!: () => void;

    audio.play.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          complete = resolve;
        }),
    );
    const pending = output.start();

    output.pause();

    if (restart) {
      await output.start();
      complete();
      await pending;
      expect(audio.srcObject).toBe(destination.stream);
      expect(audio.pause).toHaveBeenCalledOnce();
    } else {
      const cancelled = expect(pending).rejects.toMatchObject({ name: 'AbortError' });

      complete();
      await cancelled;
      expect(audio.srcObject).toBeNull();
    }

    output.dispose();
  },
);

it('routes the preliminary test signal to the selected output and releases its renderer when cancelled', async () => {
  const { context, audios, selected, destination, connect, stop } = fixture();

  vi.stubGlobal(
    'AudioContext',
    class {
      constructor() {
        return context;
      }
    },
  );
  const preparation = new AudioPreparation(() => true);

  const pending = preparation.sound('headset');

  // Selection must start before the user's handler returns, even while resume/play is pending.
  expect(selected).toEqual(['headset']);
  await pending;
  expect(connect).toHaveBeenCalledWith(destination);
  preparation.stop();
  const [audio] = audios;

  expect(audio.pause).toHaveBeenCalledOnce();
  expect(stop).toHaveBeenCalledOnce();
  expect(context.close).toHaveBeenCalledOnce();
});

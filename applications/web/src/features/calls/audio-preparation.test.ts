import { afterEach, describe, expect, it, vi } from 'vitest';

import { AudioPreparation } from './audio-preparation';

const close = vi.fn(async (): Promise<void> => {});
const resume = vi.fn(async (): Promise<void> => {});
const route = vi.fn(async (): Promise<void> => {});
const start = vi.fn();
let oscillator: any;

function context(): void {
  vi.stubGlobal(
    'AudioContext',
    class {
      state = 'running';
      currentTime = 0;
      destination = {};
      close = close;
      resume = resume;
      setSinkId = route;

      createOscillator(): any {
        oscillator = { frequency: {}, connect: vi.fn(), disconnect: vi.fn(), start, stop: vi.fn() };

        return oscillator;
      }

      createGain(): any {
        return {
          gain: { setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn() },
          connect: vi.fn(),
          disconnect: vi.fn(),
        };
      }
    },
  );
}

afterEach((): void => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('audio preparation resources', (): void => {
  it('releases microphone tracks immediately without retaining capture', async (): Promise<void> => {
    const stop = vi.fn();

    vi.stubGlobal('navigator', {
      mediaDevices: {
        getUserMedia: vi.fn(async (): Promise<object> => ({
          getTracks: (): object[] => [{ stop }],
        })),
      },
    });
    await new AudioPreparation((): boolean => true).microphone();
    expect(stop).toHaveBeenCalledOnce();
  });

  it('releases late grants when the dialog closed or a call started', async (): Promise<void> => {
    const stop = vi.fn();
    let grant!: (value: object) => void;

    vi.stubGlobal('navigator', {
      mediaDevices: {
        getUserMedia: (): Promise<object> =>
          new Promise((resolve): void => {
            grant = resolve;
          }),
      },
    });
    const preparation = new AudioPreparation((): boolean => true);
    const pending = preparation.microphone();

    preparation.stop();
    grant({ getTracks: (): object[] => [{ stop }] });
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(stop).toHaveBeenCalledOnce();
  });

  it('does not open devices in a secondary tab or during a call', async (): Promise<void> => {
    const getUserMedia = vi.fn();

    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
    await expect(new AudioPreparation((): boolean => false).microphone()).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it('plays the test through the selected output and closes resources on completion', async (): Promise<void> => {
    context();
    const preparation = new AudioPreparation((): boolean => true);

    await preparation.sound('headset');
    expect(route).toHaveBeenCalledWith('headset');
    expect(start).toHaveBeenCalledOnce();
    oscillator.onended();
    expect(close).toHaveBeenCalledOnce();
  });

  it('closes the context and reports autoplay rejection', async (): Promise<void> => {
    context();
    resume.mockRejectedValueOnce(new DOMException('Blocked', 'NotAllowedError'));
    await expect(new AudioPreparation((): boolean => true).sound('')).rejects.toMatchObject({
      name: 'NotAllowedError',
    });
    expect(close).toHaveBeenCalledOnce();
    expect(start).not.toHaveBeenCalled();
  });

  it('never starts a tone after cancellation during resume', async (): Promise<void> => {
    context();
    let finish!: () => void;

    resume.mockImplementationOnce(
      (): Promise<void> =>
        new Promise((resolve): void => {
          finish = resolve;
        }),
    );
    const preparation = new AudioPreparation((): boolean => true);
    const pending = preparation.sound('');

    preparation.stop();
    finish();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(start).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });
});

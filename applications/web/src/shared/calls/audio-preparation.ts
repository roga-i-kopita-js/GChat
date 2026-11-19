import { DeviceError } from '../device/contract';
import { cancellable } from '../device/events';
import { ContextOutput } from './context-output';

export function audioError(cause: unknown): string {
  const name = cause instanceof Error ? cause.name : '';

  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return 'Доступ заблокирован. Проверьте разрешения сайта, браузера и ОС.';
  }

  if (name === 'NotFoundError') {
    return 'Аудиоустройство не найдено. Подключите его и повторите проверку.';
  }

  if (name === 'NotReadableError' || name === 'AbortError') {
    return 'Не удалось открыть аудиоустройство. Проверьте, не занято ли оно другим приложением.';
  }

  return 'Не удалось проверить аудио. Проверьте настройки браузера и устройства.';
}

interface OutputDevices extends MediaDevices {
  selectAudioOutput(): Promise<MediaDeviceInfo>;
}

export function canSelectOutput(devices: MediaDevices): devices is OutputDevices {
  return 'selectAudioOutput' in devices && typeof devices.selectAudioOutput === 'function';
}

/** Owns only temporary resources; cancellation also disposes late microphone grants. */
export class AudioPreparation {
  private epoch = 0;
  private context?: AudioContext;
  private output?: ContextOutput;
  private closeSetup: (() => void) | null = null;

  constructor(private readonly available: () => boolean) {}

  stop(): void {
    this.closeSetup?.();
    this.stopSound();
  }

  stopSound(): void {
    this.epoch++;
    const context = this.context;

    this.context = undefined;
    this.output?.dispose();
    this.output = undefined;

    if (context) {
      void (async () => {
        try {
          return await context.close();
        } catch (cause) {}
      })();
    }
  }

  async beginSetup(signal: AbortSignal): Promise<{ close(): void; signal: AbortSignal }> {
    if (signal.aborted) {
      throw new DeviceError('CANCELLED');
    }

    if (this.closeSetup || !this.available()) {
      throw new DeviceError('BUSY');
    }

    if (!navigator.mediaDevices?.getUserMedia) {
      throw new DeviceError('UNSUPPORTED');
    }

    this.stopSound();
    const controller = new AbortController();
    let stream: MediaStream | null = null;
    const close = (): void => {
      if (this.closeSetup !== close) {
        return;
      }

      this.closeSetup = null;
      signal.removeEventListener('abort', close);
      this.stopSound();

      for (const track of stream?.getTracks() ?? []) {
        track.removeEventListener('ended', close);
        track.stop();
      }

      stream = null;
      controller.abort();
    };

    this.closeSetup = close;
    signal.addEventListener('abort', close, { once: true });

    try {
      return await cancellable(
        async () => {
          const acquired = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
          const { getTracks: acquiredGetTracks } = acquired;

          if (controller.signal.aborted || !this.available()) {
            for (const track of acquiredGetTracks.bind(acquired)()) {
              track.stop();
            }

            throw new DeviceError('CANCELLED');
          }

          stream = acquired;

          for (const track of stream.getTracks()) {
            track.addEventListener('ended', close, { once: true });
          }

          return { close, signal: controller.signal };
        },
        { signal: controller.signal },
      );
    } catch (cause) {
      close();

      throw cause;
    }
  }

  private check(epoch: number): void {
    if (epoch !== this.epoch || !this.available()) {
      throw new DOMException('Проверка отменена.', 'AbortError');
    }
  }

  async microphone(): Promise<void> {
    if (this.closeSetup) {
      throw new DeviceError('BUSY');
    }

    this.stop();
    const epoch = this.epoch;

    this.check(epoch);

    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('Для микрофона нужен HTTPS или localhost.');
    }

    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });

    const { getTracks: streamGetTracks } = stream;

    for (const track of streamGetTracks.bind(stream)()) {
      track.stop();
    }

    this.check(epoch);
  }

  async sound(sinkId: string): Promise<void> {
    this.stopSound();
    const epoch = this.epoch;

    this.check(epoch);
    const context = new AudioContext();

    this.context = context;

    try {
      const output = new ContextOutput(context);

      this.output = output;
      // Start playback and routing in the same user gesture.
      await Promise.all([output.start(), ...(sinkId ? [output.select(sinkId)] : [])]);

      this.check(epoch);

      if (context.state !== 'running') {
        throw new DOMException('Включите звук.', 'NotAllowedError');
      }

      const oscillator = context.createOscillator();
      const gain = context.createGain();

      oscillator.frequency.value = 440;
      gain.gain.setValueAtTime(0, context.currentTime);
      gain.gain.linearRampToValueAtTime(0.05, context.currentTime + 0.05);
      gain.gain.setValueAtTime(0.05, context.currentTime + 0.7);
      gain.gain.linearRampToValueAtTime(0, context.currentTime + 0.9);
      oscillator.connect(gain);
      gain.connect(output.destination);
      oscillator.onended = (): void => {
        oscillator.disconnect();
        gain.disconnect();

        if (this.context === context) {
          this.stopSound();
        }
      };
      oscillator.start();
      oscillator.stop(context.currentTime + 1);
    } catch (cause) {
      if (this.context === context) {
        this.stopSound();
      }

      throw cause;
    }
  }
}

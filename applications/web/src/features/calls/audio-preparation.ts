export function audioError(cause: unknown): string {
  const name = cause instanceof Error ? cause.name : '';

  if (name === 'NotAllowedError' || name === 'SecurityError')
    return 'Доступ заблокирован. Проверьте разрешения сайта, браузера и ОС.';

  if (name === 'NotFoundError')
    return 'Аудиоустройство не найдено. Подключите его и повторите проверку.';

  if (name === 'NotReadableError' || name === 'AbortError')
    return 'Не удалось открыть аудиоустройство. Проверьте, не занято ли оно другим приложением.';

  return 'Не удалось проверить аудио. Проверьте настройки браузера и устройства.';
}

interface OutputContext extends AudioContext {
  setSinkId(id: string): Promise<void>;
}
interface OutputDevices extends MediaDevices {
  selectAudioOutput(): Promise<MediaDeviceInfo>;
}

export function canRouteContext(context: AudioContext): context is OutputContext {
  return 'setSinkId' in context && typeof context.setSinkId === 'function';
}

export function canSelectOutput(devices: MediaDevices): devices is OutputDevices {
  return 'selectAudioOutput' in devices && typeof devices.selectAudioOutput === 'function';
}

/** Owns only temporary resources; cancellation also disposes late microphone grants. */
export class AudioPreparation {
  private epoch = 0;
  private context?: AudioContext;

  constructor(private readonly available: () => boolean) {}

  stop(): void {
    this.epoch++;
    const context = this.context;

    this.context = undefined;

    if (context) void context.close().catch((): void => {});
  }

  private check(epoch: number): void {
    if (epoch !== this.epoch || !this.available())
      throw new DOMException('Проверка отменена.', 'AbortError');
  }

  async microphone(): Promise<void> {
    this.stop();
    const epoch = this.epoch;

    this.check(epoch);

    if (!navigator.mediaDevices?.getUserMedia)
      throw new Error('Для микрофона нужен HTTPS или localhost.');

    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });

    for (const track of stream.getTracks()) track.stop();

    this.check(epoch);
  }

  async sound(sinkId: string): Promise<void> {
    this.stop();
    const epoch = this.epoch;

    this.check(epoch);
    const context = new AudioContext();

    this.context = context;

    try {
      // Resume directly in the click gesture, before awaiting device routing.
      await context.resume();
      this.check(epoch);

      if (sinkId && canRouteContext(context)) await context.setSinkId(sinkId);

      this.check(epoch);

      if (context.state !== 'running') throw new DOMException('Включите звук.', 'NotAllowedError');

      const oscillator = context.createOscillator();
      const gain = context.createGain();

      oscillator.frequency.value = 440;
      gain.gain.setValueAtTime(0, context.currentTime);
      gain.gain.linearRampToValueAtTime(0.05, context.currentTime + 0.05);
      gain.gain.setValueAtTime(0.05, context.currentTime + 0.7);
      gain.gain.linearRampToValueAtTime(0, context.currentTime + 0.9);
      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.onended = (): void => {
        oscillator.disconnect();
        gain.disconnect();

        if (this.context === context) this.stop();
      };
      oscillator.start();
      oscillator.stop(context.currentTime + 1);
    } catch (cause) {
      if (this.context === context) this.stop();

      throw cause;
    }
  }
}

import { DeviceError } from '../device/contract';

interface OutputContext extends AudioContext {
  setSinkId(id: string): Promise<void>;
}

function canRouteContext(context: AudioContext): context is OutputContext {
  return 'setSinkId' in context && typeof context.setSinkId === 'function';
}

/** Keeps Web Audio signals routable in browsers that only implement media-element sinks. */
export class ContextOutput {
  readonly destination: AudioNode;
  private readonly audio?: HTMLAudioElement;
  private stream?: MediaStream;
  private source?: MediaStreamAudioSourceNode;
  private sourceStream?: MediaStream;
  private active = false;
  private disposed = false;

  static needsMediaElement(): boolean {
    return (
      typeof AudioContext !== 'undefined' &&
      !(
        'setSinkId' in AudioContext.prototype &&
        typeof AudioContext.prototype.setSinkId === 'function'
      ) &&
      typeof HTMLMediaElement !== 'undefined' &&
      typeof HTMLMediaElement.prototype.setSinkId === 'function'
    );
  }

  constructor(private readonly context: AudioContext) {
    if (
      !canRouteContext(context) &&
      typeof HTMLMediaElement !== 'undefined' &&
      typeof HTMLMediaElement.prototype.setSinkId === 'function'
    ) {
      const destination = context.createMediaStreamDestination();

      this.destination = destination;
      this.stream = destination.stream;
      this.audio = new Audio();
      this.audio.srcObject = destination.stream;
    } else {
      this.destination = context.destination;
    }
  }

  async start(): Promise<void> {
    if (this.disposed) {
      throw new DOMException('Audio playback cancelled', 'AbortError');
    }

    this.active = true;

    if (this.audio && this.stream && this.audio.srcObject !== this.stream) {
      this.audio.srcObject = this.stream;
    }

    // Both activation calls must begin in the user gesture.
    try {
      await Promise.all([this.context.resume(), this.audio?.play()]);
    } finally {
      if (!this.active) {
        this.pauseRenderer();
      }
    }

    if (!this.active) {
      throw new DOMException('Audio playback cancelled', 'AbortError');
    }
  }

  async select(id: string): Promise<void> {
    if (canRouteContext(this.context)) {
      await this.context.setSinkId(id);
    } else if (this.audio) {
      await this.audio.setSinkId(id);
    } else {
      throw new DeviceError('UNSUPPORTED');
    }
  }

  attach(stream: MediaStream): void {
    if (this.sourceStream === stream) {
      return;
    }

    this.detach();
    const source = this.context.createMediaStreamSource(stream);

    source.connect(this.destination);
    this.source = source;
    this.sourceStream = stream;
  }

  detach(): void {
    this.source?.disconnect();
    this.source = undefined;
    this.sourceStream = undefined;
  }

  private pauseRenderer(): void {
    this.audio?.pause();

    if (this.audio) {
      this.audio.srcObject = null;
    }
  }

  pause(): void {
    this.active = false;
    this.pauseRenderer();
  }

  dispose(): void {
    this.disposed = true;
    this.pause();
    this.detach();

    for (const track of this.stream?.getTracks() ?? []) {
      track.stop();
    }

    this.stream = undefined;
  }
}

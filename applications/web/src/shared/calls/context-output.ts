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
    // Both activation calls must begin in the user gesture.
    await Promise.all([this.context.resume(), this.audio?.play()]);
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

  dispose(): void {
    if (this.audio) {
      this.audio.pause();
      this.audio.srcObject = null;
    }

    for (const track of this.stream?.getTracks() ?? []) {
      track.stop();
    }

    this.stream = undefined;
  }
}

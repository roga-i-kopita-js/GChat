import musicUrl from './assets/christmas-coming.wav?url';
import type { ContextOutput } from './context-output';

/** One local waiting signal; stale downloads and activations cannot start another call's music. */
export class Ringback {
  private callId?: string;
  private epoch = 0;
  private controller?: AbortController;
  private buffer?: AudioBuffer;
  private source?: AudioBufferSourceNode;
  private started = false;
  private gain?: GainNode;
  private output?: ContextOutput;

  constructor(private readonly blocked: () => void) {}

  start(
    callId: string,
    context: AudioContext,
    output: ContextOutput,
    activate: () => Promise<boolean>,
  ): void {
    if (this.callId === callId) {
      return;
    }

    this.stop();
    this.callId = callId;
    this.output = output;
    const epoch = this.epoch;
    const controller = new AbortController();

    this.controller = controller;
    void (async (): Promise<void> => {
      try {
        const [ready, buffer] = await Promise.all([
          activate(),
          this.load(context, controller.signal),
        ]);

        if (epoch !== this.epoch) {
          return;
        }

        if (!ready) {
          this.stop();

          return;
        }

        if (context.state !== 'running') {
          throw new DOMException('Audio playback is suspended', 'NotAllowedError');
        }

        const source = context.createBufferSource();
        const gain = context.createGain();

        this.source = source;
        this.gain = gain;
        source.buffer = buffer;
        source.loop = true;
        gain.gain.value = 0.18;
        source.connect(gain);
        gain.connect(output.destination);
        source.start();
        this.started = true;
      } catch {
        if (epoch === this.epoch) {
          this.stop();
          this.blocked();
        }
      }
    })();
  }

  private async load(context: AudioContext, signal: AbortSignal): Promise<AudioBuffer> {
    if (this.buffer) {
      return this.buffer;
    }

    const response = await fetch(musicUrl, { signal });
    const { ok, arrayBuffer } = response;

    if (!ok) {
      throw new Error('Waiting music is unavailable');
    }

    const bytes = await arrayBuffer.bind(response)();
    const buffer = await context.decodeAudioData(bytes);

    signal.throwIfAborted();
    this.buffer = buffer;

    return buffer;
  }

  stop(): void {
    this.epoch++;
    this.callId = undefined;
    this.controller?.abort();
    this.controller = undefined;

    if (this.source) {
      if (this.started) {
        this.source.stop();
      }

      this.source.disconnect();
      this.source = undefined;
    }

    this.started = false;
    this.gain?.disconnect();
    this.gain = undefined;
    this.output?.pause();
    this.output = undefined;
  }
}

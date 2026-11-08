// Read-only observer of the real client's playback stream. No getUserMedia,
// PeerConnection, track or playback result is replaced.
export function observePlayback(): void {
  let context: AudioContext | undefined;
  const contexts: AudioContext[] = [];
  let analyser: AnalyserNode | undefined;
  let output: HTMLMediaElement | undefined;
  let stream: MediaStream | undefined;
  const errors: string[] = [];
  const play = HTMLMediaElement.prototype.play;

  HTMLMediaElement.prototype.play = function (): Promise<void> {
    const result = play.call(this);
    const input = this.srcObject;

    if (input instanceof MediaStream && input !== stream) {
      stream = input;
      output = this;
      void result
        .then(async (): Promise<void> => {
          if (stream !== input || this.srcObject !== input) {
            return;
          }

          const options: AudioContextOptions & { sinkId: { type: 'none' } } = {
            sampleRate: 48000,
            sinkId: { type: 'none' },
          };

          const next = new AudioContext(options);

          contexts.push(next);
          context = next;
          await next.resume();

          if (stream !== input || this.srcObject !== input) {
            await next.close();

            return;
          }

          analyser = next.createAnalyser();
          analyser.fftSize = 8192;
          next.createMediaStreamSource(input).connect(analyser).connect(next.destination);
        })
        .catch((): void => {
          errors.push('PLAYBACK_OBSERVER_FAILED');
        });
    }

    return result;
  };

  window.playbackProbe = {
    sample: (): {
      rms: number;
      peakHz: number;
      playing: boolean;
      attached: boolean;
      liveTracks: number;
      errors: string[];
    } => {
      let rms = 0;
      let peakHz = 0;

      if (analyser && context) {
        const spectrum = new Float32Array(analyser.frequencyBinCount);
        const values = new Float32Array(analyser.fftSize);

        analyser.getFloatFrequencyData(spectrum);
        analyser.getFloatTimeDomainData(values);
        let peak = 0;

        for (let index = 1; index < spectrum.length; index++) {
          if (spectrum[index] > spectrum[peak]) {
            peak = index;
          }
        }

        peakHz = (peak * context.sampleRate) / analyser.fftSize;
        rms = Math.sqrt(
          values.reduce((sum, value): number => sum + value * value, 0) / values.length,
        );
      }

      return {
        rms,
        peakHz,
        playing: !!output && !output.paused && !output.muted && output.volume > 0,
        attached: !!output?.srcObject,
        liveTracks:
          stream?.getTracks().filter((track): boolean => track.readyState === 'live').length ?? 0,
        errors,
      };
    },
    dispose: async (): Promise<void> => {
      HTMLMediaElement.prototype.play = play;

      for (const item of contexts) {
        if (item.state !== 'closed') {
          await item.close();
        }
      }
    },
  };
}

declare global {
  interface Window {
    playbackProbe: {
      sample: () => {
        rms: number;
        peakHz: number;
        playing: boolean;
        attached: boolean;
        liveTracks: number;
        errors: string[];
      };
      dispose: () => Promise<void>;
    };
  }
}

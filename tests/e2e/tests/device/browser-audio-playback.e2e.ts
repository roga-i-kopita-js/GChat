import { expect, test } from '@playwright/test';

test.use({ launchOptions: { args: ['--mute-audio'] } });

test('the media-element profile decodes one incoming track through its shared output on two calls', async ({
  page,
}) => {
  await page.route('**/audio-playback-probe', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<button id="start">Start</button><button id="route">Route</button>',
    }),
  );
  await page.goto('/audio-playback-probe');
  await page.evaluate(async () => {
    Object.defineProperty(AudioContext.prototype, 'setSinkId', {
      configurable: true,
      value: undefined,
    });
    const path = '/src/shared/calls/client.ts';
    const { GChatClient } = await import(path);
    const client = new GChatClient();

    Reflect.set(client, 'state', { ...client.getSnapshot(), owner: true, connection: 'online' });
    Reflect.set(client, 'transport', { changed: () => {}, isUpdating: () => false });
    const sourceContext = new AudioContext({ sinkId: { type: 'none' } } as AudioContextOptions);
    const oscillator = sourceContext.createOscillator();
    const source = sourceContext.createMediaStreamDestination();

    oscillator.frequency.value = 440;
    oscillator.connect(source);
    oscillator.start();
    let sender: RTCPeerConnection;
    let receiver: RTCPeerConnection;
    let raw: HTMLAudioElement;
    let analyser: AnalyserNode;
    let selectedRaw = 0;
    const select = HTMLMediaElement.prototype.setSinkId;

    HTMLMediaElement.prototype.setSinkId = function (id): Promise<void> {
      if (this === raw) {
        selectedRaw++;
      }

      return select.call(this, id);
    };
    document.getElementById('start')!.onclick = () => {
      void (async () => {
        const ready = client.preparePlayback();
        const resumed = sourceContext.resume();

        await Promise.all([ready, resumed]);
        sender = new RTCPeerConnection();
        receiver = new RTCPeerConnection();
        raw = new Audio();
        raw.muted = true;
        Reflect.set(client, 'audio', raw);
        Reflect.set(client, 'bridgeRemoteAudio', true);
        const pending: RTCIceCandidate[] = [];
        const candidates: RTCIceCandidate[] = [];

        sender.onicecandidate = (event) => {
          if (!event.candidate) {
            return;
          }

          if (receiver.remoteDescription) {
            void receiver.addIceCandidate(event.candidate);
          } else {
            pending.push(event.candidate);
          }
        };
        receiver.onicecandidate = (event) => {
          if (!event.candidate) {
            return;
          }

          if (sender.remoteDescription) {
            void sender.addIceCandidate(event.candidate);
          } else {
            candidates.push(event.candidate);
          }
        };
        const played = new Promise<void>((resolve) => {
          receiver.ontrack = (event) => {
            raw.srcObject = event.streams[0];
            void (async () => {
              await client.playAudio();
              resolve();
            })();
          };
        });

        sender.addTrack(source.stream.getAudioTracks()[0], source.stream);
        await sender.setLocalDescription(await sender.createOffer());
        await receiver.setRemoteDescription(sender.localDescription!);
        await Promise.all(
          pending.splice(0).map((candidate) => receiver.addIceCandidate(candidate)),
        );
        await receiver.setLocalDescription(await receiver.createAnswer());
        await sender.setRemoteDescription(receiver.localDescription!);
        await Promise.all(
          candidates.splice(0).map((candidate) => sender.addIceCandidate(candidate)),
        );
        await played;
        const output = Reflect.get(Reflect.get(client, 'contextOutput'), 'audio');

        analyser = sourceContext.createAnalyser();
        sourceContext
          .createMediaStreamSource(output.srcObject)
          .connect(analyser)
          .connect(sourceContext.destination);
        document.getElementById('start')!.dataset.ready = 'true';
      })();
    };
    document.getElementById('route')!.onclick = () => {
      void (async () => {
        await client.setAudioOutput('');
        const button = document.getElementById('route')!;

        button.dataset.count = String(Number(button.dataset.count ?? 0) + 1);
      })();
    };
    Object.assign(window, {
      audioPlaybackProbe: {
        sample: () => {
          const values = new Float32Array(analyser.fftSize);
          const output = Reflect.get(Reflect.get(client, 'contextOutput'), 'audio');

          analyser.getFloatTimeDomainData(values);

          return {
            rms: Math.sqrt(values.reduce((sum, value) => sum + value * value, 0) / values.length),
            rawMuted: raw.muted,
            selectedRaw,
            blocked: client.getSnapshot().audioBlocked,
            outputPaused: output.paused,
            outputAttached: !!output.srcObject,
          };
        },
        end: () => {
          Reflect.get(client, 'disposeMedia').call(client);
          sender.close();
          receiver.close();
          document.getElementById('start')!.dataset.ready = 'false';
        },
        dispose: async () => {
          analyser.disconnect();
          Reflect.get(client, 'releaseRingtone').call(client);
          oscillator.stop();
          source.stream.getTracks().forEach((track) => track.stop());
          await sourceContext.close();
        },
      },
    });
  });

  for (let call = 0; call < 2; call++) {
    await page.locator('#start').click();
    await expect(page.locator('#start')).toHaveAttribute('data-ready', 'true');
    await expect
      .poll(() => page.evaluate(() => Reflect.get(window, 'audioPlaybackProbe').sample().rms))
      .toBeGreaterThan(0.01);

    for (let index = 0; index < 10; index++) {
      await page.locator('#route').click();
      await expect(page.locator('#route')).toHaveAttribute(
        'data-count',
        String(call * 10 + index + 1),
      );
    }

    const { rawMuted, selectedRaw, blocked, rms } = await page.evaluate(() =>
      Reflect.get(window, 'audioPlaybackProbe').sample(),
    );

    expect(rawMuted).toBe(true);
    expect(selectedRaw).toBe(0);
    expect(blocked).toBe(false);
    expect(rms).toBeGreaterThan(0.01);
    await page.evaluate(() => Reflect.get(window, 'audioPlaybackProbe').end());
    await expect
      .poll(() => page.evaluate(() => Reflect.get(window, 'audioPlaybackProbe').sample().rms))
      .toBeLessThan(0.005);
    const { outputPaused, outputAttached } = await page.evaluate(() =>
      Reflect.get(window, 'audioPlaybackProbe').sample(),
    );

    expect(outputPaused).toBe(true);
    expect(outputAttached).toBe(false);
  }

  await page.evaluate(() => Reflect.get(window, 'audioPlaybackProbe').dispose());
});

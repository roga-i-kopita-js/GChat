import { expect, test } from '@playwright/test';

test.use({ launchOptions: { args: ['--mute-audio'] } });

for (const profile of ['context', 'media-element']) {
  test(`outgoing music plays, loops and becomes silent after transitions in the ${profile} profile`, async ({
    page,
  }) => {
    test.setTimeout(65000);
    await page.route('**/outgoing-ringback-probe', (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: '<button id="dial">Dial</button><button id="activate">Activate</button>',
      }),
    );
    await page.goto('/outgoing-ringback-probe');
    await page.evaluate(async (profile) => {
      const audit = new AudioContext({ sinkId: { type: 'none' } } as AudioContextOptions);

      if (profile === 'media-element') {
        Object.defineProperty(AudioContext.prototype, 'setSinkId', {
          configurable: true,
          value: undefined,
        });
      }

      const path = '/src/shared/calls/client.ts';
      const { GChatClient } = await import(path);
      const client = new GChatClient();
      const set = (patch: object): void => Reflect.get(client, 'set').call(client, patch);

      Reflect.set(client, 'isCaller', () => true);
      Reflect.set(client, 'transport', { changed: () => {}, isUpdating: () => false });
      const call = {
        call_id: '00000000-0000-4000-8000-000000000001',
        state: 'ringing',
        caller_id: 'caller',
        recipient_id: 'recipient',
        created_at: '2026-11-16T00:00:00Z',
        started_at: null,
        ended_at: null,
        end_reason: null,
        recovery_id: null,
        recovery_deadline: null,
        ringing_deadline: null,
        connecting_deadline: null,
        version: 1,
      };
      let count = 0;
      let analyser: AnalyserNode;

      document.getElementById('dial')!.onclick = () => {
        void (async () => {
          await Promise.all([client.preparePlayback(), audit.resume()]);
          set({
            owner: true,
            selected: true,
            connection: 'online',
            call: { ...call, call_id: String(++count).padStart(36, '0') },
          });
          document.getElementById('dial')!.dataset.ready = String(count);
        })();
      };
      document.getElementById('activate')!.onclick = () => {
        void client.enableRingtone();
      };
      Object.assign(window, {
        ringbackProbe: {
          observe: () => {
            const gain = Reflect.get(Reflect.get(client, 'ringback'), 'gain') as
              GainNode | undefined;

            if (!gain) {
              return false;
            }

            const context = Reflect.get(client, 'audioContext') as AudioContext;
            const stream = context.createMediaStreamDestination();

            gain.connect(stream);
            analyser = audit.createAnalyser();
            audit
              .createMediaStreamSource(stream.stream)
              .connect(analyser)
              .connect(audit.destination);

            return true;
          },
          sample: () => {
            const samples = new Float32Array(analyser.fftSize);
            const output = Reflect.get(Reflect.get(client, 'contextOutput'), 'audio') as
              HTMLAudioElement | undefined;

            analyser.getFloatTimeDomainData(samples);

            return {
              rms: Math.sqrt(samples.reduce((sum, x) => sum + x * x, 0) / samples.length),
              blocked: client.getSnapshot().audioBlocked,
              source: !!Reflect.get(Reflect.get(client, 'ringback'), 'source'),
              paused: output?.paused ?? true,
              attached: !!output?.srcObject,
            };
          },
          route: () => client.setAudioOutput(''),
          suspend: () => (Reflect.get(client, 'audioContext') as AudioContext).suspend(),
          transition: (patch: object) => set(patch),
          localCancel: () => {
            Reflect.set(client, 'transport', {
              changed: () => {},
              send: () => new Promise(() => {}),
            });
            void client.end();
          },
          dispose: async () => {
            Reflect.get(client, 'disposeMedia').call(client);
            Reflect.get(client, 'releaseRingtone').call(client);
            await audit.close();
          },
        },
      });
    }, profile);

    const transitions = [
      { call: { state: 'connecting' } },
      { call: { state: 'ended', end_reason: 'rejected' } },
      { call: { state: 'ended', end_reason: 'no_answer' } },
      { owner: false },
      { selected: false },
      { connection: 'offline' },
      null,
    ];

    for (const [index, patch] of transitions.entries()) {
      await page.locator('#dial').click();
      await expect(page.locator('#dial')).toHaveAttribute('data-ready', String(index + 1));
      await expect
        .poll(() => page.evaluate(() => Reflect.get(window, 'ringbackProbe').observe()))
        .toBe(true);
      await expect
        .poll(() => page.evaluate(() => Reflect.get(window, 'ringbackProbe').sample().rms))
        .toBeGreaterThan(0.005);
      await page.evaluate(() => Reflect.get(window, 'ringbackProbe').route());

      if (profile === 'media-element' && index === 0) {
        await page.evaluate(() => Reflect.get(window, 'ringbackProbe').suspend());
        await expect
          .poll(() => page.evaluate(() => Reflect.get(window, 'ringbackProbe').sample().source))
          .toBe(false);
        const { blocked } = await page.evaluate(() =>
          Reflect.get(window, 'ringbackProbe').sample(),
        );

        expect(blocked).toBe(true);
        await page.locator('#activate').click();
        await expect
          .poll(() => page.evaluate(() => Reflect.get(window, 'ringbackProbe').observe()))
          .toBe(true);
        await expect
          .poll(() => page.evaluate(() => Reflect.get(window, 'ringbackProbe').sample().rms))
          .toBeGreaterThan(0.005);
      }

      if (profile === 'context' && index === 0) {
        // Cross the actual 30-second boundary to check a real decoded loop.
        await page.waitForTimeout(30500);
        await expect
          .poll(() => page.evaluate(() => Reflect.get(window, 'ringbackProbe').sample().rms))
          .toBeGreaterThan(0.005);
      }

      if (patch) {
        await page.evaluate(
          (patch) => Reflect.get(window, 'ringbackProbe').transition(patch),
          patch,
        );
      } else {
        await page.evaluate(() => Reflect.get(window, 'ringbackProbe').localCancel());
      }

      await expect
        .poll(() => page.evaluate(() => Reflect.get(window, 'ringbackProbe').sample().rms))
        .toBeLessThan(0.00001);
      const { source, attached, paused, blocked } = await page.evaluate(() =>
        Reflect.get(window, 'ringbackProbe').sample(),
      );

      expect(source).toBe(false);
      expect(attached).toBe(false);
      expect(paused).toBe(true);
      expect(blocked).toBe(false);
    }

    await page.evaluate(() => Reflect.get(window, 'ringbackProbe').dispose());
  });
}

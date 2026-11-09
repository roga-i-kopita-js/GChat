import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import type { Browser, BrowserContext, Page } from '@playwright/test';
import { expect, test } from '@playwright/test';

import type {} from '../../fixtures/protocol/participant';
import { dial, login } from '../../fixtures/web/actions';
import { observePlayback } from '../../fixtures/web/audio-observer';

const contexts: BrowserContext[] = [];

test.beforeEach((): void => {
  execFileSync(process.execPath, [
    fileURLToPath(new URL('../../scripts/reset.mjs', import.meta.url)),
  ]);
});
test.afterEach(async (): Promise<void> => {
  for (const context of contexts.splice(0)) {
    try {
      for (const page of context.pages()) {
        await page.evaluate(async (): Promise<void> => {
          await window.playbackProbe?.dispose();
        });
      }
    } finally {
      await context.close();
    }
  }
});

async function pair(
  browser: Browser,
): Promise<{ web: Page; peer: Page; signaling: { opened: number; closed: number } }> {
  const ui = await browser.newContext({ permissions: ['microphone'] });
  const reference = await browser.newContext();

  const signaling = { opened: 0, closed: 0 };

  const { on: uiOn } = ui;

  uiOn.bind(ui)('page', (page): void => {
    page.on('websocket', (socket): void => {
      // Vite HMR has its own socket on every page; only /ws is GChat signaling.
      if (new URL(socket.url()).pathname !== '/ws') {
        return;
      }

      signaling.opened++;
      socket.on('close', (): void => {
        signaling.closed++;
      });
    });
  });
  contexts.push(ui, reference);
  const { newPage: uiNewPage } = ui;
  const web = await uiNewPage.bind(ui)();
  const { newPage: referenceNewPage } = reference;
  const peer = await referenceNewPage.bind(reference)();

  const { addInitScript: webAddInitScript } = web;

  await webAddInitScript.bind(web)(observePlayback);
  await login(web, 'anna');
  const { goto: peerGoto } = peer;

  await peerGoto.bind(peer)('http://127.0.0.1:5174/fixtures/protocol/participant.html');
  const { waitForFunction: peerWaitForFunction } = peer;

  await peerWaitForFunction.bind(peer)((): boolean => !!window.callActor);
  const { evaluate: peerEvaluate } = peer;

  await peerEvaluate.bind(peer)((): Promise<void> => window.callActor.login('maxim'));

  return { web, peer, signaling };
}

async function command(page: Page, type: string, payload: object): Promise<any> {
  return page.evaluate(
    ({ type, payload }): Promise<any> => window.callActor.request(type, payload),
    { type, payload },
  );
}
async function peerSample(page: Page): Promise<any> {
  return page.evaluate((): Promise<any> => window.callActor.snapshot());
}
async function playback(page: Page): Promise<ReturnType<Window['playbackProbe']['sample']>> {
  return page.evaluate((): ReturnType<Window['playbackProbe']['sample']> =>
    window.playbackProbe.sample(),
  );
}
async function session(page: Page): Promise<{
  userId: string;
  sessionId: string;
  deviceId: string;
  issuedAt: number;
  expiresAt: number;
  pending: boolean;
}> {
  return page.evaluate(
    (): {
      userId: string;
      sessionId: string;
      deviceId: string;
      issuedAt: number;
      expiresAt: number;
      pending: boolean;
    } => {
      const stored = JSON.parse(localStorage.getItem('gchat.session.v1')!);
      const claims = JSON.parse(
        atob(stored.access_token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')),
      );

      return {
        userId: claims.sub,
        sessionId: claims.sid,
        deviceId: stored.deviceId,
        issuedAt: claims.iat * 1000,
        expiresAt: claims.exp * 1000,
        pending: stored.pending !== null,
      };
    },
  );
}

async function start(web: Page, peer: Page, direction: 'incoming' | 'outgoing'): Promise<string> {
  let id: string;
  let negotiation: string;

  if (direction === 'incoming') {
    const { userId: resultUserId } = await session(web);
    const { call: resultCall } = await command(peer, 'call.create', {
      recipient_id: resultUserId,
    });

    id = resultCall.call_id;
    await expect(web.getByTestId('call-status')).toHaveText('Входящий звонок');
    await web.getByRole('button', { name: 'Принять', exact: true }).click();
    await expect
      .poll(async (): Promise<string> => {
        const { calls: resultCalls } = await peerSample(peer);

        return resultCalls.at(-1)?.state;
      })
      .toBe('connecting');
    await peer.evaluate((id): Promise<void> => window.callActor.prepare(id, 880), id);
    negotiation = await peer.evaluate((): Promise<string> => window.callActor.offer());
    await expect
      .poll((): Promise<boolean> =>
        peer.evaluate((): boolean =>
          window.callActor.events.some((event): boolean => event.type === 'rtc.answer'),
        ),
      )
      .toBe(true);
    await peer.evaluate((): Promise<void> => window.callActor.applyAnswer());
  } else {
    await dial(web, 'Максим Волков');
    await expect
      .poll(async (): Promise<string> => {
        const { calls: resultCalls2 } = await peerSample(peer);

        return resultCalls2.at(-1)?.state;
      })
      .toBe('ringing');
    const { calls: resultCalls3 } = await peerSample(peer);

    id = resultCalls3.at(-1).call_id;
    await command(peer, 'call.accept', { call_id: id });
    await peer.evaluate((id): Promise<void> => window.callActor.prepare(id, 880), id);
    await expect
      .poll((): Promise<boolean> =>
        peer.evaluate((): boolean =>
          window.callActor.events.some((event): boolean => event.type === 'rtc.offer'),
        ),
      )
      .toBe(true);
    negotiation = await peer.evaluate((): Promise<string> => window.callActor.answer());
  }

  await expect
    .poll(
      async (): Promise<string> => {
        const { connection: resultConnection } = await peerSample(peer);

        return resultConnection;
      },
      { timeout: 20000 },
    )
    .toBe('connected');
  await command(peer, 'call.connected', { call_id: id, negotiation_id: negotiation });
  await expect(web.getByTestId('call-status')).toHaveText('Разговор', { timeout: 20000 });
  await expect
    .poll(async (): Promise<string> => {
      const { calls: resultCalls4 } = await peerSample(peer);

      return resultCalls4.at(-1)?.state;
    })
    .toBe('active');

  return id;
}

function microphoneTone(frequency: number): boolean {
  return [440, 660].some((expected): boolean => Math.abs(frequency - expected) < 25);
}
async function tones(web: Page, peer: Page): Promise<void> {
  await expect
    .poll(
      async (): Promise<boolean> => {
        const {
          relay: receivedRelay,
          rms: receivedRms,
          peakHz: receivedPeakHz,
        } = await peerSample(peer);

        return receivedRelay && receivedRms > 0.01 && microphoneTone(receivedPeakHz);
      },
      { timeout: 15000, message: 'Native web microphone WAV must decode at the reference peer' },
    )
    .toBe(true);
  await expect
    .poll(
      async (): Promise<boolean> => {
        const {
          playing: receivedPlaying,
          rms: receivedRms2,
          peakHz: receivedPeakHz2,
          errors: receivedErrors,
        } = await playback(web);

        return (
          receivedPlaying &&
          receivedRms2 > 0.01 &&
          Math.abs(receivedPeakHz2 - 880) < 20 &&
          receivedErrors.length === 0
        );
      },
      { timeout: 15000, message: 'The actual web audio element must play the decoded peer tone' },
    )
    .toBe(true);
}
async function finish(web: Page, peer: Page, id: string): Promise<void> {
  await web.getByRole('button', { name: 'Завершить', exact: true }).click();
  await expect(web.getByTestId('call-status')).toHaveText('Разговор завершён');
  await expect
    .poll(async (): Promise<string> => {
      const { call: resultCall2 } = await command(peer, 'call.get', { call_id: id });

      return resultCall2.end_reason;
    })
    .toBe('hangup');
  await expect
    .poll(async (): Promise<boolean> => {
      const output = await playback(web);

      const {
        playing: outputPlaying,
        attached: outputAttached,
        liveTracks: outputLiveTracks,
      } = output ?? {};

      return !outputPlaying && !outputAttached && outputLiveTracks === 0;
    })
    .toBe(true);
  await expect
    .poll(async (): Promise<number[]> => {
      const {
        livePeers: sampleLivePeers,
        liveTracks: sampleLiveTracks,
        liveContexts: sampleLiveContexts,
      } = await peerSample(peer);

      return [sampleLivePeers, sampleLiveTracks, sampleLiveContexts];
    })
    .toEqual([0, 0, 0]);
  const { errors: resultErrors } = await peerSample(peer);

  expect(resultErrors).toEqual([]);
}

for (const direction of ['incoming', 'outgoing'] as const) {
  test(
    'native web audio and real mute/unmute: ' + direction,
    async ({ browser }): Promise<void> => {
      const { web, peer, signaling } = await pair(browser);
      const id = await start(web, peer, direction);

      await tones(web, peer);
      const before = await peerSample(peer);

      await web.getByRole('button', { name: 'Микрофон', exact: true }).click();
      await expect
        .poll(async (): Promise<number> => {
          const { rms: resultRms } = await peerSample(peer);

          return resultRms;
        })
        .toBeLessThan(0.005);
      await expect
        .poll(async (): Promise<boolean> => {
          const sample = await peerSample(peer);

          const { received: sampleReceived } = sample;
          const { received: beforeReceived } = before;
          const { rms: sampleRms, connection: sampleConnection } = sample;

          return (
            sampleReceived > beforeReceived && sampleRms < 0.005 && sampleConnection === 'connected'
          );
        })
        .toBe(true);
      const incoming = await playback(web);

      const { playing: incomingPlaying } = incoming;

      expect(incomingPlaying).toBe(true);
      const { rms: incomingRms } = incoming;

      expect(incomingRms).toBeGreaterThan(0.01);
      const { peakHz: incomingPeakHz } = incoming;

      expect(Math.abs(incomingPeakHz - 880)).toBeLessThan(20);
      await expect(web.getByTestId('call-status')).toHaveText('Разговор');
      const { calls: resultCalls5 } = await peerSample(peer);

      expect(resultCalls5.at(-1).state).toBe('active');
      await web.getByRole('button', { name: 'Включить микрофон', exact: true }).click();
      await tones(web, peer);
      expect(signaling).toEqual({ opened: 1, closed: 0 });
      await finish(web, peer, id);
    },
  );
}

declare global {
  interface Window {
    checkOriginalAccess: () => Promise<{ status: number; code: string | null }>;
  }
}

test('live audio survives real JWT expiry and one refresh shared by browser tabs', async ({
  browser,
}): Promise<void> => {
  test.setTimeout(210000);
  const { web, peer, signaling } = await pair(browser);
  const context = web.context();
  let refreshRequests = 0;
  const refreshStatuses: number[] = [];
  let contactsAfterRefresh = 0;

  // No frame payloads, request bodies or credentials are collected.
  context.on('request', (request): void => {
    if (new URL(request.url()).pathname === '/api/auth/refresh') {
      refreshRequests++;
    }
  });
  context.on('response', (response): void => {
    const path = new URL(response.url()).pathname;

    if (path === '/api/auth/refresh') {
      refreshStatuses.push(response.status());
    }

    if (
      path.startsWith('/api/groups') &&
      response.status() === 200 &&
      refreshStatuses.includes(200)
    ) {
      contactsAfterRefresh++;
    }
  });
  const original = await session(web);

  await web.evaluate((): void => {
    const token = JSON.parse(localStorage.getItem('gchat.session.v1')!).access_token;

    window.checkOriginalAccess = async (): Promise<{ status: number; code: string | null }> => {
      const response = await fetch('/api/groups', {
        headers: { Authorization: 'Bearer ' + token },
      });
      const { json: responseJson } = response;
      const body = await responseJson.bind(response)();

      const { status: responseStatus } = response;
      const { error: bodyError } = body;

      return { status: responseStatus, code: bodyError?.code ?? null };
    };
  });
  const id = await start(web, peer, 'outgoing');

  await tones(web, peer);
  const { calls: resultCalls6 } = await peerSample(peer);
  const initial = resultCalls6.at(-1);
  const counters = await peerSample(peer);
  let observations = 0;
  const { expiresAt: originalExpiresAt, issuedAt: originalIssuedAt } = original;
  const sampleInterval = Math.min(3000, Math.max(100, (originalExpiresAt - originalIssuedAt) / 20));

  // Observe real passage of the signed JWT lifetime; do not fast-forward clocks.
  while (Date.now() < originalExpiresAt + 1500) {
    const signal = await peerSample(peer);
    const rendered = await playback(web);

    const { relay: signalRelay } = signal;

    expect(signalRelay).toBe(true);
    const { rms: signalRms } = signal;

    expect(signalRms).toBeGreaterThan(0.01);
    const { peakHz: signalPeakHz } = signal;

    expect(microphoneTone(signalPeakHz)).toBe(true);
    const { playing: renderedPlaying } = rendered;

    expect(renderedPlaying).toBe(true);
    const { rms: renderedRms } = rendered;

    expect(renderedRms).toBeGreaterThan(0.01);
    const { peakHz: renderedPeakHz } = rendered;

    expect(Math.abs(renderedPeakHz - 880)).toBeLessThan(20);
    const { errors: renderedErrors } = rendered;

    expect(renderedErrors).toEqual([]);
    await expect(web.getByTestId('call-status')).toHaveText('Разговор');
    const { calls: resultCalls7 } = await peerSample(peer);
    const call = resultCalls7.at(-1);

    expect([call.call_id, call.state, call.version, call.recovery_id]).toEqual([
      id,
      'active',
      initial.version,
      null,
    ]);
    observations++;

    if (observations % 10 === 0) {
      console.log('Live audio continuity samples:', observations);
    }

    await new Promise<void>((resolve): void => {
      setTimeout(resolve, sampleInterval);
    });
  }

  expect(observations).toBeGreaterThanOrEqual(3);
  expect(
    await web.evaluate((): Promise<{ status: number; code: string | null }> =>
      window.checkOriginalAccess(),
    ),
  ).toEqual({ status: 401, code: 'ACCESS_TOKEN_EXPIRED' });
  const followers = await Promise.all([context.newPage(), context.newPage()]);

  const { map: followersMap } = followers;

  await Promise.all(
    followersMap.bind(followers)(async (page): Promise<void> => {
      await page.goto('/');
      await expect(page.getByRole('main', { name: 'Звонки', exact: true })).toBeVisible();
      await page.getByRole('button', { name: 'Диагностика', exact: true }).click();
      await expect(page.getByText('Звонками управляет другая вкладка GChat.')).toBeVisible();
      await page.getByRole('button', { name: 'Закрыть', exact: true }).click();
    }),
  );
  await expect.poll((): number => contactsAfterRefresh, { timeout: 15000 }).toBeGreaterThan(0);
  expect(refreshRequests).toBe(1);
  expect(refreshStatuses).toEqual([200]);
  const rotated = await session(web);

  const { sessionId: rotatedSessionId } = rotated;
  const { sessionId: originalSessionId } = original;

  expect(rotatedSessionId).toBe(originalSessionId);
  const { deviceId: rotatedDeviceId } = rotated;
  const { deviceId: originalDeviceId } = original;

  expect(rotatedDeviceId).toBe(originalDeviceId);
  const { expiresAt: rotatedExpiresAt } = rotated;
  const { expiresAt: originalExpiresAt2 } = original;

  expect(rotatedExpiresAt).toBeGreaterThan(originalExpiresAt2);
  const { pending: rotatedPending } = rotated;

  expect(rotatedPending).toBe(false);

  for (const follower of followers) {
    expect(await session(follower)).toEqual(rotated);
  }

  expect(signaling).toEqual({ opened: 1, closed: 0 });
  await tones(web, peer);
  const after = await peerSample(peer);

  const { calls: afterCalls } = after;

  expect(afterCalls).toHaveLength(1);
  const { calls: afterCalls2 } = after;

  expect(afterCalls2[0].started_at).toBe(initial.started_at);
  const { calls: afterCalls3 } = after;

  expect(afterCalls3[0].version).toBe(initial.version);
  const { sent: afterSent } = after;
  const { sent: countersSent } = counters;

  expect(afterSent).toBeGreaterThan(countersSent);
  const { received: afterReceived } = after;
  const { received: countersReceived } = counters;

  expect(afterReceived).toBeGreaterThan(countersReceived);
  await finish(web, peer, id);
});

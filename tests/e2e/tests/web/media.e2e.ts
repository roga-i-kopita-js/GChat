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

  ui.on('page', (page): void => {
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
  const web = await ui.newPage();
  const peer = await reference.newPage();

  await web.addInitScript(observePlayback);
  await login(web, 'anna');
  await peer.goto('http://127.0.0.1:5174/fixtures/protocol/participant.html');
  await peer.waitForFunction((): boolean => !!window.callActor);
  await peer.evaluate((): Promise<void> => window.callActor.login('maxim'));

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
    const result = await command(peer, 'call.create', {
      recipient_id: (await session(web)).userId,
    });

    id = result.call.call_id;
    await expect(web.getByTestId('call-status')).toHaveText('Входящий звонок');
    await web.getByRole('button', { name: 'Принять', exact: true }).click();
    await expect
      .poll(async (): Promise<string> => (await peerSample(peer)).calls.at(-1)?.state)
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
      .poll(async (): Promise<string> => (await peerSample(peer)).calls.at(-1)?.state)
      .toBe('ringing');
    id = (await peerSample(peer)).calls.at(-1).call_id;
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
    .poll(async (): Promise<string> => (await peerSample(peer)).connection, { timeout: 20000 })
    .toBe('connected');
  await command(peer, 'call.connected', { call_id: id, negotiation_id: negotiation });
  await expect(web.getByTestId('call-status')).toHaveText('Разговор', { timeout: 20000 });
  await expect
    .poll(async (): Promise<string> => (await peerSample(peer)).calls.at(-1)?.state)
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
        const received = await peerSample(peer);

        return received.relay && received.rms > 0.01 && microphoneTone(received.peakHz);
      },
      { timeout: 15000, message: 'Native web microphone WAV must decode at the reference peer' },
    )
    .toBe(true);
  await expect
    .poll(
      async (): Promise<boolean> => {
        const received = await playback(web);

        return (
          received.playing &&
          received.rms > 0.01 &&
          Math.abs(received.peakHz - 880) < 20 &&
          received.errors.length === 0
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
    .poll(
      async (): Promise<string> =>
        (await command(peer, 'call.get', { call_id: id })).call.end_reason,
    )
    .toBe('hangup');
  await expect
    .poll(async (): Promise<boolean> => {
      const output = await playback(web);

      return !output.playing && !output.attached && output.liveTracks === 0;
    })
    .toBe(true);
  await expect
    .poll(async (): Promise<number[]> => {
      const sample = await peerSample(peer);

      return [sample.livePeers, sample.liveTracks, sample.liveContexts];
    })
    .toEqual([0, 0, 0]);
  expect((await peerSample(peer)).errors).toEqual([]);
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
        .poll(async (): Promise<number> => (await peerSample(peer)).rms)
        .toBeLessThan(0.005);
      await expect
        .poll(async (): Promise<boolean> => {
          const sample = await peerSample(peer);

          return (
            sample.received > before.received &&
            sample.rms < 0.005 &&
            sample.connection === 'connected'
          );
        })
        .toBe(true);
      const incoming = await playback(web);

      expect(incoming.playing).toBe(true);
      expect(incoming.rms).toBeGreaterThan(0.01);
      expect(Math.abs(incoming.peakHz - 880)).toBeLessThan(20);
      await expect(web.getByTestId('call-status')).toHaveText('Разговор');
      expect((await peerSample(peer)).calls.at(-1).state).toBe('active');
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
      const body = await response.json();

      return { status: response.status, code: body.error?.code ?? null };
    };
  });
  const id = await start(web, peer, 'outgoing');

  await tones(web, peer);
  const initial = (await peerSample(peer)).calls.at(-1);
  const counters = await peerSample(peer);
  let observations = 0;
  const sampleInterval = Math.min(
    3000,
    Math.max(100, (original.expiresAt - original.issuedAt) / 20),
  );

  // Observe real passage of the signed JWT lifetime; do not fast-forward clocks.
  while (Date.now() < original.expiresAt + 1500) {
    const signal = await peerSample(peer);
    const rendered = await playback(web);

    expect(signal.relay).toBe(true);
    expect(signal.rms).toBeGreaterThan(0.01);
    expect(microphoneTone(signal.peakHz)).toBe(true);
    expect(rendered.playing).toBe(true);
    expect(rendered.rms).toBeGreaterThan(0.01);
    expect(Math.abs(rendered.peakHz - 880)).toBeLessThan(20);
    expect(rendered.errors).toEqual([]);
    await expect(web.getByTestId('call-status')).toHaveText('Разговор');
    const call = (await peerSample(peer)).calls.at(-1);

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

  await Promise.all(
    followers.map(async (page): Promise<void> => {
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

  expect(rotated.sessionId).toBe(original.sessionId);
  expect(rotated.deviceId).toBe(original.deviceId);
  expect(rotated.expiresAt).toBeGreaterThan(original.expiresAt);
  expect(rotated.pending).toBe(false);

  for (const follower of followers) {
    expect(await session(follower)).toEqual(rotated);
  }

  expect(signaling).toEqual({ opened: 1, closed: 0 });
  await tones(web, peer);
  const after = await peerSample(peer);

  expect(after.calls).toHaveLength(1);
  expect(after.calls[0].started_at).toBe(initial.started_at);
  expect(after.calls[0].version).toBe(initial.version);
  expect(after.sent).toBeGreaterThan(counters.sent);
  expect(after.received).toBeGreaterThan(counters.received);
  await finish(web, peer, id);
});

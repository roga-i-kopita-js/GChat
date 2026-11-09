import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import type { Browser, BrowserContext, Page } from '@playwright/test';
import { expect, test } from '@playwright/test';

import type {} from '../../fixtures/protocol/participant';

const contexts: BrowserContext[] = [];
const script = (name: string): string =>
  fileURLToPath(new URL('../../scripts/' + name + '.mjs', import.meta.url));
const inspect = (): any =>
  JSON.parse(execFileSync(process.execPath, [script('inspect')], { encoding: 'utf8' }));

test.beforeEach((): void => {
  execFileSync(process.execPath, [script('reset')]);
});
test.afterEach(async (): Promise<void> => {
  await Promise.all(contexts.splice(0).map((context): Promise<void> => context.close()));
});

async function participant(browser: Browser, login: string): Promise<Page> {
  const context = await browser.newContext();

  contexts.push(context);
  const { newPage: contextNewPage } = context;
  const page = await contextNewPage.bind(context)();

  const { goto: pageGoto } = page;

  await pageGoto.bind(page)('/fixtures/protocol/participant.html');
  const { waitForFunction: pageWaitForFunction } = page;

  await pageWaitForFunction.bind(page)((): boolean => !!window.callActor);
  const { evaluate: pageEvaluate } = page;

  await pageEvaluate.bind(page)((name): Promise<void> => window.callActor.login(name), login);

  return page;
}

async function command(page: Page, type: string, payload: object = {}): Promise<any> {
  return page.evaluate(
    ({ type, payload }): Promise<any> => window.callActor.request(type, payload),
    { type, payload },
  );
}
async function result(page: Page, type: string, payload: object): Promise<string> {
  try {
    await command(page, type, payload);

    return 'OK';
  } catch (error) {
    return (error as Error).message.split('\n')[0].replace(/^.*Error: /, '');
  }
}
async function snapshot(page: Page): Promise<any> {
  return page.evaluate((): Promise<any> => window.callActor.snapshot());
}
async function identity(page: Page): Promise<string> {
  return page.evaluate((): string => window.callActor.userId);
}
async function create(a: Page, b: Page): Promise<string> {
  const recipient_idValue = await identity(b);
  const { call } = await command(a, 'call.create', { recipient_id: recipient_idValue });

  await state(b, call.call_id, 'ringing');

  return call.call_id;
}
async function state(page: Page, id: string, expected: string): Promise<any> {
  await expect
    .poll(
      async (): Promise<string | undefined> => {
        const { calls: resultCalls } = await snapshot(page);

        return resultCalls.find((call: any): boolean => call.call_id === id)?.state;
      },
      { timeout: 75000 },
    )
    .toBe(expected);

  const { calls: resultCalls2 } = await snapshot(page);

  return resultCalls2.find((call: any): boolean => call.call_id === id);
}
async function event(page: Page, type: string, id: string): Promise<void> {
  await expect
    .poll((): Promise<boolean> =>
      page.evaluate(
        ({ type, id }): boolean =>
          window.callActor.events.some(
            (event): boolean => event.type === type && event.payload.negotiation_id === id,
          ),
        { type, id },
      ),
    )
    .toBe(true);
}
async function media(a: Page, b: Page, id: string, unavailableTurn = false): Promise<string> {
  await Promise.all([
    a.evaluate(
      ({ id, unavailableTurn }): Promise<void> =>
        window.callActor.prepare(id, 440, unavailableTurn),
      { id, unavailableTurn },
    ),
    b.evaluate(
      ({ id, unavailableTurn }): Promise<void> =>
        window.callActor.prepare(id, 880, unavailableTurn),
      { id, unavailableTurn },
    ),
  ]);
  const negotiation = await a.evaluate((): Promise<string> => window.callActor.offer());

  await event(b, 'rtc.offer', negotiation);
  expect(await b.evaluate((): Promise<string> => window.callActor.answer())).toBe(negotiation);
  await event(a, 'rtc.answer', negotiation);
  await a.evaluate((): Promise<void> => window.callActor.applyAnswer());

  return negotiation;
}
async function connected(a: Page, b: Page, id: string, negotiation: string): Promise<void> {
  for (const page of [a, b]) {
    await expect
      .poll(
        async (): Promise<string> => {
          const { connection: resultConnection } = await snapshot(page);

          return resultConnection;
        },
        { timeout: 20000 },
      )
      .toBe('connected');
  }

  await command(a, 'call.connected', { call_id: id, negotiation_id: negotiation });
  await command(b, 'call.connected', { call_id: id, negotiation_id: negotiation });
  await state(a, id, 'active');
  await state(b, id, 'active');
}
async function audio(a: Page, b: Page): Promise<void> {
  for (const [page, frequency] of [
    [a, 880],
    [b, 440],
  ] as const) {
    await expect
      .poll(
        async (): Promise<boolean> => {
          const { relay: resultRelay } = await snapshot(page);

          return resultRelay;
        },
        {
          timeout: 15000,
          message: 'Both selected candidates must use TURN relay',
        },
      )
      .toBe(true);
    await (async () => {
      try {
        return await expect
          .poll(
            async (): Promise<number> => {
              const { rms: resultRms } = await snapshot(page);

              return resultRms;
            },
            {
              timeout: 15000,
              message: 'Decoded remote PCM must carry audio energy',
            },
          )
          .toBeGreaterThan(0.01);
      } catch (cause) {
        const error = cause instanceof Error ? cause : new Error(String(cause));

        const {
          rms,
          peakHz,
          connection,
          sent,
          received,
          relay,
          audioState,
          outputPaused,
          receivedEnergy,
          sourceEnergy,
        } = await snapshot(page);

        console.log('Audio metrics', {
          rms,
          peakHz,
          connection,
          sent,
          received,
          relay,
          audioState,
          outputPaused,
          receivedEnergy,
          sourceEnergy,
        });

        throw error;
      }
    })();
    await expect
      .poll(
        async (): Promise<number> => {
          const { peakHz: resultPeakHz } = await snapshot(page);

          return Math.abs(resultPeakHz - frequency);
        },
        {
          timeout: 15000,
          message: 'Decoded remote tone must match ' + frequency + ' Hz',
        },
      )
      .toBeLessThan(20);
    const before = await snapshot(page);

    await expect
      .poll(async (): Promise<boolean> => {
        const after = await snapshot(page);

        const { sent: afterSent } = after;
        const { sent: beforeSent } = before;
        const { received: afterReceived } = after;
        const { received: beforeReceived } = before;

        return afterSent > beforeSent && afterReceived > beforeReceived;
      })
      .toBe(true);
  }
}
async function ended(a: Page, b: Page, id: string, reason: string): Promise<void> {
  const left = await state(a, id, 'ended');
  const right = await state(b, id, 'ended');

  expect(left).toEqual(right);
  const { end_reason: leftEndReason } = left;

  expect(leftEndReason).toBe(reason);

  for (const page of [a, b]) {
    await expect
      .poll(async (): Promise<number[]> => {
        const {
          livePeers: sampleLivePeers,
          liveTracks: sampleLiveTracks,
          liveContexts: sampleLiveContexts,
        } = await snapshot(page);

        return [sampleLivePeers, sampleLiveTracks, sampleLiveContexts];
      })
      .toEqual([0, 0, 0]);
    expect(await command(page, 'call.current')).toEqual({ call: null });
    const { errors: resultErrors } = await snapshot(page);

    expect(resultErrors).toEqual([]);
  }

  await expect
    .poll((): boolean => {
      const data = inspect();

      return (
        data.busy === 0 &&
        data.participants
          .filter((p: any): boolean => p.call_id === id)
          .every((p: any): boolean => p.released_at !== null)
      );
    })
    .toBe(true);
}
async function start(a: Page, b: Page): Promise<string> {
  const id = await create(a, b);

  await command(b, 'call.accept', { call_id: id });
  const negotiation = await media(a, b, id);

  await connected(a, b, id, negotiation);
  await audio(a, b);

  return id;
}

test('two complete calls: one negotiation, decoded audio both ways, release and repeat', async ({
  browser,
}): Promise<void> => {
  const a = await participant(browser, 'anna');
  const b = await participant(browser, 'maxim');

  for (let iteration = 0; iteration < 2; iteration++) {
    const id = await create(a, b);

    const accepted = await command(b, 'call.accept', { call_id: id });

    expect(await command(b, 'call.accept', { call_id: id })).toEqual(accepted);
    const negotiation = await media(a, b, id);

    for (const page of [a, b]) {
      await expect
        .poll(
          async (): Promise<string> => {
            const { connection: resultConnection2 } = await snapshot(page);

            return resultConnection2;
          },
          { timeout: 20000 },
        )
        .toBe('connected');
    }

    await command(a, 'call.connected', { call_id: id, negotiation_id: negotiation });
    const { call: resultCall } = await command(a, 'call.get', { call_id: id });

    expect(resultCall.state).toBe('connecting');
    await command(b, 'call.connected', { call_id: id, negotiation_id: negotiation });
    const active = await state(a, id, 'active');

    await state(b, id, 'active');
    const { started_at: activeStartedAt } = active;

    expect(activeStartedAt).not.toBeNull();
    const participants = inspect().participants.filter((p: any): boolean => p.call_id === id);

    expect(participants).toHaveLength(2);
    expect(
      participants.every((p: any): boolean => p.connected_negotiation_id === negotiation),
    ).toBe(true);

    for (const page of [a, b]) {
      const { audioSink: resultAudioSink } = await snapshot(page);

      expect(resultAudioSink).toBe('none');
    }

    await audio(a, b);

    if (iteration === 0) {
      // Browser collection must not tear down an ongoing media graph.
      const { requestGC: aRequestGC } = a;
      const { requestGC: bRequestGC } = b;

      await Promise.all([aRequestGC.bind(a)(), bRequestGC.bind(b)()]);
      await audio(a, b);
      const { evaluate: bEvaluate } = b;

      await bEvaluate.bind(b)((): void => window.callActor.setTone(false));
      await expect
        .poll(async (): Promise<number> => {
          const { rms: resultRms2 } = await snapshot(a);

          return resultRms2;
        })
        .toBeLessThan(0.005);
      const { evaluate: bEvaluate2 } = b;

      await bEvaluate2.bind(b)((): void => window.callActor.setTone(true));
      await audio(a, b);
    }

    const final = await command(a, 'call.end', { call_id: id });

    expect(await command(a, 'call.end', { call_id: id })).toEqual(final);
    await ended(a, b, id, 'hangup');
  }

  expect(inspect().calls).toHaveLength(2);
});

test('cancel and reject reach both devices and free users', async ({ browser }): Promise<void> => {
  const a = await participant(browser, 'anna');
  const b = await participant(browser, 'maxim');

  for (const [actor, type, reason] of [
    [a, 'call.cancel', 'cancelled'],
    [b, 'call.reject', 'rejected'],
  ] as const) {
    const id = await create(a, b);

    await command(actor, type, { call_id: id });
    await ended(a, b, id, reason);
  }
});

test('simultaneous opposite calls and third participant cannot reserve busy users', async ({
  browser,
}): Promise<void> => {
  const a = await participant(browser, 'anna');
  const b = await participant(browser, 'maxim');
  const c = await participant(browser, 'elena');
  const recipient_idValue2 = await identity(b);
  const firstCall = result(a, 'call.create', { recipient_id: recipient_idValue2 });
  const recipient_idValue3 = await identity(a);
  const results = await Promise.all([
    firstCall,
    result(b, 'call.create', { recipient_id: recipient_idValue3 }),
  ]);

  const { filter: resultsFilter } = results;

  expect(resultsFilter.bind(results)((value): boolean => value === 'OK')).toHaveLength(1);
  const { filter: resultsFilter2 } = results;

  expect(resultsFilter2.bind(results)((value): boolean => value !== 'OK')).toEqual(['CALLER_BUSY']);
  const data = inspect();

  expect(data.calls).toHaveLength(1);
  expect(data.participants.filter((p: any): boolean => p.released_at === null)).toHaveLength(2);
  const recipient_idValue4 = await identity(a);

  expect(await result(c, 'call.create', { recipient_id: recipient_idValue4 })).toBe(
    'RECIPIENT_BUSY',
  );
  const id = data.calls[0].id;
  const { [0]: resultsFirst } = results;
  const caller = resultsFirst === 'OK' ? a : b;

  await command(caller, 'call.cancel', { call_id: id });
  await ended(a, b, id, 'cancelled');
});

test('two recipient sessions race: exactly one controls media', async ({
  browser,
}): Promise<void> => {
  const a = await participant(browser, 'anna');
  const b = await participant(browser, 'maxim');
  const other = await participant(browser, 'maxim');
  const id = await create(a, b);

  await state(other, id, 'ringing');
  const results = await Promise.all([
    result(b, 'call.accept', { call_id: id }),
    result(other, 'call.accept', { call_id: id }),
  ]);

  const { filter: resultsFilter3 } = results;

  expect(resultsFilter3.bind(results)((value): boolean => value === 'OK')).toHaveLength(1);
  const { filter: resultsFilter4 } = results;

  expect(resultsFilter4.bind(results)((value): boolean => value !== 'OK')).toEqual(['FORBIDDEN']);
  const { [0]: resultsFirst2 } = results;
  const winner = resultsFirst2 === 'OK' ? b : other;
  const loser = winner === b ? other : b;

  expect(await result(loser, 'call.ice_config', { call_id: id })).toBe('FORBIDDEN');
  expect(await result(loser, 'call.end', { call_id: id })).toBe('FORBIDDEN');
  const negotiation = await media(a, winner, id);

  await connected(a, winner, id, negotiation);
  await audio(a, winner);
  const { livePeers: resultLivePeers } = await snapshot(loser);

  expect(resultLivePeers).toBe(0);
  await command(a, 'call.end', { call_id: id });
  await ended(a, winner, id, 'hangup');
  await state(loser, id, 'ended');
});

test('workers expire unanswered and unconnected calls without a P2P fallback', async ({
  browser,
}): Promise<void> => {
  const a = await participant(browser, 'anna');
  const b = await participant(browser, 'maxim');
  let id = await create(a, b);

  const { call: resultCall2 } = await command(a, 'call.get', { call_id: id });
  const ringingDeadline = resultCall2.ringing_deadline;

  await ended(a, b, id, 'no_answer');
  const { call: resultCall3 } = await command(a, 'call.get', { call_id: id });

  expect(Date.parse(resultCall3.ended_at)).toBeGreaterThanOrEqual(Date.parse(ringingDeadline));
  id = await create(a, b);
  await command(b, 'call.accept', { call_id: id });
  const { call: resultCall4 } = await command(a, 'call.get', { call_id: id });
  const connectingDeadline = resultCall4.connecting_deadline;

  await media(a, b, id, true);
  // Both endpoints really attempt relay-only ICE against an unreachable TURN port.
  const { connection: resultConnection3 } = await snapshot(a);

  expect(resultConnection3).not.toBe('connected');
  await ended(a, b, id, 'connection_timeout');
  const { call: resultCall5 } = await command(a, 'call.get', { call_id: id });

  expect(Date.parse(resultCall5.ended_at)).toBeGreaterThanOrEqual(Date.parse(connectingDeadline));
});

test('WS reconnect preserves selected session; media recovery keeps the call and start time', async ({
  browser,
}): Promise<void> => {
  const a = await participant(browser, 'anna');
  const b = await participant(browser, 'maxim');
  const id = await start(a, b);
  const { call: resultCall6 } = await command(a, 'call.get', { call_id: id });
  const initial = resultCall6;
  const { negotiation: resultNegotiation } = await snapshot(a);
  const oldNegotiation = resultNegotiation;
  const { evaluate: aEvaluate } = a;
  const device = await aEvaluate.bind(a)((): string | null => window.callActor.deviceId);

  const { evaluate: aEvaluate2 } = a;

  await aEvaluate2.bind(a)((): Promise<void> => window.callActor.disconnectSocket());
  await audio(a, b);
  const { evaluate: aEvaluate3 } = a;

  await aEvaluate3.bind(a)((): Promise<void> => window.callActor.reconnect());
  const { evaluate: aEvaluate4 } = a;

  expect(await aEvaluate4.bind(a)((): string | null => window.callActor.deviceId)).toBe(device);
  const { call: resultCall7 } = await command(a, 'call.current');

  expect(resultCall7.call_id).toBe(id);
  const { evaluate: aEvaluate5 } = a;

  await aEvaluate5.bind(a)((): void => window.callActor.closeMedia());
  const { evaluate: aEvaluate6 } = a;

  await aEvaluate6.bind(a)((id): Promise<any> => window.callActor.ping(id, false), id);
  const { call: resultCall8 } = await command(a, 'call.get', { call_id: id });
  const recovery = resultCall8;

  expect(recovery.recovery_id).not.toBeNull();
  const negotiation = await media(a, b, id);

  expect(negotiation).not.toBe(oldNegotiation);
  expect(await result(a, 'call.connected', { call_id: id, negotiation_id: oldNegotiation })).toBe(
    'CALL_STATE_CONFLICT',
  );
  expect(
    await result(a, 'rtc.ice', { call_id: id, negotiation_id: oldNegotiation, candidate: null }),
  ).toBe('CALL_STATE_CONFLICT');

  await connected(a, b, id, negotiation);

  for (const page of [a, b]) {
    await command(page, 'call.get', { call_id: id });
    await page.evaluate((id): Promise<any> => window.callActor.ping(id, true), id);
  }

  await expect
    .poll(async (): Promise<any> => {
      const { call: resultCall9 } = await command(a, 'call.get', { call_id: id });

      return resultCall9.recovery_id;
    })
    .toBeNull();
  const { call: resultCall10 } = await command(a, 'call.get', { call_id: id });

  expect(resultCall10.started_at).toBe(initial.started_at);
  await audio(a, b);
  await command(b, 'call.end', { call_id: id });
  await ended(a, b, id, 'hangup');
});

test('lost create response is reconciled with current, not a second call', async ({
  browser,
}): Promise<void> => {
  const a = await participant(browser, 'anna');
  const b = await participant(browser, 'maxim');

  const { evaluate: aEvaluate7 } = a;

  await aEvaluate7.bind(a)((): void => window.callActor.dropNextResponse('call.create'));
  const recipient_idValue5 = await identity(b);

  expect(await result(a, 'call.create', { recipient_id: recipient_idValue5 })).toBe(
    'UNKNOWN_RESULT',
  );
  await expect.poll((): number => inspect().calls.length).toBe(1);
  const { call } = await command(a, 'call.current');

  expect(call.state).toBe('ringing');
  const { commands: resultCommands } = await snapshot(a);

  expect(resultCommands.filter((type: string): boolean => type === 'call.create')).toHaveLength(1);
  await command(a, 'call.cancel', { call_id: call.call_id });
  await ended(a, b, call.call_id, 'cancelled');
});

test('unrecovered audio ends at the server deadline', async ({ browser }): Promise<void> => {
  const a = await participant(browser, 'anna');
  const b = await participant(browser, 'maxim');
  const id = await start(a, b);

  const { evaluate: aEvaluate8 } = a;

  await aEvaluate8.bind(a)((): void => window.callActor.closeMedia());
  const { evaluate: aEvaluate9 } = a;

  await aEvaluate9.bind(a)((id): Promise<any> => window.callActor.ping(id, false), id);
  const { call: resultCall11 } = await command(a, 'call.get', { call_id: id });
  const recovery = resultCall11;

  expect(recovery.recovery_deadline).not.toBeNull();
  await ended(a, b, id, 'connection_lost');
  const { call: resultCall12 } = await command(a, 'call.get', { call_id: id });

  expect(Date.parse(resultCall12.ended_at)).toBeGreaterThanOrEqual(
    Date.parse(recovery.recovery_deadline),
  );
});

test('revoking the selected session ends its active call', async ({ browser }): Promise<void> => {
  const a = await participant(browser, 'anna');
  const b = await participant(browser, 'maxim');
  const id = await start(a, b);

  const { evaluate: aEvaluate10 } = a;

  await aEvaluate10.bind(a)((): Promise<void> => window.callActor.revoke());
  await state(b, id, 'ended');
  const { call: resultCall13 } = await command(b, 'call.get', { call_id: id });

  expect(resultCall13.end_reason).toBe('session_revoked');
  await expect
    .poll(
      async (): Promise<boolean> => {
        const { socketOpen: resultSocketOpen } = await snapshot(a);

        return resultSocketOpen;
      },
      { timeout: 10000 },
    )
    .toBe(false);

  for (const page of [a, b]) {
    await expect
      .poll(async (): Promise<number[]> => {
        const {
          livePeers: sampleLivePeers2,
          liveTracks: sampleLiveTracks2,
          liveContexts: sampleLiveContexts2,
        } = await snapshot(page);

        return [sampleLivePeers2, sampleLiveTracks2, sampleLiveContexts2];
      })
      .toEqual([0, 0, 0]);
  }

  expect(inspect().participants.every((p: any): boolean => p.released_at !== null)).toBe(true);
  expect(inspect().busy).toBe(0);
});

declare global {
  interface Window {
    releasePlayback: () => void;
  }
}

test('delayed audio renderer still decodes the remote tone after playback starts', async ({
  browser,
}): Promise<void> => {
  const a = await participant(browser, 'anna');
  const b = await participant(browser, 'maxim');

  for (const page of [a, b]) {
    await page.evaluate((): void => {
      const play = HTMLMediaElement.prototype.play;
      const ready = new Promise<void>((resolve): void => {
        window.releasePlayback = resolve;
      });

      // Delay startup, then invoke the real renderer: no fake PCM/PeerConnection.
      HTMLMediaElement.prototype.play = function (): Promise<void> {
        this.autoplay = false;
        this.pause();

        return (async () => {
          await ready;

          return play.call(this);
        })();
      };
    });
  }

  const id = await create(a, b);

  await command(b, 'call.accept', { call_id: id });
  const negotiation = await media(a, b, id);

  await connected(a, b, id, negotiation);

  for (const page of [a, b]) {
    await expect
      .poll(async (): Promise<number> => {
        const { received: resultReceived } = await snapshot(page);

        return resultReceived;
      })
      .toBeGreaterThan(0);
    await page.evaluate((): void => window.releasePlayback());
  }

  await audio(a, b);
  await command(a, 'call.end', { call_id: id });
  await ended(a, b, id, 'hangup');
});

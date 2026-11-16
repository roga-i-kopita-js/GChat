import { afterEach, expect, it, vi } from 'vitest';

import { GChatClient } from './client';
import type { ContextOutput } from './context-output';
import { Ringback } from './ringback';

vi.mock('../runtime/transport', () => ({
  browserTransport: { changed: vi.fn(), isUpdating: () => false },
}));

function fixture(): any {
  const sources: any[] = [];
  const gains: any[] = [];
  const buffer = {};
  const context = {
    state: 'running',
    decodeAudioData: vi.fn(async () => buffer),
    createBufferSource: vi.fn(() => {
      const source = { start: vi.fn(), stop: vi.fn(), connect: vi.fn(), disconnect: vi.fn() };

      sources.push(source);

      return source;
    }),
    createGain: vi.fn(() => {
      const gain = { gain: { value: 0 }, connect: vi.fn(), disconnect: vi.fn() };

      gains.push(gain);

      return gain;
    }),
  };
  const output = { destination: {}, pause: vi.fn() };
  const activate = vi.fn(async () => true);
  const blocked = vi.fn();
  const fetch = vi.fn(async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(1) }));

  vi.stubGlobal('fetch', fetch);
  const ringback = new Ringback(blocked);
  const start = (id = 'first'): void =>
    ringback.start(
      id,
      context as unknown as AudioContext,
      output as unknown as ContextOutput,
      activate,
    );

  return { ringback, context, output, activate, blocked, fetch, sources, gains, start };
}

afterEach(() => vi.unstubAllGlobals());

it('loops the bundled signal once per call and releases all sound on stop, then reuses the decoded buffer', async () => {
  const { ringback, sources, gains, start, output, fetch, activate } = fixture();

  start();
  start();
  await vi.waitFor(() => expect(sources).toHaveLength(1));
  expect(sources[0].loop).toBe(true);
  expect(gains[0].gain.value).toBe(0.18);
  expect(activate).toHaveBeenCalledOnce();
  ringback.stop();
  expect(sources[0].stop).toHaveBeenCalledOnce();
  expect(sources[0].disconnect).toHaveBeenCalledOnce();
  expect(gains[0].disconnect).toHaveBeenCalledOnce();
  expect(output.pause).toHaveBeenCalledOnce();
  start('second');
  await vi.waitFor(() => expect(sources).toHaveLength(2));
  expect(fetch).toHaveBeenCalledOnce();
  ringback.stop();
});

it.each(['download', 'decode', 'activation'])(
  'does not start a cancelled call after delayed %s completes',
  async (stage) => {
    const { ringback, sources, start, context, activate, fetch, blocked } = fixture();
    let finish!: (value: any) => void;
    const delayed = new Promise<any>((resolve) => {
      finish = resolve;
    });

    if (stage === 'download') {
      fetch.mockReturnValueOnce(delayed);
    } else if (stage === 'decode') {
      context.decodeAudioData.mockReturnValueOnce(delayed);
    } else {
      activate.mockReturnValueOnce(delayed);
    }

    start();

    if (stage === 'decode') {
      await vi.waitFor(() => expect(context.decodeAudioData).toHaveBeenCalledOnce());
    }

    ringback.stop();
    finish(stage === 'download' ? { ok: true, arrayBuffer: async () => new ArrayBuffer(1) } : true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sources).toHaveLength(0);
    expect(blocked).not.toHaveBeenCalled();
  },
);

it('ignores an old activation failure while a new call is playing', async () => {
  const { start, activate, sources, blocked, ringback } = fixture();
  let reject!: (cause: Error) => void;

  activate.mockReturnValueOnce(
    new Promise((_resolve, fail) => {
      reject = fail;
    }),
  );
  start();
  start('second');
  await vi.waitFor(() => expect(sources).toHaveLength(1));
  reject(new DOMException('Old activation failed', 'NotAllowedError'));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(blocked).not.toHaveBeenCalled();
  expect(sources[0].stop).not.toHaveBeenCalled();
  ringback.stop();
});

it('reports a missing asset and permits an explicit retry', async () => {
  const { start, fetch, blocked, sources, ringback } = fixture();

  fetch.mockResolvedValueOnce({ ok: false });
  start();
  await vi.waitFor(() => expect(blocked).toHaveBeenCalledOnce());
  expect(sources).toHaveLength(0);
  start();
  await vi.waitFor(() => expect(sources).toHaveLength(1));
  ringback.stop();
});

function clientFixture(): any {
  vi.stubGlobal('AudioContext', class {});
  const client: any = new GChatClient();

  client.isCaller = () => true;
  client.getContextOutput = () => ({});
  client.audioContext = {};
  client.state = {
    ...client.getSnapshot(),
    owner: true,
    connection: 'online',
    selected: true,
    call: { call_id: 'first', state: 'ringing' },
  };
  const start = vi.spyOn(client.ringback, 'start').mockImplementation(() => {});
  const stop = vi.spyOn(client.ringback, 'stop');

  return { client, start, stop };
}

it.each([
  { owner: false },
  { selected: false },
  { connection: 'offline' },
  { audioBlocked: true },
  { call: { call_id: 'first', state: 'connecting' } },
  { call: { call_id: 'first', state: 'active' } },
  { call: { call_id: 'first', state: 'ended' } },
])('silences ringing when eligibility changes to %j', (patch) => {
  const { client, start, stop } = clientFixture();

  client.set({});
  expect(start).toHaveBeenCalledOnce();
  client.set(patch);
  expect(stop).toHaveBeenCalled();
  expect(start).toHaveBeenCalledOnce();
});

it('never creates an outgoing signal for a recipient', () => {
  const { client, start } = clientFixture();

  client.isCaller = () => false;
  client.set({});
  expect(start).not.toHaveBeenCalled();
});

it('keeps the confirmed call when creating its audio output fails', () => {
  const { client, start } = clientFixture();

  client.getContextOutput = () => {
    throw new DOMException('Audio context unavailable', 'NotSupportedError');
  };
  expect(() => client.set({})).not.toThrow();
  expect(client.getSnapshot().call.state).toBe('ringing');
  expect(client.getSnapshot().audioBlocked).toBe(true);
  expect(start).not.toHaveBeenCalled();
});

it('stops local cancellation before the server responds and does not restart it on intermediate updates', async () => {
  const { client, start, stop } = clientFixture();
  let finish!: (value: object) => void;

  client.transport = {
    changed: () => {},
    send: () =>
      new Promise<object>((resolve) => {
        finish = resolve;
      }),
  };
  vi.stubGlobal('localStorage', { getItem: () => null, removeItem: vi.fn() });
  const ending = client.end();

  expect(stop).toHaveBeenCalled();
  start.mockClear();
  client.set({ audible: true });
  expect(start).not.toHaveBeenCalled();
  finish({
    call: {
      call_id: '00000000-0000-4000-8000-000000000001',
      state: 'ended',
      caller_id: 'caller',
      recipient_id: 'recipient',
      created_at: '2026-11-16T00:00:00Z',
      started_at: null,
      ended_at: '2026-11-16T00:00:10Z',
      end_reason: 'cancelled',
      recovery_id: null,
      recovery_deadline: null,
      ringing_deadline: null,
      connecting_deadline: null,
      version: 2,
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(client.getLastFailure()).toBeNull();
  await ending;
  expect(start).not.toHaveBeenCalled();
});

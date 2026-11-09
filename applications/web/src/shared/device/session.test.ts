import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DeviceSession } from './session';

const runtime = vi.hoisted(
  (): {
    claims: { sub: string; sid: string; login: string; display_name: string; role: 'user' } | null;
  } => ({ claims: null }),
);

vi.mock('../native/bridge', (): object => ({ embedded: false }));
vi.mock('../native/runtime', (): object => ({
  nativeRuntime: {
    getSnapshot: (): object => ({ phase: 'ready', cycleId: '' }),
    subscribe: (): (() => void) => (): void => {},
  },
}));
vi.mock('../session/session', (): object => ({
  currentSession: (): object | null => (runtime.claims ? {} : null),
  identity: (): unknown => runtime.claims,
  login: vi.fn(),
  logout: vi.fn(),
  run: async <T>(
    operation: (http: unknown, signal: AbortSignal) => Promise<T>,
    signal: AbortSignal,
  ): Promise<T> => operation({}, signal),
}));

beforeEach((): void => {
  vi.stubGlobal('window', new EventTarget());
  runtime.claims = { sub: 'user', sid: 'one', login: 'test', display_name: 'Test', role: 'user' };
});
afterEach((): void => {
  vi.unstubAllGlobals();
});
function fixture(): {
  session: DeviceSession<{ marker: string }>;
  http: { marker: string };
  stop: AbortController;
} {
  const stop = new AbortController();
  const http = { marker: 'injected' };
  const session = new DeviceSession(
    (): typeof http => http,
    (): AbortSignal => stop.signal,
  );

  session.start();

  return { session, http, stop };
}

describe('public session owner', (): void => {
  it('keeps generation stable across token updates and rotates it on an account scope change', async (): Promise<void> => {
    const { session } = fixture();
    const initial = await session.getState();

    runtime.claims = { ...runtime.claims!, display_name: 'Updated' };
    window.dispatchEvent(new Event('gchat-session'));
    const { generation: getStateResultGeneration } = await session.getState();
    const { generation: initialGeneration } = initial;

    expect(getStateResultGeneration).toBe(initialGeneration);
    const { identity: getStateResultIdentity } = await session.getState();

    expect(getStateResultIdentity?.displayName).toBe('Updated');
    const old = session.signal();

    runtime.claims = { ...runtime.claims, sid: 'two' };
    window.dispatchEvent(new Event('gchat-session'));
    expect(old.aborted).toBe(true);
    const { generation: getStateResultGeneration2 } = await session.getState();
    const { generation: initialGeneration2 } = initial;

    expect(getStateResultGeneration2).toBe(initialGeneration2 + 1);
    session.stop();
  });
  it('gives concurrent SDK calls independent caller cancellation and preserves callback failures', async (): Promise<void> => {
    const { session, http } = fixture();
    const one = new AbortController();
    const seen: AbortSignal[] = [];
    const operation = async (client: typeof http, signal: AbortSignal): Promise<string> => {
      expect(client).toBe(http);
      seen.push(signal);
      await new Promise<void>((done): void => {
        setTimeout(done, 0);
      });
      signal.throwIfAborted();

      return client.marker;
    };
    const first = session.run(operation, { signal: one.signal });
    const second = session.run(operation);

    // Let both calls acquire their context before cancelling one of them.
    await Promise.resolve();
    one.abort();
    await expect(first).rejects.toBeDefined();
    await expect(second).resolves.toBe('injected');
    expect(seen[0]).not.toBe(seen[1]);
    const original = new Error('SDK failure');

    await expect(session.run((): Promise<never> => Promise.reject(original))).rejects.toBe(
      original,
    );
    session.stop();
  });
  it('rejects a late SDK result after scope replacement or device stop', async (): Promise<void> => {
    const { session, stop } = fixture();
    let resolve!: (value: string) => void;
    const result = session.run(
      (): Promise<string> =>
        new Promise((done): void => {
          resolve = done;
        }),
    );

    await Promise.resolve();
    runtime.claims = { ...runtime.claims!, sid: 'next' };
    window.dispatchEvent(new Event('gchat-session'));
    resolve('stale');
    await expect(result).rejects.toBeDefined();
    stop.abort();
    await expect(session.run(async (): Promise<string> => 'late')).rejects.toBeDefined();
    session.stop();
  });
});

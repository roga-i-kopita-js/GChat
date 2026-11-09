import { afterEach, describe, expect, it, vi } from 'vitest';

import { GChatClient } from '../../shared/calls/client';
import { CallScreenWakeLock } from '../../shared/calls/screen-wake-lock';

vi.mock('../../shared/runtime/transport', (): object => ({
  browserTransport: { isUpdating: (): boolean => false, changed: (): void => {} },
}));
vi.mock('../../shared/session/session', (): object => ({
  readSession: (): null => null,
}));

afterEach((): void => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

class Sentinel extends EventTarget {
  released = false;
  type = 'screen';
  release = vi.fn(async (): Promise<void> => {
    this.released = true;
    this.dispatchEvent(new Event('release'));
  });
}

function deferredGrant(): {
  promise: Promise<Sentinel>;
  resolve: (sentinel: Sentinel) => void;
  reject: (cause: unknown) => void;
} {
  let resolve!: (sentinel: Sentinel) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<Sentinel>((grant, deny): void => {
    resolve = grant;
    reject = deny;
  });

  return { promise, resolve, reject };
}

function fixture(): {
  lock: CallScreenWakeLock;
  request: ReturnType<typeof vi.fn>;
  warning: ReturnType<typeof vi.fn>;
  document: EventTarget & { visibilityState: string };
  sentinels: Sentinel[];
  visibility: (state: string) => void;
} {
  const document = Object.assign(new EventTarget(), { visibilityState: 'visible' });
  const sentinels: Sentinel[] = [];
  const request = vi.fn(async (): Promise<Sentinel> => {
    const sentinel = new Sentinel();

    sentinels.push(sentinel);

    return sentinel;
  });
  const warning = vi.fn();
  const lock = new CallScreenWakeLock(warning);

  vi.stubGlobal('document', document);
  vi.stubGlobal('navigator', { wakeLock: { request } });

  return {
    lock,
    request,
    warning,
    document,
    sentinels,
    visibility: (state): void => {
      document.visibilityState = state;
      document.dispatchEvent(new Event('visibilitychange'));
    },
  };
}

describe('call screen wake lock', (): void => {
  it('shares one request for repeated updates and releases when the call ends', async (): Promise<void> => {
    const { lock, request, sentinels, visibility } = fixture();

    lock.setCall('call');
    lock.setCall('call');
    expect(request).toHaveBeenCalledExactlyOnceWith('screen');
    await vi.waitFor((): void => expect(sentinels).toHaveLength(1));
    lock.setCall('call');
    lock.setCall(null);
    expect(sentinels[0].release).toHaveBeenCalledOnce();
    visibility('visible');
    expect(request).toHaveBeenCalledOnce();
  });

  it('releases in the background and reacquires on return', async (): Promise<void> => {
    const { lock, request, sentinels, visibility } = fixture();

    visibility('hidden');
    lock.setCall('call');
    expect(request).not.toHaveBeenCalled();
    visibility('visible');
    await vi.waitFor((): void => expect(sentinels).toHaveLength(1));
    visibility('hidden');
    expect(sentinels[0].release).toHaveBeenCalledOnce();
    visibility('visible');
    await vi.waitFor((): void => expect(sentinels).toHaveLength(2));
    lock.setCall(null);
    expect(sentinels[1].release).toHaveBeenCalledOnce();
  });

  it.each(['end', 'replace', 'hide'])(
    'releases a late grant after %s',
    async (action): Promise<void> => {
      const { lock, request, visibility, warning } = fixture();
      const sentinel = new Sentinel();
      const deferred = deferredGrant();

      request.mockReturnValueOnce(deferred.promise);
      lock.setCall('first');

      if (action === 'end') {
        lock.setCall(null);
      } else if (action === 'replace') {
        lock.setCall('second');
      } else {
        visibility('hidden');
        visibility('visible');
      }

      deferred.resolve(sentinel);
      await vi.waitFor((): void => expect(sentinel.release).toHaveBeenCalledOnce());
      expect(warning).not.toHaveBeenCalledWith(true);
      lock.setCall(null);
    },
  );

  it('warns on denied requests without retries on state updates and retries on return', async (): Promise<void> => {
    const { lock, request, warning, visibility } = fixture();

    request.mockRejectedValueOnce(new DOMException('Denied', 'NotAllowedError'));
    lock.setCall('call');
    await vi.waitFor((): void => expect(warning).toHaveBeenLastCalledWith(true));
    lock.setCall('call');
    expect(request).toHaveBeenCalledOnce();
    visibility('hidden');
    visibility('visible');
    await vi.waitFor((): void => expect(warning).toHaveBeenLastCalledWith(false));
    expect(request).toHaveBeenCalledTimes(2);
    lock.setCall(null);
  });

  it('warns when the API is absent without affecting the call', (): void => {
    const { lock, warning } = fixture();

    vi.stubGlobal('navigator', {});
    expect((): void => lock.setCall('call')).not.toThrow();
    expect(warning).toHaveBeenLastCalledWith(true);
    lock.setCall(null);
    expect(warning).toHaveBeenLastCalledWith(false);
  });

  it('warns on system release without entering a reacquisition loop', async (): Promise<void> => {
    const { lock, request, warning, sentinels } = fixture();

    lock.setCall('call');
    await vi.waitFor((): void => expect(sentinels).toHaveLength(1));
    await sentinels[0].release();
    expect(warning).toHaveBeenLastCalledWith(true);
    lock.setCall('call');
    expect(request).toHaveBeenCalledOnce();
    lock.setCall(null);
  });

  it('ignores a late rejection from an old call', async (): Promise<void> => {
    const { lock, request, warning } = fixture();
    const deferred = deferredGrant();

    request.mockReturnValueOnce(deferred.promise);
    lock.setCall('first');
    lock.setCall('second');
    deferred.reject(new DOMException('Denied', 'NotAllowedError'));
    await vi.waitFor((): void => expect(warning).toHaveBeenLastCalledWith(false));
    expect(warning).not.toHaveBeenCalledWith(true);
    lock.setCall(null);
  });
});

describe('browser call ownership integration', (): void => {
  function clientFixture(): { client: any; stop: ReturnType<typeof vi.fn> } {
    const client: any = new GChatClient();
    const stop = vi.fn();

    client.stream = { getTracks: (): object[] => [{ stop }] };
    client.set({
      owner: true,
      selected: true,
      call: { call_id: 'call', state: 'ringing' },
    });

    return { client, stop };
  }

  it('holds through connecting, active, recovery and mute, then releases for ended', async (): Promise<void> => {
    const { request, sentinels } = fixture();
    const { client } = clientFixture();

    await vi.waitFor((): void => expect(sentinels).toHaveLength(1));

    for (const state of ['connecting', 'active']) {
      client.set({ call: { ...client.getSnapshot().call, state } });
    }

    client.set({ call: { ...client.getSnapshot().call, recovery_id: 'recovery' }, muted: true });
    expect(request).toHaveBeenCalledOnce();
    expect(sentinels[0].release).not.toHaveBeenCalled();
    client.set({ call: { ...client.getSnapshot().call, state: 'ended' } });
    expect(sentinels[0].release).toHaveBeenCalledOnce();
    client.disposeMedia();
  });

  it.each(['owner', 'selected', 'stopConnection'])(
    'releases when losing %s',
    async (reason): Promise<void> => {
      const { sentinels, visibility, request } = fixture();
      const { client } = clientFixture();

      await vi.waitFor((): void => expect(sentinels).toHaveLength(1));

      if (reason === 'stopConnection') {
        client.stopConnection();
      } else {
        client.set({ [reason]: false });
      }

      expect(sentinels[0].release).toHaveBeenCalledOnce();
      visibility('visible');
      expect(request).toHaveBeenCalledOnce();
      client.disposeMedia();
    },
  );

  it('does not hold for unaccepted incoming calls, observers or missing media', (): void => {
    const { request } = fixture();
    const client: any = new GChatClient();

    client.set({ owner: true, selected: true, call: { call_id: 'call', state: 'active' } });
    client.stream = { getTracks: (): object[] => [] };
    client.set({ selected: false });
    client.set({ owner: false, selected: true });
    expect(request).not.toHaveBeenCalled();
    client.disposeMedia();
  });

  it('keeps wake lock failures separate from call errors and media', async (): Promise<void> => {
    const { request } = fixture();

    request.mockRejectedValueOnce(new DOMException('Denied', 'NotAllowedError'));
    const { client, stop } = clientFixture();

    await vi.waitFor((): void => expect(client.getSnapshot().screenWakeLockWarning).toBe(true));
    expect(client.getSnapshot().call.state).toBe('ringing');
    expect(client.getSnapshot().error).toBeNull();
    expect(stop).not.toHaveBeenCalled();
    client.disposeMedia();
    expect(client.getSnapshot().screenWakeLockWarning).toBe(false);
  });

  it.each([false, true])(
    'cleans up runtime including pending grants: %s',
    async (pending): Promise<void> => {
      const { request, visibility } = fixture();
      const deferred = deferredGrant();
      const sentinel = new Sentinel();
      const client: any = new GChatClient();

      request.mockReturnValueOnce(deferred.promise);
      vi.stubGlobal(
        'BroadcastChannel',
        class {
          postMessage(): void {}

          close(): void {}
        },
      );
      client.transport = {
        getSnapshot: (): object => ({ owner: true, status: 'online', generation: 1, error: null }),
        protect: (): (() => void) => vi.fn(),
        subscribe: (): (() => void) => vi.fn(),
        subscribeMessage: (): (() => void) => vi.fn(),
        changed: vi.fn(),
      };
      const stop = client.start();

      client.stream = { getTracks: (): object[] => [] };
      client.set({ selected: true, call: { call_id: 'call', state: 'active' } });

      if (!pending) {
        deferred.resolve(sentinel);
        await deferred.promise;
      }

      stop();
      deferred.resolve(sentinel);
      await vi.waitFor((): void => expect(sentinel.release).toHaveBeenCalledOnce());
      visibility('hidden');
      visibility('visible');
      expect(request).toHaveBeenCalledOnce();
    },
  );
});

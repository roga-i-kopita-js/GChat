import { afterEach, describe, expect, it, vi } from 'vitest';

import { GChatClient } from '../../shared/calls/client';
import { BrowserTransport } from '../../shared/runtime/transport';

vi.mock('../auth/session', (): object => ({
  readSession: vi.fn(),
  identity: vi.fn(),
  logout: vi.fn(),
  saveSession: vi.fn(),
}));
afterEach((): void => {
  vi.restoreAllMocks();
});
function fixture(): { client: any; transport: any } {
  const transport: any = new BrowserTransport();
  const client: any = new GChatClient();

  client.transport = transport;
  client.state = { ...client.getSnapshot(), owner: true, connection: 'online' };
  client.hydrated = true;
  transport.state = { owner: true, status: 'online', generation: 1, error: null };
  transport.release = vi.fn();
  transport.protect(
    (): boolean =>
      client.hydrated &&
      !client.state.busy &&
      (!client.state.call || client.state.call.state === 'ended'),
  );
  transport.subscribe((): void => {
    if (transport.getSnapshot().status === 'offline') {
      client.hydrated = false;
      client.stopConnection();
    }
  });

  return { client, transport };
}
describe('shared transport update barrier', (): void => {
  it('closes WSS and media before releasing its lifetime', (): void => {
    const { client, transport } = fixture();
    const release = transport.release;
    const close = vi.fn();
    const stop = vi.fn();

    transport.socket = { close };
    client.stream = { getTracks: (): object[] => [{ stop }] };
    transport.prepare();
    expect(close).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
    expect(close.mock.invocationCallOrder[0]).toBeLessThan(release.mock.invocationCallOrder[0]);
    expect(stop.mock.invocationCallOrder[0]).toBeLessThan(release.mock.invocationCallOrder[0]);
    transport.prepare();
    expect(release).toHaveBeenCalledOnce();
  });
  it('keeps an active call and in-flight command protected', (): void => {
    const { client, transport } = fixture();
    const release = transport.release;

    client.state.call = { state: 'active' };
    client.state.busy = true;
    transport.prepare();
    expect(release).not.toHaveBeenCalled();
    client.set({ call: { state: 'ended' } });
    expect(release).not.toHaveBeenCalled();
    client.set({ busy: false });
    expect(release).toHaveBeenCalledOnce();
  });
  it('waits for authoritative call recovery', (): void => {
    const { client, transport } = fixture();
    const release = transport.release;

    client.hydrated = false;
    transport.prepare();
    expect(release).not.toHaveBeenCalled();
    client.hydrated = true;
    client.set({ call: { state: 'ringing' } });
    expect(release).not.toHaveBeenCalled();
    client.set({ call: { state: 'ended' } });
    expect(release).toHaveBeenCalledOnce();
  });
  it('does not start an outgoing call during an update', async (): Promise<void> => {
    const { client, transport } = fixture();

    client.state.call = { state: 'active' };
    client.microphone = vi.fn();
    transport.prepare();
    await client.dial('recipient');
    expect(client.microphone).not.toHaveBeenCalled();
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';

import { GChatClient } from './client';

vi.mock('./signaling', (): object => ({
  Signaling: class {
    close = vi.fn();
  },
}));
vi.mock('../auth/session', (): object => ({
  readSession: vi.fn(),
  identity: vi.fn(),
  logout: vi.fn(),
  saveSession: vi.fn(),
}));

function fixture(): any {
  const client: any = new GChatClient();

  client.release = vi.fn();
  client.channel = { postMessage: vi.fn() };
  client.state = { ...client.getSnapshot(), owner: true, connection: 'online' };
  client.hydrated = true;

  return client;
}

afterEach((): void => {
  vi.clearAllMocks();
});

describe('call owner update barrier', (): void => {
  it('closes WSS before releasing the update lock when idle', (): void => {
    const client = fixture();
    const track = { stop: vi.fn() };
    const pc = { close: vi.fn() };

    client.stream = { getTracks: (): object[] => [track] };
    client.pc = pc;

    client.prepareFrontendUpdate();
    expect(client.transport.close).toHaveBeenCalledOnce();
    expect(pc.close).toHaveBeenCalledOnce();
    expect(track.stop).toHaveBeenCalledOnce();
    expect(client.release).toHaveBeenCalledOnce();
    expect(client.getSnapshot()).toMatchObject({ owner: false, connection: 'offline' });
    expect(client.transport.close.mock.invocationCallOrder[0]).toBeLessThan(
      client.release.mock.invocationCallOrder[0],
    );
    expect(track.stop.mock.invocationCallOrder[0]).toBeLessThan(
      client.release.mock.invocationCallOrder[0],
    );
    client.prepareFrontendUpdate();
    client.set({ error: null });
    expect(client.transport.close).toHaveBeenCalledOnce();
    expect(client.release).toHaveBeenCalledOnce();
  });
  it('keeps a conversation and an in-flight command protected until both finish', (): void => {
    const client = fixture();

    client.state.call = { state: 'active' };
    client.state.busy = true;
    client.prepareFrontendUpdate();
    expect(client.release).not.toHaveBeenCalled();
    client.set({ call: { state: 'ended' } });
    expect(client.release).not.toHaveBeenCalled();
    client.set({ busy: false });
    expect(client.release).toHaveBeenCalledOnce();
  });
  it('waits for authoritative call recovery before releasing an owner', (): void => {
    const client = fixture();

    client.hydrated = false;
    client.prepareFrontendUpdate();
    expect(client.release).not.toHaveBeenCalled();
    client.hydrated = true;
    client.set({ call: { state: 'ringing' } });
    expect(client.release).not.toHaveBeenCalled();
    client.set({ call: { state: 'ended' } });
    expect(client.release).toHaveBeenCalledOnce();
  });
  it('does not start another outgoing call after an update request', async (): Promise<void> => {
    const client = fixture();

    client.state.call = { state: 'active' };
    client.microphone = vi.fn();
    client.prepareFrontendUpdate();
    await client.dial('recipient');
    expect(client.microphone).not.toHaveBeenCalled();
  });
});

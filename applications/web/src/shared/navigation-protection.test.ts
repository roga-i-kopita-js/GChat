import { describe, expect, it, vi } from 'vitest';

import type { SessionState } from './device/api';
import { NavigationProtections } from './navigation-protection';

const session: SessionState = {
  revision: 1,
  status: 'authenticated',
  identity: { id: 'user', login: 'test', displayName: 'Test', role: 'user' },
  generation: 1,
  error: null,
};

function fixture(): NavigationProtections {
  const value = new NavigationProtections();

  value.setSession(session);

  return value;
}

describe('shared navigation protection', (): void => {
  it('flushes dirty drafts before allowing navigation and does not confirm a saved draft', async (): Promise<void> => {
    const registry = fixture();
    let dirty = true;
    const flush = vi.fn(async (): Promise<void> => {
      dirty = false;
    });

    registry.register({ dirty: (): boolean => dirty, flush, discard: vi.fn() });
    expect(await registry.prepare()).toBe('ready');
    expect(flush).toHaveBeenCalledTimes(1);
    expect(registry.dirty()).toBe(false);
  });
  it('requires explicit confirmation for a form and never discards on cancel', async (): Promise<void> => {
    const registry = fixture();
    let dirty = true;
    const discard = vi.fn((): void => {
      dirty = false;
    });
    const off = registry.register({ dirty: (): boolean => dirty, discard });

    expect(await registry.prepare()).toBe('confirm');
    expect(discard).not.toHaveBeenCalled();
    expect(registry.dirty()).toBe(true);
    registry.discard();
    expect(discard).toHaveBeenCalledTimes(1);
    expect(registry.dirty()).toBe(false);
    off();
    off();
  });
  it('keeps failed drafts protected for retry or explicit discard', async (): Promise<void> => {
    const registry = fixture();
    let dirty = true;
    const flush = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('storage'))
      .mockImplementation(async (): Promise<void> => {
        dirty = false;
      });

    registry.register({
      dirty: (): boolean => dirty,
      flush,
      discard: (): void => {
        dirty = false;
      },
    });
    expect(await registry.prepare()).toBe('failed');
    expect(registry.dirty()).toBe(true);
    expect(await registry.prepare()).toBe('ready');
    expect(registry.dirty()).toBe(false);
  });
  it('bypasses old forms and pending flushes immediately when the session is replaced', async (): Promise<void> => {
    const registry = fixture();
    let resolve!: () => void;
    const discard = vi.fn();

    registry.register({
      dirty: (): boolean => true,
      flush: (): Promise<void> =>
        new Promise((done): void => {
          resolve = done;
        }),
      discard,
    });
    const pending = registry.prepare();

    registry.setSession({ ...session, generation: 2 });
    resolve();
    expect(registry.dirty()).toBe(false);
    expect(await pending).toBe('ready');
    expect(discard).not.toHaveBeenCalled();
    registry.setSession({ ...session, status: 'anonymous', identity: null });
    expect(await registry.prepare()).toBe('ready');
  });
});

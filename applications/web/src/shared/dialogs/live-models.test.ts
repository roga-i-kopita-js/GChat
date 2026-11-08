import { describe, expect, it, vi } from 'vitest';

import { DialogModel, DialogModelEvent } from './live-models';

type State = {
  revision: number;
  status: 'starting' | 'ready' | 'error';
  value: string;
  error: string | null;
};
function initial(): State {
  return { revision: 0, status: 'starting', value: '', error: null };
}

describe('committed dialog models', (): void => {
  it('drops a stale read when a newer commit arrives, caches the snapshot and isolates subscribers', async (): Promise<void> => {
    let finish!: (value: Omit<State, 'revision'>) => void;
    const read = vi
      .fn<() => Promise<Omit<State, 'revision'>>>()
      .mockImplementationOnce(
        (): Promise<Omit<State, 'revision'>> =>
          new Promise((resolve): void => {
            finish = resolve;
          }),
      )
      .mockResolvedValue({ status: 'ready', value: 'new commit', error: null });
    const model = new DialogModel(initial(), DialogModelEvent.ConversationChanged, read);
    const received: string[] = [];
    const off = model.on(DialogModelEvent.ConversationChanged, (state): void => {
      received.push(state.value);
    });

    model.on(DialogModelEvent.ConversationChanged, (): never => {
      throw new Error('consumer');
    });
    model.invalidate();
    finish({ status: 'ready', value: 'stale', error: null });
    const state = await model.getState();

    expect(state.value).toBe('new commit');
    expect(received).toEqual(['new commit']);
    expect(model.getSnapshot()).toBe(state);
    expect(read).toHaveBeenCalledTimes(2);
    expect(await model.getState()).toBe(state);
    expect(read).toHaveBeenCalledTimes(2);
    off();
    off();
  });
  it('does not publish late storage reads after the scope stops', async (): Promise<void> => {
    let finish!: (value: Omit<State, 'revision'>) => void;
    const model = new DialogModel(
      initial(),
      DialogModelEvent.ListChanged,
      (): Promise<Omit<State, 'revision'>> =>
        new Promise((resolve): void => {
          finish = resolve;
        }),
    );
    const listener = vi.fn();

    model.on(DialogModelEvent.ListChanged, listener);
    model.stop();
    finish({ status: 'ready', value: 'old account', error: null });
    await model.getState();
    expect(listener).not.toHaveBeenCalled();
    expect(model.getSnapshot().value).toBe('');
  });
});

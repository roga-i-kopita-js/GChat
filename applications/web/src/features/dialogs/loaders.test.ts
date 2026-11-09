import type { LoaderFunctionArgs } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { applicationCore } from '../../app/router-context';
import { dialogBootstrap } from '../../shared/dialogs/bootstrap';
import type { DialogRuntime } from '../../shared/dialogs/runtime';
import { dialogsLoader } from './loaders';

vi.mock('../../app/router-context', (): object => ({ applicationCore: vi.fn() }));
vi.mock('../../shared/dialogs/bootstrap', (): object => ({ dialogBootstrap: vi.fn() }));
afterEach((): void => {
  vi.resetAllMocks();
});

const id = '00000000-0000-4000-8000-000000000011';

function args(dialogId?: string, signal?: AbortSignal): LoaderFunctionArgs {
  return {
    params: dialogId ? { dialogId } : {},
    request: new Request('https://fixture.test/dialogs/' + (dialogId ?? ''), { signal }),
    context: {} as LoaderFunctionArgs['context'],
    url: new URL('https://fixture.test/dialogs/' + (dialogId ?? '')),
    pattern: '/dialogs/:dialogId?',
  };
}
function fixture(cached: boolean): {
  runtime: DialogRuntime;
  sync: ReturnType<typeof vi.fn>;
  list: ReturnType<typeof vi.fn>;
  complete(): void;
} {
  let complete!: () => void;
  const pending = new Promise<void>((resolve): void => {
    complete = resolve;
  });
  const sync = vi.fn((): Promise<void> => pending);
  const list = vi.fn((): Promise<void> => pending);
  const runtime = {
    signal: new AbortController().signal,
    listModel: (): object => ({
      getState: async (): Promise<object> => ({ items: cached ? [{}] : [] }),
    }),
    conversationModel: (): object => ({
      getState: async (): Promise<object> => ({
        view: cached ? { record: { dialog: { dialog_id: id } } } : null,
      }),
    }),
    refreshList: list,
    sync,
  } as unknown as DialogRuntime;

  vi.mocked(dialogBootstrap).mockReturnValue({
    ready: vi.fn().mockResolvedValue(runtime),
  } as unknown as ReturnType<typeof dialogBootstrap>);

  return { runtime, sync, list, complete };
}

describe('dialog route loaders', (): void => {
  it('rejects an invalid id before accessing bootstrap or HTTP', async (): Promise<void> => {
    await expect(dialogsLoader(args('invalid'))).rejects.toMatchObject({ status: 404 });
    expect(dialogBootstrap).not.toHaveBeenCalled();
  });
  it('starts synchronization in the loader and immediately preserves cached history', async (): Promise<void> => {
    const f = fixture(true);
    const data = await dialogsLoader(args(id));

    expect(data).toMatchObject({ runtime: f.runtime, dialogId: id });
    expect(f.sync).toHaveBeenCalledWith(id, true);
    expect(f.list).toHaveBeenCalledTimes(1);
    f.complete();
  });
  it('waits for the initial network attempt without cache and releases a cancelled navigation', async (): Promise<void> => {
    const f = fixture(false);
    const controller = new AbortController();
    const loading = dialogsLoader(args(id, controller.signal));

    await vi.waitFor((): void => expect(f.sync).toHaveBeenCalled());
    controller.abort();
    await expect(loading).rejects.toBeDefined();
    expect(f.runtime.signal.aborted).toBe(false);
    f.complete();
  });
  it('reads the list on each entry and waits for the first uncached attempt', async (): Promise<void> => {
    const f = fixture(false);
    let finished = false;
    const loading = (async () => {
      const data = await dialogsLoader(args());

      finished = true;

      return data;
    })();

    await vi.waitFor((): void => expect(f.list).toHaveBeenCalledTimes(1));
    expect(finished).toBe(false);
    f.complete();
    await expect(loading).resolves.toMatchObject({ dialogId: null });
    await dialogsLoader(args());
    expect(f.list).toHaveBeenCalledTimes(2);
  });
});

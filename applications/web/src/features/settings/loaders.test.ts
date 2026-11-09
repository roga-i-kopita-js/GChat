import { createMemoryRouter, type RouterContextProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { applicationCore } from '../../app/router-context';
import type { DeviceCore } from '../../shared/device';
import { loadDeviceSettings } from '../../shared/device/load-settings';
import { settingsFilesLoader, settingsLoader } from './loaders';

vi.mock('../../app/router-context', (): object => ({ applicationCore: vi.fn() }));
vi.mock('../../shared/device/load-settings', (): object => ({ loadDeviceSettings: vi.fn() }));

afterEach((): void => {
  vi.resetAllMocks();
});

describe('settings route loaders', (): void => {
  it('loads before navigation commits, refreshes on re-entry, and cancels an abandoned entry', async (): Promise<void> => {
    const device = {} as DeviceCore;

    vi.mocked(applicationCore).mockReturnValue(device as ReturnType<typeof applicationCore>);
    let resolve!: (value: never) => void;

    vi.mocked(loadDeviceSettings).mockImplementationOnce(
      (_device, signal): Promise<never> =>
        new Promise((done, reject): void => {
          resolve = done;
          signal.addEventListener('abort', (): void => reject(signal.reason), { once: true });
        }),
    );
    const router = createMemoryRouter(
      [
        { path: '/', loader: (): null => null },
        { id: 'settings', path: '/settings/general', loader: settingsLoader },
      ],
      { initialEntries: ['/'] },
    );

    try {
      const navigation = router.navigate('/settings/general');

      await vi.waitFor((): void => expect(loadDeviceSettings).toHaveBeenCalledTimes(1));
      expect(router.state.location.pathname).toBe('/');
      const signal = vi.mocked(loadDeviceSettings).mock.calls[0][1];

      await router.navigate('/');
      expect(signal.aborted).toBe(true);
      await navigation;
      resolve?.(undefined as never);
      vi.mocked(loadDeviceSettings).mockResolvedValue({ revision: 2 } as Awaited<
        ReturnType<typeof loadDeviceSettings>
      >);
      await router.navigate('/settings/general');
      expect(router.state.loaderData.settings).toMatchObject({
        state: { revision: 2 },
        error: null,
      });
      await router.navigate('/');
      await router.navigate('/settings/general');
      expect(loadDeviceSettings).toHaveBeenCalledTimes(3);
    } finally {
      router.dispose();
    }
  });

  it('loads every page of file access metadata into loaderData and forwards cancellation', async (): Promise<void> => {
    const listAccesses = vi
      .fn()
      .mockResolvedValueOnce({ entries: [{ id: 'a' }], nextCursor: 'next' })
      .mockResolvedValueOnce({ entries: [{ id: 'b' }], nextCursor: null });
    const device = { files: { listAccesses } } as unknown as ReturnType<typeof applicationCore>;

    vi.mocked(applicationCore).mockReturnValue(device);
    vi.mocked(loadDeviceSettings).mockResolvedValue({ revision: 1 } as Awaited<
      ReturnType<typeof loadDeviceSettings>
    >);
    const request = new Request('https://fixture.test/settings/general/files');
    const { entries: dataEntries } = await settingsFilesLoader({
      request,
      params: {},
      url: new URL(request.url),
      pattern: '/settings/general/files',
      context: {} as RouterContextProvider,
    });

    expect(dataEntries).toEqual([{ id: 'a' }, { id: 'b' }]);
    expect(listAccesses.mock.calls).toEqual([
      [{ cursor: null, limit: 100 }, { signal: request.signal }],
      [{ cursor: 'next', limit: 100 }, { signal: request.signal }],
    ]);
  });
});

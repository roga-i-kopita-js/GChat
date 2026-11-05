import { expect, test } from '@playwright/test';

for (const server of [false, true]) {
  test(`production shell, offline navigation and coordinated update (${server ? 'server' : 'root'})`, async ({
    context,
    page,
    request,
  }): Promise<void> => {
    await request.get('/__revision?value=one');
    const base = server ? '/apps/' : '/';
    const route = server ? '/apps/client/login' : '/login';

    await page.goto(route);
    await page.evaluate(async (): Promise<void> => {
      await navigator.serviceWorker.ready;
    });
    await page.reload();
    await expect
      .poll((): Promise<boolean> =>
        page.evaluate((): boolean => !!navigator.serviceWorker.controller),
      )
      .toBe(true);
    const other = await context.newPage();

    await other.goto(route);
    const manifest = await request.get(base + 'site.webmanifest');

    expect((await manifest.json()).start_url).toBe(server ? '/apps/client/calls' : '/calls');
    const keys = await page.evaluate(async (): Promise<string[]> => {
      const result: string[] = [];

      for (const name of await caches.keys())
        for (const entry of await (await caches.open(name)).keys()) result.push(entry.url);

      return result;
    });

    expect(keys.some((key): boolean => key.includes('/api/') || key.includes('/ws'))).toBe(false);
    await context.setOffline(true);
    await page.goto(server ? '/apps/client/admin/users/example' : '/admin/users/example');
    await expect(page.getByRole('heading', { name: 'Вход в GChat' })).toBeVisible();
    await context.setOffline(false);
    // A real shared browser lock represents another window's ongoing call.
    await other.evaluate((): void => {
      void navigator.locks.request(
        'gchat-frontend-update',
        { mode: 'shared' },
        (): Promise<void> =>
          new Promise((resolve): void => {
            window.addEventListener('finish-test-call', (): void => resolve(), { once: true });
          }),
      );
    });
    await expect
      .poll((): Promise<number> =>
        other.evaluate(
          async (): Promise<number> =>
            (await navigator.locks.query()).held?.filter(
              (lock): boolean => lock.name === 'gchat-frontend-update',
            ).length ?? 0,
        ),
      )
      .toBe(1);
    await request.get('/__revision?value=two');
    await page.evaluate(async (): Promise<void> => {
      await (await navigator.serviceWorker.ready).update();
    });
    await page.getByRole('button', { name: 'Обновить', exact: true }).click();
    await expect(
      page.getByText('Обновим GChat после завершения звонков во всех вкладках.'),
    ).toBeVisible();
    await expect
      .poll((): Promise<string | undefined> =>
        page.evaluate(
          async (): Promise<string | undefined> =>
            (await navigator.serviceWorker.getRegistration())?.waiting?.state,
        ),
      )
      .toBe('installed');
    const navigation = page.waitForEvent('load');
    const otherNavigation = other.waitForEvent('load');

    await other.evaluate((): void => {
      window.dispatchEvent(new Event('finish-test-call'));
    });
    await Promise.all([navigation, otherNavigation]);
    await expect
      .poll((): Promise<string[]> => page.evaluate((): Promise<string[]> => caches.keys()))
      .toEqual([expect.stringContaining('-two')]);
    await expect(page.getByRole('button', { name: 'Обновить', exact: true })).toHaveCount(0);
    // Failed publication leaves the previous complete version active.
    await request.get('/__revision?value=broken&incomplete=1');
    await page.evaluate(async (): Promise<void> => {
      await (await navigator.serviceWorker.ready).update();
    });
    await expect
      .poll((): Promise<boolean> =>
        page.evaluate(
          async (): Promise<boolean> =>
            !(await navigator.serviceWorker.getRegistration())?.installing,
        ),
      )
      .toBe(true);
    expect(await page.evaluate((): Promise<string[]> => caches.keys())).toEqual([
      expect.stringContaining('-two'),
    ]);
    // Rollback follows exactly the same explicit update lifecycle.
    await request.get('/__revision?value=one');
    await page.evaluate(async (): Promise<void> => {
      await (await navigator.serviceWorker.ready).update();
    });
    await page.getByRole('button', { name: 'Обновить', exact: true }).click();
    await expect
      .poll((): Promise<string[]> => page.evaluate((): Promise<string[]> => caches.keys()))
      .toEqual([expect.stringContaining('-one')]);
    await expect(page.getByRole('button', { name: 'Обновить', exact: true })).toHaveCount(0);
  });
}

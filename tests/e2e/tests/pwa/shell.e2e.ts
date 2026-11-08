import { expect, type Page, test } from '@playwright/test';

// Safe cross-tab UI snapshots exercise presentation priority, without simulating media.
async function callState(page: Page, busy: boolean, active: boolean): Promise<void> {
  await page.evaluate(
    ({ busy, active }): void => {
      const channel = new BroadcastChannel('gchat-client');

      channel.postMessage({
        type: 'state',
        state: {
          owner: true,
          connection: 'online',
          selected: false,
          muted: false,
          busy,
          error: null,
          audioBlocked: false,
          audible: false,
          media: 'new',
          stats: { relay: false, sent: 0, received: 0 },
          call: active
            ? {
                call_id: '00000000-0000-4000-8000-000000000010',
                caller_id: '00000000-0000-4000-8000-000000000001',
                recipient_id: '00000000-0000-4000-8000-000000000002',
                state: 'active',
                version: 1,
                created_at: new Date().toISOString(),
                started_at: null,
                ended_at: null,
                end_reason: null,
                recovery_id: null,
                recovery_deadline: null,
                ringing_deadline: null,
                connecting_deadline: null,
              }
            : null,
        },
      });
      channel.close();
    },
    { busy, active },
  );
}

for (const server of [false, true]) {
  test(`production shell, offline navigation and coordinated update (${server ? 'server' : 'root'})`, async ({
    context,
    page,
    request,
  }, info): Promise<void> => {
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

      for (const name of await caches.keys()) {
        for (const entry of await (await caches.open(name)).keys()) {
          result.push(entry.url);
        }
      }

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
    await callState(page, true, false);
    await request.get('/__revision?value=two');
    await page.evaluate(async (): Promise<void> => {
      await (await navigator.serviceWorker.ready).update();
    });
    const dialog = page.getByRole('dialog', { name: 'Обновление GChat' });

    await expect(page.getByRole('status')).toContainText('Доступна новая версия GChat.');
    await expect(dialog).toHaveCount(0);
    await callState(page, false, true);
    await expect(dialog).toHaveCount(0);
    await callState(page, false, false);
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Позже' })).toBeFocused();
    // An incoming/ongoing call displaces an already open update prompt.
    await callState(page, false, true);
    await expect(dialog).toHaveCount(0);
    await callState(page, false, false);
    await expect(dialog).toBeVisible();
    // A competing application dialog also takes priority.
    await page.evaluate((): void => {
      const competing = document.createElement('dialog');

      competing.id = 'test-competing-dialog';
      document.body.append(competing);
      competing.showModal();
    });
    await expect(dialog).toHaveCount(0);
    await page.evaluate((): void => document.getElementById('test-competing-dialog')?.remove());
    await expect(dialog).toBeVisible();

    if (!server) {
      const design = await dialog.evaluate((element): object => {
        const styles = getComputedStyle(element);
        const title = getComputedStyle(element.querySelector('h2')!);
        const copy = getComputedStyle(element.querySelector('.pwa-update-copy')!);
        const text = getComputedStyle(element.querySelector('p')!);
        const buttons = [...element.querySelectorAll('button')].map((button): object => {
          const style = getComputedStyle(button);

          return { color: style.color, weight: style.fontWeight, height: button.offsetHeight };
        });

        return {
          radius: styles.borderRadius,
          surface: styles.backgroundColor,
          backdrop: getComputedStyle(element, '::backdrop').backgroundColor,
          padding: copy.padding,
          titleSize: Math.round(parseFloat(title.fontSize)),
          titleWeight: title.fontWeight,
          textSize: text.fontSize,
          textColor: text.color,
          buttons,
        };
      });

      expect(design).toEqual({
        radius: '14px',
        surface: 'rgb(255, 255, 255)',
        backdrop: 'rgba(0, 0, 0, 0.4)',
        padding: '20px 20px 18px',
        titleSize: 18,
        titleWeight: '600',
        textSize: '14px',
        textColor: 'rgb(101, 101, 107)',
        buttons: [
          { color: 'rgb(0, 122, 255)', weight: '400', height: 48 },
          { color: 'rgb(0, 122, 255)', weight: '600', height: 48 },
        ],
      });

      for (const viewport of [
        { width: 360, height: 640 },
        { width: 390, height: 844 },
        { width: 430, height: 932 },
        { width: 1280, height: 800 },
      ]) {
        await page.setViewportSize(viewport);
        const bounds = await dialog.boundingBox();

        expect(bounds?.width).toBe(300);
        expect(Math.abs((bounds?.x ?? 0) - (viewport.width - 300) / 2)).toBeLessThan(1);
        await dialog.getByRole('button', { name: 'Позже' }).focus();
        await page.keyboard.press('Tab');
        await page.keyboard.press('Shift+Tab');
        await page.screenshot({ path: info.outputPath(`update-${viewport.width}-focus.png`) });
        await dialog.getByText('Доступна новая версия. Обновить приложение сейчас?').click();
        await page.screenshot({ path: info.outputPath(`update-${viewport.width}.png`) });
      }

      await page.evaluate((): void => {
        document.documentElement.style.fontSize = '28px';
      });
      await page.setViewportSize({ width: 360, height: 640 });
      await expect(dialog.getByRole('button', { name: 'Обновить', exact: true })).toBeInViewport();
      expect(
        await dialog
          .getByRole('button', { name: 'Обновить', exact: true })
          .evaluate((element): boolean => element.scrollWidth <= element.clientWidth),
      ).toBe(true);
      expect(
        await page.evaluate((): boolean => document.documentElement.scrollWidth <= innerWidth),
      ).toBe(true);
      await page.screenshot({ path: info.outputPath('update-text-200.png') });
      // Wider glyph metrics must also fit on platforms with a different system font.
      await dialog.evaluate((element): void => {
        for (const button of element.querySelectorAll('button')) {
          button.style.fontFamily = 'monospace';
          button.style.letterSpacing = '2px';
        }
      });

      for (const name of ['Позже', 'Обновить']) {
        const button = dialog.getByRole('button', { name, exact: true });

        await expect(button).toBeInViewport();
        expect(
          await button.evaluate((element): boolean => element.scrollWidth <= element.clientWidth),
        ).toBe(true);
      }

      await dialog.evaluate((element): void => {
        for (const button of element.querySelectorAll('button')) {
          button.style.fontFamily = '';
          button.style.letterSpacing = '';
        }
      });
      await page.evaluate((): void => {
        document.documentElement.style.fontSize = '';
      });
    }

    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await page.getByRole('button', { name: 'Обновить', exact: true }).click();
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Позже' })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(dialog.getByRole('button', { name: 'Обновить', exact: true })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(dialog.getByRole('button', { name: 'Позже' })).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(dialog.getByRole('button', { name: 'Обновить', exact: true })).toBeFocused();
    await dialog.getByRole('button', { name: 'Позже' }).click();
    await expect(page.getByRole('button', { name: 'Обновить', exact: true })).toBeFocused();
    await callState(page, false, true);
    await callState(page, false, false);
    await expect(dialog).toHaveCount(0);
    await page.getByRole('button', { name: 'Обновить', exact: true }).click();
    await page.mouse.click(4, 4);
    await expect(dialog).toHaveCount(0);
    await page.getByRole('button', { name: 'Обновить', exact: true }).click();
    await dialog.getByRole('button', { name: 'Обновить', exact: true }).click();
    await expect(
      page.getByText(
        'Обновление запрошено. GChat перезапустится после завершения звонков во всех окнах.',
      ),
    ).toBeVisible();
    await expect(other.getByRole('dialog', { name: 'Обновление GChat' })).toHaveCount(0);
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
    const rollbackNavigation = page.waitForEvent('load');
    const otherRollbackNavigation = other.waitForEvent('load');

    await page
      .getByRole('dialog', { name: 'Обновление GChat' })
      .getByRole('button', { name: 'Обновить', exact: true })
      .click();
    await Promise.all([rollbackNavigation, otherRollbackNavigation]);
    await expect
      .poll((): Promise<string[]> => page.evaluate((): Promise<string[]> => caches.keys()))
      .toEqual([expect.stringContaining('-one')]);
    await expect(page.getByRole('button', { name: 'Обновить', exact: true })).toHaveCount(0);
  });
}

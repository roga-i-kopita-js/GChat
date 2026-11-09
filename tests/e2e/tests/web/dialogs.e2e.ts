import { randomUUID } from 'node:crypto';

import { expect, test } from '@playwright/test';

import { login } from '../../fixtures/web/actions';

test('dialog loader replaces the old runtime when the authenticated session changes', async ({
  page,
}): Promise<void> => {
  await login(page, 'anna');
  await page.getByRole('button', { name: 'Написать: Максим Волков', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Максим Волков', exact: true })).toBeVisible();
  await expect(page.getByRole('banner', { name: 'Панель приложения' })).toHaveCount(0);
  await expect(page.locator('.dialog-room')).toHaveCSS('background-color', 'rgb(255, 255, 255)');
  await expect(page.locator('.dialog-composer-area')).toHaveCSS(
    'background-color',
    'rgb(255, 255, 255)',
  );
  const path = new URL(page.url()).pathname;
  const previousRefresh = await page.evaluate(
    (): string => JSON.parse(localStorage.getItem('gchat.session.v1')!).refresh_token,
  );

  try {
    await page.evaluate(async (): Promise<void> => {
      const modulePath = '/src/shared/session/browser-session.ts';
      const session = await import(modulePath);

      await session.login('maxim', 'gchat-web-test-password');
    });
    await expect(page.getByRole('heading', { name: 'Анна Смирнова', exact: true })).toBeVisible();
    await expect(page.getByRole('banner', { name: 'Панель приложения' })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Максим Волков', exact: true })).toHaveCount(0);
    await expect(page.getByLabel('Сообщение', { exact: true })).toBeVisible();
    expect(new URL(page.url()).pathname).toBe(path);
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Анна Смирнова', exact: true })).toBeVisible();
  } finally {
    await page.request.post('/api/auth/logout', { data: { refresh_token: previousRefresh } });
    const currentRefresh = await page.evaluate(
      (): string | undefined =>
        JSON.parse(localStorage.getItem('gchat.session.v1') ?? 'null')?.refresh_token,
    );

    if (currentRefresh) {
      await page.request.post('/api/auth/logout', { data: { refresh_token: currentRefresh } });
    }
  }
});

test('dialogs send, recover unknown results, retain drafts, render stickers and preserve mobile navigation', async ({
  browser,
}, testInfo): Promise<void> => {
  const a = await browser.newContext();
  const b = await browser.newContext();
  const anna = await a.newPage();
  const maxim = await b.newPage();
  const errors: string[] = [];
  const modules = new Set<string>();

  maxim.on('request', (request): void => {
    modules.add(new URL(request.url()).pathname);
  });

  anna.on('pageerror', (error): void => {
    errors.push(error.message);
  });
  maxim.on('pageerror', (error): void => {
    errors.push(error.message);
  });

  try {
    await login(anna, 'anna');
    await login(maxim, 'maxim');
    const open = anna.getByRole('button', { name: 'Написать: Максим Волков', exact: true });

    await expect(open).toBeEnabled();
    await open.click();
    await expect(anna.getByLabel('Сообщение', { exact: true })).toBeVisible();
    const sidebar = anna.getByRole('region', { name: 'Диалоги', exact: true });

    await sidebar.evaluate((element): void => {
      element.setAttribute('data-instance', 'original');
    });
    await anna
      .getByRole('navigation', { name: 'Основные разделы' })
      .getByRole('link', { name: 'Диалоги', exact: true })
      .click();
    await expect(anna.getByRole('heading', { name: 'Выберите диалог', exact: true })).toBeVisible();
    await expect(sidebar).toHaveAttribute('data-instance', 'original');
    await anna.goBack();
    await expect(anna.getByLabel('Сообщение', { exact: true })).toBeVisible();
    await expect(sidebar).toHaveAttribute('data-instance', 'original');
    const url = anna.url();
    const text = 'Тест переписки ' + randomUUID();

    await anna.getByLabel('Сообщение', { exact: true }).fill(text);
    await anna.getByRole('button', { name: 'Отправить сообщение', exact: true }).click();
    await expect(anna.locator('.dialog-message-text').filter({ hasText: text })).toHaveCount(1);
    await maxim.getByRole('link', { name: 'Диалоги', exact: true }).click();
    await expect(maxim.getByRole('link', { name: /Анна/ })).toBeVisible();
    expect(
      [...modules].some((path): boolean => /\/(DialogConversationRoute|Composer)\.tsx$/.test(path)),
    ).toBe(false);
    await maxim.getByRole('link', { name: /Анна/ }).click();
    await expect(maxim.locator('.dialog-message-text').filter({ hasText: text })).toBeVisible();
    expect(
      [...modules].some((path): boolean => path.endsWith('/DialogConversationRoute.tsx')),
    ).toBe(true);
    await maxim.bringToFront();
    await expect(
      anna
        .locator('.dialog-message-text')
        .filter({ hasText: text })
        .locator('..')
        .getByLabel('Прочитано', { exact: true }),
    ).toBeVisible({ timeout: 15000 });
    await anna.bringToFront();
    const draft = 'Черновик ' + randomUUID();

    await anna.getByLabel('Сообщение', { exact: true }).fill(draft);
    await anna.getByRole('link', { name: 'Звонки', exact: true }).click();
    await expect(anna).toHaveURL(/\/calls$/);
    await anna.goto(url);
    await expect(anna.getByLabel('Сообщение', { exact: true })).toHaveValue(draft);
    await anna.reload();
    await expect(anna.getByLabel('Сообщение', { exact: true })).toHaveValue(draft);
    const sentSticker = anna.waitForResponse(
      (response): boolean =>
        response.url().includes('/messages') &&
        response.request().method() === 'POST' &&
        response.request().postDataJSON()?.content?.kind === 'sticker',
    );

    await anna.getByRole('button', { name: 'Открыть стикеры' }).click();
    await anna.getByRole('button', { name: 'Отправить стикер: Кот' }).click();
    expect((await sentSticker).ok()).toBe(true);
    await expect(anna.getByAltText('Стикер: Кот').last()).toBeVisible();
    await expect(anna.getByLabel('Сообщение', { exact: true })).toBeEditable();
    await expect(anna.getByLabel('Сообщение', { exact: true })).toHaveValue(draft);
    const unknown = 'Неизвестный результат ' + randomUUID();
    let lost = false;
    let failedResponse = false;

    await anna.route('**/api/dialogs/*/messages', async (route): Promise<void> => {
      if (route.request().method() === 'POST' && !lost) {
        lost = true;
        await route.fetch();
        await route.abort('failed');
        failedResponse = true;
      } else {
        await route.continue();
      }
    });
    await anna.getByLabel('Сообщение', { exact: true }).fill(unknown);
    await anna.getByRole('button', { name: 'Отправить сообщение', exact: true }).click();
    await expect(anna.locator('.dialog-message-text').filter({ hasText: unknown })).toHaveCount(1);
    await expect.poll((): boolean => failedResponse).toBe(true);
    await anna.reload();
    await anna.screenshot({ path: testInfo.outputPath('dialog-after-reload.png') });
    await expect(anna.locator('.dialog-message-text').filter({ hasText: unknown })).toHaveCount(1);
    await expect(
      anna
        .getByText(unknown, { exact: true })
        .locator('..')
        .getByLabel(/Отправлено|Прочитано/),
    ).toBeVisible();
    await anna.setViewportSize({ width: 360, height: 640 });
    await expect(
      anna.getByRole('button', { name: 'Отправить сообщение', exact: true }),
    ).toBeVisible();
    await anna.screenshot({ path: testInfo.outputPath('dialog-mobile.png') });
    expect(
      await anna.evaluate((): boolean => document.documentElement.scrollWidth <= innerWidth),
    ).toBe(true);
    await anna.getByRole('link', { name: 'Назад к диалогам' }).click();
    await expect(anna.getByRole('region', { name: 'Диалоги', exact: true })).toBeVisible();
    await anna.screenshot({ path: testInfo.outputPath('dialogs-mobile.png') });
    expect(errors).toEqual([]);
  } catch (error) {
    await anna.screenshot({ path: testInfo.outputPath('dialog-failure.png') });

    throw error;
  } finally {
    await a.close();
    await b.close();
  }
});

test('tabs share one WSS, resolve draft conflicts explicitly, flush before update and purge on logout', async ({
  page,
  context,
}): Promise<void> => {
  await login(page, 'anna');
  await page.getByRole('button', { name: 'Написать: Максим Волков', exact: true }).click();
  await expect(page.getByLabel('Сообщение', { exact: true })).toBeVisible();
  const other = await context.newPage();

  await other.goto(page.url());
  await expect(other.getByLabel('Сообщение', { exact: true })).toBeVisible();
  const own = 'Первый черновик ' + randomUUID();
  const peer = 'Второй черновик ' + randomUUID();

  await Promise.all([
    page.getByLabel('Сообщение', { exact: true }).fill(own),
    other.getByLabel('Сообщение', { exact: true }).fill(peer),
  ]);
  await expect
    .poll(
      async (): Promise<number> =>
        (await page.locator('.draft-conflict').count()) +
        (await other.locator('.draft-conflict').count()),
    )
    .toBe(1);
  const conflicted = (await page.locator('.draft-conflict').count()) ? page : other;
  const text = conflicted === page ? own : peer;

  await conflicted.getByRole('button', { name: 'Сохранить мой вариант', exact: true }).click();
  await expect(page.getByLabel('Сообщение', { exact: true })).toHaveValue(text);
  await expect(other.getByLabel('Сообщение', { exact: true })).toHaveValue(text);
  expect(
    await page.evaluate(
      async (): Promise<number> =>
        (await navigator.locks.query()).held?.filter(
          (lock): boolean => lock.name === 'gchat-ws-owner',
        ).length ?? 0,
    ),
  ).toBe(1);
  await other.close();
  const updateDraft = 'Перед обновлением ' + randomUUID();

  await page.getByLabel('Сообщение', { exact: true }).fill(updateDraft);
  await page.evaluate((): void => {
    window.dispatchEvent(new Event('gchat-prepare-update'));
  });
  await expect
    .poll((): Promise<boolean> =>
      page.evaluate(async (text): Promise<boolean> => {
        const request = indexedDB.open('gchat-dialogs-v1');
        const database = await new Promise<IDBDatabase>((resolve): void => {
          request.onsuccess = (): void => resolve(request.result);
        });
        const records = database.transaction('records').objectStore('records').getAll();
        const saved = await new Promise<boolean>((resolve): void => {
          records.onsuccess = (): void =>
            resolve(records.result.some((row): boolean => row.record.draft.text === text));
        });

        database.close();

        return saved;
      }, updateDraft),
    )
    .toBe(true);
  await page.reload();
  await expect(page.getByLabel('Сообщение', { exact: true })).toHaveValue(updateDraft);
  await page.getByRole('link', { name: 'Настройки', exact: true }).click();
  await page.getByRole('button', { name: 'Выйти из аккаунта', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Выйти', exact: true }).click();
  await expect(page.getByLabel('Логин', { exact: true })).toBeVisible();
  expect(
    await page.evaluate(async (): Promise<number> => {
      const request = indexedDB.open('gchat-dialogs-v1');
      const database = await new Promise<IDBDatabase>((resolve): void => {
        request.onsuccess = (): void => resolve(request.result);
      });
      const tx = database.transaction('messages');
      const count = tx.objectStore('messages').count();
      const result = await new Promise<number>((resolve): void => {
        count.onsuccess = (): void => resolve(count.result);
      });

      database.close();

      return result;
    }),
  ).toBe(0);
});

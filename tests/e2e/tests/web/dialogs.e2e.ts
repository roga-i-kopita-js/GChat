import { randomUUID } from 'node:crypto';

import { expect, test } from '@playwright/test';

import { login } from '../../fixtures/web/actions';

test('dialogs send, recover unknown results, retain drafts, render stickers and preserve mobile navigation', async ({
  browser,
}, testInfo): Promise<void> => {
  const a = await browser.newContext(),
    b = await browser.newContext();
  const anna = await a.newPage(),
    maxim = await b.newPage();
  const errors: string[] = [];

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
    const url = anna.url(),
      text = 'Тест переписки ' + randomUUID();

    await anna.getByLabel('Сообщение', { exact: true }).fill(text);
    await anna.getByRole('button', { name: 'Отправить сообщение', exact: true }).click();
    await expect(anna.locator('.dialog-message-text').filter({ hasText: text })).toHaveCount(1);
    await maxim.getByRole('link', { name: 'Диалоги', exact: true }).click();
    await maxim.getByRole('button', { name: 'Обновить диалоги' }).click();
    await expect(maxim.getByRole('link', { name: /Анна/ })).toBeVisible();
    await maxim.getByRole('link', { name: /Анна/ }).click();
    await expect(maxim.locator('.dialog-message-text').filter({ hasText: text })).toBeVisible();
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
      } else await route.continue();
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
    await expect(anna.getByRole('heading', { name: 'Диалоги', exact: true })).toBeVisible();
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
  const own = 'Первый черновик ' + randomUUID(),
    peer = 'Второй черновик ' + randomUUID();

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
  await expect(page.getByRole('status').filter({ hasText: 'Сохранено' })).toBeVisible();
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
      const tx = database.transaction('messages'),
        count = tx.objectStore('messages').count();
      const result = await new Promise<number>((resolve): void => {
        count.onsuccess = (): void => resolve(count.result);
      });

      database.close();

      return result;
    }),
  ).toBe(0);
});

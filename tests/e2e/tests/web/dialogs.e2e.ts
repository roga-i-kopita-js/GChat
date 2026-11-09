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

      const { login: sessionLogin } = session;

      await sessionLogin.bind(session)('maxim', 'gchat-web-test-password');
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
  const { newPage: aNewPage } = a;
  const anna = await aNewPage.bind(a)();
  const { newPage: bNewPage } = b;
  const maxim = await bNewPage.bind(b)();
  const errors: string[] = [];
  const modules = new Set<string>();

  const { on: maximOn } = maxim;

  maximOn.bind(maxim)('request', (request): void => {
    modules.add(new URL(request.url()).pathname);
  });

  const { on: annaOn } = anna;

  annaOn.bind(anna)('pageerror', (error): void => {
    errors.push(error.message);
  });
  const { on: maximOn2 } = maxim;

  maximOn2.bind(maxim)('pageerror', (error): void => {
    errors.push(error.message);
  });

  try {
    await login(anna, 'anna');
    await login(maxim, 'maxim');
    const { getByRole: annaGetByRole } = anna;
    const open = annaGetByRole.bind(anna)('button', {
      name: 'Написать: Максим Волков',
      exact: true,
    });

    await expect(open).toBeEnabled();
    await open.click();
    const { getByLabel: annaGetByLabel } = anna;

    await expect(annaGetByLabel.bind(anna)('Сообщение', { exact: true })).toBeVisible();
    const { getByRole: annaGetByRole2 } = anna;
    const sidebar = annaGetByRole2.bind(anna)('region', { name: 'Диалоги', exact: true });

    await sidebar.evaluate((element): void => {
      element.setAttribute('data-instance', 'original');
    });
    const { getByRole: annaGetByRole3 } = anna;

    await annaGetByRole3
      .bind(anna)('navigation', { name: 'Основные разделы' })
      .getByRole('link', { name: 'Диалоги', exact: true })
      .click();
    const { getByRole: annaGetByRole4 } = anna;

    await expect(
      annaGetByRole4.bind(anna)('heading', { name: 'Выберите диалог', exact: true }),
    ).toBeVisible();
    await expect(sidebar).toHaveAttribute('data-instance', 'original');
    const { goBack: annaGoBack } = anna;

    await annaGoBack.bind(anna)();
    const { getByLabel: annaGetByLabel2 } = anna;

    await expect(annaGetByLabel2.bind(anna)('Сообщение', { exact: true })).toBeVisible();
    await expect(sidebar).toHaveAttribute('data-instance', 'original');
    const { url: annaUrl } = anna;
    const url = annaUrl.bind(anna)();
    const text = 'Тест переписки ' + randomUUID() + '\n😀 ' + 'Длинное сообщение '.repeat(40);

    const { getByLabel: annaGetByLabel3 } = anna;

    await annaGetByLabel3.bind(anna)('Сообщение', { exact: true }).fill(text);
    const { getByRole: annaGetByRole5 } = anna;

    await annaGetByRole5.bind(anna)('button', { name: 'Отправить сообщение', exact: true }).click();
    const { locator: annaLocator } = anna;

    await expect(
      annaLocator.bind(anna)('.dialog-message-text').filter({ hasText: text }),
    ).toHaveCount(1);
    await expect(
      annaLocator
        .bind(anna)('.dialog-contact .user-card-subtitle')
        .filter({ hasText: 'Тест переписки' }),
    ).toHaveText('Вы: ' + text);
    const { getByRole: maximGetByRole } = maxim;

    await maximGetByRole.bind(maxim)('link', { name: 'Диалоги', exact: true }).click();
    const { getByRole: maximGetByRole2 } = maxim;

    await expect(maximGetByRole2.bind(maxim)('link', { name: /Анна/ })).toBeVisible();
    const { locator: previewLocator } = maxim;
    const preview = previewLocator
      .bind(maxim)('.dialog-contact .user-card-subtitle')
      .filter({ hasText: 'Тест переписки' });

    await expect(preview).toHaveText(text);
    await expect(preview).toHaveCSS('text-overflow', 'ellipsis');
    await expect(preview).toHaveCSS('white-space', 'nowrap');
    await expect(preview).toHaveCSS('overflow', 'hidden');

    for (const width of [360, 390, 430, 1024]) {
      const { setViewportSize: previewViewport } = maxim;

      await previewViewport.bind(maxim)({ width, height: 740 });
      const { evaluate: measurePreview } = preview;

      expect(
        await measurePreview.bind(preview)(
          (element): boolean => element.scrollWidth > element.clientWidth,
        ),
      ).toBe(true);
      const { evaluate: checkPreviewViewport } = maxim;

      expect(
        await checkPreviewViewport.bind(maxim)(
          (): boolean => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);

      if (width === 360) {
        const { screenshot: previewScreenshot } = maxim;

        await previewScreenshot.bind(maxim)({
          path: testInfo.outputPath('dialog-preview-mobile.png'),
        });
      }
    }

    expect(
      [...modules].some((path): boolean => /\/api\/dialogs\/[^/]+\/(messages|read)$/.test(path)),
    ).toBe(false);
    expect(
      [...modules].some((path): boolean => /\/(DialogConversationRoute|Composer)\.tsx$/.test(path)),
    ).toBe(false);
    const { getByRole: maximGetByRole3 } = maxim;

    await maximGetByRole3.bind(maxim)('link', { name: /Анна/ }).click();
    const { locator: maximLocator } = maxim;

    await expect(
      maximLocator.bind(maxim)('.dialog-message-text').filter({ hasText: text }),
    ).toBeVisible();
    expect(
      [...modules].some((path): boolean => path.endsWith('/DialogConversationRoute.tsx')),
    ).toBe(true);
    const { bringToFront: maximBringToFront } = maxim;

    await maximBringToFront.bind(maxim)();
    const { locator: annaLocator2 } = anna;

    await expect(
      annaLocator2
        .bind(anna)('.dialog-message-text')
        .filter({ hasText: text })
        .locator('..')
        .getByLabel('Прочитано', { exact: true }),
    ).toBeVisible({ timeout: 15000 });
    const { bringToFront: annaBringToFront } = anna;

    await annaBringToFront.bind(anna)();
    const draft = 'Черновик ' + randomUUID();

    const { getByLabel: annaGetByLabel4 } = anna;

    await annaGetByLabel4.bind(anna)('Сообщение', { exact: true }).fill(draft);
    const { getByRole: annaGetByRole6 } = anna;

    await annaGetByRole6.bind(anna)('link', { name: 'Звонки', exact: true }).click();
    await expect(anna).toHaveURL(/\/calls$/);
    const { goto: annaGoto } = anna;

    await annaGoto.bind(anna)(url);
    const { getByLabel: annaGetByLabel5 } = anna;

    await expect(annaGetByLabel5.bind(anna)('Сообщение', { exact: true })).toHaveValue(draft);
    const { reload: annaReload } = anna;

    await annaReload.bind(anna)();
    const { getByLabel: annaGetByLabel6 } = anna;

    await expect(annaGetByLabel6.bind(anna)('Сообщение', { exact: true })).toHaveValue(draft);
    const { waitForResponse: annaWaitForResponse } = anna;
    const sentSticker = annaWaitForResponse.bind(anna)(
      (response): boolean =>
        response.url().includes('/messages') &&
        response.request().method() === 'POST' &&
        response.request().postDataJSON()?.content?.kind === 'sticker',
    );

    const { getByRole: annaGetByRole7 } = anna;

    await annaGetByRole7.bind(anna)('button', { name: 'Открыть стикеры' }).click();
    const { getByRole: annaGetByRole8 } = anna;

    await annaGetByRole8.bind(anna)('button', { name: 'Отправить стикер: Кот' }).click();
    const resolved = await sentSticker;
    const { ok: resultOk } = resolved;

    expect(resultOk.bind(resolved)()).toBe(true);
    const { getByAltText: annaGetByAltText } = anna;

    await expect(annaGetByAltText.bind(anna)('Стикер: Кот').last()).toBeVisible();
    const { locator: stickerPreviewLocator } = anna;
    const stickerPreview = stickerPreviewLocator
      .bind(anna)('.dialog-contact .user-card-subtitle')
      .filter({ hasText: /^Вы: Стикер$/ });

    await expect(stickerPreview).toBeVisible();
    const { getByLabel: annaGetByLabel7 } = anna;

    await expect(annaGetByLabel7.bind(anna)('Сообщение', { exact: true })).toBeEditable();
    const { getByLabel: annaGetByLabel8 } = anna;

    await expect(annaGetByLabel8.bind(anna)('Сообщение', { exact: true })).toHaveValue(draft);
    const unknown = 'Неизвестный результат ' + randomUUID();
    let lost = false;
    let failedResponse = false;

    const { route: annaRoute } = anna;

    await annaRoute.bind(anna)('**/api/dialogs/*/messages', async (route): Promise<void> => {
      if (route.request().method() === 'POST' && !lost) {
        lost = true;
        await route.fetch();
        await route.abort('failed');
        failedResponse = true;
      } else {
        await route.continue();
      }
    });
    const { getByLabel: annaGetByLabel9 } = anna;

    await annaGetByLabel9.bind(anna)('Сообщение', { exact: true }).fill(unknown);
    const { getByRole: annaGetByRole9 } = anna;

    await annaGetByRole9.bind(anna)('button', { name: 'Отправить сообщение', exact: true }).click();
    const { locator: annaLocator3 } = anna;

    await expect(
      annaLocator3.bind(anna)('.dialog-message-text').filter({ hasText: unknown }),
    ).toHaveCount(1);
    await expect.poll((): boolean => failedResponse).toBe(true);
    const { reload: annaReload2 } = anna;

    await annaReload2.bind(anna)();
    const { screenshot: annaScreenshot } = anna;

    await annaScreenshot.bind(anna)({ path: testInfo.outputPath('dialog-after-reload.png') });
    const { locator: annaLocator4 } = anna;

    await expect(
      annaLocator4.bind(anna)('.dialog-message-text').filter({ hasText: unknown }),
    ).toHaveCount(1);
    const { getByText: annaGetByText } = anna;

    await expect(
      annaGetByText
        .bind(anna)(unknown, { exact: true })
        .locator('..')
        .getByLabel(/Отправлено|Прочитано/),
    ).toBeVisible();
    const { setViewportSize: annaSetViewportSize } = anna;

    await annaSetViewportSize.bind(anna)({ width: 360, height: 640 });
    const { getByRole: annaGetByRole10 } = anna;

    await expect(
      annaGetByRole10.bind(anna)('button', { name: 'Отправить сообщение', exact: true }),
    ).toBeVisible();
    const { screenshot: annaScreenshot2 } = anna;

    await annaScreenshot2.bind(anna)({ path: testInfo.outputPath('dialog-mobile.png') });
    const { evaluate: annaEvaluate } = anna;

    expect(
      await annaEvaluate.bind(anna)(
        (): boolean => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    const { getByRole: annaGetByRole11 } = anna;

    await annaGetByRole11.bind(anna)('link', { name: 'Назад к диалогам' }).click();
    const { getByRole: annaGetByRole12 } = anna;

    await expect(
      annaGetByRole12.bind(anna)('region', { name: 'Диалоги', exact: true }),
    ).toBeVisible();
    const { screenshot: annaScreenshot3 } = anna;

    await annaScreenshot3.bind(anna)({ path: testInfo.outputPath('dialogs-mobile.png') });
    expect(errors).toEqual([]);
  } catch (error) {
    const { screenshot: annaScreenshot4 } = anna;

    await annaScreenshot4.bind(anna)({ path: testInfo.outputPath('dialog-failure.png') });

    throw error;
  } finally {
    const { close: aClose } = a;

    await aClose.bind(a)();
    const { close: bClose } = b;

    await bClose.bind(b)();
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

  const { goto: otherGoto } = other;

  await otherGoto.bind(other)(page.url());
  const { getByLabel: otherGetByLabel } = other;

  await expect(otherGetByLabel.bind(other)('Сообщение', { exact: true })).toBeVisible();
  const own = 'Первый черновик ' + randomUUID();
  const peer = 'Второй черновик ' + randomUUID();

  const { getByLabel: otherGetByLabel2 } = other;

  await Promise.all([
    page.getByLabel('Сообщение', { exact: true }).fill(own),
    otherGetByLabel2.bind(other)('Сообщение', { exact: true }).fill(peer),
  ]);
  await expect
    .poll(async (): Promise<number> => {
      const { locator: otherLocator } = other;

      return (
        (await page.locator('.draft-conflict').count()) +
        (await otherLocator.bind(other)('.draft-conflict').count())
      );
    })
    .toBe(1);
  const conflicted = (await page.locator('.draft-conflict').count()) ? page : other;
  const text = conflicted === page ? own : peer;

  await conflicted.getByRole('button', { name: 'Сохранить мой вариант', exact: true }).click();
  await expect(page.getByLabel('Сообщение', { exact: true })).toHaveValue(text);
  const { getByLabel: otherGetByLabel3 } = other;

  await expect(otherGetByLabel3.bind(other)('Сообщение', { exact: true })).toHaveValue(text);
  expect(
    await page.evaluate(async (): Promise<number> => {
      const { held: queryResultHeld } = await navigator.locks.query();

      return queryResultHeld?.filter((lock): boolean => lock.name === 'gchat-ws-owner').length ?? 0;
    }),
  ).toBe(1);
  const { close: otherClose } = other;

  await otherClose.bind(other)();
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
        const { transaction: databaseTransaction } = database;
        const records = databaseTransaction
          .bind(database)('records')
          .objectStore('records')
          .getAll();
        const saved = await new Promise<boolean>((resolve): void => {
          records.onsuccess = (): void =>
            resolve(records.result.some((row): boolean => row.record.draft.text === text));
        });

        const { close: databaseClose } = database;

        databaseClose.bind(database)();

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
      const { transaction: databaseTransaction2 } = database;
      const tx = databaseTransaction2.bind(database)('messages');
      const count = tx.objectStore('messages').count();
      const result = await new Promise<number>((resolve): void => {
        count.onsuccess = (): void => resolve(count.result);
      });

      const { close: databaseClose2 } = database;

      databaseClose2.bind(database)();

      return result;
    }),
  ).toBe(0);
});

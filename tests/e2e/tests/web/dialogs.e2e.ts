import { randomUUID } from 'node:crypto';

import { expect, test } from '@playwright/test';

import { login } from '../../fixtures/web/actions';

test('dialog loader replaces the old runtime when the authenticated session changes', async ({
  page,
}): Promise<void> => {
  await login(page, 'anna');
  await page.getByRole('button', { name: 'Написать: Максим Волков', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Максим Волков', exact: true })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Основные разделы' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Назад к диалогам', exact: true })).toBeVisible();
  const insets = await page.context().newCDPSession(page);
  const { send: overrideInsets } = insets;

  for (const width of [390, 1280]) {
    await page.setViewportSize({ width, height: 844 });

    for (const bottom of [34, 0, 21]) {
      await overrideInsets.bind(insets)('Emulation.setSafeAreaInsetsOverride', {
        insets: { bottom },
      });
      await expect
        .poll(async (): Promise<number> =>
          page
            .getByLabel('Сообщение', { exact: true })
            .evaluate((element): number =>
              Math.round(innerHeight - element.getBoundingClientRect().bottom),
            ),
        )
        .toBe(Math.max(bottom, 8));
    }
  }

  await expect(page.getByRole('banner', { name: 'Панель приложения' })).toHaveCount(0);
  await expect(page.locator('.dialog-room')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  const composerSurface = await page
    .locator('.dialog-composer-area')
    .evaluate((element): string => {
      const probe = document.createElement('span');

      probe.style.backgroundColor = 'var(--ui-surface)';
      element.append(probe);
      const color = getComputedStyle(probe).backgroundColor;

      probe.remove();

      return color;
    });

  await expect(page.locator('.dialog-composer-area')).toHaveCSS(
    'background-color',
    composerSurface,
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
    await expect(page.getByRole('navigation', { name: 'Основные разделы' })).toHaveCount(0);
    await page.getByRole('link', { name: 'Назад к диалогам', exact: true }).click();
    await expect(page.getByRole('navigation', { name: 'Основные разделы' })).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Основные разделы' })).toHaveCSS(
      'margin-bottom',
      '21px',
    );
    await page.getByRole('link', { name: 'Настройки', exact: true }).click();
    await expect(page.getByRole('navigation', { name: 'Основные разделы' })).toHaveCSS(
      'margin-bottom',
      '21px',
    );
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

    await annaGetByRole3.bind(anna)('link', { name: 'Назад к диалогам', exact: true }).click();
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

    await annaGetByRole6.bind(anna)('link', { name: 'Назад к диалогам', exact: true }).click();
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
  await page.getByRole('link', { name: 'Назад к диалогам', exact: true }).click();
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

test('message editing preserves drafts, handles keyboard, conflicts and offline updates', async ({
  browser,
}): Promise<void> => {
  const a = await browser.newContext({ viewport: { width: 1280, height: 844 } });
  const { newPage: aNewPage1, close: aClose37 } = a;

  const b = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const { newPage: bNewPage2, setOffline: bSetOffline27, close: bClose38 } = b;

  const anna = await aNewPage1.bind(a)();
  const {
    screenshot: annaScreenshot,
    getByRole: annaGetByRole13,
    url: annaUrl14,
    getByLabel: annaGetByLabel16,
    locator: annaLocator17,
    evaluate: annaEvaluate19,
    request: annaRequest20,
    getByText: annaGetByText24,
    route: annaRoute25,
    unroute: annaUnroute26,
    waitForTimeout: annaWaitForTimeout29,
    setViewportSize: annaSetViewportSize36,
  } = anna;

  const maxim = await bNewPage2.bind(b)();
  const {
    goto: maximGoto15,
    locator: maximLocator18,
    reload: maximReload30,
    getByLabel: maximGetByLabel31,
    evaluate: maximEvaluate32,
  } = maxim;

  const marker = 'edit-' + randomUUID();

  try {
    await login(anna, 'anna');
    await login(maxim, 'maxim');
    await annaGetByRole13
      .bind(anna)('button', { name: 'Написать: Максим Волков', exact: true })
      .click();
    await expect(annaGetByLabel16.bind(anna)('Сообщение', { exact: true })).toBeVisible();
    const path = new URL(annaUrl14.bind(anna)()).pathname;

    await maximGoto15.bind(maxim)(path);
    const input = annaGetByLabel16.bind(anna)('Сообщение', { exact: true });

    await input.fill(marker);
    await input.press('Enter');
    await expect(annaLocator17.bind(anna)('article').filter({ hasText: marker })).toBeVisible();
    await expect(maximLocator18.bind(maxim)('article').filter({ hasText: marker })).toBeVisible();
    const id = path.split('/').at(-1)!;
    const token = async (): Promise<string> =>
      annaEvaluate19.bind(anna)(
        (): string => JSON.parse(localStorage.getItem('gchat.session.v1')!).access_token,
      );
    const authorization = 'Bearer ' + (await token());
    const list = await annaRequest20.get(`/api/dialogs/${id}/messages`, {
      headers: { Authorization: authorization },
    });
    const { ok: listOk21, json: listJson } = list;

    expect(listOk21.bind(list)()).toBeTruthy();
    const { messages: messagesResult22 } = await listJson.bind(list)();
    const sent = messagesResult22.find(
      (message: { content: { text?: string } }): boolean => message.content.text === marker,
    );
    const patch = async (text: string, version: number): Promise<void> => {
      const authorization = 'Bearer ' + (await token());
      const response = await annaRequest20.patch(`/api/dialogs/${id}/messages/${sent.message_id}`, {
        headers: { Authorization: authorization },
        data: {
          client_edit_id: randomUUID(),
          expected_version: version,
          content: { kind: 'text', text },
        },
      });
      const { status: responseStatus23 } = response;

      const { text: responseText } = response;
      const detail = await responseText.bind(response)();

      expect(responseStatus23.bind(response)(), detail).toBe(200);
    };

    await input.fill('ordinary draft');
    await input.press('ArrowUp');
    await expect(
      annaGetByLabel16.bind(anna)('Редактирование сообщения', { exact: true }),
    ).toHaveCount(0);
    await expect(input).toHaveValue('ordinary draft');
    await annaLocator17
      .bind(anna)('article')
      .filter({ hasText: marker })
      .click({ button: 'right' });
    const menu = annaGetByRole13.bind(anna)('menu', { name: 'Действия сообщения', exact: true });

    await expect(menu).toBeVisible();
    await expect(
      annaGetByRole13.bind(anna)('dialog', { name: 'Сообщение', exact: true }),
    ).toHaveCount(0);
    await annaScreenshot.bind(anna)({ path: '/tmp/gchat-message-menu-desktop.png' });
    await menu.press('Escape');
    const ownMessage = annaLocator17.bind(anna)('article').filter({ hasText: marker });

    await expect(ownMessage).toBeFocused();
    await ownMessage.press('Shift+F10');
    await expect(menu).toBeVisible();
    const menuBox = await menu.boundingBox();
    const { x: menuBoxX1, width: menuBoxWidth2 } = menuBox!;

    const messageBox = await ownMessage.boundingBox();
    const { x: messageBoxX3, width: messageBoxWidth4 } = messageBox!;

    expect(menuBox).not.toBeNull();
    expect(messageBox).not.toBeNull();
    expect(Math.abs(menuBoxX1 + menuBoxWidth2 - messageBoxX3 - messageBoxWidth4)).toBeLessThan(20);
    await annaGetByRole13.bind(anna)('menuitem', { name: 'Редактировать', exact: true }).click();
    const editor = annaGetByLabel16.bind(anna)('Текст сообщения', { exact: true });

    await expect(editor).toBeFocused();
    await editor.fill(marker + '-mine');
    await annaScreenshot.bind(anna)({ path: '/tmp/gchat-message-editing-desktop.png' });
    await patch(marker + '-other-device', 1);
    await annaGetByRole13.bind(anna)('button', { name: 'Сохранить', exact: true }).click();
    await expect(annaGetByText24.bind(anna)('Актуальный текст:', { exact: true })).toBeVisible();
    await expect(editor).toHaveValue(marker + '-mine');
    await annaGetByRole13
      .bind(anna)('button', { name: 'Применить мой текст', exact: true })
      .click();
    await expect(input).toBeVisible();
    await expect(input).toHaveValue('ordinary draft');
    await expect(
      maximLocator18
        .bind(maxim)('article')
        .filter({ hasText: marker + '-mine' }),
    ).toBeVisible();
    await input.fill(' ');
    await input.press('ArrowUp');
    await expect(editor).toHaveCount(0);
    await input.fill('');
    await input.press('Shift+ArrowUp');
    await expect(editor).toHaveCount(0);
    await input.dispatchEvent('keydown', { key: 'ArrowUp', isComposing: true });
    await input.dispatchEvent('keydown', { key: 'ArrowUp', repeat: true });
    await expect(editor).toHaveCount(0);
    await input.press('ArrowUp');
    await expect(editor).toHaveValue(marker + '-mine');
    await editor.press('ArrowUp');
    await expect(editor).toHaveValue(marker + '-mine');
    await editor.press('Escape');
    await expect(input).toBeFocused();
    await input.press('ArrowUp');
    await editor.fill(marker + '-unknown-result');
    let allowReconcile = false;
    let losePatchResponse = true;

    await annaRoute25.bind(anna)('**/api/dialogs/*/messages/*', async (route): Promise<void> => {
      if (route.request().method() === 'PATCH' && losePatchResponse) {
        losePatchResponse = false;
        await route.fetch();
        await route.abort('failed');
      } else if (route.request().method() === 'GET' && !allowReconcile) {
        await route.abort('failed');
      } else {
        await route.continue();
      }
    });
    await editor.press('Enter');
    await expect(
      annaGetByRole13.bind(anna)('button', { name: 'Проверить сохранение', exact: true }),
    ).toBeEnabled();
    await editor.fill(marker + '-after-unknown');
    allowReconcile = true;
    await annaGetByRole13
      .bind(anna)('button', { name: 'Проверить сохранение', exact: true })
      .click();
    await expect(
      annaGetByText24.bind(anna)('Предыдущая правка сохранена. Новый текст ещё не сохранён.', {
        exact: true,
      }),
    ).toBeVisible();
    await expect(editor).toHaveValue(marker + '-after-unknown');
    await editor.press('Enter');
    await expect(input).toBeVisible();
    await expect(
      annaLocator17
        .bind(anna)('article')
        .filter({ hasText: marker + '-after-unknown' }),
    ).toBeVisible();
    await annaUnroute26.bind(anna)('**/api/dialogs/*/messages/*');
    await bSetOffline27.bind(b)(true);

    // Keep the first message outside the next initial history page.
    for (let i = 0; i < 32; i++) {
      const authorization = 'Bearer ' + (await token());
      const response = await annaRequest20.post(`/api/dialogs/${id}/messages`, {
        headers: { Authorization: authorization },
        data: {
          client_message_id: randomUUID(),
          content: { kind: 'text', text: marker + '-tail-' + i },
        },
      });
      const { status: responseStatus28 } = response;

      expect(responseStatus28.bind(response)()).toBe(201);
      await annaWaitForTimeout29.bind(anna)(220);
    }

    await patch(marker + '-offline-edited', 5);
    await bSetOffline27.bind(b)(false);
    await maximReload30.bind(maxim)();
    await expect(maximGetByLabel31.bind(maxim)('Сообщение', { exact: true })).toBeVisible();
    // Reloading uses the cached old message, then restores its edit independently of the new tail.
    await expect
      .poll(async (): Promise<boolean> =>
        maximEvaluate32.bind(maxim)(
          async ({ dialogId, messageId, expected }): Promise<boolean> => {
            const db = await new Promise<IDBDatabase>((resolve, reject): void => {
              const request = indexedDB.open('gchat-dialogs-v1', 2);

              request.onsuccess = (): void => resolve(request.result);
              request.onerror = (): void => reject(request.error);
            });
            const { transaction: dbTransaction33, close: dbClose35 } = db;

            try {
              const rows = await new Promise<
                { message: { dialog_id: string; message_id: string; content: { text?: string } } }[]
              >((resolve, reject): void => {
                const request = dbTransaction33
                  .bind(db)('messages')
                  .objectStore('messages')
                  .getAll();

                request.onsuccess = (): void => resolve(request.result);
                request.onerror = (): void => reject(request.error);
              });
              const { some: rowsSome34 } = rows;

              return rowsSome34.bind(rows)(
                ({ message }): boolean =>
                  message.dialog_id === dialogId &&
                  message.message_id === messageId &&
                  message.content.text === expected,
              );
            } finally {
              dbClose35.bind(db)();
            }
          },
          { dialogId: id, messageId: sent.message_id, expected: marker + '-offline-edited' },
        ),
      )
      .toBe(true);
    await annaSetViewportSize36.bind(anna)({ width: 390, height: 844 });
    await input.fill('');
    await input.press('ArrowUp');
    await expect(editor).toBeVisible();
    await editor.fill('mobile\nline');
    await annaScreenshot.bind(anna)({ path: '/tmp/gchat-message-editing-mobile.png' });
    await editor.press('Enter');
    await expect(editor).toHaveValue('mobile\nline\n');
    await editor.press('Escape');
    const touchMessage = annaLocator17.bind(anna)('article').last();

    await touchMessage.scrollIntoViewIfNeeded();
    await touchMessage.dispatchEvent('pointerdown', {
      pointerType: 'touch',
      clientX: 150,
      clientY: 300,
    });
    await expect(menu).toBeVisible();
    await touchMessage.dispatchEvent('pointerup', { pointerType: 'touch' });
    await annaScreenshot.bind(anna)({ path: '/tmp/gchat-message-menu-mobile.png' });
    const touchMenuBox = await menu.boundingBox();
    const { x: touchMenuBoxX5, width: touchMenuBoxWidth6 } = touchMenuBox!;

    expect(touchMenuBoxX5).toBeGreaterThanOrEqual(0);
    expect(touchMenuBoxX5 + touchMenuBoxWidth6).toBeLessThanOrEqual(390);
    await menu.press('Escape');
    expect(
      await annaLocator17
        .bind(anna)('body')
        .evaluate((element): boolean => element.scrollWidth <= innerWidth),
    ).toBe(true);
  } finally {
    await aClose37.bind(a)();
    await bClose38.bind(b)();
  }
});

test('Shift+Enter sends and saves edits at desktop and narrow widths without IME or repeat submissions', async ({
  page,
}): Promise<void> => {
  await login(page, 'anna');
  await page.getByRole('button', { name: 'Написать: Максим Волков', exact: true }).click();
  const input = page.getByLabel('Сообщение', { exact: true });

  await expect(input).toBeVisible();
  const requests = { send: 0, edit: 0 };

  page.on('request', (request): void => {
    if (
      /\/api\/dialogs\/[^/]+\/messages$/.test(new URL(request.url()).pathname) &&
      request.method() === 'POST'
    ) {
      requests.send++;
    }

    if (
      /\/api\/dialogs\/[^/]+\/messages\/[^/]+$/.test(new URL(request.url()).pathname) &&
      request.method() === 'PATCH'
    ) {
      requests.edit++;
    }
  });

  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 844 });
    const text = 'Shift+Enter ' + width + ' ' + randomUUID();

    await input.fill(text);

    for (const state of [
      { isComposing: true },
      { keyCode: 229 },
      { repeat: true },
      { ctrlKey: true },
      { altKey: true },
      { metaKey: true },
    ]) {
      await input.dispatchEvent('keydown', { key: 'Enter', shiftKey: true, ...state });
    }

    await expect(input).toHaveValue(text);
    const sentBefore = requests.send;
    const [sent] = await Promise.all([
      page.waitForResponse(
        (response): boolean =>
          response.request().method() === 'POST' &&
          /\/api\/dialogs\/[^/]+\/messages$/.test(new URL(response.url()).pathname),
      ),
      input.press('Shift+Enter'),
    ]);

    expect(sent.status()).toBe(201);
    await expect(input).toHaveValue('');
    const { message: sentMessage } = await sent.json();

    expect(sentMessage).toMatchObject({ content: { kind: 'text', text } });
    expect(requests.send).toBe(sentBefore + 1);
    await expect(input).toBeEnabled();
    await input.press('ArrowUp');
    const editor = page.getByLabel('Текст сообщения', { exact: true });

    await expect(editor).toHaveValue(text);
    const updated = text + ' исправлено';

    await editor.fill(updated);
    const editedBefore = requests.edit;

    for (const state of [
      { isComposing: true },
      { keyCode: 229 },
      { repeat: true },
      { ctrlKey: true },
      { altKey: true },
      { metaKey: true },
    ]) {
      await editor.dispatchEvent('keydown', { key: 'Enter', shiftKey: true, ...state });
    }

    await expect(editor).toHaveValue(updated);
    expect(requests.edit).toBe(editedBefore);
    const [saved] = await Promise.all([
      page.waitForResponse(
        (response): boolean =>
          response.request().method() === 'PATCH' &&
          /\/api\/dialogs\/[^/]+\/messages\/[^/]+$/.test(new URL(response.url()).pathname),
      ),
      editor.press('Shift+Enter'),
    ]);

    expect(saved.status()).toBe(200);
    await expect(editor).toHaveCount(0);
    await expect(input).toBeVisible();
    const { message: savedMessage } = await saved.json();

    expect(savedMessage).toMatchObject({ content: { kind: 'text', text: updated } });
    expect(requests.edit).toBe(editedBefore + 1);
  }
});

test('local sends keep input focus and smoothly follow the tail before the HTTP response', async ({
  page,
}): Promise<void> => {
  await login(page, 'anna');
  await page.getByRole('button', { name: 'Написать: Максим Волков', exact: true }).click();
  const input = page.getByLabel('Сообщение', { exact: true });
  const feed = page.getByRole('log', { name: 'Сообщения', exact: true });

  await expect(input).toBeVisible();

  for (const scenario of [
    { width: 1280, click: false, reduced: false },
    { width: 390, click: true, reduced: false },
    { width: 390, click: false, reduced: true },
  ]) {
    await page.setViewportSize({ width: scenario.width, height: 844 });
    await page.emulateMedia({ reducedMotion: scenario.reduced ? 'reduce' : 'no-preference' });
    await expect
      .poll(async (): Promise<number> =>
        feed.evaluate(
          (element): number => element.scrollHeight - element.clientHeight - element.scrollTop,
        ),
      )
      .toBeLessThanOrEqual(1);
    // Allow virtua's 150 ms measurement window to settle after resizing the viewport.
    await page.waitForTimeout(200);
    await feed.hover();
    await page.mouse.wheel(0, -550);
    await expect
      .poll(async (): Promise<number> =>
        feed.evaluate(
          (element): number => element.scrollHeight - element.clientHeight - element.scrollTop,
        ),
      )
      .toBeGreaterThan(200);
    const text = 'Фокус и прокрутка ' + randomUUID() + '\n' + 'Строка сообщения\n'.repeat(7);

    await input.fill(text);
    await page.evaluate((): void => {
      const field = document.querySelector<HTMLTextAreaElement>('.dialog-composer textarea')!;
      const log = document.querySelector<HTMLElement>('.dialog-feed')!;
      const state = { start: log.scrollTop, frames: [] as number[], blurs: 0, stopped: false };
      const blur = (): void => {
        state.blurs++;
      };

      field.addEventListener('blur', blur);
      const sample = (): void => {
        if (state.stopped) {
          return;
        }

        state.frames.push(log.scrollTop);
        requestAnimationFrame(sample);
      };

      requestAnimationFrame(sample);
      (window as any).__gchatSendProbe = {
        state,
        stop: (): void => {
          state.stopped = true;
          field.removeEventListener('blur', blur);
        },
      };
    });
    let release = (): void => {};
    const held = new Promise<void>((resolve): void => {
      release = resolve;
    });
    let requested = false;
    const pattern = '**/api/dialogs/*/messages';

    await page.route(pattern, async (route): Promise<void> => {
      if (route.request().method() === 'POST') {
        requested = true;
        await held;
      }

      await route.continue();
    });
    const response = page.waitForResponse(
      (value): boolean =>
        value.request().method() === 'POST' &&
        /\/api\/dialogs\/[^/]+\/messages$/.test(new URL(value.url()).pathname),
    );

    try {
      if (scenario.click) {
        await page.getByRole('button', { name: 'Отправить сообщение', exact: true }).click();
      } else {
        await input.press('Shift+Enter');
      }

      await expect.poll((): boolean => requested).toBe(true);
      await expect(input).toBeFocused();
      await expect(input).toHaveAttribute('readonly', '');
      await expect
        .poll(async (): Promise<number> =>
          feed.evaluate(
            (element): number => element.scrollHeight - element.clientHeight - element.scrollTop,
          ),
        )
        .toBeLessThanOrEqual(1);
      const { start, frames, blurs } = await page.evaluate(
        (): { start: number; frames: number[]; blurs: number } =>
          (window as any).__gchatSendProbe.state,
      );

      expect(blurs).toBe(0);

      if (!scenario.reduced) {
        const end = await feed.evaluate((element): number => element.scrollTop);

        expect(
          new Set(
            frames
              .filter((offset): boolean => offset > start + 2 && offset < end - 2)
              .map((offset): number => Math.round(offset)),
          ).size,
        ).toBeGreaterThan(2);
      }

      if (scenario.reduced) {
        await page.getByRole('link', { name: 'Назад к диалогам', exact: true }).focus();
      }

      release();
      const saved = await response;
      const { status } = saved;

      expect(status.bind(saved)()).toBe(201);
      await expect(input).not.toHaveAttribute('readonly', '');
      await expect(input).toHaveValue('');

      if (scenario.reduced) {
        await expect(
          page.getByRole('link', { name: 'Назад к диалогам', exact: true }),
        ).toBeFocused();
      } else {
        await expect(input).toBeFocused();
      }

      await expect
        .poll(async (): Promise<number> =>
          feed.evaluate(
            (element): number => element.scrollHeight - element.clientHeight - element.scrollTop,
          ),
        )
        .toBeLessThanOrEqual(1);
    } finally {
      release();

      if (requested) {
        try {
          await response;
        } catch {
          /* The page may already have closed after a test failure. */
        }
      }

      await page.unroute(pattern);
      await page.evaluate((): void => (window as any).__gchatSendProbe.stop());
    }
  }
});

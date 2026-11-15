import { randomUUID } from 'node:crypto';

import {
  type Browser,
  type BrowserContext,
  expect,
  type Locator,
  type Page,
  test,
} from '@playwright/test';

import { login } from '../../fixtures/web/actions';

async function withPeers(
  browser: Browser,
  work: (anna: Page, maxim: Page, reader: Page) => Promise<void>,
  mobile = false,
): Promise<void> {
  const contexts: BrowserContext[] = [];
  const pages: Page[] = [];

  try {
    for (let index = 0; index < 3; index++) {
      const context = await browser.newContext(
        mobile && index === 1
          ? { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true }
          : {},
      );
      const { newPage } = context;

      contexts.push(context);
      pages.push(await newPage.call(context));
    }

    await work(pages[0], pages[1], pages[2]);
  } finally {
    await Promise.all(
      contexts.map(async (context): Promise<void> => {
        const { close } = context;

        await close.call(context);
      }),
    );
  }
}

function bubble(page: Page, text: string): Locator {
  return page
    .locator('article')
    .filter({ has: page.locator('.dialog-message-text').filter({ hasText: text }) });
}
async function send(page: Page, text: string): Promise<void> {
  await page.getByLabel('Сообщение', { exact: true }).fill(text);
  await page.getByLabel('Сообщение', { exact: true }).press('Shift+Enter');
  await expect(bubble(page, text)).toBeVisible();
}
async function answer(page: Page, source: string): Promise<void> {
  await bubble(page, source).click({ button: 'right' });
  await page.getByRole('menu').getByRole('menuitem', { name: 'Ответить', exact: true }).click();
  await expect(page.getByLabel('Ответ на сообщение', { exact: true })).toContainText(source);
}
async function edit(page: Page, source: string, text: string): Promise<void> {
  await bubble(page, source).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Редактировать', exact: true }).click();
  await page.getByLabel('Текст сообщения', { exact: true }).fill(text);
  await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await expect(bubble(page, text)).toBeVisible();
}

test('replies preserve drafts, show a frozen quote to both peers and resolve a lost response once', async ({
  browser,
}) =>
  withPeers(
    browser,
    async (anna, maxim) => {
      const marker = 'reply-' + randomUUID();
      const source = marker + '-source';
      const response = marker + '-answer';

      await login(anna, 'anna');
      await login(maxim, 'maxim');
      await anna.getByRole('button', { name: 'Написать: Максим Волков', exact: true }).click();
      await send(anna, source);
      const path = new URL(anna.url()).pathname;

      await maxim.goto(path);
      await expect(bubble(maxim, source)).toBeVisible();
      await maxim.getByLabel('Сообщение', { exact: true }).fill(response);
      await answer(maxim, source);
      await expect(maxim.getByLabel('Сообщение', { exact: true })).toHaveValue(response);
      await maxim.reload();
      await expect(maxim.getByLabel('Ответ на сообщение', { exact: true })).toContainText(source);
      await expect(maxim.getByLabel('Сообщение', { exact: true })).toHaveValue(response);
      await maxim.getByRole('button', { name: 'Отменить ответ', exact: true }).click();
      await expect(maxim.getByLabel('Сообщение', { exact: true })).toHaveValue(response);
      await answer(maxim, source);
      let posts = 0;

      await maxim.route('**/api/dialogs/*/messages', async (route) => {
        if (
          route.request().method() === 'POST' &&
          route.request().postDataJSON().content?.text === response
        ) {
          posts++;

          if (posts === 1) {
            await route.fetch();
            await route.abort();

            return;
          }
        }

        await route.continue();
      });
      await maxim.getByLabel('Сообщение', { exact: true }).press('Shift+Enter');
      const replied = bubble(maxim, response);
      // Either WS has already reconciled the commit, or the user resolves the unknown send.
      const retry = replied.getByRole('button', { name: 'Повторить', exact: true });

      await expect
        .poll(
          async () =>
            (await retry.count()) > 0 || (await replied.locator('.dialog-status').count()) > 0,
        )
        .toBe(true);

      if (await retry.isVisible()) {
        await retry.click();
      }

      await expect(replied).toHaveCount(1);
      await expect(
        replied.getByRole('button', { name: 'Перейти к исходному сообщению' }),
      ).toContainText(source);
      await expect(
        bubble(anna, response).getByRole('button', { name: 'Перейти к исходному сообщению' }),
      ).toContainText(source);
      await maxim.reload();
      await expect(bubble(maxim, response)).toHaveCount(1);
      expect(posts).toBe(1);
      await edit(anna, source, source + '-changed');
      await maxim.reload();
      await expect(
        bubble(maxim, response).getByRole('button', { name: 'Перейти к исходному сообщению' }),
      ).toContainText(source);
      await expect(
        bubble(maxim, response).getByRole('button', { name: 'Перейти к исходному сообщению' }),
      ).not.toContainText('-changed');
      await bubble(maxim, response)
        .getByRole('button', { name: 'Перейти к исходному сообщению' })
        .click();
      await expect(bubble(maxim, source + '-changed')).toHaveClass(/reply-target/);
      await expect(bubble(maxim, source + '-changed')).toBeFocused();
    },
    true,
  ));

test('a source edited during send requires explicit confirmation of the refreshed quote', async ({
  browser,
}) =>
  withPeers(browser, async (anna, maxim) => {
    const marker = 'reply-conflict-' + randomUUID();
    const source = marker + '-source';
    const response = marker + '-answer';

    await login(anna, 'anna');
    await login(maxim, 'maxim');
    await anna.getByRole('button', { name: 'Написать: Максим Волков', exact: true }).click();
    await send(anna, source);
    await maxim.goto(new URL(anna.url()).pathname);
    await answer(maxim, source);
    let changed = false;

    await maxim.route('**/api/dialogs/*/messages', async (route) => {
      if (
        !changed &&
        route.request().method() === 'POST' &&
        route.request().postDataJSON().content?.text === response
      ) {
        changed = true;
        await edit(anna, source, source + '-new');
      }

      await route.continue();
    });
    await send(maxim, response);
    await bubble(maxim, response)
      .getByRole('button', { name: 'Обновить цитату и повторить' })
      .click();
    const dialog = maxim.getByRole('dialog', { name: 'Исходное сообщение изменилось' });

    await expect(dialog).toContainText(source + '-new');
    await dialog.getByRole('button', { name: 'Отправить с обновлённой цитатой' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(bubble(maxim, response)).toHaveCount(1);
    await expect(
      bubble(maxim, response).getByRole('button', { name: 'Перейти к исходному сообщению' }),
    ).toContainText(source + '-new');
    await maxim.reload();
    await expect(bubble(maxim, response)).toHaveCount(1);
  }));

test('a quote loads a source outside the initial history window', async ({ browser }) =>
  withPeers(browser, async (anna, maxim, reader) => {
    const marker = 'reply-far-' + randomUUID();
    const source = marker + '-source';
    const response = marker + '-answer';

    await login(anna, 'anna');
    await anna.getByRole('button', { name: 'Написать: Максим Волков', exact: true }).click();
    await send(anna, source);
    await answer(anna, source);
    const path = new URL(anna.url()).pathname;

    await login(maxim, 'maxim');
    await maxim.goto(path);

    for (let i = 0; i < 35; i++) {
      const text = marker + '-filler-' + i;

      const committed = maxim.waitForResponse(
        (response) =>
          response.request().method() === 'POST' &&
          response.url().endsWith('/messages') &&
          response.request().postDataJSON().content?.text === text,
      );

      await send(maxim, text);
      const persisted = await committed;
      const { status } = persisted;

      expect(status.call(persisted)).toBe(201);
      await maxim.waitForTimeout(300);
    }

    await send(anna, response);
    await login(reader, 'maxim');
    await reader.goto(path);
    await expect(bubble(reader, response)).toBeVisible();
    await expect(bubble(reader, source)).toHaveCount(0);
    await bubble(reader, response)
      .getByRole('button', { name: 'Перейти к исходному сообщению' })
      .click();
    await expect(bubble(reader, source)).toBeVisible();
    await expect(bubble(reader, source)).toHaveClass(/reply-target/);
  }));

test('sticker replies retain typed text and switching from a dirty edit requires confirmation', async ({
  browser,
}) =>
  withPeers(browser, async (anna) => {
    const marker = 'reply-sticker-' + randomUUID();

    await login(anna, 'anna');
    await anna.getByRole('button', { name: 'Написать: Максим Волков', exact: true }).click();
    await anna.getByRole('button', { name: 'Открыть стикеры' }).click();
    await anna
      .getByRole('button', { name: /Отправить стикер:/ })
      .first()
      .click();
    const sticker = anna.locator('article.sticker').last();

    await expect(
      sticker.locator('..').getByRole('button', { name: 'Действия сообщения', exact: true }),
    ).toHaveCount(1);
    await anna.getByLabel('Сообщение', { exact: true }).fill(marker);
    await sticker.click({ button: 'right' });
    await anna.getByRole('menuitem', { name: 'Ответить', exact: true }).click();
    await expect(anna.getByLabel('Ответ на сообщение', { exact: true })).toContainText('Стикер');
    await anna.getByRole('button', { name: 'Открыть стикеры' }).click();
    await anna
      .getByRole('button', { name: /Отправить стикер:/ })
      .first()
      .click();
    await expect(anna.getByLabel('Ответ на сообщение', { exact: true })).toHaveCount(0);
    await expect(anna.getByLabel('Сообщение', { exact: true })).toHaveValue(marker);
    await expect(
      anna
        .locator('article.sticker')
        .last()
        .getByRole('button', { name: 'Перейти к исходному сообщению' }),
    ).toContainText('Стикер');
    await send(anna, marker);
    await anna.getByLabel('Сообщение', { exact: true }).fill(marker + '-draft');
    await bubble(anna, marker).click({ button: 'right' });
    await anna.getByRole('menuitem', { name: 'Редактировать', exact: true }).click();
    await anna.getByLabel('Текст сообщения', { exact: true }).fill(marker + '-unsaved-edit');
    await bubble(anna, marker).click({ button: 'right' });
    await anna.getByRole('menuitem', { name: 'Ответить', exact: true }).click();
    const confirm = anna.getByRole('dialog', { name: 'Отменить редактирование и ответить?' });

    await confirm.getByRole('button', { name: 'Продолжить редактирование' }).click();
    await expect(anna.getByLabel('Текст сообщения', { exact: true })).toHaveValue(
      marker + '-unsaved-edit',
    );
    await bubble(anna, marker).click({ button: 'right' });
    await anna.getByRole('menuitem', { name: 'Ответить', exact: true }).click();
    await confirm.getByRole('button', { name: 'Ответить', exact: true }).click();
    await expect(anna.getByLabel('Редактирование сообщения', { exact: true })).toHaveCount(0);
    await expect(anna.getByLabel('Сообщение', { exact: true })).toHaveValue(marker + '-draft');
    await expect(anna.getByLabel('Ответ на сообщение', { exact: true })).toContainText(marker);
  }));

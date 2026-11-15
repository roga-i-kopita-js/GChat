import { randomUUID } from 'node:crypto';

import { expect, test } from '@playwright/test';

import { login } from '../../fixtures/web/actions';

test.use({ actionTimeout: 15000 });

test('message actions copy exact text and links, merge reactions and recover one forwarded snapshot', async ({
  browser,
}) => {
  const a = await browser.newContext();
  const { newPage: aNewPage1 } = a;

  const { setOffline: aSetOffline47 } = a;

  const { setOffline: aSetOffline50 } = a;

  const { close: aClose53 } = a;

  const b = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  });
  const { newPage: bNewPage2 } = b;

  const { close: bClose54 } = b;

  const c = await browser.newContext();
  const { newPage: cNewPage3 } = c;

  const { close: cClose55 } = c;

  const anna = await aNewPage1.bind(a)();
  const { getByRole: annaGetByRole1 } = anna;

  const { getByLabel: annaGetByLabel2 } = anna;

  const { getByLabel: annaGetByLabel3 } = anna;

  const { getByRole: annaGetByRole6 } = anna;

  const { getByLabel: annaGetByLabel7 } = anna;

  const { getByRole: annaGetByRole8 } = anna;

  const { locator: annaLocator9 } = anna;

  const { url: annaUrl7 } = anna;

  const { locator: annaLocator24 } = anna;

  const { reload: annaReload51 } = anna;

  const maxim = await bNewPage2.bind(b)();
  const { locator: maximLocator4 } = maxim;

  const { locator: maximLocator5 } = maxim;

  const { goto: maximGoto8 } = maxim;

  const { locator: maximLocator9 } = maxim;

  const { evaluate: maximEvaluate11 } = maxim;

  const { getByRole: maximGetByRole12 } = maxim;

  const { route: maximRoute28 } = maxim;

  const { getByRole: maximGetByRole30 } = maxim;

  const elena = await cNewPage3.bind(c)();
  const { evaluate: elenaEvaluate150 } = elena;

  const { goto: elenaGoto37 } = elena;

  const { locator: elenaLocator38 } = elena;

  const marker = 'actions-' + randomUUID();
  const text = marker + '\nhttps://example.org/a(b) https://example.net/path?q=1#x';

  try {
    await login(anna, 'anna');
    await login(maxim, 'maxim');
    await login(elena, 'elena');
    const elenaName = await elenaEvaluate150.bind(elena)((): string => {
      const token = JSON.parse(localStorage.getItem('gchat.session.v1')!).access_token;
      const payload = token.split('.')[1].replaceAll('-', '+').replaceAll('_', '/');

      return JSON.parse(
        new TextDecoder().decode(Uint8Array.from(atob(payload), (c) => c.charCodeAt(0))),
      ).display_name;
    });

    await annaGetByRole1
      .bind(anna)('button', {
        name: 'Написать: Максим Волков',
        exact: true,
      })
      .click();

    await annaGetByLabel2.bind(anna)('Сообщение', { exact: true }).fill(text);

    await annaGetByLabel3.bind(anna)('Сообщение', { exact: true }).press('Shift+Enter');
    const sourcePath = new URL(annaUrl7.bind(anna)()).pathname;

    await maximGoto8.bind(maxim)(sourcePath);
    const source = maximLocator9.bind(maxim)('article').filter({ hasText: marker });

    await expect(source).toBeVisible();
    await maximEvaluate11.bind(maxim)(() => {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          writeText: async (value: string) => {
            document.body.dataset.copied = value;
          },
        },
      });
    });
    await source.click({ button: 'right' });
    const menu = maximGetByRole12.bind(maxim)('menu', { name: 'Действия сообщения' });

    await menu.getByRole('menuitem', { name: 'Копировать текст', exact: true }).click();

    await expect(maximLocator4.bind(maxim)('body')).toHaveAttribute('data-copied', text);

    await expect(menu).toHaveCount(0);
    await source.click({ button: 'right' });

    await menu
      .getByRole('menuitem', {
        name: 'Копировать ссылку',
        exact: true,
      })
      .click();

    await menu
      .getByRole('menuitem', {
        name: 'https://example.org/a(b)',
        exact: true,
      })
      .click();

    await expect(maximLocator5.bind(maxim)('body')).toHaveAttribute(
      'data-copied',
      'https://example.org/a(b)',
    );
    await expect(menu).toHaveCount(0);
    await maximEvaluate11.bind(maxim)(() => {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          writeText: async () => {
            throw new DOMException('Denied', 'NotAllowedError');
          },
        },
      });
    });
    await source.click({ button: 'right' });

    await menu.getByRole('menuitem', { name: 'Копировать текст', exact: true }).click();
    const fallback = menu.getByRole('textbox', { name: 'Текст для копирования', exact: true });

    await expect(fallback).toHaveValue(text);

    await expect(fallback).toBeFocused();
    await fallback.press('Escape');
    await menu.press('Escape');
    await source.click({ button: 'right' });

    await menu.getByRole('button', { name: 'Реакция: Нравится', exact: true }).click();

    await expect(menu).toHaveCount(0);
    await source.click({ button: 'right' });

    await expect(
      menu.getByRole('button', { name: 'Реакция: Нравится', exact: true }),
    ).toHaveAttribute('aria-pressed', 'true');

    await menu.getByRole('button', { name: 'Реакция: Сердце', exact: true }).click();

    await expect(menu).toHaveCount(0);
    await source.click({ button: 'right' });

    await expect(
      menu.getByRole('button', { name: 'Реакция: Сердце', exact: true }),
    ).toHaveAttribute('aria-pressed', 'true');

    await menu.getByRole('menuitem', { name: 'Все реакции', exact: true }).click();

    await expect(menu.getByRole('button', { name: /^Реакция:/ })).toHaveCount(73);
    const firstEmoji = menu.getByRole('button', { name: 'Реакция: Нравится', exact: true });

    await expect(firstEmoji).toBeFocused();
    await firstEmoji.press('ArrowRight');

    await expect(
      menu.getByRole('button', { name: 'Реакция: Не нравится', exact: true }),
    ).toBeFocused();

    await menu.getByRole('button', { name: 'Реакция: Не нравится', exact: true }).press('End');

    await expect(
      menu.getByRole('button', { name: 'Реакция: Аплодисменты', exact: true }),
    ).toBeFocused();

    await menu.press('Escape');
    await menu.press('Escape');
    const annaSource = annaLocator24.bind(anna)('article').filter({ hasText: marker });

    await expect(
      annaSource.getByRole('button', { name: 'Реакция: Нравится, 1', exact: true }),
    ).toBeVisible();

    await source
      .getByRole('button', {
        name: 'Реакция: Нравится, 1',
        exact: true,
      })
      .click();

    await expect(
      source.getByRole('button', { name: 'Реакция: Нравится, 1', exact: true }),
    ).toHaveCount(0);
    let forwardPosts = 0;

    await maximRoute28.bind(maxim)('**/api/dialogs/*/forwards', async (route) => {
      forwardPosts++;
      await route.fetch();
      await route.abort('failed');
    });
    await source.click({ button: 'right' });

    await menu.getByRole('menuitem', { name: 'Переслать', exact: true }).click();
    const forward = maximGetByRole30.bind(maxim)('dialog', {
      name: 'Переслать сообщение',
      exact: true,
    });

    await forward.getByRole('button', { name: elenaName, exact: true }).click();

    await forward.getByRole('button', { name: 'Переслать', exact: true }).click();

    await expect(
      forward.getByRole('button', { name: 'Проверить и повторить', exact: true }),
    ).toBeVisible();

    await forward
      .getByRole('button', {
        name: 'Проверить и повторить',
        exact: true,
      })
      .click();

    await expect(forward.getByRole('status')).toContainText('Переслано: ' + elenaName);
    expect(forwardPosts).toBe(1);

    const targetPath = await forward
      .getByRole('link', { name: 'Открыть диалог', exact: true })
      .getAttribute('href');

    await forward.getByRole('button', { name: 'Закрыть', exact: true }).click();
    await elenaGoto37.bind(elena)(targetPath!);
    const copy = elenaLocator38.bind(elena)('article').filter({ hasText: marker });

    await expect(copy).toHaveCount(1);

    await expect(copy.locator('.dialog-forward-label')).toHaveText('Переслано от Анна Смирнова');

    await expect(copy.locator('.dialog-message-reactions')).toHaveCount(0);

    await annaSource.click({ button: 'right' });

    await annaGetByRole6.bind(anna)('menuitem', { name: 'Редактировать', exact: true }).click();

    await annaGetByLabel7
      .bind(anna)('Текст сообщения', { exact: true })
      .fill(marker + '-edited');

    await annaGetByRole8.bind(anna)('button', { name: 'Сохранить', exact: true }).click();

    await expect(annaGetByLabel7.bind(anna)('Текст сообщения', { exact: true })).toHaveCount(0);
    await expect(source.locator('.dialog-message-text')).toHaveText(marker + '-edited');
    await expect(copy.locator('.dialog-message-text')).toHaveText(text);
    await aSetOffline47.bind(a)(true);

    await source
      .getByRole('button', {
        name: 'Реакция: Сердце, 1',
        exact: true,
      })
      .click();

    await expect(source.locator('.dialog-message-reactions')).toHaveCount(0);
    await aSetOffline50.bind(a)(false);
    await annaReload51.bind(anna)();
    await expect(
      annaLocator9
        .bind(anna)('article')
        .filter({ hasText: marker + '-edited' }),
    ).toBeVisible();

    await expect(
      annaLocator9
        .bind(anna)('article')
        .filter({ hasText: marker + '-edited' })
        .locator('.dialog-message-reactions'),
    ).toHaveCount(0);
  } finally {
    await Promise.allSettled([aClose53.bind(a)(), bClose54.bind(b)(), cClose55.bind(c)()]);
  }
});

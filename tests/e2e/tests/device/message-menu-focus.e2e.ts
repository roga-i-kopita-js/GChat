import { expect, type Page, test } from '@playwright/test';

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

async function openExample(page: Page, query = 'message=text', open = true): Promise<void> {
  await page.goto('/tests/device-harness.html?' + query);
  await page.evaluate(async () => {
    const viewport = document.createElement('meta');

    viewport.name = 'viewport';
    viewport.content = 'width=device-width, initial-scale=1';
    document.head.append(viewport);
    document.body.style.margin = '0';
    const path = '/tests/message-menu-harness.tsx';
    const { start } = await import(path);

    start();
  });

  if (open) {
    await page.locator('article').dispatchEvent('contextmenu');
    await expect(page.getByRole('menu', { name: 'Действия сообщения' })).toBeVisible();
  }
}

test('releasing a long press on the hidden source permits the next action tap', async ({
  page,
}) => {
  await openExample(page, 'message=text', false);
  const { x, y, width, height } = (await page.locator('article').boundingBox())!;
  const touch = await page.context().newCDPSession(page);
  const { send } = touch;

  await send.bind(touch)('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: x + width / 2, y: y + height / 2 }],
  });
  const menu = page.getByRole('menu');

  await expect(menu).toBeVisible();
  await expect(page.locator('article')).toBeHidden();
  await send.bind(touch)('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await expect(menu).toBeVisible();
  await menu.getByRole('menuitem', { name: 'Ответить', exact: true }).tap();
  await expect(page.getByRole('status')).toHaveText('Ответ открыт');
  await expect(menu).toHaveCount(0);
  await expect(page.locator('article')).toBeVisible();
});

test('focus preview keeps the existing palette and restores the source without moving the feed', async ({
  page,
}) => {
  for (const viewport of [
    { width: 320, height: 640 },
    { width: 360, height: 640 },
    { width: 390, height: 844 },
    { width: 430, height: 932 },
  ]) {
    await page.setViewportSize(viewport);
    await openExample(page, 'message=text&top');
    const menu = page.getByRole('menu');
    const source = page.locator('article');
    const preview = menu.getByRole('note', { name: 'Выбранное сообщение' });

    await expect(source).toBeHidden();
    await expect(preview).toBeVisible();
    await expect(menu.getByRole('menuitem')).toHaveText([
      '',
      'Ответить',
      'Копировать текст',
      'Переслать',
      'Редактировать',
      'Копировать ссылку',
    ]);
    const sourceBounds = await source.boundingBox();
    const { x, y, width, height } = (await menu.boundingBox())!;

    expect(x).toBeGreaterThanOrEqual(0);
    expect(y).toBeGreaterThanOrEqual(0);
    expect(x + width).toBeLessThanOrEqual(viewport.width);
    expect(y + height).toBeLessThanOrEqual(viewport.height);
    const { preview: previewColor, original: sourceColor } = await preview.evaluate((element) => ({
      preview: getComputedStyle(element).backgroundColor,
      original: getComputedStyle(document.querySelector('article')!).backgroundColor,
    }));

    expect(previewColor).toBe(sourceColor);
    const { bodyFont, commandFont, cardRadius, sharedRadius } = await menu.evaluate((element) => ({
      bodyFont: getComputedStyle(document.body).fontSize,
      commandFont: getComputedStyle(element.querySelector('.dialog-message-menu-actions button')!)
        .fontSize,
      cardRadius: getComputedStyle(element.querySelector('.dialog-message-menu-body')!)
        .borderRadius,
      sharedRadius: getComputedStyle(element).getPropertyValue('--ui-radius').trim(),
    }));

    expect(commandFont).toBe(bodyFont);
    expect(cardRadius).toBe(sharedRadius);
    const {
      x: feedX,
      y: feedY,
      width: feedWidth,
      height: feedHeight,
    } = (await page.getByLabel('Лента', { exact: true }).boundingBox())!;
    const {
      x: shadeX,
      y: shadeY,
      width: shadeWidth,
      height: shadeHeight,
    } = (await menu.locator('.dialog-message-menu-shade').boundingBox())!;

    expect(shadeX).toBe(feedX);
    expect(shadeY).toBe(feedY);
    expect(shadeWidth).toBe(feedWidth);
    expect(shadeHeight).toBe(feedHeight);
    expect(y).toBeGreaterThanOrEqual(feedY);
    expect(y + height).toBeLessThanOrEqual(feedY + feedHeight);

    for (const button of await menu.getByRole('button').all()) {
      const {
        x: buttonX,
        width: buttonWidth,
        height: buttonHeight,
      } = (await button.boundingBox())!;

      expect(buttonWidth).toBeGreaterThanOrEqual(44);
      expect(buttonHeight).toBeGreaterThanOrEqual(44);
      expect(buttonX + buttonWidth).toBeLessThanOrEqual(viewport.width);
    }

    await menu.press('Escape');
    await expect(source).toBeVisible();
    await expect(source).toBeFocused();
    expect(await source.boundingBox()).toEqual(sourceBounds);
  }
});

test('catalog keeps its height and keyboard return, closing after each reaction selection', async ({
  page,
}, testInfo) => {
  await openExample(page);
  const menu = page.getByRole('menu');
  const { height: collapsedHeight } = (await menu.boundingBox())!;
  const { y: previewY } = (await menu.getByRole('note').boundingBox())!;

  await page.screenshot({ path: testInfo.outputPath('focused-menu-390.png') });

  await menu.getByRole('menuitem', { name: 'Все реакции', exact: true }).click();
  await expect(menu.getByRole('menuitem', { name: 'Копировать текст', exact: true })).toHaveCount(
    0,
  );
  await expect(menu.getByRole('button', { name: /^Реакция:/ })).toHaveCount(73);
  await expect
    .poll(async () => {
      const { height } = (await menu.boundingBox())!;

      return height;
    })
    .toBeLessThanOrEqual(collapsedHeight + 1);
  const { y: expandedPreviewY } = (await menu.getByRole('note').boundingBox())!;

  expect(expandedPreviewY).toBeCloseTo(previewY, 0);
  await page.screenshot({ path: testInfo.outputPath('reaction-catalog-390.png') });
  const like = menu.getByRole('button', { name: 'Реакция: Нравится', exact: true });
  const heart = menu.getByRole('button', { name: 'Реакция: Сердце', exact: true });

  await expect(like).toBeFocused();
  await like.press('ArrowRight');
  await expect(
    menu.getByRole('button', { name: 'Реакция: Не нравится', exact: true }),
  ).toBeFocused();
  await page.keyboard.press('End');
  await expect(
    menu.getByRole('button', { name: 'Реакция: Аплодисменты', exact: true }),
  ).toBeFocused();
  await menu.press('Escape');
  await expect(menu.getByRole('menuitem', { name: 'Все реакции', exact: true })).toBeFocused();
  await menu.getByRole('menuitem', { name: 'Все реакции', exact: true }).click();
  await like.click();
  await expect(menu).toHaveCount(0);
  await expect(page.locator('article')).toBeFocused();
  await page.locator('article').press('Shift+F10');
  await menu.getByRole('menuitem', { name: 'Все реакции', exact: true }).click();
  await expect(like).toHaveAttribute('aria-pressed', 'true');
  await heart.click();
  await expect(menu).toHaveCount(0);
  await page.locator('article').press('Shift+F10');
  await menu.getByRole('menuitem', { name: 'Все реакции', exact: true }).click();
  await expect(like).toHaveAttribute('aria-pressed', 'true');
  await expect(heart).toHaveAttribute('aria-pressed', 'true');
  await heart.click();
  await expect(menu).toHaveCount(0);
  await page.locator('article').press('Shift+F10');
  await menu.getByRole('menuitem', { name: 'Все реакции', exact: true }).click();
  await expect(heart).toHaveAttribute('aria-pressed', 'false');
  await menu.getByRole('menuitem', { name: 'Готово', exact: true }).click();
  await expect(menu).toHaveCount(0);
  await expect(page.locator('article')).toBeFocused();
});

test('quick reactions close after success and remain open on failure', async ({ page }) => {
  await openExample(page);
  await page.getByRole('button', { name: 'Реакция: Нравится', exact: true }).click();
  await expect(page.getByRole('menu')).toHaveCount(0);
  await expect(page.locator('article')).toBeVisible();
  await openExample(page, 'message=text&reaction-error');
  await page.getByRole('button', { name: 'Реакция: Нравится', exact: true }).click();
  await expect(page.getByRole('menu')).toBeVisible();
  await expect(page.getByRole('alert')).toHaveText('Не удалось изменить реакцию');
  await expect(
    page.getByRole('button', { name: 'Реакция: Нравится', exact: true }),
  ).toHaveAttribute('aria-pressed', 'false');
  await page.getByRole('menuitem', { name: 'Все реакции', exact: true }).click();
  await page.getByRole('button', { name: 'Реакция: Нравится', exact: true }).click();
  await expect(page.getByRole('menu')).toBeVisible();
  await expect(page.getByRole('alert')).toHaveText('Не удалось изменить реакцию');
});

test('copy closes with feedback; multiple links and clipboard failure keep their dedicated flow', async ({
  page,
}) => {
  await openExample(page);
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          document.body.dataset.copied = text;
        },
      },
    });
  });
  const text = 'Встречаемся завтра в 18:00?\nhttps://example.org/meet https://example.net/info';

  await page.getByRole('menuitem', { name: 'Копировать текст', exact: true }).click();
  await expect(page.getByRole('menu')).toHaveCount(0);
  await expect(page.getByRole('status')).toHaveText('Скопировано');
  await expect(page.locator('body')).toHaveAttribute('data-copied', text);
  await expect(page.locator('article')).toBeFocused();
  await page.locator('article').press('Shift+F10');
  await page.getByRole('menuitem', { name: 'Копировать ссылку', exact: true }).click();
  await page.getByRole('menuitem', { name: 'https://example.net/info', exact: true }).click();
  await expect(page.getByRole('menu')).toHaveCount(0);
  await expect(page.locator('body')).toHaveAttribute('data-copied', 'https://example.net/info');
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async () => {
          throw new DOMException('Denied', 'NotAllowedError');
        },
      },
    });
  });
  await page.locator('article').press('Shift+F10');
  await page.getByRole('menuitem', { name: 'Копировать текст', exact: true }).click();
  const manual = page.getByRole('textbox', { name: 'Текст для копирования', exact: true });

  await expect(manual).toHaveValue(text);
  await expect(manual).toBeFocused();
  await expect(page.getByRole('alert')).toBeVisible();
  await manual.press('Escape');
  await page.getByRole('menu').press('Escape');
  await expect(page.locator('article')).toBeVisible();
});

test('sticker, forwarded, readonly and long messages keep a usable preview', async ({ page }) => {
  for (const query of [
    'message=sticker&peer',
    'message=forward',
    'message=text&readonly&peer',
    'message=long',
  ]) {
    await openExample(page, query);
    const menu = page.getByRole('menu');

    await expect(menu.getByRole('note')).toBeVisible();
    const { y, height } = (await menu.boundingBox())!;

    expect(y + height).toBeLessThanOrEqual(844);

    if (query.includes('sticker')) {
      await expect(menu.getByRole('img', { name: 'Стикер: Кот' })).toBeVisible();
      await expect(
        menu.getByRole('menuitem', { name: 'Копировать текст', exact: true }),
      ).toHaveCount(0);
    }

    if (query.includes('forward')) {
      await expect(menu.getByText('Переслано от Анна', { exact: true })).toBeVisible();
      await expect(menu.getByRole('menuitem', { name: 'Редактировать', exact: true })).toHaveCount(
        0,
      );
    }

    if (query.includes('readonly')) {
      await expect(menu.getByRole('button', { name: /^Реакция:/ })).toHaveCount(0);
      await expect(menu.getByRole('menuitem', { name: 'Ответить', exact: true })).toHaveCount(0);
      await expect(
        menu.getByRole('menuitem', { name: 'Копировать текст', exact: true }),
      ).toBeVisible();
    }

    if (query.includes('long')) {
      const { height: textHeight } = (await menu.locator('.dialog-message-text').boundingBox())!;

      expect(textHeight).toBeLessThanOrEqual(64);
    }

    await menu.press('Escape');
    await expect(page.locator('article')).toBeVisible();
  }
});

test.describe('desktop', () => {
  test.use({ viewport: { width: 1280, height: 800 }, hasTouch: false, isMobile: false });

  test('keyboard and visual viewport resize retain focus and a visible preview', async ({
    page,
  }) => {
    await openExample(page);
    await page.getByRole('menu').press('Escape');
    await page.locator('article').press('Shift+F10');
    await expect(page.getByRole('menuitem', { name: 'Ответить', exact: true })).toBeFocused();
    await page.setViewportSize({ width: 390, height: 400 });
    const menu = page.getByRole('menu');

    await expect(menu.getByRole('note')).toBeVisible();
    await expect
      .poll(async () => {
        const { y, height } = (await menu.boundingBox())!;

        return y + height;
      })
      .toBeLessThanOrEqual(400);
    await page.locator('article').evaluate((element) => element.remove());
    await page.setViewportSize({ width: 360, height: 500 });
    await expect(menu).toBeVisible();
    await menu.press('Escape');
    await expect(menu).toHaveCount(0);
  });
});

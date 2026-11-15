import { expect, test } from '@playwright/test';

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

test.beforeEach(async ({ page }): Promise<void> => {
  await page.goto('/tests/device-harness.html');
  await page.evaluate(async (): Promise<void> => {
    const path = '/tests/message-menu-harness.tsx';
    const { start } = await import(path);

    start();
  });
});

test('long press release leaves the action available for a subsequent tap', async ({
  page,
}): Promise<void> => {
  const button = page.getByRole('button', { name: 'Тестовое сообщение', exact: true });
  const { x, y, width, height } = (await button.boundingBox())!;

  const touch = await page.context().newCDPSession(page);
  const { send } = touch;

  await send.bind(touch)('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: x + width / 2, y: y + height / 2 }],
  });
  const menu = page.getByRole('menu', { name: 'Действия сообщения' });

  await expect(menu).toBeVisible();
  await send.bind(touch)('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  // Synchronize with the release's browser event processing before the next gesture.
  await page.evaluate(
    (): Promise<void> =>
      new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
  );

  await expect(menu).toBeVisible();

  await menu.getByRole('menuitem', { name: 'Редактировать' }).tap();

  await expect(page.getByText('Редактирование открыто', { exact: true })).toBeVisible();
});

test('viewport changes, focus changes and feed scrolling preserve the menu until an outside tap', async ({
  page,
}): Promise<void> => {
  const source = page.getByRole('button', { name: 'Тестовое сообщение', exact: true });
  const menu = page.getByRole('menu', { name: 'Действия сообщения' });

  await source.dispatchEvent('pointerdown', { pointerType: 'touch' });

  await expect(menu).toBeVisible();
  await page.evaluate((): void => {
    document.dispatchEvent(new Event('scroll'));
  });

  await expect(menu).toBeVisible();
  await page.setViewportSize({ width: 390, height: 600 });

  await expect(menu).toBeVisible();
  const { y, height } = (await menu.boundingBox())!;

  expect(y).toBeGreaterThanOrEqual(0);
  expect(y + height).toBeLessThanOrEqual(600);
  const operationTarget159 = page.getByLabel('Лента', { exact: true });

  await operationTarget159.dispatchEvent('wheel', { deltaY: 40 });

  await operationTarget159.evaluate((element): void => {
    element.scrollTop = 40;
  });

  await expect(menu).toBeVisible();
  await page.getByRole('textbox', { name: 'Черновик' }).focus();

  await expect(menu).toBeVisible();

  await page.getByRole('button', { name: 'Вне меню', exact: true }).tap();

  await expect(menu).toHaveCount(0);
});

test('menu opens above its button and repeated button taps keep it open', async ({
  page,
}): Promise<void> => {
  const source = page.getByRole('button', { name: 'Тестовое сообщение', exact: true });
  const menu = page.getByRole('menu', { name: 'Действия сообщения' });

  await source.tap();

  await expect(menu).toBeVisible();
  const { y: buttonY } = (await source.boundingBox())!;
  const { y: menuY, height: menuHeight } = (await menu.boundingBox())!;

  expect(menuY + menuHeight).toBeLessThan(buttonY);
  await source.tap();

  await expect(menu).toBeVisible();
  await page.getByRole('button', { name: 'Вне меню', exact: true }).tap();

  await expect(menu).toHaveCount(0);
});

test('only a completed outside tap dismisses the menu, not a drag or cancelled gesture', async ({
  page,
}): Promise<void> => {
  const source = page.getByRole('button', { name: 'Тестовое сообщение', exact: true });
  const menu = page.getByRole('menu', { name: 'Действия сообщения' });
  const outside = page.getByRole('button', { name: 'Вне меню', exact: true });
  const start = {
    pointerId: 7,
    pointerType: 'touch',
    isPrimary: true,
    button: 0,
    clientX: 20,
    clientY: 250,
  };

  await source.tap();
  await outside.dispatchEvent('pointerdown', start);

  await expect(menu).toBeVisible();
  await outside.dispatchEvent('pointermove', { ...start, clientY: 270 });
  await outside.dispatchEvent('pointerup', start);

  await expect(menu).toBeVisible();
  await outside.dispatchEvent('pointerdown', start);
  await outside.dispatchEvent('pointercancel', start);
  await outside.dispatchEvent('pointerup', start);

  await expect(menu).toBeVisible();
  await outside.dispatchEvent('pointerdown', start);

  await expect(menu).toBeVisible();
  await outside.dispatchEvent('pointerup', start);

  await expect(menu).toHaveCount(0);
});

test('manual popover keeps keyboard navigation and restores focus on Escape', async ({
  page,
}): Promise<void> => {
  const source = page.getByRole('button', { name: 'Тестовое сообщение', exact: true });
  const menu = page.getByRole('menu', { name: 'Действия сообщения' });

  await source.dispatchEvent('pointerdown', { pointerType: 'touch' });
  const edit = menu.getByRole('menuitem', { name: 'Редактировать' });

  await expect(edit).toBeFocused();
  await edit.press('ArrowDown');

  await expect(edit).toBeFocused();
  await edit.press('Tab');

  await expect(menu).toBeVisible();
  await edit.press('Escape');

  await expect(menu).toHaveCount(0);

  await expect(source).toBeFocused();
});

test('virtualizing the source out of the feed does not dismiss the menu', async ({
  page,
}): Promise<void> => {
  const source = page.getByRole('button', { name: 'Тестовое сообщение', exact: true });
  const menu = page.getByRole('menu', { name: 'Действия сообщения' });

  await source.tap();
  await source.evaluate((element): void => element.remove());
  await page.getByLabel('Лента', { exact: true }).dispatchEvent('scroll');
  await page.setViewportSize({ width: 390, height: 600 });

  await expect(menu).toBeVisible();
  await page.getByRole('button', { name: 'Вне меню', exact: true }).tap();

  await expect(menu).toHaveCount(0);
});

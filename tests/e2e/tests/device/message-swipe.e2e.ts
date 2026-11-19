import { expect, type Locator, type Page, test } from '@playwright/test';

import { setupDialogUi } from '../../fixtures/web/dialog-ui';

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

async function touch(
  page: Page,
  target: Locator,
): Promise<{
  move(dx: number, dy?: number): Promise<void>;
  finish(cancel?: boolean): Promise<void>;
}> {
  const { x, y, width, height } = (await target.boundingBox())!;
  const startX = Math.max(32, x + Math.min(width / 3, 28));
  const startY = y + height / 2;
  const session = await page.context().newCDPSession(page);
  const { send, detach } = session;

  await send.bind(session)('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: startX, y: startY }],
  });

  return {
    move: async (dx, dy = 0) => {
      await send.bind(session)('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [{ x: startX + dx, y: startY + dy }],
      });
    },
    finish: async (cancel = false) => {
      await send.bind(session)('Input.dispatchTouchEvent', {
        type: cancel ? 'touchCancel' : 'touchEnd',
        touchPoints: [],
      });
      await detach.bind(session)();
    },
  };
}

async function reset(target: Locator): Promise<void> {
  await expect
    .poll(() =>
      target.evaluate((element) => {
        const transform = getComputedStyle(element.parentElement!).transform;

        return transform === 'none' ? 0 : new DOMMatrix(transform).m41;
      }),
    )
    .toBe(0);
}

test('right swipe replies once, retains the draft and returns through CSS', async ({
  page,
}, testInfo) => {
  const { requests } = await setupDialogUi(page);
  const input = page.getByRole('textbox', { name: 'Сообщение', exact: true });
  const source = page
    .getByRole('log')
    .locator('article')
    .filter({ hasText: 'Встречаемся завтра в 18:00?' });

  await input.fill('Мой черновик');
  const { move, finish } = await touch(page, source);

  try {
    await move(16);
    await move(64);
    await expect(source.locator('..')).toHaveAttribute('data-swipe-ready', '');
    await expect(page.getByLabel('Ответ на сообщение', { exact: true })).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: testInfo.outputPath('swipe-ready.png') });
  } finally {
    await finish();
  }

  const quote = page.getByLabel('Ответ на сообщение', { exact: true });

  await expect(quote).toHaveCount(1);
  await expect(quote).toContainText('Встречаемся завтра в 18:00?');
  await expect(input).toHaveValue('Мой черновик');
  await expect(input).toBeFocused();
  await reset(source);
  await expect(source.locator('..')).not.toHaveAttribute('data-swiping');
  await expect(page.getByRole('menu')).toHaveCount(0);
  expect(requests()).toBe(0);
});

test('a slow right swipe tolerates small vertical drift and does not open the menu', async ({
  page,
}) => {
  await setupDialogUi(page);
  const source = page
    .getByRole('log')
    .locator('article')
    .filter({ hasText: 'Встречаемся завтра в 18:00?' });

  await expect(source).toBeVisible();
  const { move, finish } = await touch(page, source);

  try {
    for (let dx = 2; dx <= 64; dx += 2) {
      await move(dx, 2);
      await page.waitForTimeout(25);
    }

    await expect(source.locator('..')).toHaveAttribute('data-swipe-ready', '');
    await expect(page.getByRole('menu')).toHaveCount(0);
  } finally {
    await finish();
  }

  await expect(page.getByLabel('Ответ на сообщение', { exact: true })).toContainText(
    'Встречаемся завтра в 18:00?',
  );
  await reset(source);
  await expect(page.getByRole('menu')).toHaveCount(0);
});

test('short, leftward and cancelled swipes do not choose a reply', async ({ page }) => {
  await setupDialogUi(page);
  const source = page
    .getByRole('log')
    .locator('article')
    .filter({ hasText: 'Встречаемся завтра в 18:00?' });

  await expect(source).toBeVisible();

  for (const { dx, cancelled } of [
    { dx: 24, cancelled: false },
    { dx: -64, cancelled: false },
    { dx: 64, cancelled: true },
  ]) {
    const { move, finish } = await touch(page, source);

    await move(dx);
    await finish(cancelled);
    await reset(source);
    await expect(page.getByLabel('Ответ на сообщение', { exact: true })).toHaveCount(0);
    await expect(page.getByRole('menu')).toHaveCount(0);
  }
});

test('vertical movement scrolls the feed and cancels the menu timer', async ({ page }) => {
  await setupDialogUi(page);
  const source = page.getByRole('log').locator('article').filter({ hasText: 'Сообщение 15' });
  const feed = page.getByRole('log');

  await expect(source).toBeVisible();
  const before = await feed.evaluate((element) => element.scrollTop);
  const { move, finish } = await touch(page, source);

  await move(0, 30);
  await move(2, 60);
  await move(3, 100);
  await finish();
  await expect.poll(() => feed.evaluate((element) => element.scrollTop)).toBeLessThan(before);
  await expect(page.getByLabel('Ответ на сообщение', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('menu')).toHaveCount(0);
});

test('a stationary long press opens the normal menu and its release does not reply', async ({
  page,
}) => {
  await setupDialogUi(page);
  const source = page
    .getByRole('log')
    .locator('article')
    .filter({ hasText: 'Встречаемся завтра в 18:00?' });

  await expect(source).toBeVisible();
  await source.tap();
  const actions = source.locator('..').getByRole('button', { name: 'Действия сообщения' });

  await expect(actions).toHaveCount(1);
  expect(await actions.evaluate((node) => getComputedStyle(node).opacity)).toBe('0');
  expect(await actions.evaluate((node) => getComputedStyle(node).pointerEvents)).toBe('none');
  expect(await source.evaluate((node) => getComputedStyle(node).userSelect)).toBe('none');
  const { finish } = await touch(page, source);

  try {
    await expect(page.getByRole('menu')).toBeVisible();
  } finally {
    await finish();
  }

  await expect(page.getByRole('menu')).toBeVisible();
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe('');
  await expect(page.getByLabel('Ответ на сообщение', { exact: true })).toHaveCount(0);
  await page.getByRole('menu').press('Escape');
  await expect(source).toBeVisible();
});

test('readonly messages do not swipe', async ({ page }) => {
  await setupDialogUi(page, { canSend: false });
  const source = page
    .getByRole('log')
    .locator('article')
    .filter({ hasText: 'Встречаемся завтра в 18:00?' });

  await expect(source).toBeVisible();
  await expect(source.locator('..')).not.toHaveAttribute('data-swipe-enabled');
  const { move, finish } = await touch(page, source);

  await move(64);
  await finish();
  await reset(source);
  await expect(page.getByLabel('Ответ на сообщение', { exact: true })).toHaveCount(0);
});

test('interactive controls and selected text do not start the gesture', async ({ page }) => {
  await setupDialogUi(page, { reactions: 'single' });
  const source = page
    .getByRole('log')
    .locator('article')
    .filter({ hasText: 'Встречаемся завтра в 18:00?' });
  const reaction = source.getByRole('button', { name: 'Реакция: Огонь, 1', exact: true });

  await expect(reaction).toBeVisible();
  const { move, finish } = await touch(page, reaction);

  await move(64);
  await finish();
  await reset(source);
  await expect(page.getByLabel('Ответ на сообщение', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.evaluate(() => {
    // Touch messages are no longer selectable in the feed. A selection in
    // another browser surface must still prevent a new reply gesture.
    const text = document.createElement('p');
    const range = document.createRange();

    text.textContent = 'Выбранный текст вне сообщения';
    document.body.append(text);
    range.selectNodeContents(text);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
  });
  await source.dispatchEvent('pointerdown', {
    pointerId: 80,
    pointerType: 'touch',
    isPrimary: true,
    button: 0,
    clientX: 100,
    clientY: 600,
  });
  await source.dispatchEvent('pointermove', {
    pointerId: 80,
    pointerType: 'touch',
    isPrimary: true,
    button: 0,
    clientX: 164,
    clientY: 600,
  });
  await source.dispatchEvent('pointerup', {
    pointerId: 80,
    pointerType: 'touch',
    isPrimary: true,
    button: 0,
    clientX: 164,
    clientY: 600,
  });
  await expect(source.locator('..')).not.toHaveAttribute('data-swiping');
  await expect(page.getByLabel('Ответ на сообщение', { exact: true })).toHaveCount(0);
});

test('a pending send cannot be used as a swipe reply source', async ({ page }) => {
  const { release, requests } = await setupDialogUi(page);
  const input = page.getByRole('textbox', { name: 'Сообщение', exact: true });

  await input.fill('Ожидающая отправка');
  await input.press('Shift+Enter');
  await expect.poll(requests).toBe(1);
  const source = page.getByRole('log').locator('article').filter({ hasText: 'Ожидающая отправка' });

  try {
    await expect(source).toBeVisible();
    await expect(source.locator('..')).not.toHaveAttribute('data-swipe-enabled');
    const { move, finish } = await touch(page, source);

    await move(64);
    await finish();
    await expect(page.getByLabel('Ответ на сообщение', { exact: true })).toHaveCount(0);
  } finally {
    release();
    await expect(source.getByRole('img', { name: 'Отправлено', exact: true })).toBeVisible();
  }
});

test('reduced motion returns immediately and foreign messages can be replied to', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await setupDialogUi(page);
  const source = page.getByRole('log').locator('article').filter({ hasText: 'Сообщение 16' });

  await expect(source).toBeVisible();
  const { move, finish } = await touch(page, source);

  await move(64);
  await finish();
  await expect(page.getByLabel('Ответ на сообщение', { exact: true })).toContainText(
    'Анна Смирнова',
  );
  await reset(source);
  expect(
    await source.evaluate((element) => getComputedStyle(element.parentElement!).transitionDuration),
  ).toBe('0s');
});

test('mouse selection does not trigger the touch gesture', async ({ page }) => {
  await setupDialogUi(page);
  const source = page
    .getByRole('log')
    .locator('article')
    .filter({ hasText: 'Встречаемся завтра в 18:00?' });

  await expect(source).toBeVisible();
  const { x, y } = (await source.boundingBox())!;

  await page.mouse.move(x + 20, y + 10);
  await page.mouse.down();
  await page.mouse.move(x + 80, y + 10, { steps: 5 });
  await page.mouse.up();
  await reset(source);
  await expect(page.getByLabel('Ответ на сообщение', { exact: true })).toHaveCount(0);
});

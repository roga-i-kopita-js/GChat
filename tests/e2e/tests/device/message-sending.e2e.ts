import { expect, test } from '@playwright/test';

import { setupDialogUi } from '../../fixtures/web/dialog-ui';

test('sending keeps bubble geometry and its DOM node when the server confirms', async ({
  page,
}, testInfo) => {
  const { release, requests } = await setupDialogUi(page);
  const input = page.getByRole('textbox', { name: 'Сообщение', exact: true });
  const feed = page.getByRole('log', { name: 'Сообщения' });
  let expectedRequests = 0;

  await expect(input).toBeVisible();

  await page.evaluate(() => {
    const feed = document.querySelector('.dialog-feed-wrapper')!;
    const probe = { sawGap: false };
    const observer = new MutationObserver(() => {
      probe.sawGap ||= !!feed.querySelector('.dialog-gap');
    });

    observer.observe(feed, { childList: true, subtree: true });
    (window as any).__gchatGapProbe = probe;
  });

  try {
    for (const width of [360, 390, 1280]) {
      await page.setViewportSize({ width, height: 844 });

      for (const text of [
        'Ок ' + width,
        'Длинное сообщение ' + width + '\nСтрока сообщения\n'.repeat(6),
      ]) {
        await input.fill(text);
        await input.press('Shift+Enter');
        expectedRequests++;
        await expect.poll(requests).toBe(expectedRequests);
        const bubble = feed.locator('article').filter({ hasText: text.split('\n')[0] });

        await expect(bubble.getByRole('img', { name: 'Отправляется', exact: true })).toBeVisible();
        await expect(bubble.getByRole('button', { name: 'Повторить', exact: true })).toHaveCount(0);
        await expect(input).toBeFocused();
        await expect
          .poll(() =>
            feed.evaluate(
              (element) => element.scrollHeight - element.clientHeight - element.scrollTop,
            ),
          )
          .toBeLessThanOrEqual(1);
        const before = await bubble.evaluate((element) => {
          element.dataset.continuity = 'same-bubble';

          return {
            width: element.getBoundingClientRect().width,
            height: element.getBoundingClientRect().height,
          };
        });

        if (text === 'Ок 390') {
          await page.screenshot({ path: testInfo.outputPath('sending-390.png') });
        }

        release();
        await expect(bubble.getByRole('img', { name: 'Отправлено', exact: true })).toBeVisible();
        await expect(bubble).toHaveAttribute('data-continuity', 'same-bubble');
        const after = await bubble.evaluate((element) => ({
          width: element.getBoundingClientRect().width,
          height: element.getBoundingClientRect().height,
        }));

        expect(after).toEqual(before);
        await expect(input).toBeFocused();
        await expect(input).toHaveValue('');
        await expect(input).not.toHaveAttribute('readonly', '');
        await expect
          .poll(() =>
            feed.evaluate(
              (element) => element.scrollHeight - element.clientHeight - element.scrollTop,
            ),
          )
          .toBeLessThanOrEqual(1);
      }
    }

    expect(await page.evaluate(() => (window as any).__gchatGapProbe.sawGap)).toBe(false);
  } finally {
    release();
  }
});

for (const result of ['unknown', 'rejected'] as const) {
  test(result + ' sends retain a clear explanation and manual retry', async ({ page }) => {
    const { requests } = await setupDialogUi(page, { sendResult: result });
    const input = page.getByRole('textbox', { name: 'Сообщение', exact: true });

    await input.fill('Проверка отказа');
    await input.press('Shift+Enter');
    const bubble = page.getByRole('log').locator('article').filter({ hasText: 'Проверка отказа' });

    await expect(
      bubble.getByRole('img', {
        name: result === 'unknown' ? 'Результат неизвестен' : 'Отклонено',
        exact: true,
      }),
    ).toBeVisible();
    await expect(bubble.getByRole('button', { name: 'Повторить', exact: true })).toBeVisible();
    await expect(bubble.locator('.dialog-retry')).toContainText(
      result === 'unknown' ? 'Результат неизвестен' : 'Отклонено',
    );
    await expect(input).not.toHaveAttribute('readonly', '');
    expect(requests()).toBe(1);
  });
}

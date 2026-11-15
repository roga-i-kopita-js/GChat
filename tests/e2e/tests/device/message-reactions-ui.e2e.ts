import { expect, test } from '@playwright/test';

import { setupDialogUi } from '../../fixtures/web/dialog-ui';

for (const width of [360, 1280]) {
  test(
    'reaction pills and participant rows fit the chat at ' + width + 'px',
    async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: 844 });
      await setupDialogUi(page, { reactions: 'both' });
      const message = page
        .getByRole('log')
        .locator('article')
        .filter({ hasText: 'Встречаемся завтра в 18:00?' });
      const reaction = message.getByRole('button', { name: 'Реакция: Огонь, 1', exact: true });

      await expect(reaction).toBeVisible();
      const { width: hitWidth, height: hitHeight } = (await reaction.boundingBox())!;
      const { height: pillHeight } = (await reaction
        .locator('.dialog-reaction-chip')
        .boundingBox())!;

      expect(hitWidth).toBeGreaterThanOrEqual(44);
      expect(hitHeight).toBeGreaterThanOrEqual(44);
      expect(pillHeight).toBe(28);
      await expect(reaction).toHaveAttribute('aria-pressed', 'true');
      await page.screenshot({ path: testInfo.outputPath('reaction-pills.png') });
      await message.getByRole('button', { name: 'Кто поставил реакции', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: 'Реакции', exact: true });

      await expect(dialog).toBeVisible();
      await expect(dialog.getByRole('listitem')).toHaveCount(2);
      await expect(dialog.getByRole('listitem').filter({ hasText: 'Вы' })).toContainText('🔥');
      await expect(dialog.getByRole('listitem').filter({ hasText: 'Вы' })).toContainText('❤️');
      const { width: dialogWidth, height: dialogHeight } = (await dialog.boundingBox())!;

      expect(dialogWidth).toBeLessThanOrEqual(300);
      expect(dialogHeight).toBeLessThanOrEqual(200);
      await page.screenshot({ path: testInfo.outputPath('reaction-participants.png') });
      await dialog.getByRole('button', { name: 'Закрыть', exact: true }).click();
      await expect(dialog).toHaveCount(0);
      await expect(
        message.getByRole('button', { name: 'Кто поставил реакции', exact: true }),
      ).toBeFocused();
    },
  );
}

test('one reaction has one compact participant row', async ({ page }) => {
  await setupDialogUi(page, { reactions: 'single' });
  await page.getByRole('button', { name: 'Кто поставил реакции', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Реакции', exact: true });

  await expect(dialog.getByRole('listitem')).toHaveCount(1);
  const { height } = (await dialog.boundingBox())!;

  expect(height).toBeLessThanOrEqual(160);
});

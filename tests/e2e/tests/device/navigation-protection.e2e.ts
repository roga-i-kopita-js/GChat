import { expect, test } from '@playwright/test';
async function start(
  page: import('@playwright/test').Page,
  mode: 'form' | 'draft',
  fail = false,
): Promise<void> {
  await page.goto('/tests/device-harness.html');
  await page.evaluate(
    async ({ mode, fail }): Promise<void> => {
      const path = '/tests/navigation-protection-harness.tsx';
      const fixture = await import(path);

      const { start: fixtureStart } = fixture;

      await fixtureStart.bind(fixture)(mode, fail);
    },
    { mode, fail },
  );
  await expect(page.getByLabel('Draft', { exact: true })).toBeVisible();
}
test('Link and device navigation share a single blocker and continue the original transition', async ({
  page,
}): Promise<void> => {
  await start(page, 'form');
  await page.getByLabel('Draft', { exact: true }).fill('unsaved');
  await page.getByRole('link', { name: 'Next', exact: true }).click();
  const modal = page.getByRole('dialog', { name: 'Несохранённые изменения' });

  await expect(modal).toHaveCount(1);
  await modal.getByRole('button', { name: 'Остаться', exact: true }).click();
  await expect(page.getByLabel('Draft', { exact: true })).toHaveValue('unsaved');
  await page.evaluate(async (): Promise<void> => {
    const path = '/tests/navigation-protection-harness.tsx';

    const resolved = await import(path);
    const { command: resultCommand } = resolved;

    resultCommand.bind(resolved)(false);
  });
  await expect(modal).toBeVisible();
  await modal.getByRole('button', { name: 'Уйти без сохранения', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Next route' })).toBeVisible();
  expect(
    await page.evaluate(async (): Promise<string> => {
      const path = '/tests/navigation-protection-harness.tsx';

      const { control: resultControl } = await import(path);

      return resultControl.lastOutcome;
    }),
  ).toBe('committed');
});
test('native navigation waits for the same dialog and reports Blocked after staying', async ({
  page,
}): Promise<void> => {
  await start(page, 'form');
  await page.getByLabel('Draft', { exact: true }).fill('unsaved');
  await page.evaluate(async (): Promise<void> => {
    const path = '/tests/navigation-protection-harness.tsx';

    const resolved2 = await import(path);
    const { command: resultCommand2 } = resolved2;

    resultCommand2.bind(resolved2)(true);
  });
  await page
    .getByRole('dialog', { name: 'Несохранённые изменения' })
    .getByRole('button', { name: 'Остаться', exact: true })
    .click();
  await expect
    .poll(async (): Promise<string | undefined> => {
      return page.evaluate(async (): Promise<string | undefined> => {
        const path = '/tests/navigation-protection-harness.tsx';

        const { control: resultControl2 } = await import(path);

        return resultControl2.nativeOutcomes.at(-1);
      });
    })
    .toBe('blocked');
  await expect(page.getByLabel('Draft', { exact: true })).toHaveValue('unsaved');
});
test('drafts flush before leaving and failed flushes can be retried without losing input', async ({
  page,
}): Promise<void> => {
  await start(page, 'draft', true);
  await page.getByLabel('Draft', { exact: true }).fill('draft text');
  await page.getByRole('link', { name: 'Next', exact: true }).click();
  const modal = page.getByRole('dialog', { name: 'Несохранённые изменения' });

  await expect(modal).toContainText('Не удалось сохранить черновик');
  await page.evaluate(async (): Promise<void> => {
    const path = '/tests/navigation-protection-harness.tsx';

    const { control: resultControl3 } = await import(path);

    resultControl3.fail = false;
  });
  await modal.getByRole('button', { name: 'Повторить сохранение', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Next route' })).toBeVisible();
  expect(
    await page.evaluate(async (): Promise<string> => {
      const path = '/tests/navigation-protection-harness.tsx';

      const { control: resultControl4 } = await import(path);

      return resultControl4.stored;
    }),
  ).toBe('draft text');
});
test('explicit discard after a failed flush continues native navigation without reporting a save', async ({
  page,
}): Promise<void> => {
  await start(page, 'draft', true);
  await page.getByLabel('Draft', { exact: true }).fill('discarded');
  await page.evaluate(async (): Promise<void> => {
    const path = '/tests/navigation-protection-harness.tsx';

    const resolved3 = await import(path);
    const { command: resultCommand3 } = resolved3;

    resultCommand3.bind(resolved3)(true);
  });
  await page
    .getByRole('dialog', { name: 'Несохранённые изменения' })
    .getByRole('button', { name: 'Уйти без сохранения', exact: true })
    .click();
  await expect(page.getByRole('heading', { name: 'Next route' })).toBeVisible();
  await expect
    .poll(async (): Promise<string | undefined> =>
      page.evaluate(async (): Promise<string | undefined> => {
        const path = '/tests/navigation-protection-harness.tsx';

        const { control: resultControl5 } = await import(path);

        return resultControl5.nativeOutcomes.at(-1);
      }),
    )
    .toBe('committed');
  expect(
    await page.evaluate(async (): Promise<string> => {
      const path = '/tests/navigation-protection-harness.tsx';

      const { control: resultControl6 } = await import(path);

      return resultControl6.stored;
    }),
  ).toBe('');
});

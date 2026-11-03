import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import type { Page } from '@playwright/test';
import { expect, test } from '@playwright/test';

test.beforeEach((): void => {
  execFileSync(process.execPath, [
    fileURLToPath(new URL('../../backend/scripts/web-test-reset.mjs', import.meta.url)),
  ]);
});

async function login(page: Page, name: string): Promise<void> {
  await page.goto('/');
  await page.getByLabel('Логин', { exact: true }).fill(name);
  await page.getByLabel('Пароль', { exact: true }).fill('gchat-web-test-password');
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Ваши люди' })).toBeVisible();
  await expect(page.getByRole('status').first()).toHaveText('На связи');
}

async function dial(page: Page, name: string): Promise<void> {
  await page.getByRole('button', { name: name + ' Голосовой звонок' }).click();
  await page.getByRole('button', { name: 'Позвонить', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Позвонить', exact: true }).click();
}

test('full browser call uses relay audio, mute, reload and ends for both users', async ({
  browser,
}, testInfo): Promise<void> => {
  const a = await browser.newContext({ permissions: ['microphone'] });
  const b = await browser.newContext({ permissions: ['microphone'] });
  const anna = await a.newPage();
  const maxim = await b.newPage();
  const errors: string[] = [];

  anna.on('pageerror', (cause): void => {
    errors.push(cause.message);
  });
  maxim.on('pageerror', (cause): void => {
    errors.push(cause.message);
  });

  try {
    await anna.goto('/');
    await anna.screenshot({ path: testInfo.outputPath('login.png'), fullPage: true });
    await login(anna, 'anna');
    await login(maxim, 'maxim');
    await anna.screenshot({ path: testInfo.outputPath('contacts.png'), fullPage: true });
    await dial(anna, 'Максим Волков');
    await expect(anna.getByTestId('call-status')).toHaveText('Вызываем…', { timeout: 20000 });
    await expect(maxim.getByTestId('call-status')).toHaveText('Входящий звонок', {
      timeout: 15000,
    });
    await maxim.getByRole('button', { name: 'Принять', exact: true }).click();
    await expect(anna.getByTestId('call-status')).toHaveText('Разговор', { timeout: 35000 });
    await expect(maxim.getByTestId('call-status')).toHaveText('Разговор');

    for (const page of [anna, maxim]) {
      await page.getByRole('button', { name: 'Диагностика', exact: true }).click();
      await expect(page.getByTestId('relay')).toHaveText('TURN (relay)', { timeout: 10000 });
      await expect
        .poll(async (): Promise<number> =>
          Number((await page.getByTestId('rtp-received').textContent())?.split(' ')[0] ?? 0),
        )
        .toBeGreaterThan(0);
      await expect
        .poll(async (): Promise<number> =>
          Number((await page.getByTestId('rtp-sent').textContent())?.split(' ')[0] ?? 0),
        )
        .toBeGreaterThan(0);
      await page.getByRole('button', { name: 'Закрыть', exact: true }).click();
    }

    await anna.getByRole('button', { name: 'Микрофон', exact: true }).click();
    await expect(anna.getByRole('button', { name: 'Включить микрофон' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await anna.getByRole('button', { name: 'Включить микрофон' }).click();
    const extra = await a.newPage();

    await extra.goto('/');
    await expect(extra.getByText('Звонками управляет другая вкладка GChat.')).toBeVisible();
    await expect(anna.getByTestId('call-status')).toHaveText('Разговор');
    await extra.close();
    await anna.reload();
    await expect(anna.getByRole('heading', { name: 'Ваши люди' })).toBeVisible();
    await expect(anna.getByTestId('call-status')).toHaveText('Разговор', { timeout: 20000 });
    await anna.getByRole('button', { name: 'Диагностика', exact: true }).click();
    await expect
      .poll(
        async (): Promise<number> =>
          Number((await anna.getByTestId('rtp-received').textContent())?.split(' ')[0] ?? 0),
        { timeout: 20000 },
      )
      .toBeGreaterThan(0);
    await anna.getByRole('button', { name: 'Закрыть', exact: true }).click();
    await anna.getByRole('button', { name: 'Завершить', exact: true }).click();
    await expect(anna.getByTestId('call-status')).toHaveText('Разговор завершён');
    await expect(maxim.getByTestId('call-status')).toHaveText('Разговор завершён');
    expect(errors).toEqual([]);
  } finally {
    await a.close();
    await b.close();
  }
});

test('responsive contacts, cancel confirmation, reject and persist session', async ({
  browser,
}): Promise<void> => {
  const a = await browser.newContext({
    permissions: ['microphone'],
    viewport: { width: 390, height: 844 },
  });
  const b = await browser.newContext({ permissions: ['microphone'] });
  const anna = await a.newPage();
  const maxim = await b.newPage();

  try {
    await login(anna, 'anna');
    await login(maxim, 'maxim');
    await anna.getByRole('button', { name: 'Максим Волков Голосовой звонок' }).click();
    await anna.getByRole('button', { name: 'Позвонить', exact: true }).click();
    await anna.getByRole('dialog').getByRole('button', { name: 'Отмена', exact: true }).click();
    await expect(maxim.getByTestId('call-status')).not.toBeVisible();
    await anna.reload();
    await expect(anna.getByRole('heading', { name: 'Ваши люди' })).toBeVisible();
    await expect(anna.getByRole('status').first()).toHaveText('На связи');
    await dial(anna, 'Максим Волков');
    await maxim.getByRole('button', { name: 'Отклонить', exact: true }).click();
    await expect(anna.getByTestId('call-status')).toHaveText('Вызов отклонён');
    await expect(maxim.getByTestId('call-status')).toHaveText('Вызов отклонён');
  } finally {
    await a.close();
    await b.close();
  }
});

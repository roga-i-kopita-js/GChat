import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { expect, test } from '@playwright/test';

import { dial, login } from '../../fixtures/web/actions';

test.beforeEach((): void => {
  execFileSync(process.execPath, [
    fileURLToPath(new URL('../../scripts/reset.mjs', import.meta.url)),
  ]);
});

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
    await extra.getByRole('button', { name: 'Диагностика', exact: true }).click();
    await expect(extra.getByText('Звонками управляет другая вкладка GChat.')).toBeVisible();
    await expect(anna.getByTestId('call-status')).toHaveText('Разговор');
    await extra.close();
    await anna.reload();
    await expect(anna.getByRole('main', { name: 'Звонки', exact: true })).toBeVisible();
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
    await expect(anna.getByRole('main', { name: 'Звонки', exact: true })).toBeVisible();
    await expect(
      anna.getByRole('button', { name: 'Позвонить: Максим Волков', exact: true }),
    ).toBeEnabled();
    await maxim.getByRole('button', { name: 'Елена Соколова Голосовой звонок' }).click();
    await maxim.getByRole('button', { name: /Максим Волков @maxim/ }).click();
    await expect(maxim.getByRole('dialog')).toBeVisible();
    await anna.getByRole('button', { name: 'Позвонить: Максим Волков', exact: true }).click();
    await expect(anna.getByRole('dialog')).not.toBeVisible();
    await expect(anna.getByTestId('call-status')).toHaveText('Вызываем…');
    const incoming = maxim.getByRole('dialog', { name: 'Входящий звонок', exact: true });

    await expect(incoming).toBeVisible();
    await expect(incoming.getByRole('heading', { name: 'Анна Смирнова' })).toBeVisible();
    await expect(maxim.getByRole('heading', { name: 'Мой аккаунт' })).not.toBeVisible();
    await expect(incoming).toHaveJSProperty('open', true);
    await maxim.keyboard.press('Escape');
    await expect(incoming).toBeVisible();
    await maxim.keyboard.press('Tab');
    await expect(incoming.locator(':focus')).toHaveCount(1);
    await incoming.getByRole('button', { name: 'Отклонить', exact: true }).click();
    await expect(anna.getByTestId('call-status')).toHaveText('Вызов отклонён');
    await expect(maxim.getByTestId('call-status')).toHaveText('Вызов отклонён');

    for (const page of [anna, maxim]) {
      await page.getByRole('button', { name: 'Вернуться к контактам' }).click();
      await expect(page.getByRole('button', { name: 'Позвонить', exact: true })).not.toBeVisible();
      await expect(
        page.getByRole('button', { name: 'Елена Соколова Голосовой звонок' }),
      ).toBeVisible();
      await expect(page.getByTestId('call-status')).not.toBeVisible();
    }

    await anna.getByRole('button', { name: 'Диагностика', exact: true }).click();
    await dial(maxim, 'Анна Смирнова');
    const mobileIncoming = anna.getByRole('dialog', { name: 'Входящий звонок', exact: true });

    await expect(mobileIncoming).toBeVisible();
    await expect(anna.getByRole('heading', { name: 'Диагностика соединения' })).not.toBeVisible();
    await maxim.getByRole('button', { name: 'Отменить', exact: true }).click();
    await expect(mobileIncoming).not.toBeVisible();
    await expect(anna.getByTestId('call-status')).toHaveText('Вызов отменён');
  } finally {
    await a.close();
    await b.close();
  }
});

test('an idle secondary tab can enable calls without opening diagnostics', async ({
  browser,
}): Promise<void> => {
  const context = await browser.newContext({ permissions: ['microphone'] });

  try {
    const primary = await context.newPage();

    await login(primary, 'anna');
    const secondary = await context.newPage();

    await secondary.addInitScript((): void => localStorage.removeItem('debug'));
    await secondary.goto('/');
    const call = secondary.getByRole('button', { name: 'Позвонить: Максим Волков', exact: true });

    await expect(call).toBeDisabled();
    await expect(secondary.getByRole('button', { name: 'Диагностика', exact: true })).toHaveCount(
      0,
    );
    await secondary.getByRole('button', { name: 'Открыть здесь', exact: true }).click();
    await expect(call).toBeEnabled();
    await expect(
      primary.getByRole('button', { name: 'Позвонить: Максим Волков', exact: true }),
    ).toBeDisabled();
    await call.click();
    await expect(secondary.getByTestId('call-status')).toHaveText('Вызываем…');
    await secondary.getByRole('button', { name: 'Отменить', exact: true }).click();
    await expect(secondary.getByTestId('call-status')).toHaveText('Вызов отменён');
  } finally {
    await context.close();
  }
});

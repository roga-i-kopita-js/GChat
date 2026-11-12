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
  const { newPage: aNewPage } = a;
  const anna = await aNewPage.bind(a)();
  const { newPage: bNewPage } = b;
  const maxim = await bNewPage.bind(b)();
  const errors: string[] = [];

  const { on: annaOn } = anna;

  annaOn.bind(anna)('pageerror', (cause): void => {
    errors.push(cause.message);
  });
  const { on: maximOn } = maxim;

  maximOn.bind(maxim)('pageerror', (cause): void => {
    errors.push(cause.message);
  });

  try {
    const { goto: annaGoto } = anna;

    await annaGoto.bind(anna)('/');
    const { screenshot: annaScreenshot } = anna;

    await annaScreenshot.bind(anna)({ path: testInfo.outputPath('login.png'), fullPage: true });
    await login(anna, 'anna');
    await login(maxim, 'maxim');
    const { screenshot: annaScreenshot2 } = anna;

    await annaScreenshot2.bind(anna)({ path: testInfo.outputPath('contacts.png'), fullPage: true });
    await dial(anna, 'Максим Волков');
    const { getByTestId: annaGetByTestId } = anna;

    await expect(annaGetByTestId.bind(anna)('call-status')).toHaveText('Вызываем…', {
      timeout: 20000,
    });
    const { getByTestId: maximGetByTestId } = maxim;

    await expect(maximGetByTestId.bind(maxim)('call-status')).toHaveText('Входящий звонок', {
      timeout: 15000,
    });
    const { getByRole: maximGetByRole } = maxim;

    await maximGetByRole.bind(maxim)('button', { name: 'Принять', exact: true }).click();
    const { getByTestId: annaGetByTestId2 } = anna;

    await expect(annaGetByTestId2.bind(anna)('call-status')).toHaveText('Разговор', {
      timeout: 35000,
    });
    const { getByTestId: maximGetByTestId2 } = maxim;

    await expect(maximGetByTestId2.bind(maxim)('call-status')).toHaveText('Разговор');

    for (const page of [anna, maxim]) {
      await page.getByRole('button', { name: 'Диагностика', exact: true }).click();
      await expect(page.getByTestId('relay')).toHaveText('TURN (relay)', { timeout: 10000 });
      await expect
        .poll(async (): Promise<number> => {
          const resolved = await page.getByTestId('rtp-received').textContent();
          const { split: textContentResultSplit } = resolved ?? {};

          return Number(textContentResultSplit?.bind(resolved)(' ')[0] ?? 0);
        })
        .toBeGreaterThan(0);
      await expect
        .poll(async (): Promise<number> => {
          const resolved2 = await page.getByTestId('rtp-sent').textContent();
          const { split: textContentResultSplit2 } = resolved2 ?? {};

          return Number(textContentResultSplit2?.bind(resolved2)(' ')[0] ?? 0);
        })
        .toBeGreaterThan(0);
      await page.getByRole('button', { name: 'Закрыть', exact: true }).click();
    }

    const { getByRole: annaGetByRole } = anna;

    await annaGetByRole.bind(anna)('button', { name: 'Микрофон', exact: true }).click();
    const { getByRole: annaGetByRole2 } = anna;

    await expect(
      annaGetByRole2.bind(anna)('button', { name: 'Включить микрофон' }),
    ).toHaveAttribute('aria-pressed', 'true');
    const { getByRole: annaGetByRole3 } = anna;

    await annaGetByRole3.bind(anna)('button', { name: 'Включить микрофон' }).click();
    const { newPage: aNewPage2 } = a;
    const extra = await aNewPage2.bind(a)();

    const { goto: extraGoto } = extra;

    await extraGoto.bind(extra)('/');
    const { getByRole: extraGetByRole } = extra;

    await extraGetByRole.bind(extra)('button', { name: 'Диагностика', exact: true }).click();
    const { getByText: extraGetByText } = extra;

    await expect(
      extraGetByText.bind(extra)('Звонками управляет другая вкладка GChat.'),
    ).toBeVisible();
    const { getByTestId: annaGetByTestId3 } = anna;

    await expect(annaGetByTestId3.bind(anna)('call-status')).toHaveText('Разговор');
    const { close: extraClose } = extra;

    await extraClose.bind(extra)();
    const { reload: annaReload } = anna;

    await annaReload.bind(anna)();
    const { getByRole: annaGetByRole4 } = anna;

    await expect(annaGetByRole4.bind(anna)('main', { name: 'Звонки', exact: true })).toBeVisible();
    const { getByTestId: annaGetByTestId4 } = anna;

    await expect(annaGetByTestId4.bind(anna)('call-status')).toHaveText('Разговор', {
      timeout: 20000,
    });
    const { getByRole: annaGetByRole5 } = anna;

    await annaGetByRole5.bind(anna)('button', { name: 'Диагностика', exact: true }).click();
    await expect
      .poll(
        async (): Promise<number> => {
          const { getByTestId: annaGetByTestId5 } = anna;
          const resolved3 = await annaGetByTestId5.bind(anna)('rtp-received').textContent();
          const { split: textContentResultSplit3 } = resolved3 ?? {};

          return Number(textContentResultSplit3?.bind(resolved3)(' ')[0] ?? 0);
        },
        { timeout: 20000 },
      )
      .toBeGreaterThan(0);
    const { getByRole: annaGetByRole6 } = anna;

    await annaGetByRole6.bind(anna)('button', { name: 'Закрыть', exact: true }).click();
    const { getByRole: annaGetByRole7 } = anna;

    await annaGetByRole7.bind(anna)('button', { name: 'Завершить', exact: true }).click();
    const { getByTestId: annaGetByTestId6 } = anna;

    await expect(annaGetByTestId6.bind(anna)('call-status')).toHaveText('Разговор завершён');
    const { getByTestId: maximGetByTestId3 } = maxim;

    await expect(maximGetByTestId3.bind(maxim)('call-status')).toHaveText('Разговор завершён');
    expect(errors).toEqual([]);
  } finally {
    const { close: aClose } = a;

    await aClose.bind(a)();
    const { close: bClose } = b;

    await bClose.bind(b)();
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
  const { newPage: aNewPage3 } = a;
  const anna = await aNewPage3.bind(a)();
  const { newPage: bNewPage2 } = b;
  const maxim = await bNewPage2.bind(b)();

  try {
    await login(anna, 'anna');
    await login(maxim, 'maxim');
    const { getByRole: annaGetByRole8 } = anna;

    await annaGetByRole8.bind(anna)('button', { name: 'Максим Волков Голосовой звонок' }).click();
    const { getByRole: annaGetByRole9 } = anna;

    await annaGetByRole9.bind(anna)('button', { name: 'Позвонить', exact: true }).click();
    const { getByRole: annaGetByRole10 } = anna;

    await annaGetByRole10
      .bind(anna)('dialog')
      .getByRole('button', { name: 'Отмена', exact: true })
      .click();
    const { getByTestId: maximGetByTestId4 } = maxim;

    await expect(maximGetByTestId4.bind(maxim)('call-status')).not.toBeVisible();
    const { reload: annaReload2 } = anna;

    await annaReload2.bind(anna)();
    const { getByRole: annaGetByRole11 } = anna;

    await expect(annaGetByRole11.bind(anna)('main', { name: 'Звонки', exact: true })).toBeVisible();
    const { getByRole: annaGetByRole12 } = anna;

    await expect(
      annaGetByRole12.bind(anna)('button', { name: 'Позвонить: Максим Волков', exact: true }),
    ).toBeEnabled();
    const { getByRole: maximGetByRole2 } = maxim;

    await maximGetByRole2
      .bind(maxim)('button', { name: 'Елена Соколова Голосовой звонок' })
      .click();
    const { getByRole: maximGetByRole3 } = maxim;

    await maximGetByRole3.bind(maxim)('link', { name: 'Настройки', exact: true }).click();
    const { getByRole: maximGetByRole4 } = maxim;

    await expect(
      maximGetByRole4.bind(maxim)('main', { name: 'Настройки', exact: true }),
    ).toBeVisible();
    const { getByRole: annaGetByRole13 } = anna;

    await annaGetByRole13
      .bind(anna)('button', { name: 'Позвонить: Максим Волков', exact: true })
      .click();
    const { getByRole: annaGetByRole14 } = anna;

    await expect(annaGetByRole14.bind(anna)('dialog')).not.toBeVisible();
    const { getByTestId: annaGetByTestId7 } = anna;

    await expect(annaGetByTestId7.bind(anna)('call-status')).toHaveText('Вызываем…');
    const { getByRole: maximGetByRole5 } = maxim;
    const incoming = maximGetByRole5.bind(maxim)('dialog', {
      name: 'Входящий звонок',
      exact: true,
    });

    await expect(incoming).toBeVisible();
    await expect(incoming.getByRole('heading', { name: 'Анна Смирнова' })).toBeVisible();
    const { getByRole: maximGetByRole6 } = maxim;

    await expect(
      maximGetByRole6.bind(maxim)('main', { name: 'Настройки', exact: true }),
    ).toBeVisible();
    await expect(incoming).toHaveJSProperty('open', true);
    const { keyboard: maximKeyboard } = maxim;

    await maximKeyboard.press('Escape');
    await expect(incoming).toBeVisible();
    const { keyboard: maximKeyboard2 } = maxim;

    await maximKeyboard2.press('Tab');
    await expect(incoming.locator(':focus')).toHaveCount(1);
    await incoming.getByRole('button', { name: 'Отклонить', exact: true }).click();
    const { getByTestId: annaGetByTestId8 } = anna;

    await expect(annaGetByTestId8.bind(anna)('call-status')).toHaveText('Вызов отклонён');
    const { getByRole: maximGetByRole7 } = maxim;

    await maximGetByRole7.bind(maxim)('link', { name: 'Звонки', exact: true }).click();
    const { getByTestId: maximGetByTestId5 } = maxim;

    await expect(maximGetByTestId5.bind(maxim)('call-status')).toHaveText('Вызов отклонён');

    for (const page of [anna, maxim]) {
      await page.getByRole('link', { name: 'Звонки', exact: true }).click();
      await page.getByRole('button', { name: 'Вернуться к истории' }).click();
      await expect(page.getByRole('button', { name: 'Позвонить', exact: true })).not.toBeVisible();
      await expect(
        page.getByRole('button', { name: 'Елена Соколова Голосовой звонок' }),
      ).toBeVisible();
      await expect(page.getByTestId('call-status')).not.toBeVisible();
    }

    const { getByRole: annaGetByRole15 } = anna;

    await annaGetByRole15.bind(anna)('button', { name: 'Диагностика', exact: true }).click();
    await dial(maxim, 'Анна Смирнова');
    const { getByRole: annaGetByRole16 } = anna;
    const mobileIncoming = annaGetByRole16.bind(anna)('dialog', {
      name: 'Входящий звонок',
      exact: true,
    });

    await expect(mobileIncoming).toBeVisible();
    const { getByRole: annaGetByRole17 } = anna;

    await expect(
      annaGetByRole17.bind(anna)('heading', { name: 'Диагностика соединения' }),
    ).not.toBeVisible();
    const { getByRole: maximGetByRole8 } = maxim;

    await maximGetByRole8.bind(maxim)('button', { name: 'Отменить', exact: true }).click();
    await expect(mobileIncoming).not.toBeVisible();
    const { getByTestId: annaGetByTestId9 } = anna;

    await expect(annaGetByTestId9.bind(anna)('call-status')).toHaveText('Вызов отменён');
  } finally {
    const { close: aClose2 } = a;

    await aClose2.bind(a)();
    const { close: bClose2 } = b;

    await bClose2.bind(b)();
  }
});

test('an idle secondary tab can enable calls without opening diagnostics', async ({
  browser,
}): Promise<void> => {
  const context = await browser.newContext({ permissions: ['microphone'] });

  try {
    const { newPage: contextNewPage } = context;
    const primary = await contextNewPage.bind(context)();

    await login(primary, 'anna');
    const { newPage: contextNewPage2 } = context;
    const secondary = await contextNewPage2.bind(context)();

    const { addInitScript: secondaryAddInitScript } = secondary;

    await secondaryAddInitScript.bind(secondary)((): void => localStorage.removeItem('debug'));
    const { goto: secondaryGoto } = secondary;

    await secondaryGoto.bind(secondary)('/');
    const { getByRole: secondaryGetByRole } = secondary;
    const call = secondaryGetByRole.bind(secondary)('button', {
      name: 'Позвонить: Максим Волков',
      exact: true,
    });

    await expect(call).toBeDisabled();
    const { getByRole: secondaryGetByRole2 } = secondary;

    await expect(
      secondaryGetByRole2.bind(secondary)('button', { name: 'Диагностика', exact: true }),
    ).toHaveCount(0);
    const { getByRole: secondaryGetByRole3 } = secondary;

    await secondaryGetByRole3
      .bind(secondary)('button', { name: 'Открыть здесь', exact: true })
      .click();
    await expect(call).toBeEnabled();
    const { getByRole: primaryGetByRole } = primary;

    await expect(
      primaryGetByRole.bind(primary)('button', { name: 'Позвонить: Максим Волков', exact: true }),
    ).toBeDisabled();
    await call.click();
    const { getByTestId: secondaryGetByTestId } = secondary;

    await expect(secondaryGetByTestId.bind(secondary)('call-status')).toHaveText('Вызываем…');
    const { getByRole: secondaryGetByRole4 } = secondary;

    await secondaryGetByRole4.bind(secondary)('button', { name: 'Отменить', exact: true }).click();
    const { getByTestId: secondaryGetByTestId2 } = secondary;

    await expect(secondaryGetByTestId2.bind(secondary)('call-status')).toHaveText('Вызов отменён');
  } finally {
    const { close: contextClose } = context;

    await contextClose.bind(context)();
  }
});

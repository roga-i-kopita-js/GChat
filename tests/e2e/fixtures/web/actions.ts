import type { Page } from '@playwright/test';
import { expect } from '@playwright/test';

export async function login(page: Page, name: string): Promise<void> {
  await page.addInitScript((): void => localStorage.setItem('debug', '1'));
  await page.goto('/');
  await page.getByLabel('Логин', { exact: true }).fill(name);
  await page.getByLabel('Пароль', { exact: true }).fill('gchat-web-test-password');
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  await expect(page.getByRole('main', { name: 'Звонки', exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Диалоги', exact: true }).click();
  await page.getByRole('link', { name: 'Написать сообщение', exact: true }).click();
  await expect(page.getByRole('button', { name: /^Позвонить:/ }).first()).toBeEnabled();
}

export async function dial(page: Page, name: string): Promise<void> {
  if (!page.url().includes('/dialogs/contacts')) {
    await page.getByRole('link', { name: 'Диалоги', exact: true }).click();
    await page.getByRole('link', { name: 'Написать сообщение', exact: true }).click();
  }

  await page.getByRole('button', { name: name + ' Голосовой звонок' }).click();
  await page.getByRole('button', { name: 'Позвонить', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Позвонить', exact: true }).click();
}

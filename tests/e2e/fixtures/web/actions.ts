import type { Page } from '@playwright/test';
import { expect } from '@playwright/test';

export async function login(page: Page, name: string): Promise<void> {
  await page.goto('/');
  await page.getByLabel('Логин', { exact: true }).fill(name);
  await page.getByLabel('Пароль', { exact: true }).fill('gchat-web-test-password');
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Ваши люди' })).toBeVisible();
  await expect(page.getByRole('status').first()).toHaveText('На связи');
}

export async function dial(page: Page, name: string): Promise<void> {
  await page.getByRole('button', { name: name + ' Голосовой звонок' }).click();
  await page.getByRole('button', { name: 'Позвонить', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Позвонить', exact: true }).click();
}

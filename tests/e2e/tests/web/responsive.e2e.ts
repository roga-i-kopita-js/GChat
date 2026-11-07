import { expect, type Page, test } from '@playwright/test';

const adminId = '00000000-0000-4000-8000-000000000001';
const annaId = '00000000-0000-4000-8000-000000000002';
const anna = {
  id: annaId,
  display_name: 'Анна Смирнова',
  login: 'anna',
  role: 'user',
  status: 'active',
  disabled_at: null,
  groups: [{ id: 'family', name: 'близкие' }],
  created_at: '2026-11-04T10:00:00Z',
  updated_at: '2026-11-04T10:00:00Z',
};

async function setup(
  page: Page,
  authenticated = true,
): Promise<(state?: 'ringing' | 'active') => void> {
  let current: Record<string, unknown> | null = null;
  let send = (_payload: object): void => {};

  await page.routeWebSocket('**/ws', (socket): void => {
    send = (payload: object): void =>
      socket.send(JSON.stringify({ type: 'call.updated', payload }));
    socket.onMessage((message): void => {
      const command = JSON.parse(String(message));

      socket.send(
        JSON.stringify({
          type: 'response',
          request_id: command.request_id,
          payload:
            command.type === 'device.register'
              ? { device_id: '00000000-0000-4000-8000-000000000099' }
              : { call: current },
        }),
      );
    });
  });

  if (authenticated) {
    await page.addInitScript(
      ({ adminId }): void => {
        const now = Math.floor(Date.now() / 1000);
        const jwt = btoa(
          JSON.stringify({
            sub: adminId,
            sid: 'responsive',
            login: 'admin',
            display_name: 'Admin',
            role: 'admin',
            iat: now,
            exp: now + 3600,
          }),
        );

        localStorage.setItem(
          'gchat.session.v1',
          JSON.stringify({
            access_token: `e30.${jwt}.test`,
            refresh_token: 'test-refresh',
            token_type: 'Bearer',
            deviceId: null,
            pending: null,
          }),
        );
      },
      { adminId },
    );
  }

  await page.route(
    (url): boolean => url.pathname.startsWith('/api/'),
    async (route): Promise<void> => {
      const path = new URL(route.request().url()).pathname;
      let body: unknown;

      if (path === '/api/auth/ws-ticket')
        body = { ticket: 'test-ticket', expires_at: new Date(Date.now() + 60000).toISOString() };
      else if (path === '/api/groups') body = { groups: [{ id: 'family', name: 'близкие' }] };
      else if (path === '/api/groups/family/members')
        body = {
          members: [
            { id: adminId, display_name: 'Admin' },
            anna,
            { id: 'maxim', display_name: 'Максим Волков' },
          ],
        };
      else if (path === '/api/admin/users')
        body = {
          users: [anna, { ...anna, id: 'maxim', display_name: 'Максим Волков', login: 'maxim' }],
          total: 2,
        };
      else if (path.startsWith('/api/admin/users/')) body = { user: anna };
      else if (path === '/api/admin/groups')
        body = { groups: [{ id: 'family', name: 'близкие' }], total: 1 };
      else {
        await route.fulfill({ status: 404, json: {} });

        return;
      }

      await route.fulfill({ json: body });
    },
  );
  await page.goto(authenticated ? '/admin/users' : '/login');

  return (state = 'ringing'): void => {
    current = {
      call_id: '00000000-0000-4000-8000-000000000010',
      caller_id: annaId,
      recipient_id: adminId,
      state,
      version: 1,
      created_at: new Date().toISOString(),
      started_at: state === 'active' ? new Date().toISOString() : null,
      ended_at: null,
      end_reason: null,
      recovery_id: null,
      recovery_deadline: null,
      ringing_deadline: null,
      connecting_deadline: null,
    };
    send({ call: current });
  };
}

async function noOverflow(page: Page): Promise<void> {
  expect(
    await page.evaluate((): boolean => document.documentElement.scrollWidth <= window.innerWidth),
  ).toBe(true);
}

for (const viewport of [
  { width: 360, height: 640 },
  { width: 390, height: 844 },
  { width: 430, height: 932 },
]) {
  test(`return to current call from other sections at ${viewport.width}px`, async ({
    page,
  }): Promise<void> => {
    await page.setViewportSize(viewport);
    const updateCall = await setup(page);
    const nav = page.getByRole('navigation', { name: 'Основные разделы' });
    const banner = page.getByRole('link', { name: /Вернуться к звонку/ });

    await nav.getByRole('link', { name: 'Звонки', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Позвонить: Анна Смирнова' })).toBeEnabled();
    updateCall('active');
    await expect(page.locator('.call-card')).toBeVisible();
    await expect(banner).toHaveCount(0);

    for (const section of ['Настройки', 'Диалоги', 'Администрирование']) {
      await page.getByRole('button', { name: 'Контакты', exact: true }).click();
      await nav.getByRole('link', { name: section, exact: true }).click();
      await expect(banner).toBeInViewport();
      await expect(banner).toContainText('Анна Смирнова');
      await page.evaluate((): void => window.scrollTo(0, document.body.scrollHeight));
      await expect(banner).toBeInViewport();
      await banner.click();
      await expect(page).toHaveURL(/\/calls$/);
      await expect(page.locator('.call-card')).toBeVisible();
      await expect(banner).toHaveCount(0);
    }
  });

  test(`audio settings fit a ${viewport.width}px phone`, async ({ page }, info): Promise<void> => {
    await page.setViewportSize(viewport);
    await setup(page);
    await page
      .getByRole('navigation', { name: 'Основные разделы' })
      .getByRole('link', { name: 'Настройки' })
      .click();
    await page.getByRole('link', { name: 'Основные', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Основные', exact: true })).toBeVisible();
    await noOverflow(page);
    await page.screenshot({ path: info.outputPath('settings-general.png') });
    await page.getByRole('link', { name: /Микрофон/ }).click();
    await page.getByRole('button', { name: 'Проверить микрофон', exact: true }).click();
    await expect(
      page.getByText('Микрофон доступен. Проверка завершена.', { exact: true }),
    ).toBeVisible();
    await page.getByRole('link', { name: 'Назад', exact: true }).click();
    await page.getByRole('link', { name: /Динамики и звук/ }).click();
    await page.getByRole('button', { name: 'Проверить звук', exact: true }).click();
    await page.getByRole('button', { name: 'Не слышу', exact: true }).click();
    await expect(page.getByText('Проверьте громкость устройства', { exact: false })).toBeVisible();
    await noOverflow(page);
    await page.screenshot({ path: info.outputPath('audio-settings.png') });
    await page.goBack();
    await expect(page.getByRole('heading', { name: 'Основные', exact: true })).toBeVisible();
  });

  test(`compact account, forms, contacts and incoming call at ${viewport.width}px`, async ({
    page,
  }, info): Promise<void> => {
    await page.setViewportSize(viewport);
    const incoming = await setup(page);
    const nav = page.getByRole('navigation', { name: 'Основные разделы' });
    const list = page.getByRole('region', { name: 'Список аккаунтов' });

    await expect(list.getByRole('link').filter({ hasText: 'Максим Волков' })).toBeInViewport();
    await expect(
      page.getByRole('button', { name: 'Создать аккаунт', exact: true }),
    ).toBeInViewport();
    await expect(nav).toBeInViewport();
    await noOverflow(page);
    await page.screenshot({ path: info.outputPath('accounts.png') });
    await list.getByRole('link').filter({ hasText: 'Анна Смирнова' }).click();
    const detail = page.getByRole('dialog', { name: 'Карточка аккаунта', exact: true });

    await expect(
      detail.getByRole('button', { name: 'Отключить аккаунт', exact: true }),
    ).toBeInViewport();
    await noOverflow(page);
    await page.screenshot({ path: info.outputPath('account.png') });
    await detail.getByRole('button', { name: 'Сменить пароль', exact: true }).click();
    const password = page.getByRole('dialog', { name: 'Сменить пароль', exact: true });

    await expect(
      password.getByRole('button', { name: 'Подтвердить', exact: true }),
    ).toBeInViewport();
    await expect(password.getByLabel('Новый пароль')).toHaveCSS('font-size', '16px');
    await noOverflow(page);
    await page.screenshot({ path: info.outputPath('password.png') });
    await password.getByRole('button', { name: 'Отмена', exact: true }).click();
    await detail.getByRole('button', { name: 'Закрыть', exact: true }).click();
    await page.getByRole('button', { name: 'Создать аккаунт', exact: true }).click();
    const create = page.getByRole('dialog', { name: 'Создать аккаунт', exact: true });

    await noOverflow(page);
    await page.screenshot({ path: info.outputPath('create.png') });
    await create
      .getByRole('button', { name: 'Создать аккаунт', exact: true })
      .scrollIntoViewIfNeeded();
    await expect(
      create.getByRole('button', { name: 'Создать аккаунт', exact: true }),
    ).toBeInViewport();
    await create.getByRole('button', { name: 'Отмена', exact: true }).click();
    await nav.getByRole('link', { name: 'Звонки', exact: true }).click();
    await expect(
      page.getByRole('button', { name: 'Позвонить: Анна Смирнова', exact: true }),
    ).toBeEnabled();
    await noOverflow(page);
    await page.screenshot({ path: info.outputPath('contacts.png') });
    await page.getByRole('button', { name: 'Анна Смирнова Голосовой звонок', exact: true }).click();
    await page.screenshot({ path: info.outputPath('person.png') });
    incoming();
    const call = page.getByRole('dialog', { name: 'Входящий звонок', exact: true });

    await expect(call).toBeVisible();
    await expect(call.getByRole('button', { name: 'Принять', exact: true })).toBeInViewport();
    await noOverflow(page);
    await page.screenshot({ path: info.outputPath('incoming.png') });
  });

  test(`login fits a ${viewport.width}px phone`, async ({ page }, info): Promise<void> => {
    await page.setViewportSize(viewport);
    await setup(page, false);
    await expect(page.getByRole('button', { name: 'Войти', exact: true })).toBeInViewport();
    await expect(page.getByLabel('Пароль', { exact: true })).toHaveCSS('font-size', '16px');
    await noOverflow(page);
    await page.screenshot({ path: info.outputPath('login.png') });
  });
}

for (const viewport of [
  { width: 390, height: 844 },
  { width: 1280, height: 800 },
]) {
  test(`settings routes, file access and large text at ${viewport.width}px`, async ({
    page,
  }, info): Promise<void> => {
    await page.setViewportSize(viewport);
    await page.addInitScript((): void => {
      Object.defineProperty(window, 'showOpenFilePicker', { value: undefined });
    });
    await setup(page);
    await page.goto('/settings/general');
    await expect(page.getByRole('link', { name: /Камера/ })).toBeVisible();
    await page.getByRole('link', { name: /Геопозиция/ }).click();
    await expect(page.getByRole('heading', { name: 'Геопозиция', exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Геопозиция', exact: true })).toBeVisible();
    await page.getByRole('link', { name: 'Назад', exact: true }).click();
    await page.getByRole('link', { name: /Файлы и папки/ }).click();
    const chooser = page.waitForEvent('filechooser');

    await page.getByRole('button', { name: 'Выбрать файл', exact: true }).click();
    await (
      await chooser
    ).setFiles({
      name: 'Очень длинное имя выбранного файла для проверки переноса текста и доступности.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('fixture'),
    });
    await expect(page.getByText('До закрытия приложения', { exact: true })).toBeVisible();
    await noOverflow(page);
    await page.screenshot({ path: info.outputPath('settings-files.png') });
    await page.getByRole('button', { name: 'Забыть доступ', exact: true }).click();
    await expect(page.getByRole('dialog')).toContainText('останется на устройстве');
    await page
      .getByRole('dialog')
      .getByRole('button', { name: 'Забыть доступ', exact: true })
      .click();
    await expect(page.getByText('Пока нет выбранных файлов', { exact: false })).toBeVisible();
    await page.getByRole('link', { name: 'Назад', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Основные', exact: true })).toBeVisible();
    await page.evaluate((): void => {
      document.documentElement.style.fontSize = '28px';
      document.body.style.zoom = '2';
    });
    await noOverflow(page);
    await page.screenshot({ path: info.outputPath('settings-large-text.png') });
  });
}

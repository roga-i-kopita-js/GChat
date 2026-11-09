import { expect, type Page, test } from '@playwright/test';

const adminId = '00000000-0000-4000-8000-000000000001';
const targetId = '00000000-0000-4000-8000-000000000002';
const password = 'A new secure password 123';

test('layout has no top bar and nested settings keep their back navigation', async ({
  page,
}): Promise<void> => {
  await setup(page, 'user');
  await expect(page.getByRole('banner', { name: 'Панель приложения' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: /^Профиль:/ })).toHaveCount(0);
  const main = page.getByRole('main');

  expect((await main.boundingBox())!.y).toBe(0);
  await page.getByRole('link', { name: 'Настройки', exact: true }).click();
  const settings = page.getByRole('region', { name: 'Настройки', exact: true });

  await expect(settings).toBeVisible();
  await expect(settings.locator(':scope > header')).toHaveCount(0);
  await page.getByRole('link', { name: 'Основные', exact: true }).click();
  const general = page.getByRole('region', { name: 'Основные', exact: true });

  await expect(general).toBeVisible();
  await general.getByRole('link', { name: 'Назад', exact: true }).click();
  await expect(settings).toBeVisible();
});

function account(id = targetId, status = 'active'): Record<string, unknown> {
  return {
    id,
    display_name: id === adminId ? 'Администратор' : 'Анна',
    login: id === adminId ? 'admin' : 'anna',
    role: id === adminId ? 'admin' : 'user',
    status,
    disabled_at: status === 'disabled' ? '2026-11-04T10:00:00Z' : null,
    groups: [
      { id: 'group', name: 'команда' },
      { id: 'other', name: 'семья' },
    ],
    created_at: '2026-11-01T10:00:00Z',
    updated_at: '2026-11-04T10:00:00Z',
  };
}

async function setup(page: Page, role = 'admin', path = '/', withSession = true): Promise<void> {
  await page.addInitScript(
    ({ role, adminId, withSession }): void => {
      if (!withSession) {
        return;
      }

      const now = Math.floor(Date.now() / 1000);
      const jwt = btoa(
        JSON.stringify({
          sub: adminId,
          sid: 'test-session',
          role,
          login: 'admin',
          display_name: 'Admin',
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
    { role, adminId, withSession },
  );
  await page.route(/^https?:\/\/[^/]+\/api\//, async (route): Promise<void> => {
    const path = new URL(route.request().url()).pathname;
    let body: unknown = {};

    if (path === '/api/groups') {
      body = { groups: [] };
    } else if (path === '/api/admin/users') {
      body = { users: [account(), account(adminId)], total: 2 };
    } else if (path === '/api/admin/groups') {
      body = { groups: [{ id: 'group', name: 'команда' }], total: 1 };
    } else if (path.startsWith('/api/admin/users/')) {
      body = { user: account(path.split('/')[4]) };
    } else {
      await route.fulfill({
        status: 503,
        json: { error: { code: 'SERVICE_UNAVAILABLE', message: 'Unavailable' } },
      });

      return;
    }

    await route.fulfill({ json: body });
  });
  await page.goto(path);
}

async function openAdmin(page: Page): Promise<void> {
  await page.getByRole('link', { name: 'Администрирование', exact: true }).click();
  await expect(
    page.getByRole('region', { name: 'Список аккаунтов' }).getByText('Анна', { exact: true }),
  ).toBeVisible();
}

test('admin navigation is hidden for ordinary users', async ({ page }): Promise<void> => {
  await setup(page, 'user');
  await expect(page.getByRole('main', { name: 'Звонки', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Администрирование' })).toHaveCount(0);
  await expect(
    page
      .getByRole('navigation', { name: 'Основные разделы' })
      .getByRole('link', { name: 'Звонки', exact: true }),
  ).toHaveAttribute('aria-current', 'page');
});

test('server search, filters and pagination are sent explicitly', async ({
  page,
}): Promise<void> => {
  await setup(page);
  await openAdmin(page);
  await page.route('**/api/admin/users?**', async (route): Promise<void> => {
    const url = new URL(route.request().url());

    expect(url.searchParams.get('limit')).toBe('25');
    await route.fulfill({ json: { users: [account()], total: 26 } });
  });
  await page.getByRole('button', { name: 'Обновить', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Следующая страница' })).toBeEnabled();
  const next = page.waitForRequest(
    (req): boolean => new URL(req.url()).searchParams.get('offset') === '25',
  );

  await page.getByRole('button', { name: 'Следующая страница' }).click();
  await next;
  const search = page.waitForRequest((req): boolean => {
    const url = new URL(req.url());

    return url.searchParams.get('q') === 'андр' && url.searchParams.get('offset') === '0';
  });

  await page.getByRole('textbox', { name: 'Поиск по имени или логину' }).fill('андр');
  await search;
  const filter = page.waitForRequest(
    (req): boolean => new URL(req.url()).searchParams.get('status') === 'disabled',
  );

  await page.getByRole('combobox', { name: 'Состояние аккаунтов' }).selectOption('disabled');
  await filter;
});

test('creates an account with group suggestions and shows credentials only once', async ({
  page,
}): Promise<void> => {
  await setup(page);
  await openAdmin(page);
  let sent: Record<string, unknown> = {};

  await page.route('**/api/admin/users', async (route): Promise<void> => {
    sent = route.request().postDataJSON();
    await route.fulfill({ status: 201, json: { user: account() } });
  });
  await page.getByRole('button', { name: 'Создать аккаунт', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Создать аккаунт' });

  await dialog.getByLabel('Имя', { exact: true }).fill('Анна');
  await dialog.getByLabel('Группа', { exact: true }).fill('команда');
  await expect(
    dialog.getByText('Пользователь будет добавлен в существующую группу.'),
  ).toBeVisible();
  await dialog.getByLabel('Группа', { exact: true }).fill('новая');
  await expect(
    dialog.getByText('Если группы с этим названием нет, она будет создана вместе с аккаунтом.'),
  ).toBeVisible();
  const generated = await dialog.getByLabel('Новый пароль').inputValue();

  expect(generated).toMatch(/^[A-Za-z0-9_-]{24}$/);
  await dialog.getByRole('button', { name: 'Создать аккаунт', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Данные для входа' })).toContainText(generated);
  expect(sent).toEqual({ display_name: 'Анна', group_name: 'новая', password: generated });
  expect(await page.evaluate((): string => JSON.stringify(localStorage))).not.toContain(generated);
  await page.getByRole('button', { name: 'Готово', exact: true }).click();
  await expect(page.getByText(generated, { exact: true })).toHaveCount(0);
});

test('confirms access changes and cancels without sending an operation', async ({
  page,
}): Promise<void> => {
  await page.setViewportSize({ width: 390, height: 844 });
  await setup(page);
  await openAdmin(page);
  await expect(
    page
      .getByRole('navigation', { name: 'Основные разделы' })
      .getByRole('link', { name: 'Администрирование' }),
  ).toHaveAttribute('aria-current', 'page');
  await page
    .getByRole('region', { name: 'Список аккаунтов' })
    .getByRole('link')
    .filter({ hasText: 'Анна' })
    .click();
  const detail = page.getByRole('dialog', { name: 'Карточка аккаунта', exact: true });

  await expect(detail).toContainText('команда, семья');
  let posts = 0;
  let status = 'active';

  await page.route(`**/api/admin/users/${targetId}**`, async (route): Promise<void> => {
    if (route.request().method() === 'POST') {
      posts++;
      status = route.request().url().endsWith('/disable') ? 'disabled' : 'active';
    }

    await route.fulfill({ json: { user: account(targetId, status) } });
  });
  await detail.getByRole('button', { name: 'Отключить аккаунт', exact: true }).click();
  const confirmation = page.getByRole('dialog', { name: 'Отключить аккаунт?', exact: true });
  const cancelBox = await confirmation
    .getByRole('button', { name: 'Отмена', exact: true })
    .boundingBox();
  const confirmBox = await confirmation
    .getByRole('button', { name: 'Подтвердить', exact: true })
    .boundingBox();

  if (!cancelBox || !confirmBox) {
    throw new Error('Confirmation buttons must be visible');
  }

  expect(Math.abs(cancelBox.y - confirmBox.y)).toBeLessThan(1);
  expect(Math.abs(cancelBox.width - confirmBox.width)).toBeLessThan(1);
  expect(Math.abs(cancelBox.height - confirmBox.height)).toBeLessThan(1);
  await page.getByRole('button', { name: 'Отмена', exact: true }).click();
  expect(posts).toBe(0);
  await detail.getByRole('button', { name: 'Отключить аккаунт', exact: true }).click();
  await page.getByRole('button', { name: 'Подтвердить', exact: true }).click();
  await expect(detail.getByRole('button', { name: 'Включить аккаунт', exact: true })).toBeVisible();
  await detail.getByRole('button', { name: 'Включить аккаунт', exact: true }).click();
  await page.getByRole('button', { name: 'Подтвердить', exact: true }).click();
  await expect(
    detail.getByRole('button', { name: 'Отключить аккаунт', exact: true }),
  ).toBeVisible();
  expect(posts).toBe(2);
});

test('does not retry or reveal passwords after an unknown mutation result', async ({
  page,
}): Promise<void> => {
  await setup(page);
  await openAdmin(page);
  await expect(
    page
      .getByRole('navigation', { name: 'Основные разделы' })
      .getByRole('link', { name: 'Администрирование' }),
  ).toHaveAttribute('aria-current', 'page');
  await page
    .getByRole('region', { name: 'Список аккаунтов' })
    .getByRole('link')
    .filter({ hasText: 'Анна' })
    .click();
  await page.getByRole('button', { name: 'Сменить пароль', exact: true }).click();
  await page.getByLabel('Новый пароль').fill(password);
  let posts = 0;

  await page.route(`**/api/admin/users/${targetId}/password`, async (route): Promise<void> => {
    posts++;
    await route.fulfill({
      status: 503,
      json: { error: { code: 'SERVICE_UNAVAILABLE', message: 'Unavailable' } },
    });
  });
  await page.getByRole('button', { name: 'Подтвердить', exact: true }).click();
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText(
    'Результат операции неизвестен',
  );
  await expect(page.getByLabel('Новый пароль')).toHaveValue('');
  await expect(page.getByRole('button', { name: 'Подтвердить', exact: true })).toHaveCount(0);
  expect(posts).toBe(1);
});

test('mobile admin can change own password and receives credentials after session termination', async ({
  page,
}): Promise<void> => {
  await page.setViewportSize({ width: 390, height: 844 });
  await setup(page);
  await openAdmin(page);
  await expect(
    page
      .getByRole('navigation', { name: 'Основные разделы' })
      .getByRole('link', { name: 'Администрирование' }),
  ).toHaveAttribute('aria-current', 'page');
  await page
    .getByRole('region', { name: 'Список аккаунтов' })
    .getByRole('link')
    .filter({ hasText: 'Администратор' })
    .click();
  const detail = page.getByRole('dialog', { name: 'Карточка аккаунта', exact: true });

  await expect(
    detail.getByRole('button', { name: 'Отключить аккаунт', exact: true }),
  ).toBeDisabled();
  expect(
    await page.evaluate((): boolean => document.documentElement.scrollWidth <= window.innerWidth),
  ).toBe(true);
  await detail.getByRole('button', { name: 'Сменить пароль', exact: true }).click();
  await page.getByLabel('Новый пароль').fill(password);
  await page.getByRole('button', { name: 'Подтвердить', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Данные для входа' })).toContainText(password);
  expect(
    await page.evaluate((): string | null => localStorage.getItem('gchat.session.v1')),
  ).toBeNull();
  await page.getByRole('button', { name: 'Готово', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Вход в GChat' })).toBeVisible();
});

test('distinguishes forbidden access from an empty search result', async ({
  page,
}): Promise<void> => {
  await setup(page);
  await openAdmin(page);
  let forbidden = true;

  await page.route('**/api/admin/users?**', async (route): Promise<void> => {
    await route.fulfill(
      forbidden
        ? { status: 403, json: { error: { code: 'FORBIDDEN', message: 'Forbidden' } } }
        : { json: { users: [], total: 0 } },
    );
  });
  await page.getByRole('button', { name: 'Обновить', exact: true }).click();
  const list = page.getByRole('region', { name: 'Список аккаунтов' });

  await expect(list).toContainText('Доступ запрещён');
  forbidden = false;
  await page.getByRole('textbox', { name: 'Поиск по имени или логину' }).fill('нет совпадений');
  await expect(list).toContainText('Нет совпадений');
});

test('account opens over the list; reload, closing and history preserve list parameters', async ({
  page,
}): Promise<void> => {
  const path = `/admin/users/${targetId}?q=anna&status=active&offset=25`;

  await setup(page, 'admin', path);
  const detail = page.getByRole('dialog', { name: 'Карточка аккаунта', exact: true });

  await expect(detail.getByRole('heading', { name: 'Анна', exact: true })).toBeVisible();
  await expect(detail).toHaveJSProperty('open', true);
  await page.reload();
  await expect(detail.getByRole('heading', { name: 'Анна', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(detail).toHaveCount(0);
  await expect(page).toHaveURL(/\/admin\/users\?q=anna&status=active&offset=25$/);
  await expect(page.getByRole('textbox', { name: 'Поиск по имени или логину' })).toHaveValue(
    'anna',
  );
  await expect(page.getByRole('combobox', { name: 'Состояние аккаунтов' })).toHaveValue('active');
  await page
    .getByRole('region', { name: 'Список аккаунтов' })
    .getByRole('link')
    .filter({ hasText: 'Анна' })
    .click();
  await expect(detail).toBeVisible();
  await page.goBack();
  await expect(detail).toHaveCount(0);
  await page.goForward();
  await expect(detail).toBeVisible();
  await detail.getByRole('button', { name: 'Закрыть', exact: true }).click();
  await expect(detail).toHaveCount(0);
});

test('direct admin URL denies a user before any administrative request', async ({
  page,
}): Promise<void> => {
  let requests = 0;

  page.on('request', (request): void => {
    if (new URL(request.url()).pathname.startsWith('/api/admin')) {
      requests++;
    }
  });
  await setup(page, 'user', `/admin/users/${targetId}`);
  await expect(page.getByRole('heading', { name: 'Доступ запрещён' })).toBeVisible();
  expect(requests).toBe(0);
});

test('login returns to the protected deep link and unknown URLs show not found', async ({
  page,
}): Promise<void> => {
  await setup(page, 'admin', `/admin/users/${targetId}?status=disabled`, false);
  await expect(page).toHaveURL(/\/login\?returnTo=/);
  expect(new URL(page.url()).searchParams.get('returnTo')).toBe(
    `/admin/users/${targetId}?status=disabled`,
  );
  await page.route('**/api/auth/login', async (route): Promise<void> => {
    const now = Math.floor(Date.now() / 1000);
    const jwt = Buffer.from(
      JSON.stringify({
        sub: adminId,
        sid: 'login-session',
        role: 'admin',
        login: 'admin',
        display_name: 'Admin',
        iat: now,
        exp: now + 3600,
      }),
    ).toString('base64url');

    await route.fulfill({
      json: {
        access_token: `e30.${jwt}.test`,
        refresh_token: 'test-refresh',
        token_type: 'Bearer',
      },
    });
  });
  await page.getByRole('textbox', { name: 'Логин', exact: true }).fill('admin');
  await page.getByLabel('Пароль', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/admin/users/${targetId}\\?status=disabled$`));
  await expect(page.getByRole('dialog', { name: 'Карточка аккаунта', exact: true })).toContainText(
    'Анна',
  );
  await page.goto('/unknown-page');
  await expect(page.getByRole('heading', { name: 'Страница не найдена' })).toBeVisible();
});

test('route changes keep the signaling owner and active call; incoming calls appear over administration', async ({
  page,
}): Promise<void> => {
  let connections = 0;
  let sendEvent: (payload: object) => void = (): void => {};
  let current = {
    call_id: '00000000-0000-4000-8000-000000000010',
    state: 'ringing',
    caller_id: adminId,
    recipient_id: targetId,
    created_at: new Date().toISOString(),
    started_at: null as string | null,
    ended_at: null as string | null,
    end_reason: null as string | null,
    recovery_id: null,
    recovery_deadline: null,
    ringing_deadline: null,
    connecting_deadline: null,
    version: 1,
  };

  await page.routeWebSocket('**/ws', (socket): void => {
    connections++;
    sendEvent = (payload: object): void =>
      socket.send(JSON.stringify({ type: 'call.updated', payload }));
    socket.onMessage((message): void => {
      const command = JSON.parse(String(message));
      const payload =
        command.type === 'device.register'
          ? { device_id: '00000000-0000-4000-8000-000000000099' }
          : { call: current };

      socket.send(JSON.stringify({ type: 'response', request_id: command.request_id, payload }));
    });
  });
  await setup(page);
  await page.route('**/api/auth/ws-ticket', async (route): Promise<void> => {
    await route.fulfill({
      json: { ticket: 'test-ticket', expires_at: new Date(Date.now() + 60000).toISOString() },
    });
  });
  await page.reload();
  await expect(page.getByTestId('call-status')).toHaveText('Вызываем…');
  current = {
    ...current,
    state: 'active',
    started_at: new Date(Date.now() - 5000).toISOString(),
    version: 2,
  };
  sendEvent({ call: current });
  await expect(page.getByTestId('call-status')).toHaveText('Разговор');
  // The explicit reload above may replace an initial connection; measure route changes only.
  const connectionsBeforeNavigation = connections;

  expect(connectionsBeforeNavigation).toBeGreaterThan(0);
  await openAdmin(page);
  await expect(page).toHaveURL(/\/admin\/users$/);
  await expect(page.getByRole('link', { name: 'Вернуться к звонку' })).toBeVisible();
  await page.getByRole('link', { name: 'Вернуться к звонку' }).click();
  await expect(page.getByTestId('call-status')).toHaveText('Разговор');
  expect(connections).toBe(connectionsBeforeNavigation);
  current = {
    ...current,
    state: 'ended',
    ended_at: new Date().toISOString(),
    end_reason: 'ended',
    version: 3,
  };
  sendEvent({ call: current });
  await expect(page.getByTestId('call-status')).not.toHaveText('Разговор');
  await openAdmin(page);
  await page.evaluate((): void => {
    localStorage.setItem('debug', '');
    window.dispatchEvent(new Event('focus'));
  });
  await page.getByRole('button', { name: 'Диагностика', exact: true }).click();
  const diagnostics = page.getByRole('dialog', { name: 'Диагностика соединения', exact: true });

  await expect(diagnostics).toBeVisible();
  current = {
    ...current,
    call_id: '00000000-0000-4000-8000-000000000011',
    caller_id: targetId,
    recipient_id: adminId,
    state: 'ringing',
    started_at: null,
    ended_at: null,
    end_reason: null,
    version: 1,
  };
  sendEvent({ call: current });
  await expect(page.getByRole('dialog', { name: 'Входящий звонок' })).toBeVisible();
  await expect(diagnostics).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Принять', exact: true })).toBeVisible();
  await expect(page).toHaveURL(/\/admin\/users$/);
  expect(connections).toBe(connectionsBeforeNavigation);
  current = {
    ...current,
    state: 'ended',
    ended_at: new Date().toISOString(),
    end_reason: 'ended',
    version: 2,
  };
  sendEvent({ call: current });
  await expect(page.getByRole('button', { name: 'Диагностика', exact: true })).toBeVisible();
  await expect(diagnostics).toHaveCount(0);
});

test('a completed operation shows credentials without redirecting a user who left the page', async ({
  page,
}): Promise<void> => {
  await setup(page);
  await openAdmin(page);
  let release = (): void => {};
  let started = false;
  const gate = new Promise<void>((resolve): void => {
    release = resolve;
  });

  await page.route('**/api/admin/users', async (route): Promise<void> => {
    started = true;
    await gate;
    await route.fulfill({ status: 201, json: { user: account() } });
  });
  await page.getByRole('button', { name: 'Создать аккаунт', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Создать аккаунт' });

  await dialog.getByLabel('Имя', { exact: true }).fill('Анна');
  await dialog.getByLabel('Группа', { exact: true }).fill('команда');
  await dialog.getByRole('button', { name: 'Создать аккаунт', exact: true }).click();
  await expect.poll((): boolean => started).toBe(true);
  await page.goBack();
  await expect(page).toHaveURL(/\/calls$/);
  release();
  await expect(page.getByRole('dialog', { name: 'Данные для входа' })).toBeVisible();
  await expect(page).toHaveURL(/\/calls$/);
});

for (const role of ['user', 'admin']) {
  test(`diagnostics requires the local debug key for ${role}`, async ({ page }): Promise<void> => {
    await setup(page, role);
    const button = page.getByRole('button', { name: 'Диагностика', exact: true });
    const dialog = page.getByRole('dialog', { name: 'Диагностика соединения', exact: true });

    await expect(button).toHaveCount(0);
    await page.evaluate((): void => {
      localStorage.setItem('debug', '');
      window.dispatchEvent(new Event('focus'));
    });
    await expect(button).toBeVisible();
    await button.click();
    await expect(dialog).toBeVisible();
    await page.evaluate((): void => {
      localStorage.removeItem('debug');
      window.dispatchEvent(new Event('focus'));
    });
    await expect(button).toHaveCount(0);
    await expect(dialog).toHaveCount(0);
  });
}

test('password forms can reveal and copy a draft without submitting it', async ({
  page,
}): Promise<void> => {
  await page.setViewportSize({ width: 390, height: 844 });
  await setup(page);
  await openAdmin(page);
  let mutations = 0;

  page.on('request', (request): void => {
    if (request.method() === 'POST' && new URL(request.url()).pathname.startsWith('/api/admin')) {
      mutations++;
    }
  });
  await page.evaluate((): void => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (text: string): Promise<void> => {
          Object.defineProperty(window, 'copiedDraft', { configurable: true, value: text });
        },
      },
    });
  });

  for (const action of ['create', 'password']) {
    if (action === 'create') {
      await page.getByRole('button', { name: 'Создать аккаунт', exact: true }).click();
    } else {
      await page
        .getByRole('region', { name: 'Список аккаунтов' })
        .getByRole('link')
        .filter({ hasText: 'Анна' })
        .click();
      await page.getByRole('button', { name: 'Сменить пароль', exact: true }).click();
    }

    const dialog = page.getByRole('dialog', {
      name: action === 'create' ? 'Создать аккаунт' : 'Сменить пароль',
      exact: true,
    });
    const input = dialog.getByLabel('Новый пароль', { exact: true });

    await expect(input).toHaveAttribute('type', 'password');
    await input.fill(password);
    await dialog.getByRole('button', { name: 'Показать пароль', exact: true }).click();
    await expect(input).toHaveAttribute('type', 'text');
    await dialog.getByRole('button', { name: 'Скопировать пароль', exact: true }).click();
    await expect(dialog.getByRole('status')).toContainText('Изменения ещё не сохранены');
    expect(
      await page.evaluate(
        (): unknown => Object.getOwnPropertyDescriptor(window, 'copiedDraft')?.value,
      ),
    ).toBe(password);
    await dialog.getByRole('button', { name: 'Скрыть пароль', exact: true }).click();
    await expect(input).toHaveAttribute('type', 'password');
    await dialog.getByRole('button', { name: 'Сгенерировать другой', exact: true }).click();
    await expect(input).not.toHaveValue(password);
    await input.fill('');
    await expect(
      dialog.getByRole('button', { name: 'Скопировать пароль', exact: true }),
    ).toBeDisabled();
    await dialog.getByRole('button', { name: 'Отмена', exact: true }).click();
  }

  expect(mutations).toBe(0);
});

test('search waits for a typing pause and cancels pending work when leaving the page', async ({
  page,
}): Promise<void> => {
  await page.clock.install();
  await setup(page, 'admin', '/admin/users?offset=25');
  await expect(page.getByRole('region', { name: 'Список аккаунтов' })).toContainText('Анна');
  await page.clock.pauseAt(new Date(await page.evaluate((): number => Date.now() + 1000)));
  const queries: string[] = [];

  page.on('request', (request): void => {
    const url = new URL(request.url());

    if (url.pathname === '/api/admin/users' && url.searchParams.get('q')) {
      queries.push(url.searchParams.get('q') ?? '');
    }
  });
  const search = page.getByRole('textbox', { name: 'Поиск по имени или логину' });

  await search.fill('a');
  await page.clock.fastForward(200);
  await search.fill('an');
  await page.clock.fastForward(200);
  await search.fill('anna');
  await expect(search).toHaveValue('anna');
  await page.clock.fastForward(349);
  expect(queries).toEqual([]);
  const request = page.waitForRequest(
    (request): boolean => new URL(request.url()).searchParams.get('q') === 'anna',
  );

  await page.clock.fastForward(1);
  await request;
  await page.clock.fastForward(150);
  expect(queries).toEqual(['anna']);
  await expect(page).toHaveURL(/\/admin\/users\?q=anna$/);
  await search.fill('maxim');
  await page
    .getByRole('navigation', { name: 'Основные разделы' })
    .getByRole('link', { name: 'Звонки', exact: true })
    .click();
  await page.clock.fastForward(1000);
  expect(queries).toEqual(['anna']);
});

test('admin calls list includes active users across pages and without groups', async ({
  page,
}): Promise<void> => {
  await setup(page);
  const offsets: number[] = [];

  await page.route('**/api/admin/users?*', async (route): Promise<void> => {
    const query = new URL(route.request().url()).searchParams;

    expect(query.get('status')).toBe('active');
    expect(query.get('limit')).toBe('100');
    const offset = Number(query.get('offset'));

    offsets.push(offset);
    await route.fulfill({
      json: {
        users:
          offset === 0
            ? [account(adminId), account()]
            : [{ ...account('no-group'), display_name: 'Без группы', groups: [] }],
        total: 3,
      },
    });
  });
  await page.reload();
  await expect(page.getByRole('combobox', { name: 'Группа контактов' })).toHaveValue('');
  await expect(page.getByRole('button', { name: 'Позвонить: Анна', exact: true })).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Позвонить: Без группы', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Позвонить: Администратор', exact: true }),
  ).toHaveCount(0);
  expect(offsets).toEqual([0, 2]);
});

test('contact group belongs to the URL and survives reload and browser history', async ({
  page,
}): Promise<void> => {
  await setup(page, 'user');
  const first = '00000000-0000-4000-8000-000000000031';
  const second = '00000000-0000-4000-8000-000000000032';

  await page.route('**/api/groups', async (route): Promise<void> => {
    await route.fulfill({
      json: {
        groups: [
          { id: first, name: 'Первая группа' },
          { id: second, name: 'Вторая группа' },
        ],
      },
    });
  });
  await page.route('**/api/groups/*/members', async (route): Promise<void> => {
    const selected = route.request().url().includes(second);

    await route.fulfill({
      json: {
        members: [
          { id: targetId, display_name: selected ? 'Второй собеседник' : 'Первый собеседник' },
        ],
      },
    });
  });
  await page.goto('/calls');
  const groups = page.getByRole('combobox', { name: 'Группа контактов' });

  await groups.selectOption(first);
  await expect(page).toHaveURL(new RegExp(`\\?group=${first}$`));
  await groups.selectOption(second);
  await expect(
    page.getByRole('button', { name: 'Второй собеседник Голосовой звонок' }),
  ).toBeVisible();
  await page.reload();
  await expect(groups).toHaveValue(second);
  await page.goBack();
  await expect(groups).toHaveValue(first);
  await expect(
    page.getByRole('button', { name: 'Первый собеседник Голосовой звонок' }),
  ).toBeVisible();
});

test('contacts reload on each route entry without a timer or focus refresh', async ({
  page,
}): Promise<void> => {
  await setup(page, 'user', '/settings');
  await page.clock.install();
  let groupsRead = 0;
  let membersRead = 0;
  let name = 'Первый собеседник';

  await page.route('**/api/groups', async (route): Promise<void> => {
    groupsRead++;
    await route.fulfill({
      json: { groups: [{ id: '00000000-0000-4000-8000-000000000031', name: 'Команда' }] },
    });
  });
  await page.route('**/api/groups/*/members', async (route): Promise<void> => {
    membersRead++;
    await route.fulfill({ json: { members: [{ id: targetId, display_name: name }] } });
  });
  await page.goto('/calls');
  await expect(
    page.getByRole('button', { name: 'Первый собеседник Голосовой звонок' }),
  ).toBeVisible();
  await page.clock.fastForward(61000);
  await page.evaluate((): void => {
    window.dispatchEvent(new Event('focus'));
  });
  expect([groupsRead, membersRead]).toEqual([1, 1]);

  await page.getByRole('link', { name: 'Настройки', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Настройки', exact: true })).toBeVisible();
  name = 'Изменённый собеседник';
  await page.getByRole('link', { name: 'Звонки', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Изменённый собеседник Голосовой звонок' }),
  ).toBeVisible();
  expect([groupsRead, membersRead]).toEqual([2, 2]);

  await page.getByRole('link', { name: 'Настройки', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Настройки', exact: true })).toBeVisible();
  name = 'Собеседник после возврата';
  await page.goBack();
  await expect(
    page.getByRole('button', { name: 'Собеседник после возврата Голосовой звонок' }),
  ).toBeVisible();
  expect([groupsRead, membersRead]).toEqual([3, 3]);
});

test('settings loader finishes the device read before mounting its page', async ({
  page,
}): Promise<void> => {
  await setup(page, 'user');
  await page
    .getByRole('navigation', { name: 'Основные разделы' })
    .getByRole('link', { name: 'Настройки', exact: true })
    .click();
  await expect(page.getByRole('region', { name: 'Настройки', exact: true })).toBeVisible();
  await page.evaluate((): void => {
    const query = navigator.permissions.query.bind(navigator.permissions);
    let release!: () => void;
    const gate = new Promise<void>((resolve): void => {
      release = resolve;
    });

    Reflect.set(window, 'releaseSettingsRead', release);
    Object.defineProperty(navigator.permissions, 'query', {
      configurable: true,
      value: async (descriptor: PermissionDescriptor): Promise<PermissionStatus> => {
        await gate;

        return query(descriptor);
      },
    });
  });
  await page.getByRole('link', { name: /Основные/ }).click({ noWaitAfter: true });
  await expect(
    page.getByRole('progressbar', { name: 'Загрузка страницы', exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('region', { name: 'Основные', exact: true })).toHaveCount(0);
  await page.evaluate((): void => {
    Reflect.get(window, 'releaseSettingsRead')();
  });
  await expect(page.getByRole('region', { name: 'Основные', exact: true })).toBeVisible();
});

test('layout loading bar covers file revalidation without navigating away', async ({
  page,
}): Promise<void> => {
  await page.addInitScript((): void => {
    Object.defineProperty(window, 'showOpenFilePicker', { value: undefined });
  });
  await setup(page, 'user', '/settings/general/files');
  await expect(page.getByRole('region', { name: 'Файлы и папки', exact: true })).toBeVisible();
  await page.evaluate((): void => {
    const query = navigator.permissions.query.bind(navigator.permissions);
    let release!: () => void;
    const gate = new Promise<void>((resolve): void => {
      release = resolve;
    });

    Reflect.set(window, 'releaseSettingsRead', release);
    Object.defineProperty(navigator.permissions, 'query', {
      configurable: true,
      value: async (descriptor: PermissionDescriptor): Promise<PermissionStatus> => {
        await gate;

        return query(descriptor);
      },
    });
  });
  const chooser = page.waitForEvent('filechooser');

  await page.getByRole('button', { name: 'Выбрать файл', exact: true }).click();
  await (
    await chooser
  ).setFiles({
    name: 'loading-fixture.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('fixture'),
  });
  const bar = page.getByRole('progressbar', { name: 'Загрузка страницы', exact: true });

  await expect(bar).toBeVisible();
  await expect(page.getByRole('region', { name: 'Файлы и папки', exact: true })).toBeVisible();
  await expect(page).toHaveURL(/\/settings\/general\/files$/);
  await page.evaluate((): void => {
    Reflect.get(window, 'releaseSettingsRead')();
  });
  await expect(page.getByText('loading-fixture.txt', { exact: true })).toBeVisible();
  await expect(bar).toHaveCount(0);
});

test('settings read current device permissions on each route entry without a change event', async ({
  page,
}): Promise<void> => {
  await page.addInitScript((): void => {
    Reflect.set(window, 'testMicrophonePermission', 'prompt');
    Object.defineProperty(navigator.permissions, 'query', {
      value: async ({ name }: { name: string }): Promise<PermissionStatus> =>
        Object.assign(new EventTarget(), {
          name,
          onchange: null,
          state: name === 'microphone' ? Reflect.get(window, 'testMicrophonePermission') : 'prompt',
        }) as PermissionStatus,
    });
  });
  await setup(page, 'user');
  await page.goto('/settings/general');
  const microphone = page.getByRole('link', { name: /Микрофон/ });

  await expect(microphone).toContainText('Не запрошен');
  await page.evaluate((): void => {
    Reflect.set(window, 'testMicrophonePermission', 'denied');
  });
  const nav = page.getByRole('navigation', { name: 'Основные разделы' });

  await nav.getByRole('link', { name: 'Звонки', exact: true }).click();
  await nav.getByRole('link', { name: 'Настройки', exact: true }).click();
  await page.getByRole('link', { name: /Основные/ }).click();
  await expect(microphone).toContainText('Запрещён');
  await page.evaluate((): void => {
    Reflect.set(window, 'testMicrophonePermission', 'granted');
  });
  await microphone.click();
  await expect(page.getByText('Разрешён', { exact: true })).toBeVisible();
});

test('settings follow the audio service output and invalidate hearing confirmation by output ID', async ({
  page,
}): Promise<void> => {
  await setup(page, 'user');
  await page.addInitScript((): void => {
    const outputs = ['one', 'two'].map((id): object => ({
      deviceId: id,
      groupId: 'test',
      kind: 'audiooutput',
      label: 'Тестовая гарнитура',
    }));

    Reflect.set(window, 'testAudioOutput', 0);
    Object.defineProperty(navigator.mediaDevices, 'selectAudioOutput', {
      value: async (): Promise<object> => outputs[Reflect.get(window, 'testAudioOutput')],
    });
    Object.defineProperty(navigator.mediaDevices, 'enumerateDevices', {
      configurable: true,
      value: async (): Promise<object[]> => outputs,
    });
    Object.defineProperty(HTMLMediaElement.prototype, 'setSinkId', {
      value: async (): Promise<void> => {},
    });
    Object.defineProperty(AudioContext.prototype, 'setSinkId', {
      value: async (): Promise<void> => {},
    });
  });
  await page.goto('/settings/general/audio');
  await page.getByRole('button', { name: 'Выбрать аудиовыход' }).click();
  await expect(page.getByText('Тестовая гарнитура', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Проверить звук' }).click();
  await page.getByRole('button', { name: 'Слышу', exact: true }).click();
  await expect(page.getByText('Слышимость подтверждена вами.', { exact: true })).toBeVisible();

  await page.evaluate((): void => {
    Reflect.set(window, 'testAudioOutput', 1);
  });
  await page.getByRole('button', { name: 'Выбрать аудиовыход' }).click();
  await expect(page.getByText('Слышимость подтверждена вами.', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Тестовая гарнитура', { exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Назад', exact: true }).click();
  await expect(page.getByText('Тестовая гарнитура', { exact: true })).toBeVisible();

  await page.evaluate((): void => {
    Object.defineProperty(navigator.mediaDevices, 'enumerateDevices', {
      value: async (): Promise<object[]> => [],
    });
    navigator.mediaDevices.dispatchEvent(new Event('devicechange'));
  });
  await expect(page.getByText('Системный выход', { exact: true })).toBeVisible();
});

test('loads page modules on demand and keeps the parent list across nested detail navigation', async ({
  page,
}): Promise<void> => {
  const modules: string[] = [];

  page.on('request', (request): void => {
    modules.push(new URL(request.url()).pathname);
  });
  await setup(page);
  await expect(page.getByRole('main', { name: 'Звонки', exact: true })).toBeVisible();
  expect(
    modules.some((path): boolean =>
      /\/(UsersPage|DialogsPage|SettingsIndexRoute)\.tsx$/.test(path),
    ),
  ).toBe(false);
  await openAdmin(page);
  const list = page.getByRole('region', { name: 'Список аккаунтов' });

  await list.evaluate((element): void => {
    element.setAttribute('data-instance', 'original');
  });
  await list.getByRole('link').filter({ hasText: 'Анна' }).click();
  await expect(page.getByRole('dialog', { name: 'Карточка аккаунта', exact: true })).toBeVisible();
  await expect(list).toHaveAttribute('data-instance', 'original');
  await page.goBack();
  await expect(page.getByRole('dialog', { name: 'Карточка аккаунта', exact: true })).toHaveCount(0);
  await expect(list).toHaveAttribute('data-instance', 'original');
  await page.goForward();
  await expect(page.getByRole('dialog', { name: 'Карточка аккаунта', exact: true })).toBeVisible();
  await expect(list).toHaveAttribute('data-instance', 'original');
  await page.reload();
  await expect(page.getByRole('dialog', { name: 'Карточка аккаунта', exact: true })).toContainText(
    'Анна',
  );
});

for (const width of [390, 1280]) {
  test(`loading bar reaches the right edge before disappearing at ${width}px`, async ({
    page,
  }): Promise<void> => {
    await page.setViewportSize({ width, height: 844 });
    await setup(page);
    await expect(page.getByRole('main', { name: 'Звонки', exact: true })).toBeVisible();
    await page.evaluate((): void => {
      Reflect.set(window, 'loadingBarCompletion', null);
      document.addEventListener('animationend', (event: AnimationEvent): void => {
        const element = event.target;

        if (
          !(element instanceof HTMLElement) ||
          !element.classList.contains('ui-loading-bar-complete') ||
          event.pseudoElement !== '::before'
        ) {
          return;
        }

        const rect = element.getBoundingClientRect();
        const fill = getComputedStyle(element, '::before');
        const transform = new DOMMatrixReadOnly(fill.transform);

        Reflect.set(window, 'loadingBarCompletion', {
          right: rect.left + parseFloat(fill.width) * transform.a,
          visible: element.isConnected && Number(getComputedStyle(element).opacity) > 0,
        });
      });
    });
    await page
      .getByRole('navigation', { name: 'Основные разделы' })
      .getByRole('link', { name: 'Настройки', exact: true })
      .click();
    await expect(page.getByRole('region', { name: 'Настройки', exact: true })).toBeVisible();
    await expect
      .poll((): Promise<number> =>
        page.evaluate((): number => Reflect.get(window, 'loadingBarCompletion')?.right ?? -1),
      )
      .toBeCloseTo(width, 1);
    expect(
      await page.evaluate((): boolean => Reflect.get(window, 'loadingBarCompletion').visible),
    ).toBe(true);
    await expect(page.getByRole('progressbar')).toHaveCount(0);
  });
}

test('shows pending navigation while importing settings and resolves nested settings routes', async ({
  page,
}): Promise<void> => {
  await setup(page);
  const content = page.getByRole('main', { name: 'Звонки', exact: true });

  await expect(content).toBeVisible();
  const contentTop = await content.evaluate(
    (element): number => element.getBoundingClientRect().top,
  );
  let release!: () => void;
  const gate = new Promise<void>((resolve): void => {
    release = resolve;
  });

  await page.route(
    /\/features\/settings\/SettingsIndexRoute\.tsx(?:\?|$)/,
    async (route): Promise<void> => {
      await gate;
      await route.continue();
    },
  );
  await page.getByRole('link', { name: 'Настройки', exact: true }).click();

  try {
    const bar = page.getByRole('progressbar', { name: 'Загрузка страницы', exact: true });

    await expect(bar).toBeVisible();
    await expect(page.getByText('Загружаем страницу…', { exact: true })).toHaveCount(0);
    const bounds = await bar.boundingBox();

    expect(bounds!.x).toBe(0);
    expect(bounds!.y).toBe(0);
    expect(bounds!.width).toBe(page.viewportSize()!.width);
    expect(bounds!.height).toBe(2);
    const transform = await bar.evaluate(
      (element): string => getComputedStyle(element, '::after').transform,
    );

    await expect
      .poll((): Promise<string> =>
        bar.evaluate((element): string => getComputedStyle(element, '::after').transform),
      )
      .not.toBe(transform);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    expect(
      await bar.evaluate((element): string => getComputedStyle(element, '::after').animationName),
    ).toBe('none');
    await expect(page.getByRole('navigation', { name: 'Основные разделы' })).toBeVisible();
    await expect
      .poll((): Promise<number> =>
        content.evaluate((element): number => element.getBoundingClientRect().top),
      )
      .toBe(contentTop);
  } finally {
    release();
  }

  await expect(page.getByRole('region', { name: 'Настройки', exact: true })).toBeVisible();
  await expect(page.getByRole('progressbar')).toHaveCount(0);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.getByRole('link', { name: 'Основные', exact: false }).click();
  await expect(page).toHaveURL(/\/settings\/general$/);
  await page.getByRole('link', { name: /Микрофон/ }).click();
  await expect(page.getByRole('region', { name: 'Микрофон', exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('region', { name: 'Микрофон', exact: true })).toBeVisible();
  await page.goto('/settings/general/unknown');
  await expect(page.getByRole('region', { name: 'Настройка не найдена' })).toBeVisible();
});

test('contains lazy import failures inside the section and preserves the application shell', async ({
  page,
}): Promise<void> => {
  await setup(page);
  await expect(page.getByRole('main', { name: 'Звонки', exact: true })).toBeVisible();
  await page.route(
    /\/features\/settings\/SettingsIndexRoute\.tsx(?:\?|$)/,
    async (route): Promise<void> => {
      await route.abort('failed');
    },
  );
  await page.getByRole('link', { name: 'Настройки', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Не удалось открыть страницу' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Основные разделы' })).toBeVisible();
  await page.getByRole('link', { name: 'К звонкам', exact: true }).click();
  await expect(page.getByRole('main', { name: 'Звонки', exact: true })).toBeVisible();
});

test('settings imports only the page being opened', async ({ page }): Promise<void> => {
  const pages = new Set<string>();

  page.on('request', (request): void => {
    const match = new URL(request.url()).pathname.match(
      /\/features\/settings\/(Settings\w+Route)\.tsx$/,
    );

    if (match) {
      pages.add(match[1]);
    }
  });
  await setup(page);
  await page.getByRole('link', { name: 'Настройки', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Настройки', exact: true })).toBeVisible();
  expect([...pages]).toEqual(['SettingsIndexRoute']);
  await page.getByRole('link', { name: 'Основные', exact: false }).click();
  await expect(page.getByRole('region', { name: 'Основные', exact: true })).toBeVisible();
  expect([...pages]).toEqual(['SettingsIndexRoute', 'SettingsGeneralRoute']);

  for (const [name, module] of [
    ['Микрофон', 'SettingsMicrophoneRoute'],
    ['Динамики и звук', 'SettingsAudioRoute'],
    ['Push-уведомления', 'SettingsPushRoute'],
    ['Камера', 'SettingsCameraRoute'],
    ['Геопозиция', 'SettingsGeolocationRoute'],
    ['Файлы и папки', 'SettingsFilesRoute'],
  ]) {
    const before = new Set(pages);

    await page.getByRole('link', { name: new RegExp(name) }).click();
    await expect(page.getByRole('region', { name, exact: true })).toBeVisible();
    expect([...pages].filter((item): boolean => !before.has(item))).toEqual([module]);
    await page.getByRole('link', { name: 'Назад', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Основные', exact: true })).toBeVisible();
  }
});

test('contacts do not import person details, call card or diagnostics before opening them', async ({
  page,
}): Promise<void> => {
  const modules = new Set<string>();

  page.on('request', (request): void => {
    modules.add(new URL(request.url()).pathname);
  });
  await page.addInitScript((): void => localStorage.setItem('debug', '1'));
  await setup(page);
  await expect(page.getByRole('main', { name: 'Звонки', exact: true })).toBeVisible();
  expect(
    [...modules].some((path): boolean =>
      /\/(ContactDetails|CallCard|DiagnosticsDialog)\.tsx$/.test(path),
    ),
  ).toBe(false);
  await page.getByRole('button', { name: 'Анна Голосовой звонок', exact: true }).click();
  await expect(page.locator('.person-preview')).toContainText('Анна');
  expect([...modules].some((path): boolean => path.endsWith('/ContactDetails.tsx'))).toBe(true);
  expect(
    [...modules].some((path): boolean => /\/(CallCard|DiagnosticsDialog)\.tsx$/.test(path)),
  ).toBe(false);
  await page.getByRole('button', { name: 'Диагностика', exact: true }).click();
  await expect(
    page.getByRole('dialog', { name: 'Диагностика соединения', exact: true }),
  ).toBeVisible();
  expect([...modules].some((path): boolean => path.endsWith('/DiagnosticsDialog.tsx'))).toBe(true);
  expect([...modules].some((path): boolean => path.endsWith('/CallCard.tsx'))).toBe(false);
});

test('incoming call can be rejected while the card loads and after its import fails', async ({
  page,
}): Promise<void> => {
  let sendEvent: (payload: object) => void = (): void => {};
  let current: Record<string, unknown> | null = null;
  let rejected = 0;
  let connections = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve): void => {
    release = resolve;
  });

  await page.route(/\/features\/calls\/CallCard\.tsx(?:\?|$)/, async (route): Promise<void> => {
    await gate;
    await route.abort('failed');
  });
  await page.routeWebSocket('**/ws', (socket): void => {
    connections++;
    sendEvent = (payload): void => socket.send(JSON.stringify({ type: 'call.updated', payload }));
    socket.onMessage((message): void => {
      const command = JSON.parse(String(message));

      if (command.type === 'call.reject') {
        rejected++;
        current = {
          ...current,
          state: 'ended',
          ended_at: new Date().toISOString(),
          end_reason: 'rejected',
          version: 2,
        };
      }

      const payload =
        command.type === 'device.register'
          ? { device_id: '00000000-0000-4000-8000-000000000099' }
          : { call: current };

      socket.send(JSON.stringify({ type: 'response', request_id: command.request_id, payload }));
    });
  });
  await setup(page);
  await page.route('**/api/auth/ws-ticket', async (route): Promise<void> => {
    await route.fulfill({
      json: { ticket: 'test-ticket', expires_at: new Date(Date.now() + 60000).toISOString() },
    });
  });
  await page.reload();
  await openAdmin(page);
  await expect.poll((): number => connections).toBe(1);
  current = {
    call_id: '00000000-0000-4000-8000-000000000012',
    state: 'ringing',
    caller_id: targetId,
    recipient_id: adminId,
    created_at: new Date().toISOString(),
    started_at: null,
    ended_at: null,
    end_reason: null,
    recovery_id: null,
    recovery_deadline: null,
    ringing_deadline: null,
    connecting_deadline: null,
    version: 1,
  };
  sendEvent({ call: current });
  const incoming = page.getByRole('dialog', { name: 'Входящий звонок', exact: true });

  try {
    await expect(incoming.getByRole('button', { name: 'Принять', exact: true })).toBeEnabled();
    await expect(incoming.getByRole('button', { name: 'Отклонить', exact: true })).toBeEnabled();
    await expect(incoming.getByText('Загружаем экран звонка…', { exact: true })).toBeVisible();
  } finally {
    release();
  }

  await expect(incoming.getByRole('alert')).toContainText('Не удалось загрузить экран звонка.');
  await incoming.getByRole('button', { name: 'Отклонить', exact: true }).click();
  await expect(incoming).toHaveCount(0);
  expect(rejected).toBe(1);
  expect(connections).toBe(1);
  await expect(page).toHaveURL(/\/admin\/users$/);
});

test('one blocker protects a dirty admin form on Back and preserves it when staying', async ({
  page,
}): Promise<void> => {
  await setup(page);
  await openAdmin(page);
  await page.getByRole('button', { name: 'Создать аккаунт', exact: true }).click();
  const form = page.getByRole('dialog', { name: 'Создать аккаунт' });

  await form.getByLabel('Имя', { exact: true }).fill('Несохранённое имя');
  await page.goBack();
  const guard = page.getByRole('dialog', { name: 'Несохранённые изменения' });

  await expect(guard).toBeVisible();
  await guard.getByRole('button', { name: 'Остаться', exact: true }).click();
  await expect(page).toHaveURL(/\/admin\/users$/);
  await expect(form.getByLabel('Имя', { exact: true })).toHaveValue('Несохранённое имя');
  expect(
    await page.evaluate((): boolean => {
      const event = new Event('beforeunload', { cancelable: true });

      window.dispatchEvent(event);

      return event.defaultPrevented;
    }),
  ).toBe(true);
  await page.goBack();
  await expect(guard).toBeVisible();
  await guard.getByRole('button', { name: 'Уйти без сохранения', exact: true }).click();
  await expect(page).toHaveURL(/\/calls$/);
  await expect(form).toHaveCount(0);
});

test('restoring pristine input removes protection and session invalidation bypasses dirty forms', async ({
  page,
}): Promise<void> => {
  await setup(page);
  await openAdmin(page);
  await page.getByRole('button', { name: 'Создать аккаунт', exact: true }).click();
  const field = page
    .getByRole('dialog', { name: 'Создать аккаунт' })
    .getByLabel('Имя', { exact: true });

  await field.fill('черновик');
  await field.fill('');
  expect(
    await page.evaluate((): boolean => {
      const event = new Event('beforeunload', { cancelable: true });

      window.dispatchEvent(event);

      return event.defaultPrevented;
    }),
  ).toBe(false);
  await field.fill('Секретный черновик');
  await page.evaluate((): void => {
    localStorage.removeItem('gchat.session.v1');
    window.dispatchEvent(new Event('gchat-session'));
  });
  await expect(page.getByRole('heading', { name: 'Вход в GChat', exact: true })).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'Несохранённые изменения' })).toHaveCount(0);
  await expect(field).toHaveCount(0);
});

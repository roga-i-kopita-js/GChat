import { expect, type Page, test } from '@playwright/test';

const adminId = '00000000-0000-4000-8000-000000000001';
const targetId = '00000000-0000-4000-8000-000000000002';
const password = 'A new secure password 123';

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
      if (!withSession) return;

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
  await page.route('**/api/**', async (route): Promise<void> => {
    const path = new URL(route.request().url()).pathname;
    let body: unknown = {};

    if (path === '/api/groups') body = { groups: [] };
    else if (path === '/api/admin/users') body = { users: [account(), account(adminId)], total: 2 };
    else if (path === '/api/admin/groups')
      body = { groups: [{ id: 'group', name: 'команда' }], total: 1 };
    else if (path.startsWith('/api/admin/users/')) body = { user: account(path.split('/')[4]) };
    else {
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

  if (!cancelBox || !confirmBox) throw new Error('Confirmation buttons must be visible');

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
    if (new URL(request.url()).pathname.startsWith('/api/admin')) requests++;
  });
  await setup(page, 'user', `/admin/users/${targetId}`);
  await expect(page.getByRole('heading', { name: 'Доступ запрещён' })).toBeVisible();
  expect(requests).toBe(0);
});

test('login returns to the protected deep link and unknown URLs show not found', async ({
  page,
}): Promise<void> => {
  await setup(page, 'admin', `/admin/users/${targetId}?status=disabled`, false);
  await expect(page).toHaveURL(/\/login$/);
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
        command.type === 'device.register' ? { device_id: 'test-device' } : { call: current };

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
  await openAdmin(page);
  await expect(page).toHaveURL(/\/admin\/users$/);
  await expect(page.getByRole('link', { name: 'Вернуться к звонку' })).toBeVisible();
  await page.getByRole('link', { name: 'Вернуться к звонку' }).click();
  await expect(page.getByTestId('call-status')).toHaveText('Разговор');
  expect(connections).toBe(1);
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
  await expect(page.getByRole('button', { name: 'Принять', exact: true })).toBeVisible();
  await expect(page).toHaveURL(/\/admin\/users$/);
  expect(connections).toBe(1);
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
    if (request.method() === 'POST' && new URL(request.url()).pathname.startsWith('/api/admin'))
      mutations++;
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
    if (action === 'create')
      await page.getByRole('button', { name: 'Создать аккаунт', exact: true }).click();
    else {
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
  await page.clock.pauseAt(new Date());
  await setup(page, 'admin', '/admin/users?offset=25');
  await expect(page.getByRole('region', { name: 'Список аккаунтов' })).toContainText('Анна');
  const queries: string[] = [];

  page.on('request', (request): void => {
    const url = new URL(request.url());

    if (url.pathname === '/api/admin/users' && url.searchParams.get('q'))
      queries.push(url.searchParams.get('q') ?? '');
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

import { expect, type Page, test } from '@playwright/test';

test.use({
  permissions: ['microphone'],
  launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] },
});

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

      if (path === '/api/auth/ws-ticket') {
        body = { ticket: 'test-ticket', expires_at: new Date(Date.now() + 60000).toISOString() };
      } else if (path === '/api/calls/history') {
        body = { items: [], next_cursor: null };
      } else if (path === '/api/dialogs') {
        body = { dialogs: [], has_more: false };
      } else if (path === '/api/groups') {
        body = { groups: [{ id: 'family', name: 'близкие' }] };
      } else if (path === '/api/groups/family/members') {
        body = {
          members: [
            { id: adminId, display_name: 'Admin' },
            anna,
            { id: 'maxim', display_name: 'Максим Волков' },
          ],
        };
      } else if (path === '/api/admin/users') {
        body = {
          users: [anna, { ...anna, id: 'maxim', display_name: 'Максим Волков', login: 'maxim' }],
          total: 2,
        };
      } else if (path.startsWith('/api/admin/users/')) {
        body = { user: anna };
      } else if (path === '/api/admin/groups') {
        body = { groups: [{ id: 'family', name: 'близкие' }], total: 1 };
      } else {
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
    await expect(
      page.getByRole('heading', { name: 'Звонков пока нет', exact: true }),
    ).toBeVisible();
    updateCall('active');
    await expect(page.locator('.call-card')).toBeVisible();
    await expect(banner).toHaveCount(0);

    for (const section of ['Настройки', 'Диалоги', 'Администрирование']) {
      await page.getByRole('button', { name: 'История звонков', exact: true }).click();
      await nav.getByRole('link', { name: section, exact: true }).click();
      await expect(banner).toBeInViewport();
      await expect(banner).toContainText('Анна Смирнова');
      await page.locator('.app-viewport').evaluate((element): void => {
        element.scrollTop = element.scrollHeight;
      });
      await expect(banner).toBeInViewport();
      expect(await page.evaluate((): number => window.scrollY)).toBe(0);
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
    await expect(page.getByRole('region', { name: 'Основные', exact: true })).toBeVisible();
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
    await expect(page.getByRole('region', { name: 'Основные', exact: true })).toBeVisible();
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
    await page.goto('/dialogs/contacts');
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
  test(`layout keeps document fixed while long pages scroll at ${viewport.width}px`, async ({
    page,
  }): Promise<void> => {
    await page.setViewportSize({ width: viewport.width, height: 400 });
    await setup(page);
    const users = Array.from({ length: 40 }, (_, index): typeof anna => ({
      ...anna,
      id: '00000000-0000-4000-8000-' + String(index + 100).padStart(12, '0'),
      display_name: 'Контакт ' + index,
      login: 'contact' + index,
    }));

    await page.route('**/api/groups/family/members', async (route): Promise<void> => {
      await route.fulfill({
        json: { members: [{ id: adminId, display_name: 'Admin' }, ...users] },
      });
    });
    await page.route(
      (url): boolean => url.pathname === '/api/admin/users',
      async (route): Promise<void> => {
        await route.fulfill({ json: { users, total: users.length } });
      },
    );
    const nav = page.getByRole('navigation', { name: 'Основные разделы' });
    const scroll = page.locator('.app-viewport');

    for (const path of ['/dialogs/contacts', '/settings/general', '/admin/users']) {
      await page.goto(path);
      await expect(page.getByRole('main')).toBeVisible();
      await expect(page.locator('body')).toHaveCSS('position', 'fixed');
      await expect
        .poll((): Promise<number> =>
          scroll.evaluate((element): number => element.scrollHeight - element.clientHeight),
        )
        .toBeGreaterThan(100);
      const menu = await nav.boundingBox();

      await scroll.hover();
      await page.mouse.wheel(0, 300);
      await expect
        .poll((): Promise<number> => scroll.evaluate((element): number => element.scrollTop))
        .toBeGreaterThan(0);

      for (const edge of ['end', 'start']) {
        await scroll.evaluate((element, edge): void => {
          element.scrollTop = edge === 'end' ? element.scrollHeight : 0;
        }, edge);
        await page.mouse.wheel(0, edge === 'end' ? 500 : -500);
        await page.evaluate((): void => window.scrollTo(0, 200));
        expect(await page.evaluate((): number => window.scrollY)).toBe(0);
        expect(await nav.boundingBox()).toEqual(menu);
      }

      if (path === '/settings/general') {
        await scroll.evaluate((element): void => {
          element.scrollTop = element.scrollHeight;
        });
        const last = page.getByRole('link', { name: /Файлы и папки/ });

        await expect(last).toBeInViewport();
        const box = await last.boundingBox();

        const { y: boxY } = box!;
        const { height: boxHeight } = box!;
        const { y: menuY } = menu!;

        expect(boxY + boxHeight).toBeLessThanOrEqual(menuY);
      }
    }

    await nav.getByRole('link', { name: 'Диалоги', exact: true }).click();
    await expect(scroll).toHaveCSS('overflow-y', 'hidden');
    await expect(scroll).toHaveJSProperty('scrollTop', 0);
    await nav.getByRole('link', { name: 'Настройки', exact: true }).click();
    await expect(scroll).toHaveCSS('overflow-y', 'auto');
    await expect(scroll).toHaveJSProperty('scrollTop', 0);
    await expect(nav).toBeInViewport();
    await noOverflow(page);
  });

  test(`shared tokens update spacing, typography and controls at ${viewport.width}px`, async ({
    page,
  }): Promise<void> => {
    await page.setViewportSize(viewport);
    await setup(page);
    await page
      .getByRole('navigation', { name: 'Основные разделы' })
      .getByRole('link', { name: 'Настройки', exact: true })
      .click();
    await expect(page.getByRole('region', { name: 'Настройки', exact: true })).toBeVisible();
    await page.evaluate((): void => {
      const style = document.documentElement.style;

      style.setProperty('--ui-space-3', '16px');
      style.setProperty('--ui-page-gutter', '16px');
      style.setProperty('--ui-font-heading', '1.5rem');
      style.setProperty('--ui-section-font-size', '1.5rem');
      style.setProperty('--ui-control-height', '52px');
      style.setProperty('--ui-radius', '16px');
    });
    await expect(page.getByRole('main', { name: 'Настройки', exact: true })).toHaveCSS(
      'padding-left',
      '16px',
    );
    await expect(page.locator('.settings-page > .ui-page-header')).toHaveCount(1);
    await expect(page.locator('.settings-page > .ui-page-header h1')).toHaveCSS(
      'font-size',
      '24px',
    );
    const radii = await page
      .locator('.ui-card:not(.ui-page-surface)')
      .evaluateAll((elements): string[] =>
        elements.map((element): string => getComputedStyle(element).borderRadius),
      );

    const { length: radiiLength } = radii;

    expect(radiiLength).toBeGreaterThan(1);
    const { every: radiiEvery } = radii;

    expect(radiiEvery.bind(radii)((radius): boolean => radius === '16px')).toBe(true);
    await expect(page.locator('.ui-page-surface')).toHaveCSS('border-radius', '0px');
    await page.getByRole('button', { name: 'Выйти из аккаунта', exact: true }).click();
    const modal = page.getByRole('dialog', { name: 'Выйти из GChat?', exact: true });

    await expect(modal.getByRole('heading')).toHaveCSS('font-size', '24px');
    await expect(modal.getByRole('button', { name: 'Закрыть', exact: true })).toHaveCSS(
      'width',
      '52px',
    );
    await expect(modal.getByRole('button', { name: 'Закрыть', exact: true })).toHaveCSS(
      'height',
      '52px',
    );
    await noOverflow(page);
  });

  test(`main sections keep one outer layout at ${viewport.width}px`, async ({
    page,
  }, info): Promise<void> => {
    await page.setViewportSize(viewport);
    await setup(page);
    const nav = page.getByRole('navigation', { name: 'Основные разделы' });
    const frames = [];

    for (const section of ['Звонки', 'Диалоги', 'Настройки', 'Звонки']) {
      await nav.getByRole('link', { name: section, exact: true }).click();
      const content = page.getByRole('main', { name: section, exact: true });
      const surface = content.locator(':scope > .ui-page-surface');

      await expect(surface).toBeVisible();
      await expect(page.getByRole('banner', { name: 'Панель приложения' })).toHaveCount(0);
      await expect(page.getByRole('link', { name: /^Профиль:/ })).toHaveCount(0);
      await expect(page.locator('.app-shell')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
      await expect(page.locator('html')).toHaveCSS(
        'background-image',
        /radial-gradient.*linear-gradient/,
      );
      await expect(surface).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
      await expect(content.locator('.ui-page-header-section')).toHaveCSS(
        'background-color',
        'rgba(0, 0, 0, 0)',
      );
      await expect(surface).toHaveCSS('border-radius', '0px');
      await expect(surface).toHaveCSS('border-top-width', '0px');
      await expect(nav).toHaveCSS('background-color', 'rgb(244, 249, 252)');

      if (section === 'Настройки') {
        await expect(page.locator('.settings-page')).toHaveCSS(
          'background-color',
          'rgba(0, 0, 0, 0)',
        );
      }

      await expect(content.locator('.settings-heading, .panel-title')).toHaveCount(0);

      if (section === 'Диалоги') {
        const header = content.locator('.dialogs-sidebar > .ui-page-header');

        await expect(header.getByRole('heading', { name: 'Диалоги', exact: true })).toBeVisible();
        await expect(header.getByRole('link', { name: 'Написать сообщение' })).toHaveAttribute(
          'href',
          '/dialogs/contacts',
        );
        await expect(page.getByText('Пока нет диалогов', { exact: true })).toBeVisible();
        await page.screenshot({ path: info.outputPath('dialogs.png') });
      } else {
        await expect(content.locator('.dialogs-sidebar > .ui-page-header')).toHaveCount(0);
      }

      await expect(content).toHaveCSS('padding', '0px');
      const bounds = await surface.boundingBox();

      const { x: boundsX } = bounds!;

      expect(boundsX).toBe(0);
      const { width: boundsWidth } = bounds!;

      expect(boundsWidth).toBe(viewport.width);
      frames.push(
        await surface.evaluate((element): object => {
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);

          return {
            left: rect.left,
            top: rect.top,
            width: rect.width,
            radius: style.borderRadius,
            border: style.borderTopColor,
          };
        }),
      );
      await expect(nav).toBeInViewport();
      await noOverflow(page);
    }

    for (const frame of frames.slice(1)) {
      expect(frame).toEqual(frames[0]);
    }
  });

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
    await expect(page.getByRole('region', { name: 'Геопозиция', exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByRole('region', { name: 'Геопозиция', exact: true })).toBeVisible();
    await page.getByRole('link', { name: 'Назад', exact: true }).click();
    await page.getByRole('link', { name: /Файлы и папки/ }).click();
    const chooser = page.waitForEvent('filechooser');

    await page.getByRole('button', { name: 'Выбрать файл', exact: true }).click();
    const resolved = await chooser;
    const { setFiles: resultSetFiles } = resolved;

    await resultSetFiles.bind(resolved)({
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
    await expect(page.getByRole('region', { name: 'Основные', exact: true })).toBeVisible();
    await page.evaluate((): void => {
      document.documentElement.style.fontSize = '28px';
      document.body.style.zoom = '2';
    });
    await noOverflow(page);
    const back = page.getByRole('link', { name: 'Назад', exact: true });
    const bounds = await back.boundingBox();
    const menu = await page.getByRole('navigation', { name: 'Основные разделы' }).boundingBox();

    expect(bounds).not.toBeNull();
    expect(menu).not.toBeNull();
    const { y: boundsY } = bounds!;
    const { height: boundsHeight } = bounds!;
    const { y: menuY2 } = menu!;

    expect(boundsY + boundsHeight).toBeLessThanOrEqual(menuY2);
    expect(
      await back.evaluate((element): boolean => element.scrollWidth <= element.clientWidth),
    ).toBe(true);
    await page.screenshot({ path: info.outputPath('settings-large-text.png') });
  });
}

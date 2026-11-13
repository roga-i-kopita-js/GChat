import { expect, type Page, test } from '@playwright/test';

const me = '00000000-0000-4000-8000-000000000001';
const peer = '00000000-0000-4000-8000-000000000002';
const group = '00000000-0000-4000-8000-000000000003';
const callId = (value: number): string =>
  '10000000-0000-4000-8000-' + String(value).padStart(12, '0');

test.use({
  launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] },
  timezoneId: 'Europe/Nicosia',
});

async function setup(
  page: Page,
  options: { fail?: boolean; empty?: boolean; displayName?: string } = {},
): Promise<{ count(): number; fail(value: boolean): void; incoming(): void; finish(): void }> {
  await page.addInitScript(
    ({ me }) => {
      const now = Math.floor(Date.now() / 1000);

      localStorage.setItem(
        'gchat.session.v1',
        JSON.stringify({
          access_token:
            'e30.' +
            btoa(
              JSON.stringify({
                sub: me,
                sid: 'history-session',
                role: 'user',
                login: 'history',
                display_name: 'Test',
                iat: now,
                exp: now + 3600,
              }),
            ) +
            '.test',
          refresh_token: 'history-refresh',
          token_type: 'Bearer',
          deviceId: null,
          pending: null,
        }),
      );
    },
    { me },
  );
  const items = Array.from({ length: options.empty ? 0 : 42 }, (_, index) => ({
    call_id: callId(index + 1),
    version: 1,
    peer_id: peer,
    peer_display_name: options.displayName ?? 'Анна Смирнова',
    direction: 'incoming',
    outcome: index % 3 === 0 ? 'missed' : 'completed',
    created_at: new Date(Date.now() - index * 60000 - 30000).toISOString(),
    started_at: index % 3 === 0 ? null : new Date(Date.now() - index * 60000 - 25000).toISOString(),
    ended_at: new Date(Date.now() - index * 60000 - 10000).toISOString(),
    end_reason: index % 3 === 0 ? 'no_answer' : 'hangup',
    duration_seconds: index % 3 === 0 ? null : 15,
  }));
  let failed = options.fail ?? false;
  let creates = 0;
  let current: Record<string, unknown> | null = null;
  let finish = (): void => {};
  let incoming = (): void => {};

  await page.route(/^https?:\/\/[^/]+\/api\//, async (route): Promise<void> => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    let json: unknown;

    if (path === '/api/auth/ws-ticket') {
      json = { ticket: 'history-ticket', expires_at: new Date(Date.now() + 60000).toISOString() };
    } else if (path === '/api/groups') {
      json = { groups: [{ id: group, name: 'Семья' }] };
    } else if (path.endsWith('/members')) {
      json = { members: [{ id: peer, display_name: options.displayName ?? 'Анна Смирнова' }] };
    } else if (path === '/api/dialogs') {
      json = { dialogs: [], has_more: false };
    } else if (path === '/api/calls/history') {
      if (failed) {
        await route.fulfill({ status: 503, json: { error: { code: 'SERVICE_UNAVAILABLE' } } });

        return;
      }

      const filtered = items.filter(
        (item): boolean => url.searchParams.get('filter') !== 'missed' || item.outcome === 'missed',
      );
      const offset = Number(url.searchParams.get('cursor') ?? 0);

      json = {
        items: filtered.slice(offset, offset + 30),
        next_cursor: offset + 30 < filtered.length ? String(offset + 30) : null,
      };
    } else if (path.startsWith('/api/calls/history/')) {
      const item = items.find((item): boolean => item.call_id === path.split('/').at(-1));

      if (!item) {
        await route.fulfill({ status: 404, json: { error: { code: 'NOT_FOUND' } } });

        return;
      }

      json = { item };
    } else {
      await route.fulfill({ status: 503, json: {} });

      return;
    }

    await route.fulfill({ json });
  });
  await page.routeWebSocket('**/ws', (socket): void => {
    incoming = (): void => {
      current = {
        call_id: callId(100),
        state: 'ringing',
        version: 0,
        caller_id: peer,
        recipient_id: me,
        created_at: new Date().toISOString(),
        started_at: null,
        ended_at: null,
        end_reason: null,
        recovery_id: null,
        recovery_deadline: null,
        ringing_deadline: null,
        connecting_deadline: null,
      };
      socket.send(JSON.stringify({ type: 'call.updated', payload: { call: current } }));
    };
    finish = (): void => {
      const item = { ...items[0], call_id: callId(100), created_at: new Date().toISOString() };

      items.unshift(item);
      const ended = {
        call_id: item.call_id,
        state: 'ended',
        version: 1,
        caller_id: peer,
        recipient_id: me,
        created_at: item.created_at,
        started_at: null,
        ended_at: item.created_at,
        end_reason: 'no_answer',
        recovery_id: null,
        recovery_deadline: null,
        ringing_deadline: null,
        connecting_deadline: null,
      };

      current = ended;
      socket.send(JSON.stringify({ type: 'call.updated', payload: { call: ended } }));
      socket.send(JSON.stringify({ type: 'call.updated', payload: { call: ended } }));
    };
    socket.onMessage((message): void => {
      const command = JSON.parse(String(message));

      if (command.type === 'call.create') {
        creates++;
        current = {
          call_id: callId(200),
          state: 'ringing',
          version: 0,
          caller_id: me,
          recipient_id: peer,
          created_at: new Date().toISOString(),
          started_at: null,
          ended_at: null,
          end_reason: null,
          recovery_id: null,
          recovery_deadline: null,
          ringing_deadline: null,
          connecting_deadline: null,
        };
      }

      let payload: object = { call: current };

      if (command.type === 'device.register') {
        payload = { device_id: '00000000-0000-4000-8000-000000000099' };
      } else if (command.type === 'call.ice_config') {
        payload = { ice_servers: [], expires_at: new Date(Date.now() + 3600000).toISOString() };
      }

      socket.send(JSON.stringify({ type: 'response', request_id: command.request_id, payload }));
    });
  });

  return {
    count: (): number => creates,
    fail: (value): void => {
      failed = value;
    },
    incoming: (): void => incoming(),
    finish: (): void => finish(),
  };
}

for (const viewport of [
  { width: 360, height: 640 },
  { width: 390, height: 844 },
  { width: 430, height: 932 },
  { width: 1280, height: 900 },
]) {
  test(`history uses centered bordered filters and shows details at ${viewport.width}px`, async ({
    page,
  }, info) => {
    await page.setViewportSize(viewport);
    const control = await setup(page);
    const { count: controlResult1 } = control;

    await page.goto('/calls');
    await expect(page.locator('.history-row')).toHaveCount(30);
    await expect(page.getByRole('heading', { name: 'Звонки', exact: true })).toBeVisible();
    await expect(page.locator('.history-detail-panel')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Новый звонок' })).toHaveCount(0);

    if (viewport.width > 800) {
      const { x, width } = (await page
        .getByRole('region', { name: 'История звонков' })
        .boundingBox())!;

      expect(width).toBeLessThan(viewport.width);
      expect(Math.abs(x + width / 2 - viewport.width / 2)).toBeLessThan(1);
    }

    const filter = page.getByRole('group', { name: 'Фильтр истории звонков' });
    const style = await filter.evaluate((element): { centered: string; border: string } => ({
      centered: getComputedStyle(element).justifyContent,
      border: getComputedStyle(element.querySelector('a:not(.selected)')!).borderWidth,
    }));

    expect(style).toEqual({ centered: 'center', border: '1px' });
    await expect(
      page.locator('.history-row').first().getByText('Пропущенный', { exact: true }),
    ).toBeVisible();
    const links = page.getByRole('link', { name: /^Сведения о звонке:/ });

    await links.first().click();
    await expect(page.getByRole('region', { name: 'Сведения о звонке' })).toBeVisible();

    if (viewport.width > 800) {
      const { x, width } = (await page
        .getByRole('region', { name: 'История звонков' })
        .boundingBox())!;
      const { x: detailX } = (await page
        .getByRole('region', { name: 'Сведения о звонке' })
        .boundingBox())!;

      expect(x + width).toBeLessThanOrEqual(detailX);
    } else {
      await expect(page.getByRole('region', { name: 'История звонков' })).toBeHidden();
    }

    expect(controlResult1.bind(control)()).toBe(0);
    await page.screenshot({ path: info.outputPath('history-details.png') });
    await page
      .getByRole('link', { name: 'Звонки', exact: true })
      .filter({ has: page.locator('svg.lucide-chevron-left, svg.lucide-arrow-left') })
      .click();
    await expect(page).toHaveURL(/\/calls$/);
    await expect(page.locator('.history-detail-panel')).toHaveCount(0);
    await filter.getByRole('link', { name: 'Пропущенные', exact: true }).click();
    await expect(page.locator('.history-row')).toHaveCount(14);
    await expect(page.locator('.history-row:not(.history-missed)')).toHaveCount(0);
    expect(
      await page.evaluate((): boolean => document.documentElement.scrollWidth <= innerWidth),
    ).toBe(true);
    await page.screenshot({ path: info.outputPath('history-list.png') });
  });

  test(`history wraps long names with 200% text at ${viewport.width}px`, async ({ page }, info) => {
    await page.setViewportSize(viewport);
    const displayName = 'Анна Александровна ОченьДлиннаяНепрерывнаяФамилияДляПроверкиПереноса';

    await setup(page, { displayName });
    await page.goto('/calls');
    await expect(page.locator('.history-row')).toHaveCount(30);
    await page.evaluate((): void => {
      document.documentElement.style.fontSize = '200%';
    });
    const row = page.locator('.history-row').first();
    const name = row.locator('.user-card-name');

    await expect(name).toHaveText(displayName);
    const {
      nameHeight,
      nameLine,
      nameBottom,
      nameRight,
      subtitleTop,
      subtitleBottom,
      rowBottom,
      timeLeft,
      timeRight,
      redialLeft,
      redialWidth,
      redialHeight,
      avatarWidth,
      avatarHeight,
    } = await row.evaluate((element) => {
      const name = element.querySelector('.user-card-name')!;
      const subtitle = element.querySelector('.history-subtitle')!.getBoundingClientRect();
      const time = element.querySelector('.history-time')!.getBoundingClientRect();
      const redial = element.querySelector('.history-redial')!.getBoundingClientRect();
      const avatar = element.querySelector('.avatar')!.getBoundingClientRect();
      const nameBounds = name.getBoundingClientRect();

      return {
        nameHeight: nameBounds.height,
        nameLine: Number.parseFloat(getComputedStyle(name).lineHeight),
        nameBottom: nameBounds.bottom,
        nameRight: nameBounds.right,
        subtitleTop: subtitle.top,
        subtitleBottom: subtitle.bottom,
        rowBottom: element.getBoundingClientRect().bottom,
        timeLeft: time.left,
        timeRight: time.right,
        redialLeft: redial.left,
        redialWidth: redial.width,
        redialHeight: redial.height,
        avatarWidth: avatar.width,
        avatarHeight: avatar.height,
      };
    });

    expect(nameHeight).toBeGreaterThan(nameLine);
    expect(subtitleTop).toBeGreaterThanOrEqual(nameBottom);
    expect(subtitleBottom).toBeLessThanOrEqual(rowBottom);
    expect(nameRight).toBeLessThanOrEqual(timeLeft);
    expect(timeRight).toBeLessThanOrEqual(redialLeft);
    expect(redialWidth).toBeGreaterThanOrEqual(44);
    expect(redialHeight).toBeGreaterThanOrEqual(44);
    expect(avatarWidth).toBe(44);
    expect(avatarHeight).toBe(44);
    expect(
      await page.locator('.history-list').evaluate((element): boolean => {
        return element.scrollWidth <= element.clientWidth;
      }),
    ).toBe(true);
    expect(
      await page.evaluate((): boolean => document.documentElement.scrollWidth <= innerWidth),
    ).toBe(true);
    await page.screenshot({ path: info.outputPath('history-large-text.png') });
  });
}

test('loads older calls, preserves scroll on return and refreshes from a terminal event', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const control = await setup(page);
  const { incoming: controlResult2, finish: controlResult3 } = control;

  await page.goto('/calls');
  await expect(page.locator('.history-row')).toHaveCount(30);
  await page.getByRole('button', { name: 'Ещё звонки', exact: true }).click();
  await expect(page.locator('.history-row')).toHaveCount(42);
  const list = page.locator('.history-list');

  await list.evaluate((element): void => {
    element.scrollTop = 500;
  });
  await expect
    .poll(async (): Promise<number> => list.evaluate((element): number => element.scrollTop))
    .toBeGreaterThan(300);
  await page
    .getByRole('link', { name: /^Сведения о звонке:/ })
    .nth(10)
    .click();
  await page
    .getByRole('region', { name: 'Сведения о звонке' })
    .getByRole('link', { name: 'Звонки', exact: true })
    .click();
  await expect(page.locator('.history-row')).toHaveCount(42);
  await expect
    .poll(async (): Promise<number> => list.evaluate((element): number => element.scrollTop))
    .toBeGreaterThan(300);
  await page
    .getByRole('link', { name: /^Сведения о звонке:/ })
    .nth(10)
    .click();
  controlResult2.bind(control)();
  await expect(page.getByRole('dialog', { name: 'Входящий звонок', exact: true })).toBeVisible();
  controlResult3.bind(control)();
  await page.getByRole('button', { name: 'Вернуться к истории', exact: true }).click();
  await expect(page).toHaveURL(/\/calls$/);
  await expect(page.locator('.history-row')).toHaveCount(43);
  await expect(page.locator('.history-person').first()).toHaveAttribute(
    'href',
    '/calls/' + callId(100),
  );
});

test('confirms a redial once, can cancel it, and opens the common call screen', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const control = await setup(page);
  const { count: controlResult4 } = control;

  await page.goto('/calls');
  const redial = page
    .getByRole('button', { name: 'Позвонить: Анна Смирнова', exact: true })
    .first();

  await expect(redial).toBeEnabled();
  await redial.click();
  const dialog = page.getByRole('dialog', { name: 'Позвонить?', exact: true });

  await expect(dialog).toBeVisible();
  expect(controlResult4.bind(control)()).toBe(0);
  await dialog.getByRole('button', { name: 'Отмена', exact: true }).click();
  expect(controlResult4.bind(control)()).toBe(0);
  await redial.click();
  await dialog.getByRole('button', { name: 'Позвонить', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Отменить', exact: true })).toBeVisible();
  expect(controlResult4.bind(control)()).toBe(1);
  await page.getByRole('button', { name: 'История звонков', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Вернуться к звонку', exact: true })).toBeVisible();
});

test('keeps failures distinct from empty history and exposes contacts from dialogs', async ({
  page,
}) => {
  const control = await setup(page, { fail: true });
  const { fail: controlResult5 } = control;

  await page.goto('/calls');
  await expect(
    page.getByRole('alert').filter({ hasText: 'Не удалось загрузить историю' }),
  ).toBeVisible();
  await expect(page.getByText('Звонков пока нет', { exact: true })).toHaveCount(0);
  controlResult5.bind(control)(false);
  await page.getByRole('button', { name: 'Повторить', exact: true }).click();
  await expect(page.locator('.history-row')).toHaveCount(30);
  await page.getByRole('link', { name: 'Диалоги', exact: true }).click();
  await page.getByRole('link', { name: 'Написать сообщение', exact: true }).click();
  await expect(page).toHaveURL(/\/dialogs\/contacts$/);
  await expect(
    page.getByRole('button', { name: 'Позвонить: Анна Смирнова', exact: true }),
  ).toBeVisible();
  await page.goto('/calls/' + callId(999));
  await expect(page.getByRole('heading', { name: 'Звонок не найден', exact: true })).toBeVisible();
});

test('shows an empty account without introducing a new-call button', async ({ page }) => {
  await setup(page, { empty: true });
  await page.goto('/calls');
  await expect(page.getByRole('heading', { name: 'Звонков пока нет', exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Пропущенные', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Пропущенных звонков нет', exact: true }),
  ).toBeVisible();
});

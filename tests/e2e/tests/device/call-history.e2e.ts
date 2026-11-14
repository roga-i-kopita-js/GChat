import { expect, type Page, test } from '@playwright/test';

const me = '00000000-0000-4000-8000-000000000001';
const peer = '00000000-0000-4000-8000-000000000002';
const group = '00000000-0000-4000-8000-000000000003';
const dialogId = '00000000-0000-4000-8000-000000000004';
const secondPeer = '00000000-0000-4000-8000-000000000006';
const secondDialogId = '00000000-0000-4000-8000-000000000007';
const callId = (value: number): string =>
  '10000000-0000-4000-8000-' + String(value).padStart(12, '0');

test.use({
  launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] },
  timezoneId: 'Europe/Nicosia',
});

async function setup(
  page: Page,
  options: {
    fail?: boolean;
    empty?: boolean;
    displayName?: string;
    dialError?: boolean;
    listDialogs?: boolean;
    secondDialog?: boolean;
  } = {},
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
  const dialog = {
    dialog_id: dialogId,
    peer_id: peer,
    peer_display_name: options.displayName ?? 'Анна Смирнова',
    created_at: new Date().toISOString(),
    last_message_at: null,
    last_message: null,
    last_sequence: 0,
    last_edit_sequence: 0,
    last_read_sequence: 0,
    peer_last_read_sequence: 0,
    has_unread_messages: false,
  };
  const dialogs = options.listDialogs || options.secondDialog ? [dialog] : [];

  if (options.secondDialog) {
    dialogs.push({
      ...dialog,
      dialog_id: secondDialogId,
      peer_id: secondPeer,
      peer_display_name: 'Максим Орлов',
    });
  }

  const dialRecipient = options.secondDialog ? secondPeer : peer;

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
      json = { dialogs, has_more: false };
    } else if (path === '/api/dialogs/' + dialogId) {
      json = { dialog };
    } else if (path === `/api/dialogs/${dialogId}/permissions`) {
      json = { dialogs: { can_read: true, can_send: true } };
    } else if (path === `/api/dialogs/${dialogId}/messages`) {
      json = { messages: [], has_more: false };
    } else if (path === `/api/dialogs/${dialogId}/message-edits`) {
      json = { messages: [], next_edit_sequence: 0, has_more: false };
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
        expect(command.payload.recipient_id).toBe(dialRecipient);

        if (options.dialError) {
          socket.send(
            JSON.stringify({
              type: 'response',
              request_id: command.request_id,
              error: { code: 'FORBIDDEN', message: 'Forbidden' },
            }),
          );

          return;
        }

        current = {
          call_id: callId(200),
          state: 'ringing',
          version: 0,
          caller_id: me,
          recipient_id: dialRecipient,
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

for (const width of [360, 1280]) {
  test(`dialog list confirms a call for the selected contact at ${width}px`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: 844 });
    const { count } = await setup(page, { secondDialog: true });
    let messageReads = 0;

    page.on('request', (request) => {
      if (/\/api\/dialogs\/[^/]+\/(messages|read)/.test(new URL(request.url()).pathname)) {
        messageReads++;
      }
    });
    await page.goto('/dialogs');
    const sidebar = page.locator('.dialogs-sidebar');

    await expect(sidebar.locator('.dialog-contact')).toHaveCount(2);
    await expect(sidebar.getByRole('button', { name: /^Позвонить:/ })).toHaveCount(2);
    await expect(page.locator('a button')).toHaveCount(0);
    await page.screenshot({ path: info.outputPath('dialog-list-calls.png') });
    await sidebar.getByRole('button', { name: 'Позвонить: Анна Смирнова', exact: true }).click();
    const confirmation = page.getByRole('dialog', { name: 'Позвонить?', exact: true });

    await expect(confirmation).toContainText('Анна Смирнова');
    await confirmation.getByRole('button', { name: 'Отмена', exact: true }).click();
    await expect(confirmation).toHaveCount(0);
    await expect(page).toHaveURL('/dialogs');
    expect(count()).toBe(0);
    expect(messageReads).toBe(0);

    if (width > 800) {
      await sidebar.locator('.dialog-contact').filter({ hasText: 'Анна Смирнова' }).click();
      await page
        .getByRole('textbox', { name: 'Сообщение', exact: true })
        .fill('Сохранить черновик');
    }

    const originalPath = new URL(page.url()).pathname;
    const readsBeforeConfirmation = messageReads;

    await sidebar.getByRole('button', { name: 'Позвонить: Максим Орлов', exact: true }).click();
    await expect(confirmation).toContainText('Максим Орлов');
    await expect(page).toHaveURL(originalPath);
    expect(count()).toBe(0);
    expect(messageReads).toBe(readsBeforeConfirmation);
    await confirmation.getByRole('button', { name: 'Отмена', exact: true }).click();

    if (width > 800) {
      await expect(page.getByRole('textbox', { name: 'Сообщение', exact: true })).toHaveValue(
        'Сохранить черновик',
      );
    }

    await sidebar.getByRole('button', { name: 'Позвонить: Максим Орлов', exact: true }).click();
    await expect(
      confirmation.getByRole('button', { name: 'Позвонить', exact: true }),
    ).toBeEnabled();
    await confirmation.getByRole('button', { name: 'Позвонить', exact: true }).click();
    await expect(page).toHaveURL('/calls');
    await expect(page.getByRole('button', { name: 'Отменить', exact: true })).toBeVisible();
    expect(count()).toBe(1);
    await page.getByRole('link', { name: 'Диалоги', exact: true }).click();
    await sidebar.getByRole('button', { name: 'Вернуться к звонку', exact: true }).first().click();
    await expect(page).toHaveURL('/calls');
    expect(count()).toBe(1);
  });
}

test('dialog list closes call confirmation on an incoming call', async ({ page }) => {
  const { count, incoming } = await setup(page, { listDialogs: true });

  await page.goto('/dialogs');
  await page
    .locator('.dialogs-sidebar')
    .getByRole('button', { name: 'Позвонить: Анна Смирнова', exact: true })
    .click();
  await expect(page.getByRole('dialog', { name: 'Позвонить?', exact: true })).toBeVisible();
  incoming();
  await expect(page.getByRole('dialog', { name: 'Позвонить?', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Принять', exact: true })).toBeVisible();
  await expect(page).toHaveURL('/dialogs');
  expect(count()).toBe(0);
});

test('dialog list keeps a failed call in place without retrying', async ({ page }) => {
  const { count } = await setup(page, { listDialogs: true, dialError: true });

  await page.goto('/dialogs');
  const sidebar = page.locator('.dialogs-sidebar');

  await sidebar.getByRole('button', { name: 'Позвонить: Анна Смирнова', exact: true }).click();
  const confirmation = page.getByRole('dialog', { name: 'Позвонить?', exact: true });

  await expect(confirmation.getByRole('button', { name: 'Позвонить', exact: true })).toBeEnabled();
  await confirmation.getByRole('button', { name: 'Позвонить', exact: true }).click();
  await expect(sidebar.getByRole('alert')).toBeVisible();
  await expect(page).toHaveURL('/dialogs');
  await expect(confirmation).toHaveCount(0);
  expect(count()).toBe(1);
});

for (const width of [390, 1280]) {
  test(`dialog confirms a call before leaving the conversation at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    const { count } = await setup(page);

    await page.goto('/dialogs/' + dialogId);
    const composer = page.getByRole('textbox', { name: 'Сообщение', exact: true });

    await composer.fill('Сохранить черновик');
    const dial = page
      .getByRole('region', { name: 'Переписка', exact: true })
      .getByRole('button', { name: 'Позвонить: Анна Смирнова', exact: true });

    await dial.click();
    const confirmation = page.getByRole('dialog', { name: 'Позвонить?', exact: true });

    await expect(confirmation).toBeVisible();
    await expect(confirmation.getByText('Анна Смирнова', { exact: true })).toBeVisible();
    await expect(page).toHaveURL('/dialogs/' + dialogId);
    expect(count()).toBe(0);
    await confirmation.getByRole('button', { name: 'Отмена', exact: true }).click();
    await expect(confirmation).toHaveCount(0);
    await expect(page).toHaveURL('/dialogs/' + dialogId);
    await expect(composer).toHaveValue('Сохранить черновик');
    expect(count()).toBe(0);
    await dial.click();
    await expect(
      confirmation.getByRole('button', { name: 'Позвонить', exact: true }),
    ).toBeEnabled();
    await confirmation.getByRole('button', { name: 'Позвонить', exact: true }).click();
    await expect(page).toHaveURL('/calls');
    await expect(page.getByRole('button', { name: 'Отменить', exact: true })).toBeVisible();
    expect(count()).toBe(1);
    await page.goto('/dialogs/' + dialogId);
    await page
      .getByRole('region', { name: 'Переписка', exact: true })
      .getByRole('button', { name: 'Вернуться к звонку', exact: true })
      .click();
    await expect(page).toHaveURL('/calls');
    expect(count()).toBe(1);
  });
}

test('dialog closes call confirmation on an incoming call', async ({ page }) => {
  const { count, incoming } = await setup(page);

  await page.goto('/dialogs/' + dialogId);
  await page
    .getByRole('region', { name: 'Переписка', exact: true })
    .getByRole('button', { name: 'Позвонить: Анна Смирнова', exact: true })
    .click();
  await expect(page.getByRole('dialog', { name: 'Позвонить?', exact: true })).toBeVisible();
  incoming();
  await expect(page.getByRole('dialog', { name: 'Позвонить?', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Принять', exact: true })).toBeVisible();
  await expect(page).toHaveURL('/dialogs/' + dialogId);
  expect(count()).toBe(0);
});

test('dialog keeps a failed outgoing attempt in the conversation without retrying', async ({
  page,
}) => {
  const { count } = await setup(page, { dialError: true });

  await page.goto('/dialogs/' + dialogId);
  await page
    .getByRole('region', { name: 'Переписка', exact: true })
    .getByRole('button', { name: 'Позвонить: Анна Смирнова', exact: true })
    .click();
  const confirmation = page.getByRole('dialog', { name: 'Позвонить?', exact: true });

  await expect(confirmation.getByRole('button', { name: 'Позвонить', exact: true })).toBeEnabled();
  await confirmation.getByRole('button', { name: 'Позвонить', exact: true }).click();
  await expect(page.locator('.dialog-error[role="alert"]')).toBeVisible();
  await expect(page).toHaveURL('/dialogs/' + dialogId);
  await expect(confirmation).toHaveCount(0);
  expect(count()).toBe(1);
});

for (const viewport of [
  { width: 360, height: 640 },
  { width: 390, height: 844 },
  { width: 430, height: 932 },
  { width: 1280, height: 900 },
]) {
  test(`history uses winter underline filters and shows details at ${viewport.width}px`, async ({
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
    const style = await filter.evaluate((element) => {
      const selected = getComputedStyle(element.querySelector('a.selected')!);

      return {
        alignment: getComputedStyle(element).justifyContent,
        underline: selected.borderBottomWidth,
        underlineColor: selected.borderBottomColor,
        textColor: selected.color,
        background: selected.backgroundColor,
      };
    });

    expect(style).toEqual({
      alignment: 'flex-start',
      underline: '2px',
      underlineColor: 'rgb(36, 119, 173)',
      textColor: 'rgb(36, 119, 173)',
      background: 'rgba(0, 0, 0, 0)',
    });
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
      const detailPath = new URL(page.url()).pathname;

      await filter.getByRole('link', { name: 'Пропущенные', exact: true }).click();
      await expect(page).toHaveURL(detailPath + '?filter=missed');
      await expect(page.locator('.history-row:not(.history-missed)')).toHaveCount(0);
      await expect(page.getByRole('region', { name: 'Сведения о звонке' })).toBeVisible();
      await filter.getByRole('link', { name: 'Все', exact: true }).click();
      await expect(page).toHaveURL(detailPath);
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

test('winter tokens and decoration persist across navigation and respect reduced motion', async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => {
    const start = document.startViewTransition.bind(document);

    document.startViewTransition = (...args: Parameters<Document['startViewTransition']>) => {
      const root = document.documentElement;

      root.dataset.winterTransitions = String(Number(root.dataset.winterTransitions ?? 0) + 1);

      const transition = start(...args);

      void (async () => {
        try {
          await transition.ready;
          root.dataset.winterTransitionTargets = JSON.stringify(
            Array.from(document.querySelectorAll('.ui-page-surface, .history-list')).flatMap(
              (element) => {
                const name = getComputedStyle(element).viewTransitionName;

                return name && name !== 'none' ? [element.className] : [];
              },
            ),
          );
          const animations = document.getAnimations().flatMap((animation) => {
            const effect = animation.effect;

            if (
              !(effect instanceof KeyframeEffect) ||
              !effect.pseudoElement?.startsWith('::view-transition-')
            ) {
              return [];
            }

            const duration = effect.getTiming().duration;
            const transforms = effect
              .getKeyframes()
              .map((frame) =>
                String(frame.transform ?? '').replace(/^translate\(([^,]*)\)$/, 'translateX($1)'),
              );
            const easing = effect.getKeyframes()[0]?.easing;
            const name = animation instanceof CSSAnimation ? animation.animationName : '';

            const opacities = effect.getKeyframes().map((frame) => frame.opacity);

            return [
              { name, pseudo: effect.pseudoElement, duration, transforms, opacities, easing },
            ];
          });

          root.dataset.winterTransitionFrames = JSON.stringify(animations);
        } catch {
          root.dataset.winterTransitionFrames = '[]';
        }
      })();

      return transition;
    };
  });
  await setup(page);
  await page.goto('/calls');
  await expect(page.locator('.history-row')).toHaveCount(30);
  await expect(page.locator('.winter-weather')).toHaveAttribute('aria-hidden', 'true');
  await expect(page.locator('.winter-flake')).toHaveCount(10);
  await expect(page.locator('.winter-gust')).toHaveCount(0);
  const transitionsBeforeFiltering = await page.evaluate(() =>
    Number(document.documentElement.dataset.winterTransitions ?? 0),
  );

  for (const width of [390, 1280]) {
    await page.setViewportSize({ width, height: 844 });
    await expect(page.locator('.history-list')).toHaveCSS('scrollbar-width', 'thin');
    await expect(page.locator('.history-list')).toHaveCSS('scrollbar-gutter', 'stable');
    expect(
      await page.locator('.history-list').evaluate((element) => {
        const color = getComputedStyle(element).scrollbarColor;

        element.scrollTop = 100;
        const scrolled = element.scrollTop > 0;

        element.scrollTop = 0;

        return { transparentTrack: color.endsWith('rgba(0, 0, 0, 0)'), scrolled };
      }),
    ).toEqual({ transparentTrack: true, scrolled: true });
    await page.screenshot({ path: info.outputPath(`winter-calls-${width}.png`) });
    const headerBounds = await page.locator('.history-header').boundingBox();
    const filterBounds = await page.locator('.history-filter').boundingBox();
    const expectListFade = async (): Promise<void> => {
      await expect
        .poll(async () =>
          page.evaluate(() =>
            JSON.parse(document.documentElement.dataset.winterTransitionFrames ?? '[]'),
          ),
        )
        .toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              name: 'route-fade-in',
              duration: 210,
              transforms: ['', ''],
              opacities: ['0', '1'],
            }),
            expect.objectContaining({
              name: 'route-fade-out',
              duration: 210,
              transforms: ['', ''],
              opacities: ['1', '0'],
            }),
          ]),
        );
      expect(
        await page.evaluate(() =>
          JSON.parse(document.documentElement.dataset.winterTransitionTargets ?? '[]'),
        ),
      ).toEqual(['history-list']);
      expect(await page.locator('.history-header').boundingBox()).toEqual(headerBounds);
      expect(await page.locator('.history-filter').boundingBox()).toEqual(filterBounds);
    };

    await page.getByRole('link', { name: 'Пропущенные', exact: true }).click();
    await expect(page).toHaveURL(/\/calls\?filter=missed$/);
    await expect(page.locator('.history-row:not(.history-missed)')).toHaveCount(0);
    await expect(page.locator('.history-row')).not.toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Пропущенные', exact: true })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await expectListFade();
    await page.getByRole('link', { name: 'Пропущенные', exact: true }).click();
    await page.getByRole('link', { name: 'Все', exact: true }).click();
    await expect(page).toHaveURL(/\/calls$/);
    await expect(page.locator('.history-row')).toHaveCount(30);
    await expect(page.locator('.history-row:not(.history-missed)').first()).toBeVisible();
    await expectListFade();
  }

  expect(
    await page.evaluate(() => Number(document.documentElement.dataset.winterTransitions ?? 0)),
  ).toBe(transitionsBeforeFiltering + 4);
  await page.setViewportSize({ width: 390, height: 844 });
  await page
    .locator('.winter-weather')
    .evaluate((element) => element.setAttribute('data-persisted', 'true'));
  const originalAvatar = await page
    .locator('.history-row .avatar')
    .first()
    .getAttribute('data-tone');
  const navigationBounds = await page
    .getByRole('navigation', { name: 'Основные разделы' })
    .boundingBox();

  await expect(page.locator('.history-header h1')).toHaveCSS('font-size', '28px');
  await expect(page.locator('.history-row .avatar').first()).toHaveCSS('font-size', '13px');
  await page.screenshot({ path: info.outputPath('winter-calls.png') });
  await page.getByRole('link', { name: 'Диалоги', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Диалоги', exact: true })).toBeVisible();
  await expect
    .poll(async () =>
      page.evaluate(() => Number(document.documentElement.dataset.winterTransitions ?? 0)),
    )
    .toBeGreaterThan(0);
  await expect
    .poll(async () =>
      page.evaluate(() => {
        return JSON.parse(document.documentElement.dataset.winterTransitionFrames ?? '[]');
      }),
    )
    .toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'route-enter-right',
          duration: 210,
          easing: 'cubic-bezier(0.32, 0, 0.2, 1)',
          transforms: ['translateX(100%)', 'translateX(0%)'],
        }),
        expect.objectContaining({
          name: 'route-leave-left',
          duration: 210,
          easing: 'cubic-bezier(0.32, 0, 0.2, 1)',
          transforms: ['translateX(0%)', 'translateX(-100%)'],
        }),
      ]),
    );
  await expect(page.locator('.ui-page-surface')).toHaveCount(1);
  await expect(page.getByRole('navigation', { name: 'Основные разделы' })).toHaveCount(1);
  await expect(page.locator('.winter-weather')).toHaveAttribute('data-persisted', 'true');
  expect(await page.getByRole('navigation', { name: 'Основные разделы' }).boundingBox()).toEqual(
    navigationBounds,
  );
  const { leavingX, enteringX, width } = await page.evaluate(async () => {
    const animations = document.getAnimations().filter((animation) => {
      const effect = animation.effect;

      return (
        animation instanceof CSSAnimation &&
        effect instanceof KeyframeEffect &&
        effect.pseudoElement?.startsWith('::view-transition-')
      );
    });

    for (const animation of animations) {
      animation.pause();
      animation.currentTime = Number(animation.effect!.getTiming().duration) / 2;
    }

    await new Promise((resolve) => requestAnimationFrame(resolve));
    const offsets = animations.map((animation) => {
      const effect = animation.effect as KeyframeEffect;
      const style = getComputedStyle(document.documentElement, effect.pseudoElement);

      return {
        name: (animation as CSSAnimation).animationName,
        x: new DOMMatrixReadOnly(style.transform).m41,
      };
    });
    const { x: leavingX } =
      offsets.find((animation) => animation.name === 'route-leave-left') ?? {};
    const { x: enteringX } =
      offsets.find((animation) => animation.name === 'route-enter-right') ?? {};

    return { leavingX, enteringX, width: document.querySelector('.ui-page-surface')!.clientWidth };
  });

  expect(leavingX).toBeLessThan(-width / 2);
  expect(enteringX).toBeGreaterThan(0);
  expect(enteringX).toBeLessThan(width / 2);
  await page.screenshot({ path: info.outputPath('winter-dialogs.png') });
  await page.evaluate(() => {
    for (const animation of document.getAnimations()) {
      if (animation instanceof CSSAnimation && animation.animationName.startsWith('route-')) {
        animation.play();
      }
    }
  });
  await page.getByRole('link', { name: 'Звонки', exact: true }).click();
  await expect
    .poll(async () =>
      page.evaluate(() =>
        JSON.parse(document.documentElement.dataset.winterTransitionFrames ?? '[]'),
      ),
    )
    .toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'route-enter-left',
          duration: 210,
          transforms: ['translateX(-100%)', 'translateX(0%)'],
        }),
        expect.objectContaining({
          name: 'route-leave-right',
          duration: 210,
          transforms: ['translateX(0%)', 'translateX(100%)'],
        }),
      ]),
    );
  await page.evaluate(() => {
    document.documentElement.style.setProperty('--ui-view-transition-duration', '105ms');
    document.documentElement.style.setProperty('--ui-view-transition-easing', 'linear');
  });
  await page.getByRole('link', { name: 'Диалоги', exact: true }).click();
  await expect
    .poll(async () =>
      page.evaluate(() =>
        JSON.parse(document.documentElement.dataset.winterTransitionFrames ?? '[]'),
      ),
    )
    .toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'route-enter-right', duration: 105, easing: 'linear' }),
        expect.objectContaining({ name: 'route-leave-left', duration: 105, easing: 'linear' }),
      ]),
    );
  await page.evaluate(() => {
    document.documentElement.style.removeProperty('--ui-view-transition-duration');
    document.documentElement.style.removeProperty('--ui-view-transition-easing');
  });
  await page.getByRole('link', { name: 'Написать сообщение', exact: true }).click();
  await expect(page.locator('.user-card .avatar').first()).toHaveAttribute(
    'data-tone',
    originalAvatar!,
  );

  for (const name of ['Настройки', 'Звонки', 'Диалоги']) {
    await page
      .getByRole('navigation', { name: 'Основные разделы' })
      .getByRole('link', { name, exact: true })
      .click();
  }

  await expect(page).toHaveURL(/\/dialogs$/);
  await expect(page.getByRole('heading', { name: 'Диалоги', exact: true })).toBeVisible();
  await expect(page.locator('.ui-page-surface')).toHaveCount(1);

  await page.getByRole('link', { name: 'Настройки', exact: true }).click();

  for (const [link, path, entering, leaving] of [
    [/^Основные$/, /\/settings\/general$/, 'route-enter-right', 'route-leave-left'],
    [/^Динамики и звук/, /\/settings\/general\/audio$/, 'route-enter-right', 'route-leave-left'],
    [/^Назад$/, /\/settings\/general$/, 'route-enter-left', 'route-leave-right'],
    [/^Назад$/, /\/settings$/, 'route-enter-left', 'route-leave-right'],
  ] as const) {
    await page.evaluate(() => {
      document.documentElement.dataset.winterTransitionFrames = '[]';
    });
    await page.getByRole('link', { name: link }).click();
    await expect(page).toHaveURL(path);
    await expect
      .poll(async () =>
        page.evaluate(() =>
          JSON.parse(document.documentElement.dataset.winterTransitionFrames ?? '[]'),
        ),
      )
      .toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: entering }),
          expect.objectContaining({ name: leaving }),
        ]),
      );
  }

  await page.goBack();
  await expect(page).toHaveURL(/\/settings\/general$/);
  await expect(page.getByRole('region', { name: 'Основные', exact: true })).toBeVisible();
  await page.goForward();
  await expect(page).toHaveURL(/\/settings$/);
  await expect(page.getByRole('heading', { name: 'Настройки', exact: true })).toBeVisible();

  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(page.locator('.winter-flake').first()).toHaveCSS('animation-name', 'none');
  await page.getByRole('link', { name: 'Настройки', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Настройки', exact: true })).toBeVisible();
  await expect
    .poll(async () =>
      page.evaluate(
        () =>
          document
            .getAnimations()
            .filter(
              (animation) =>
                animation.playState === 'running' &&
                animation.effect?.getTiming().iterations !== Infinity,
            ).length,
      ),
    )
    .toBe(0);
  const { y: headingY } = (await page
    .getByRole('heading', { name: 'Настройки', exact: true })
    .boundingBox())!;

  expect(headingY).toBeGreaterThanOrEqual(28);
  await page.screenshot({ path: info.outputPath('winter-settings.png') });
  await page.evaluate(() => {
    document.documentElement.style.setProperty('--ui-accent', 'rgb(20, 80, 110)');
  });
  await expect(page.locator('.bottom-tab.active')).toHaveCSS('color', 'rgb(20, 80, 110)');
  await expect(page.locator('.ui-page-header-motif')).toHaveCSS('color', 'rgb(20, 80, 110)');
  await page.getByRole('link', { name: 'Звонки', exact: true }).click();
  await expect(page.locator('.history-filter-button.selected')).toHaveCSS(
    'color',
    'rgb(20, 80, 110)',
  );
  await page.getByRole('button', { name: 'Позвонить: Анна Смирнова', exact: true }).first().click();
  const dialog = page.getByRole('dialog', { name: 'Позвонить?', exact: true });

  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Отмена', exact: true }).click();
  await expect(dialog).toHaveCount(0);
});

test('navigation and call controls remain available without View Transitions', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(document, 'startViewTransition', {
      value: undefined,
      configurable: true,
    });
  });
  const control = await setup(page);

  await page.goto('/calls');
  await expect(page.locator('.history-row')).toHaveCount(30);
  await page.getByRole('link', { name: 'Диалоги', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Диалоги', exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Настройки', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Настройки', exact: true })).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/\/dialogs$/);
  await page.goForward();
  await expect(page).toHaveURL(/\/settings$/);
  const { incoming: showIncoming } = control;

  showIncoming.bind(control)();
  await expect(page.getByRole('dialog', { name: 'Входящий звонок', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Принять', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Отклонить', exact: true })).toBeEnabled();
});

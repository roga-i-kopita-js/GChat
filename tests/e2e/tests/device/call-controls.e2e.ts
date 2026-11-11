import { expect, type Page, test } from '@playwright/test';

const caller = '00000000-0000-4000-8000-000000000001';
const recipient = '00000000-0000-4000-8000-000000000002';

test.use({
  launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] },
  viewport: { width: 390, height: 844 },
});

async function setup(
  page: Page,
  outputSupport: 'all' | 'select' | 'none' | 'mediaOnly' = 'select',
): Promise<(state: string) => void> {
  let current: Record<string, unknown> | null = null;
  let update = (_state: string): void => {};

  await page.addInitScript(
    ({ caller, outputSupport }) => {
      const now = Math.floor(Date.now() / 1000);
      const claims = {
        sub: caller,
        sid: 'call-controls',
        login: 'test',
        display_name: 'Test',
        role: 'admin',
        iat: now,
        exp: now + 3600,
      };

      localStorage.setItem(
        'gchat.session.v1',
        JSON.stringify({
          access_token: 'e30.' + btoa(JSON.stringify(claims)) + '.test',
          refresh_token: 'test-refresh',
          token_type: 'Bearer',
          deviceId: null,
          pending: null,
        }),
      );
      const outputs = ['Динамики', 'Гарнитура'].map((label, index) => ({
        deviceId: 'output-' + index,
        kind: 'audiooutput',
        groupId: 'group-' + index,
        label,
        toJSON: (): object => ({}),
      }));

      navigator.mediaDevices.enumerateDevices = async (): Promise<MediaDeviceInfo[]> =>
        outputs as MediaDeviceInfo[];
      // Exercise real device/client routing with a recorded hardware boundary.
      const selected: string[] = [];

      Object.assign(window, { selectedOutputs: selected });
      Object.defineProperty(navigator.mediaDevices, 'selectAudioOutput', {
        configurable: true,
        writable: true,
        value: undefined,
      });
      Object.assign(window, { wakeRequests: 0, wakeReleases: 0 });
      Object.defineProperty(navigator, 'wakeLock', {
        configurable: true,
        value: {
          request: async (): Promise<object> => {
            Reflect.set(window, 'wakeRequests', Reflect.get(window, 'wakeRequests') + 1);
            const sentinel = Object.assign(new EventTarget(), {
              released: false,
              release: async (): Promise<void> => {
                sentinel.released = true;
                Reflect.set(window, 'wakeReleases', Reflect.get(window, 'wakeReleases') + 1);
                sentinel.dispatchEvent(new Event('release'));
              },
            });

            return sentinel;
          },
        },
      });
      HTMLMediaElement.prototype.setSinkId = async (id): Promise<void> => {
        if (id === 'output-1' && sessionStorage.getItem('fail-output')) {
          throw new DOMException('Disconnected', 'NotFoundError');
        }

        selected.push(id);
      };
      Object.defineProperty(AudioContext.prototype, 'setSinkId', {
        configurable: true,
        value: async (id: string): Promise<void> => {
          selected.push(id);
        },
      });

      if (outputSupport === 'all') {
        Object.assign(navigator.mediaDevices, {
          selectAudioOutput: async (): Promise<never> => {
            throw new DOMException('Cancelled', 'NotAllowedError');
          },
        });
      }

      if (outputSupport === 'none') {
        Object.defineProperty(HTMLMediaElement.prototype, 'setSinkId', {
          configurable: true,
          value: undefined,
        });
      }

      if (outputSupport === 'none' || outputSupport === 'mediaOnly') {
        Object.defineProperty(AudioContext.prototype, 'setSinkId', {
          configurable: true,
          value: undefined,
        });
      }

      if (outputSupport === 'none') {
        // A picker without renderer support cannot apply the chosen output.
        Object.assign(navigator.mediaDevices, {
          selectAudioOutput: async (): Promise<never> => {
            throw new Error('Unsupported picker must not be called');
          },
        });
      }
    },
    { caller, outputSupport },
  );
  await page.route(/^https?:\/\/[^/]+\/api\//, async (route) => {
    const path = new URL(route.request().url()).pathname;
    let json: unknown;

    if (path === '/api/auth/ws-ticket') {
      json = {
        ticket: 'call-controls-ticket',
        expires_at: new Date(Date.now() + 60000).toISOString(),
      };
    } else if (path === '/api/groups') {
      json = { groups: [] };
    } else if (path === '/api/admin/users') {
      json = {
        users: [
          { id: recipient, display_name: 'Анна', login: 'anna', role: 'user', status: 'active' },
        ],
        total: 1,
      };
    } else {
      await route.fulfill({ status: 503, json: {} });

      return;
    }

    await route.fulfill({ json });
  });
  await page.routeWebSocket('**/ws', (socket) => {
    update = (state): void => {
      current = { ...current, state, version: Number(current?.version ?? 0) + 1 };

      if (state === 'ended') {
        current.ended_at = new Date().toISOString();
        current.end_reason = 'hangup';
      }

      socket.send(JSON.stringify({ type: 'call.updated', payload: { call: current } }));
    };
    socket.onMessage((message) => {
      const command = JSON.parse(String(message));

      if (command.type === 'call.create') {
        current = {
          call_id: crypto.randomUUID(),
          state: 'ringing',
          version: 1,
          caller_id: caller,
          recipient_id: recipient,
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
      } else if (command.type === 'call.ping') {
        payload = { ...current };
      }

      socket.send(JSON.stringify({ type: 'response', request_id: command.request_id, payload }));
    });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Позвонить: Анна', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Заблокировать', exact: true })).toBeVisible();
  update('connecting');
  await expect(page.getByRole('button', { name: 'Микрофон', exact: true })).toBeVisible();

  return (state): void => update(state);
}

test('screen protection intercepts taps and Escape and unlocks only with a full swipe or keyboard', async ({
  page,
}, testInfo) => {
  const update = await setup(page);
  const lock = page.getByRole('dialog', { name: 'Экран заблокирован от случайных нажатий' });

  for (const width of [360, 390, 430, 1280]) {
    await page.setViewportSize({ width, height: width === 360 ? 640 : 844 });
    const card = page.locator('.call-card');
    const lockButton = card.getByRole('button', { name: 'Заблокировать', exact: true });

    await expect(lockButton).toBeVisible();
    await expect(page.getByRole('button', { name: 'Аудиовыход', exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: testInfo.outputPath(`call-${width}.png`) });
  }

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Заблокировать', exact: true }).click();
  await expect(lock).toBeVisible();
  await lock.click({ position: { x: 20, y: 20 } });
  await page.keyboard.press('Escape');
  await lock.getByRole('button', { name: 'Разблокировать экран', exact: true }).click();
  await expect(lock).toBeVisible();
  const thumb = lock.getByRole('button', { name: 'Разблокировать экран', exact: true });
  const box = await thumb.boundingBox();

  if (!box) {
    throw new Error('Missing unlock control');
  }

  const { x, y, width, height } = box;

  await page.mouse.move(x + width / 2, y + height / 2);
  await page.mouse.down();
  await page.mouse.move(x + width, y + height / 2);
  await page.mouse.up();
  await expect(lock).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('protected.png') });
  await page.mouse.move(x + width / 2, y + height / 2);
  await page.mouse.down();
  await page.mouse.move(x + 280, y + height / 2, { steps: 10 });
  await page.mouse.up();
  await expect(lock).toHaveCount(0);
  await page.getByRole('link', { name: 'Настройки', exact: true }).click();
  await page.getByRole('link', { name: /Вернуться к звонку/ }).click();
  await page.getByRole('button', { name: 'Заблокировать', exact: true }).click();
  await page.goBack();
  await expect(page).toHaveURL(/\/settings$/);
  await expect(lock).toBeVisible();
  await thumb.focus();
  await page.keyboard.press('Enter');
  await expect(lock).toHaveCount(0);
  expect(await page.evaluate(() => Reflect.get(window, 'wakeRequests'))).toBe(1);
  expect(await page.evaluate(() => Reflect.get(window, 'wakeReleases'))).toBe(0);
  await page.getByRole('link', { name: /Вернуться к звонку/ }).click();
  await page.getByRole('button', { name: 'Заблокировать', exact: true }).click();
  update('ended');
  await expect(lock).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Заблокировать', exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => Reflect.get(window, 'wakeReleases'))).toBe(1);
});

test('audio output switches the call renderer, reports errors, and hides unsupported pickers', async ({
  page,
}, testInfo) => {
  const update = await setup(page);

  await page.getByRole('button', { name: 'Аудиовыход', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Аудиовыход', exact: true });

  await dialog.getByRole('button', { name: 'Гарнитура', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Гарнитура', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(dialog).toContainText('Сейчас: Гарнитура');
  expect(await page.evaluate(() => Reflect.get(window, 'selectedOutputs'))).toContain('output-1');
  await dialog.getByRole('button', { name: 'Динамики', exact: true }).click();
  await expect(dialog).toContainText('Сейчас: Динамики');
  await page.evaluate(() => sessionStorage.setItem('fail-output', '1'));
  await dialog.getByRole('button', { name: 'Гарнитура', exact: true }).click();
  await expect(dialog.getByRole('alert')).toBeVisible();
  await expect(dialog).toContainText('Сейчас: Динамики');
  await expect(dialog.getByRole('button', { name: 'Системный выбор', exact: true })).toHaveCount(0);
  await expect(dialog).toContainText('Системный выбор в этом браузере недоступен');
  await page.screenshot({ path: testInfo.outputPath('audio-output.png') });
  update('ended');
  await expect(dialog).toHaveCount(0);
});

test('picker cancellation is quiet and a late picker cannot change output after closing', async ({
  page,
}) => {
  await setup(page, 'all');
  await page.getByRole('button', { name: 'Аудиовыход', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Аудиовыход', exact: true });

  await page.evaluate(() => {
    Object.assign(navigator.mediaDevices, {
      selectAudioOutput: async (): Promise<never> => {
        throw new DOMException('Cancelled', 'NotAllowedError');
      },
    });
  });
  await dialog.getByRole('button', { name: 'Системный выбор', exact: true }).click();
  await expect(dialog.getByRole('alert')).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: 'Системный выбор', exact: true })).toBeEnabled();
  await page.evaluate(() => {
    Object.assign(navigator.mediaDevices, {
      selectAudioOutput: (): Promise<object> =>
        new Promise((resolve) => {
          Object.assign(window, {
            finishPicker: (): void => resolve({ deviceId: 'output-1', label: 'Гарнитура' }),
          });
        }),
    });
  });
  await dialog.getByRole('button', { name: 'Системный выбор', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Гарнитура', exact: true })).toBeDisabled();
  await dialog.getByRole('button', { name: 'Закрыть', exact: true }).click();
  await page.evaluate(() => Reflect.get(window, 'finishPicker')());
  await page.getByRole('button', { name: 'Аудиовыход', exact: true }).click();
  await expect(dialog).toContainText('Сейчас: Системный выход');
  expect(await page.evaluate(() => Reflect.get(window, 'selectedOutputs'))).toEqual([]);
  await page.evaluate(() => {
    Object.assign(navigator.mediaDevices, {
      selectAudioOutput: async (): Promise<object> => ({
        deviceId: 'output-1',
        label: 'Гарнитура',
      }),
    });
  });
  await dialog.getByRole('button', { name: 'Системный выбор', exact: true }).click();
  await expect(dialog).toContainText('Сейчас: Гарнитура');
  expect(await page.evaluate(() => Reflect.get(window, 'selectedOutputs'))).toContain('output-1');
});

for (const support of ['none'] as const) {
  test(`unsupported output routing (${support}) shows system guidance without failed actions`, async ({
    page,
  }) => {
    const update = await setup(page, support);

    await page.getByRole('button', { name: 'Аудиовыход', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Аудиовыход', exact: true });

    await expect(dialog).toContainText('Этот браузер не поддерживает смену аудиовыхода из GChat');
    await expect(dialog.getByRole('button', { name: 'Системный выбор', exact: true })).toHaveCount(
      0,
    );
    await expect(dialog.getByRole('button', { name: 'Гарнитура', exact: true })).toHaveCount(0);
    await expect(dialog.getByRole('alert')).toHaveCount(0);
    expect(await page.evaluate(() => Reflect.get(window, 'selectedOutputs'))).toEqual([]);
    await dialog.getByRole('button', { name: 'Закрыть', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Микрофон', exact: true })).toBeEnabled();
    await expect(page.getByRole('button', { name: 'Включить звук', exact: true })).toHaveCount(0);
    update('active');
    await expect(page.getByRole('button', { name: 'Завершить', exact: true })).toBeEnabled();
    await page.goto('/settings/general/audio');
    await expect(page.getByRole('button', { name: 'Выбрать аудиовыход', exact: true })).toHaveCount(
      0,
    );
    await expect(
      page.getByText('Системный выбор аудиовыхода из GChat в этом браузере недоступен.', {
        exact: false,
      }),
    ).toBeVisible();
  });
}

test('disconnecting the selected output returns the call to the system route', async ({ page }) => {
  await setup(page);
  await page.getByRole('button', { name: 'Аудиовыход', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Аудиовыход', exact: true });

  await dialog.getByRole('button', { name: 'Гарнитура', exact: true }).click();
  await expect(dialog).toContainText('Сейчас: Гарнитура');
  await page.evaluate(() => {
    navigator.mediaDevices.enumerateDevices = async (): Promise<MediaDeviceInfo[]> => [];
    navigator.mediaDevices.dispatchEvent(new Event('devicechange'));
  });
  await expect(dialog).toContainText('Сейчас: Системный выход');
  await expect(dialog.getByRole('button', { name: 'Гарнитура', exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => Reflect.get(window, 'selectedOutputs').at(-1))).toBe('');
});

test('Safari-style media-element routing offers real outputs without AudioContext.setSinkId', async ({
  page,
}) => {
  await setup(page, 'mediaOnly');
  await page.getByRole('button', { name: 'Аудиовыход', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Аудиовыход', exact: true });

  await expect(dialog.getByRole('button', { name: 'Системный выбор', exact: true })).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Гарнитура', exact: true }).click();
  await expect(dialog).toContainText('Сейчас: Гарнитура');
  await expect(dialog.getByRole('alert')).toHaveCount(0);
  expect(await page.evaluate(() => Reflect.get(window, 'selectedOutputs'))).toContain('output-1');
  await dialog.getByRole('button', { name: 'Закрыть', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Включить звук', exact: true })).toHaveCount(0);
  const routed = await page.evaluate(async (): Promise<boolean> => {
    const path = '/src/shared/calls/context-output.ts';
    const { ContextOutput } = await import(path);
    const context = new AudioContext();
    const output = new ContextOutput(context);

    try {
      await output.start();
      await output.select('output-1');

      return (
        output.destination instanceof MediaStreamAudioDestinationNode && context.state === 'running'
      );
    } finally {
      output.dispose();
      await context.close();
    }
  });

  expect(routed).toBe(true);
});

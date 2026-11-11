import { expect, type Page, test } from '@playwright/test';

const me = '00000000-0000-4000-8000-000000000001';
const peer = '00000000-0000-4000-8000-000000000002';

async function setup(
  page: Page,
  compatible = true,
  options: { initialPath?: string; navigationDelayMs?: number } = {},
): Promise<void> {
  await page.addInitScript(
    ({ me, peer, compatible, options }) => {
      const listeners = new Map<string, (event: unknown) => void>();
      const commands: { method: string; args: unknown }[] = [];
      let cycleId = '';
      let muted = false;
      let call: Record<string, unknown> | null = null;
      const ui = { loginSeen: false, waiting: false, restoreDelayMs: 0 };

      new MutationObserver(() => {
        if (document.querySelector('input[name="login"]')) {
          ui.loginSeen = true;
        }
      }).observe(document, { childList: true, subtree: true });
      const emit = (name: string, data: object): void =>
        listeners.get(name)?.({ cycleId, ...data });
      const update = (state: string, outgoing = call?.caller_id === me): void => {
        call = {
          call_id:
            call?.state === 'ended' && state === 'ringing'
              ? crypto.randomUUID()
              : (call?.call_id ?? '00000000-0000-4000-8000-000000000010'),
          caller_id: outgoing ? me : peer,
          recipient_id: outgoing ? peer : me,
          state,
          version: Number(call?.version ?? 0) + 1,
          created_at: new Date().toISOString(),
          started_at: state === 'active' ? new Date().toISOString() : null,
          ended_at: state === 'ended' ? new Date().toISOString() : null,
          end_reason: state === 'ended' ? 'hangup' : null,
          recovery_id: null,
          recovery_deadline: null,
          ringing_deadline: null,
          connecting_deadline: null,
        };
        emit('callStateChanged', { call });
        emit('callRuntimeChanged', {
          status: {
            status: 'online',
            muted,
            selected: state !== 'ended' && (state !== 'ringing' || outgoing),
          },
        });
      };
      const methods = [
        'getCapabilities',
        'webReady',
        'getAccessToken',
        'httpRequest',
        'httpCancel',
        'navigationReady',
        'completeNavigation',
        'executeDeviceCommand',
        'mediaCommand',
        'acceptCall',
        'endCall',
        'setCallMuted',
      ];
      const token =
        'e30.' +
        btoa(
          JSON.stringify({
            sub: me,
            sid: 'native-call-screen',
            role: 'user',
            login: 'test',
            display_name: 'Test',
            iat: Math.floor(Date.now() / 1000),
            exp: Math.floor(Date.now() / 1000) + 3600,
          }),
        ) +
        '.test';
      const request = async (
        _plugin: string,
        method: string,
        args: Record<string, unknown>,
      ): Promise<unknown> => {
        if (method === 'getCapabilities') {
          return {
            bridgeVersion: 1,
            platform: 'ios',
            nativeAuth: true,
            nativeCalls: true,
            httpVersion: 1,
            navigationVersion: 1,
            mediaVersion: 1,
            ...(compatible ? { webCallControls: true } : {}),
          };
        }

        if (method === 'webReady') {
          cycleId = String(args.cycleId);
          ui.waiting = true;

          if (ui.restoreDelayMs) {
            await new Promise((resolve) => setTimeout(resolve, ui.restoreDelayMs));
          }

          emit('route', { path: '/calls', accessToken: token });
          emit('callSnapshot', { call, runtime: { status: 'online', muted, selected: true } });
          ui.waiting = false;
        } else if (method === 'navigationReady') {
          const cycle = String(args.cycleId);

          setTimeout(() => {
            listeners.get('navigationCommand')?.({
              navigationVersion: 1,
              cycleId: cycle,
              requestId: crypto.randomUUID(),
              command: 'navigate',
              args: { to: '/calls', replace: true },
            });
          }, options.navigationDelayMs ?? 0);
        } else if (method === 'httpRequest') {
          const input = args.request as { url: string };
          const path = new URL(input.url).pathname;
          const data =
            path === '/api/groups'
              ? { groups: [{ id: 'family', name: 'Семья' }] }
              : { members: [{ id: peer, display_name: 'Анна' }] };

          return {
            httpVersion: 1,
            cycleId: args.cycleId,
            requestId: args.requestId,
            result: {
              status: 200,
              statusText: 'OK',
              headers: [['Content-Type', 'application/json']],
              bodyBase64: btoa(
                String.fromCharCode(...new TextEncoder().encode(JSON.stringify(data))),
              ),
              url: input.url,
            },
          };
        } else if (method === 'mediaCommand') {
          const command = args.command;
          let result: object = { outcome: 'completed' };

          if (command === 'camera.current') {
            result = {
              sourceId: null,
              call: false,
              state: {
                facing: 'front',
                status: 'released',
                recording: 'idle',
                format: null,
                error: null,
              },
            };
          } else if (command === 'audio.state') {
            result = { volume: { level: null }, output: null, outputs: null };
          } else if (command === 'audio.pick') {
            commands.push({ method, args });
            result = { outcome: 'cancelled', output: null };
          }

          return { mediaVersion: 1, cycleId: args.cycleId, requestId: args.requestId, result };
        } else if (method === 'executeDeviceCommand') {
          return {
            deviceBridgeVersion: 1,
            cycleId: args.cycleId,
            requestId: args.requestId,
            error: { code: 'UNSUPPORTED' },
          };
        } else if (['acceptCall', 'endCall', 'setCallMuted'].includes(method)) {
          commands.push({ method, args });

          if (method === 'acceptCall') {
            update('active');
          } else if (method === 'endCall') {
            update('ended');
          } else {
            muted = Boolean(args.muted);
            emit('callRuntimeChanged', { status: { status: 'online', muted, selected: true } });
          }
        }

        return undefined;
      };

      Object.assign(window, {
        GChatRuntime: 'native',
        nativeTest: {
          update,
          commands,
          ui,
          logout: (): void => {
            emit('loggedOut', {});
            emit('route', { path: '/login' });
            emit('navigationCommand', {
              navigationVersion: 1,
              requestId: crypto.randomUUID(),
              command: 'navigate',
              args: { to: '/login', replace: true },
            });
          },
        },
        Capacitor: {
          PluginHeaders: [
            {
              name: 'GChat',
              methods: [
                ...methods.map((name) => ({ name, rtype: 'promise' })),
                { name: 'addListener', rtype: 'callback' },
                { name: 'removeListener', rtype: 'promise' },
              ],
            },
          ],
          nativePromise: request,
          nativeCallback: (
            _plugin: string,
            method: string,
            args: { eventName: string },
            callback: (event: unknown) => void,
          ): string => {
            if (method === 'addListener') {
              listeners.set(args.eventName, callback);
            }

            return args.eventName;
          },
        },
      });
      navigator.mediaDevices.getUserMedia = async (): Promise<never> => {
        throw new Error('Native UI opened browser media');
      };
      window.WebSocket = class {
        constructor() {
          throw new Error('Native UI opened browser signaling');
        }
      } as unknown as typeof WebSocket;
    },
    { me, peer, compatible, options },
  );
  await page.goto(options.initialPath ?? '/calls');
  await expect(page.getByRole('button', { name: 'Позвонить: Анна', exact: true })).toBeVisible();
  await page.evaluate(() => Reflect.get(window, 'nativeTest').update('ringing'));
}

for (const viewport of [
  { width: 360, height: 640 },
  { width: 390, height: 844 },
  { width: 430, height: 932 },
  { width: 1280, height: 900 },
]) {
  test(`native calls use the shared incoming and active screen at ${viewport.width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize(viewport);
    await setup(page);
    const incoming = page.getByRole('dialog', { name: 'Входящий звонок', exact: true });

    await expect(incoming.getByRole('heading', { name: 'Анна', exact: true })).toBeVisible();
    await expect(incoming.getByRole('button', { name: 'Принять', exact: true })).toBeInViewport();
    await expect(incoming.getByRole('button', { name: 'Отклонить', exact: true })).toBeInViewport();
    await page.screenshot({ path: testInfo.outputPath('native-incoming.png') });
    await incoming.getByRole('button', { name: 'Принять', exact: true }).click();
    await expect(incoming).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Завершить', exact: true })).toBeInViewport();
    await expect(page.getByRole('button', { name: 'Микрофон', exact: true })).toBeEnabled();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: testInfo.outputPath('native-active.png') });
    await page.getByRole('button', { name: 'Микрофон', exact: true }).click();
    await expect(
      page.getByRole('button', { name: 'Включить микрофон', exact: true }),
    ).toHaveAttribute('aria-pressed', 'true');
    await page.getByRole('button', { name: 'Аудиовыход', exact: true }).click();
    const audio = page.getByRole('dialog', { name: 'Аудиовыход', exact: true });

    await audio.getByRole('button', { name: 'Системный выбор', exact: true }).click();
    await expect(audio.getByRole('alert')).toHaveCount(0);
    await audio.getByRole('button', { name: 'Закрыть', exact: true }).click();
    await page.getByRole('button', { name: 'Заблокировать', exact: true }).click();
    await expect(
      page.getByRole('dialog', { name: 'Экран заблокирован от случайных нажатий' }),
    ).toBeVisible();
    // A system/remote end also removes Web protection.
    await page.evaluate(() => Reflect.get(window, 'nativeTest').update('ended'));
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await page.getByRole('button', { name: 'Вернуться к контактам', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Позвонить: Анна', exact: true })).toBeVisible();
    await page.evaluate(() => Reflect.get(window, 'nativeTest').update('ringing'));
    await page.getByRole('button', { name: 'Отклонить', exact: true }).click();
    const commands = await page.evaluate(() => Reflect.get(window, 'nativeTest').commands);

    const { map: mapCommands } = commands;
    const [first] = commands;

    expect(mapCommands.bind(commands)((value: { method: string }) => value.method)).toEqual([
      'acceptCall',
      'setCallMuted',
      'mediaCommand',
      'endCall',
    ]);
    const { args } = first;

    expect(args.callId).toBe('00000000-0000-4000-8000-000000000010');
    expect(args.cycleId).toBeTruthy();
  });
}

test('an older iOS shell shows update guidance and disables unsupported call actions', async ({
  page,
}) => {
  await setup(page, false);
  await expect(page.getByRole('button', { name: 'Принять', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Отклонить', exact: true })).toBeDisabled();
  await expect(page.getByRole('dialog', { name: 'Входящий звонок', exact: true })).toContainText(
    'Обновите приложение',
  );
  expect(await page.evaluate(() => Reflect.get(window, 'nativeTest').commands)).toEqual([]);
});

test('the native outgoing screen offers cancel through the same end command', async ({ page }) => {
  await setup(page);
  await page.getByRole('button', { name: 'Отклонить', exact: true }).click();
  await page.getByRole('button', { name: 'Вернуться к контактам', exact: true }).click();
  await page.evaluate(() => Reflect.get(window, 'nativeTest').update('ringing', true));
  await expect(page.getByRole('dialog', { name: 'Входящий звонок', exact: true })).toHaveCount(0);
  await expect(page.getByTestId('call-status')).toHaveText('Вызываем…');
  await page.getByRole('button', { name: 'Отменить', exact: true }).click();
  await expect(page.getByTestId('call-status')).toHaveText('Разговор завершён');
  const { commands } = await page.evaluate(() => Reflect.get(window, 'nativeTest'));
  const [decline, cancel] = commands;

  expect(decline.method).toBe('endCall');
  expect(cancel.method).toBe('endCall');
  expect(decline.args.callId).not.toBe(cancel.args.callId);
});

test('a saved native session never mounts the login form while applying the initial route', async ({
  page,
}) => {
  await setup(page, true, { initialPath: '/login', navigationDelayMs: 400 });
  await expect(page).toHaveURL(/\/calls$/);
  expect(await page.evaluate(() => Reflect.get(window, 'nativeTest').ui.loginSeen)).toBe(false);
});

test('foreground session restoration keeps the route and does not mount login before confirmed logout', async ({
  page,
}) => {
  await setup(page);
  await page.evaluate(() => {
    Reflect.get(window, 'nativeTest').ui.restoreDelayMs = 400;
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect
    .poll(() => page.evaluate(() => Reflect.get(window, 'nativeTest').ui.waiting))
    .toBe(true);
  await expect(page).toHaveURL(/\/calls$/);
  await expect(page.getByRole('dialog', { name: 'Входящий звонок', exact: true })).toBeVisible();
  expect(await page.evaluate(() => Reflect.get(window, 'nativeTest').ui.loginSeen)).toBe(false);
  // Ending a call lets the real logout route display the form without an incoming overlay.
  await page.evaluate(() => {
    const { update, logout } = Reflect.get(window, 'nativeTest');

    update('ended');
    logout();
  });
  await expect(page.getByRole('heading', { name: 'Вход в GChat', exact: true })).toBeVisible();
  await expect(page.locator('input[name="login"]')).toBeVisible();
});

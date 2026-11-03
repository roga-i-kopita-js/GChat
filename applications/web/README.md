# GChat Web

Полноценный браузерный клиент: вход, группы и собеседники, входящие и исходящие голосовые звонки, микрофон, восстановление и выход. [Контракт клиента](../../docs/web/README.md) и [карта документации](../../docs/README.md).

## Разработка с настроенным backend

Из корня репозитория, с версиями Node/pnpm из `.nvmrc` и `package.json`:

```sh
pnpm install
pnpm --filter @gchat/web dev
```

Vite принимает `http://127.0.0.1:5173` и проксирует `/api` и `/ws` на backend `http://127.0.0.1:3000`. Другой backend задаётся переменной процесса `GCHAT_BACKEND_URL` при запуске Vite. Прокси сохраняет браузерный Origin. В backend нужно явно включить origin страницы в `SIGNALING_BROWSER_ORIGINS`.

Для рабочего окружения соберите `pnpm --filter @gchat/web build`, разместите `dist/` на HTTPS-origin и настройте reverse proxy: `/api/*` передаётся в backend без префикса `/api`, `/ws` — с upgrade и исходным Origin. Остальные клиентские пути получают `index.html`. Backend отдельно настраивается по своему README; TURN должен быть доступен клиентским устройствам.

## Изолированный локальный стенд

Стенд использует отдельный Compose-проект `gchat-web-test`, PostgreSQL 17, Redis 8.2 и coturn. Он предназначен для двух браузеров на этом же компьютере. Порты 55439, 56389, 53479 и диапазон UDP 55000–55039 должны быть свободны. Существующий backend Compose и legacy Mattermost/Jitsi не используются.

```sh
pnpm --filter @gchat/backend build
docker compose -f applications/web/tests/compose.yml up -d --wait
node applications/backend/scripts/web-test-fixtures.mjs
```

Fixture-скрипт обращается только к специальной локальной БД `gchat_web_test`, применяет миграции и добавляет группу «Близкие» с тремя аккаунтами. Логины: `anna`, `maxim`, `elena`. Пароль каждого: `gchat-web-test-password`. Это открытые тестовые данные, их нельзя использовать для рабочего контура.

В первом терминале:

```sh
node applications/backend/scripts/web-test-server.mjs
```

Во втором:

```sh
GCHAT_BACKEND_URL=http://127.0.0.1:3300 pnpm --filter @gchat/web dev
```

Откройте `http://127.0.0.1:5173` в двух независимых профилях/контекстах браузера и войдите разными пользователями. Обычная вторая вкладка того же профиля использует ту же сессию; она не является вторым собеседником. Чтобы перенести управление в другую вкладку вне разговора, используйте «Открыть здесь».

Генерируемые ключи и конфигурация сохраняются в игнорируемом `.local/`, не печатаются в лог и не коммитятся. APNs-ключ в стенде синтетический: VoIP-токены не регистрируются, запросов в Apple в браузерных тестах нет. Рабочий контракт Push не отключается. Loopback-реле coturn разрешено только в изолированном стенде; этот Compose не является production-конфигурацией TURN.

Повторная генерация fixture-конфигурации меняет тестовые ключи: перезапустите backend и войдите заново. Для остановки нажмите Ctrl+C в обоих терминалах и выполните:

```sh
docker compose -f applications/web/tests/compose.yml down --volumes
```

## Проверки

```sh
pnpm --filter @gchat/web typecheck
pnpm --filter @gchat/web build
pnpm --filter @gchat/web test
```

Для браузерных тестов нужен запущенный изолированный стенд, backend на 3300 и Vite на 5173:

```sh
pnpm --filter @gchat/web exec playwright install chromium
pnpm --filter @gchat/web test:e2e
```

E2E использует настоящий HTTP/WSS backend, PostgreSQL, Redis, coturn и PeerConnection. Chromium работает с искусственным микрофоном; проверяются relay-маршрут, входящие/исходящие RTP-счётчики, микрофон, дополнительная вкладка, перезагрузка и завершение. Отдельный мобильный viewport проверяет пользовательский сценарий и отклонение. Это не тест реального микрофона, слышимости человеком, Safari, мобильной ОС или приёма при закрытом браузере.

Перед каждым E2E-сценарием скрипт очищает только звонки и их Redis-проекции в специальном `gchat_web_test`. Эти тесты не направляются на произвольный backend; контур для них фиксирован в `tests/compose.yml`. Артефакты тестов содержат только данные стенда и сохраняются в игнорируемом `test-results/`.

## Форматирование и линтинг

Как и backend, веб-клиент использует Prettier и Oxlint из корня workspace с общими `.prettierrc.json` и `.oxlintrc.json`. Отдельные версии инструментов и копии правил в приложении не создаются. Команды ниже выполняются из корня и проверяют только веб-приложение:

```sh
pnpm --filter @gchat/web lint
pnpm --filter @gchat/web lint:fix
```

`lint` запускает Oxlint без допустимых предупреждений, затем Prettier в режиме проверки. `lint:fix` выполняет Prettier → Oxlint с исправлениями → Prettier. Форматирование включает TypeScript/TSX, CSS, HTML, JSON, YAML и Markdown. Генерируемые `dist/`, `.local/`, `test-results/`, `playwright-report/` и зависимости исключены через `.gitignore` приложения и корневой `.prettierignore`.

Инструменты можно запускать отдельно:

```sh
pnpm --filter @gchat/web format
pnpm --filter @gchat/web format:check
pnpm --filter @gchat/web style:check
pnpm --filter @gchat/web style:fix
```

Общие правила сохраняются: сортировка импортов, пустые строки между смысловыми блоками, явные возвращаемые типы TypeScript-функций; `any` и утверждения типов разрешены только в тестах. Корневой lint-staged также обрабатывает staged-файлы веб-клиента. Команды линтинга не заменяют typecheck и тесты.

## Сессия и ограничения

Один браузерный профиль использует сохранённую сессию и device binding. Токены и незавершённый запрос refresh находятся в localStorage; они доступны скриптам того же origin. Не подключайте сторонние скрипты к клиентскому origin. Web Locks сериализует ротацию и выбирает одну вкладку-владельца WSS/микрофона; BroadcastChannel передаёт остальным безопасное состояние UI. Выход из профиля действует на все его вкладки.

После перезагрузки браузер может потребовать явное включение звука. Для работы вне localhost требуется HTTPS. Оповещения доступны в открытом клиенте; Web Push, PWA, фоновый/закрытый браузер и iOS-интеграция требуют отдельных решений и проверок. Клиент рассчитан на браузеры с Web Locks, BroadcastChannel и WebRTC; текущие автоматические проверки выполняются в Chromium.

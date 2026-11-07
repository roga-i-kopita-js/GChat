# Запуск GChat Backend

Серверный workspace-пакет. [Архитектура](../../docs/architecture/system.md), [правила разработки](AGENTS.md), [контракты](../../docs/README.md).

## Запуск приложения

Версии Node.js и pnpm — в package.json и .nvmrc. Для локальных зависимостей нужен запущенный Docker Engine / Docker Desktop с Compose v2 и поддержкой `--wait`. Из корня монорепозитория:

```sh
pnpm install
cp applications/backend/.env.example applications/backend/.env
pnpm --filter @gchat/backend db:up
# Перед первым запуском настройте ключи Auth и примените миграции (см. ниже).
pnpm --filter @gchat/backend start:dev
```

Если `.env` уже существует, пропустите команду копирования и добавьте нужные переменные из примера. `db:up` запускает локальные PostgreSQL и Redis и ждёт готовности обеих зависимостей. Приложение читает `applications/backend/.env` при запуске через команды пакета. Переменные процесса имеют приоритет.

## Настройка HTTP Auth

Срок жизни access JWT задаётся `AUTH_ACCESS_TOKEN_TTL_SECONDS` в `.env`, по умолчанию 120 секунд. Например, `AUTH_ACCESS_TOKEN_TTL_SECONDS=15` сокращает срок до 15 секунд; после изменения перезапустите backend. Это не TTL серверной сессии: её правила и поведение при смене срока JWT описаны в [Auth](../../docs/backend/modules/auth.md#конфигурация).

До запуска HTTP заполните обязательные ключи из `.env.example`. Для локальной разработки команда ниже генерирует новый комплект и печатает строки для ручного переноса в `.env`. Вывод содержит секреты; не сохраняйте его в Git или обычные логи. В production используйте защищённую конфигурацию и отдельные ключи окружения.

```sh
node --input-type=module <<'JS'
import { generateKeyPairSync, randomBytes } from 'node:crypto';
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const kid = 'local-1';
console.log('AUTH_PASSWORD_PEPPER=' + randomBytes(32).toString('base64'));
console.log(`AUTH_JWT_ACTIVE_KID=${kid}`);
console.log('AUTH_JWT_PRIVATE_KEY=' + JSON.stringify(privateKey.export({ type: 'pkcs8', format: 'pem' })));
console.log('AUTH_JWT_PUBLIC_KEYS=' + JSON.stringify({ [kid]: publicKey.export({ type: 'spki', format: 'pem' }) }));
console.log(`AUTH_ROTATION_ACTIVE_KID=${kid}`);
console.log('AUTH_ROTATION_KEYS=' + JSON.stringify({ [kid]: randomBytes(32).toString('base64') }));
JS
```

Pepper обязателен и независим от ключей JWT. Старые хеши без pepper больше не принимаются; пароли нужно задать заново через `AuthCrypto.hashPassword`. Правила хранения, смены секрета и отзыва существующих сессий — в [контракте Auth](../../docs/backend/modules/auth.md#пароли-и-pepper). Для существующего E2E-стенда повторите `fixtures` после сборки backend.

Перед первым запуском примените схему аккаунтов отдельной командой:

```sh
pnpm --filter @gchat/backend build
pnpm --filter @gchat/backend db:migrate
```

Административный API `/admin` реализован в [Backoffice](../../docs/backend/modules/backoffice.md). Сессии, результаты ротации и WS-билеты хранятся в PostgreSQL. После обновления выполните `build` и `db:migrate` перед запуском сервера. Совместимость с прежними Redis-сессиями не предусмотрена. Параметры токенов, лимиты и правила смены ключей — в [контракте Auth](../../docs/backend/modules/auth.md). HTTP Guard экспортируется из AuthModule и подключается к защищённым контроллерам через `@UseGuards(AuthGuard)`; проверенная личность доступна в `request.user`.

Первый и последующие администраторы создаются только отдельной командой после сборки:

```sh
pnpm --filter @gchat/backend admin:create --display-name "Администратор" --login admin
pnpm --filter @gchat/backend admin:create --display-name "Администратор семьи" --login family-admin --group "Family"
```

Пароль вводится скрыто в интерактивном терминале. CLI не принимает пароль или роль аргументами и не управляет существующими аккаунтами. Создание обычных пользователей выполняется через API бэк-офиса. Правила — в [Auth](../../docs/backend/modules/auth.md#cli).

Тесты бэкофиса включаются через `BACKOFFICE_INTEGRATION_DATABASE_URL` и `BACKOFFICE_INTEGRATION_REDIS_URL`. Они используют отдельную временную БД и случайный префикс Redis; требуются права создавать и удалять БД. Используйте выделенные тестовые зависимости. Запуск: `pnpm --filter @gchat/backend test --watchman=false --runTestsByPath test/backoffice.integration.spec.ts`.

Интеграционные тесты Auth включаются только при одновременном задании `AUTH_INTEGRATION_DATABASE_URL` и `AUTH_INTEGRATION_REDIS_URL`. PostgreSQL-пользователю нужны права создавать и удалять тестовую БД. Тест создаёт отдельную случайную БД, применяет миграции и удаляет её после проверки; Redis использует отдельный случайный префикс и удаляет только свои ключи. Используйте выделенные тестовые зависимости.

## DirectCalls, WSS и APNs

Backend содержит Devices, DirectCalls, Signaling и Push. Для браузерного клиента также реализованы `GET /groups`, `GET /groups/:group_id/members` и `POST /auth/ws-ticket`. Точный браузерный origin включается в `SIGNALING_BROWSER_ORIGINS`; пустой список запрещает выдачу/погашение билетов. [Запуск веб-клиента и изолированного стенда](../web/README.md). Перед запуском примените миграции и заполните параметры TURN и APNs из `.env.example`. TURN должен быть отдельным coturn GChat с совпадающим shared secret; backend выдаёт временные credentials, аудио не обрабатывает. Приватный ключ APNs храните вне репозитория. Без обязательной конфигурации backend не запускается. TLS для `/ws` завершает reverse proxy; локальный сервер принимает WS по HTTP-порту приложения.

WS-конверты и команды определены в [DirectCalls](../../docs/backend/modules/direct-calls/README.md) и [Signaling](../../docs/backend/modules/signaling.md). Обычные тесты APNs подменяют транспорт и не отправляют уведомления. Реальные iPhone, PushKit/CallKit и маршрут аудио через coturn проверяются отдельно.

Интеграционные тесты звонков включаются только при `CALLS_INTEGRATION_DATABASE_URL` и `CALLS_INTEGRATION_REDIS_URL`. Используйте выделенные тестовые зависимости: тест создаёт и удаляет случайную БД и собственный префикс Redis. PostgreSQL-пользователю нужны права создания и удаления БД.

## Сборка и проверки

Команды выполняются из корня репозитория. Версии инструментов задаются package.json и .nvmrc.

```sh
pnpm --filter @gchat/backend typecheck
pnpm --filter @gchat/backend build
pnpm --filter @gchat/backend test --watchman=false
```

start собирает и запускает один раз; start:dev пересобирает при изменениях, start:prod запускает dist после build. Обычные тесты используют подменённые зависимости. Интеграционные тесты включаются отдельными переменными, описанными в контрактах миграций и RedLock.

## Форматирование

Настройки Prettier обязательны. Общая проверка кода и конфигурации — `pnpm lint`: Oxlint проверяет правила, затем Prettier проверяет соответствие `.prettierrc.json`. Любое нарушение завершает команду с ошибкой. `pnpm lint:fix` применяет Prettier, исправления Oxlint и повторно Prettier. Markdown, HTML и CSS проверяются отдельно через `pnpm format:check <пути>` либо lint-staged.

Пустая строка обязательна перед `return` и `throw`, вокруг `if`, `switch`, циклов и `try`, а также после объявлений переменных перед следующей операцией. Последовательные объявления переменных могут оставаться вместе. Смысловые границы между однотипными действиями отделяются вручную; Prettier сохраняет одну пустую строку.

Для выбранных файлов из корня запускайте готовые CLI напрямую: `pnpm style:fix <файлы кода>` сортирует импорты и добавляет пустые строки между методами, вокруг классов и экспортируемых объявлений; `pnpm format <файлы>` применяет Prettier. Проверки без изменения файлов — `pnpm style:check <файлы кода>` и `pnpm format:check <файлы>`. Конфигурация — `.oxlintrc.json` и `.prettierrc.json`.

В TypeScript-коде приложения обязательны возвращаемые типы у функций и методов, включая callbacks; запрещены явный `any` и утверждения типов (`as Type`, включая `as unknown as Type`, и `<Type>value`). Возвращаемые типы обязательны и в тестах. В тестах (`*.spec.ts`, `*.test.ts`, каталоги `test` и `tests`) разрешены явный `any` и касты, включая `as unknown as Type`. Сортировка импортов действует везде.

```sh
pnpm format applications/backend/src/auth/auth.service.ts
pnpm style:fix applications/backend/src/auth/auth.service.ts
```

`pnpm format:staged` запускает lint-staged для файлов, уже добавленных в индекс Git. Для кода выполняются Prettier → Oxlint → Prettier: сначала нормализуется раскладка кода, затем применяются правила и сортируются импорты, после чего выравнивается результат автоисправлений; для Markdown, JSON, YAML, CSS и HTML — Prettier. Исправления включаются в индекс стандартным механизмом lint-staged. Незакоммиченные файлы вне индекса эта команда не выбирает; новые файлы нужно сначала добавить через `git add`. Git hooks автоматически не устанавливаются.

## Проверка приложения

```sh
curl http://127.0.0.1:3000/health
curl -i http://127.0.0.1:3000/ready
```

Адрес и порт задаются окружением. [Контракт healthcheck](../../docs/backend/modules/healthcheck.md) определяет ответы и границы этих проверок. [OpenAPI](../../docs/backend/openapi.md) описывает UI и JSON-спецификацию.

## Локальные PostgreSQL и Redis

[docker-compose.yml](docker-compose.yml) поднимает PostgreSQL 17 и Redis 8.2 ([официальный образ](https://hub.docker.com/_/redis)). Требуются запущенный Docker Engine / Docker Desktop и Docker Compose v2 с поддержкой `--wait`.

Из корня репозитория создайте локальный файл настроек:

```sh
cp applications/backend/.env.example applications/backend/.env
pnpm --filter @gchat/backend db:up
```

`.env` исключён из Git. Значения из примера предназначены для локальной разработки. База доступна на `127.0.0.1:5433`, имя базы и пользователь — `gchat`. `DATABASE_URL` в примере предназначен для backend, запущенного на хосте, и используется пулом PostgreSQL. При изменении `POSTGRES_*` обновите его вручную; специальные символы в логине и пароле для URL нужно кодировать.

Порт можно изменить через `POSTGRES_PORT`. Публикация ограничена loopback-интерфейсом. Имя Compose-проекта `gchat-backend` отделяет контейнеры, сеть и volume от корневого Compose с Mattermost / Jitsi.

Команды из корня:

```sh
pnpm --filter @gchat/backend db:ps
pnpm --filter @gchat/backend db:logs
pnpm --filter @gchat/backend db:down
```

`db:up` ждёт успешного healthcheck. `db:down` останавливает и удаляет контейнеры, сохраняя данные в именованных volumes PostgreSQL и Redis. Изменение имени базы, пользователя или пароля в `.env` не перенастраивает уже инициализированную БД: эти параметры применяются при первом создании хранилища.

Для проверки конфигурации без запуска контейнера из корня:

```sh
docker compose --env-file applications/backend/.env.example -f applications/backend/docker-compose.yml config --quiet
```

Redis доступен только на `127.0.0.1:6379`, порт меняется через `REDIS_PORT`. Пароль задаётся в `REDIS_PASSWORD`; адрес для приложения — в `REDIS_URL`. При изменении пароля или порта обновите URL вручную, кодируя специальные символы пароля. Внутри сети Compose адрес Redis — `redis:6379`, PostgreSQL — `postgres:5432`.

Redis использует постоянный volume `redis-data`, AOF с `appendfsync always` и политику `noeviction`. Лимит `REDIS_MAXMEMORY` по умолчанию равен `256mb`; это лимит данных Redis, а не всей памяти контейнера. Healthcheck проверяет авторизованный PING. Команды `db:up`, `db:down`, `db:ps` и `db:logs` обслуживают обе зависимости; `db:up` ждёт готовности обеих.

Настройки `REDIS_*` используются RedisModule; `REDLOCK_*` используются RedlockModule. AuthModule подключает RedlockModule.forFeature() только для фоновой очистки; транзакции сессий и CLI не используют Redis-блокировки. Отдельный контейнер Redlock не нужен. См. [RedisModule](../../docs/backend/modules/redis.md) и [RedlockModule](../../docs/backend/modules/redlock.md).

Проверка Redis без вывода пароля (из корня репозитория):

```sh
docker compose --env-file applications/backend/.env -f applications/backend/docker-compose.yml exec redis sh -ec 'REDISCLI_AUTH="$REDIS_PASSWORD" redis-cli ping'
```

Ожидаемый ответ — `PONG`. `db:down` сохраняет данные; не используйте `down -v` для обычного перезапуска. Восстановление PostgreSQL с сессиями и Redis с состоянием звонков требует процедур из профильных контрактов.

## Работа со схемой БД

[Миграции PostgreSQL](../../docs/backend/operations/migrations.md) — единая инструкция генерации, сборки, применения и поставки SQL. Применение выполняется отдельной командой перед запуском новой версии, а не при старте HTTP-сервера.

## Восстановление

При неизвестной актуальности Redis сначала читайте [правила восстановления](../../docs/backend/operations/recovery.md). Обычный перезапуск сохраняет volumes; удаление томов не является штатным способом восстановления доступа.

## Генерация HTTP-клиента

[Контракт backend-api](../../docs/packages/backend-api.md) описывает пакет, команды экспорта и проверки актуальности схемы. `pnpm api:generate` из корня собирает backend и обновляет снимок OpenAPI и SDK; `pnpm api:check` проверяет их без изменения файлов. `pnpm --filter @gchat/backend openapi:test` сравнивает автономный документ с документом HTTP-приложения из одной сборки. Внешняя инфраструктура для этих команд не нужна.

## Диалоги

[DialogsModule](../../docs/backend/modules/dialogs/README.md) реализует REST-диалоги 1х1, серверное шифрование истории, прочтение и best-effort уведомления. Перед запуском примените миграции и задайте DIALOGS_ENCRYPTION_KEYS / DIALOGS_ACTIVE_KEY_ID по контракту; ключи должны иметь независимую резервную копию. Мигратор их не получает. Проверка восстановленной истории после build: `pnpm --filter @gchat/backend dialogs:verify`. Интеграционные тесты и границы эксплуатационной приёмки описаны в контракте.

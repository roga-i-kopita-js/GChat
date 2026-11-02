# GChat Backend

Workspace-проект `@gchat/backend`: базовое NestJS 12-приложение на TypeScript (ESM / NodeNext) с HTTP-сервером Express, конфигурацией окружения и отдельным модулем healthcheck.

- [Технологический стек](../../docs/backend/README.md): TypeScript, NestJS, PostgreSQL, Drizzle ORM / Drizzle Kit, WebSocket, WebRTC / coturn и APNs.
- [Настройки репозитория](../../docs/repository-settings/README.md).
- [Обзор приложения](../../docs/application-overview.md).

Исходники и конфигурация сервера размещаются здесь. Документация архитектуры остаётся в `docs/backend`.

## Запуск приложения

Требуются Node.js 24.15+ (ветка 24.x) и pnpm 10.33.0. Из корня монорепозитория:

```sh
pnpm install
cp applications/backend/.env.example applications/backend/.env
pnpm --filter @gchat/backend start:dev
```

Если `.env` уже существует, сохраните его и добавьте нужные переменные из примера. Приложение читает `applications/backend/.env` при запуске через команды пакета. Переменные процесса имеют приоритет.

По умолчанию сервер слушает `127.0.0.1:3000`. Параметры `HOST` и `PORT` переопределяют адрес и порт; некорректный `PORT` останавливает запуск. `DATABASE_URL` обязателен и проверяется при старте; его отсутствие или неверный формат останавливают приложение. Соединения с PostgreSQL создаются по запросу, поэтому недоступная БД не мешает запуску HTTP-сервера. Для доступа извне, например с телефона в локальной сети, можно задать `HOST=0.0.0.0`.

```sh
curl http://127.0.0.1:3000/health
```

Ожидаемый ответ: `{"status":"ok","service":"gchat-backend"}`. Это liveness-проверка HTTP-приложения: она не обращается к PostgreSQL и продолжает возвращать 200 при отказе БД.

Для readiness запустите PostgreSQL командой `pnpm --filter @gchat/backend db:up` и выполните:

```sh
curl -i http://127.0.0.1:3000/ready
```

| Endpoint | Проверка | Ответ |
| --- | --- | --- |
| `GET /health` | HTTP-приложение работает | 200, `{"status":"ok","service":"gchat-backend"}` |
| `GET /ready` | Новый запрос `SELECT 1` через Drizzle / PostgreSQL | 200, `{"status":"ok","service":"gchat-backend","checks":{"database":"up"}}` |
| `GET /ready` при ошибке БД | Ошибка подключения, запроса или таймаут | 503, `{"status":"error","service":"gchat-backend","checks":{"database":"down"}}` |

Результат readiness не кешируется. Ошибка подключения и секреты не включаются в HTTP-ответ. Для пула заданы лимит 5 соединений, ожидание соединения до 2 секунд и таймаут запроса 2 секунды; суммарно проверка может занять около 4 секунд. Пул закрывается при завершении приложения. Readiness проверяет только доступность БД, без проверки схемы и миграций. Корневой URL и бизнес-маршруты пока возвращают 404.

Команды из корня:

```sh
pnpm --filter @gchat/backend build
pnpm --filter @gchat/backend typecheck
pnpm --filter @gchat/backend test
pnpm --filter @gchat/backend start:prod
```

`start:dev` пересобирает приложение при изменениях. `start` собирает и запускает один раз. `start:prod` запускает `dist/main.js` после `build`. Nest CLI установлен локально, глобальная установка не нужна. Тесты Jest / Supertest проверяют HTTP через Nest-модули и реальный слой Drizzle с подменённым пулом: успешную проверку БД, отказ, восстановление, независимость liveness и закрытие пула. Рабочая БД для этих тестов не требуется.

```text
src/
  main.ts                    # Запуск HTTP-сервера и обработка завершения
  app.module.ts              # Корневой модуль и ConfigModule
  config/environment.ts      # Значения по умолчанию и проверка окружения
  database/                  # Пул PostgreSQL, Drizzle и управление подключением
  healthcheck/               # HealthcheckModule, GET /health и GET /ready
test/
  app.e2e.spec.ts             # HTTP smoke-тесты
```

Авторизация, контакты, звонки, схема БД, Drizzle Kit / миграции, WebSocket и push ещё не реализованы. `DatabaseModule` экспортирует `DatabaseService` с Drizzle-клиентом для следующих модулей.

## Локальная PostgreSQL

[docker-compose.yml](docker-compose.yml) поднимает только PostgreSQL 17. Требуются запущенный Docker Engine / Docker Desktop и Docker Compose v2 с поддержкой `--wait`.

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

`db:up` ждёт успешного healthcheck. `db:down` останавливает и удаляет контейнеры, сохраняя данные в именованном volume. Изменение имени базы, пользователя или пароля в `.env` не перенастраивает уже инициализированную БД: эти параметры применяются при первом создании хранилища.

Для проверки конфигурации без запуска контейнера из корня:

```sh
docker compose --env-file applications/backend/.env.example -f applications/backend/docker-compose.yml config --quiet
```

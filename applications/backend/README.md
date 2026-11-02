# Запуск GChat Backend

Серверный workspace-пакет. [Архитектура](../../docs/architecture/system.md), [правила разработки](AGENTS.md), [контракты](../../docs/README.md).

## Запуск приложения

Версии Node.js и pnpm — в package.json и .nvmrc. Для локальных зависимостей нужен запущенный Docker Engine / Docker Desktop с Compose v2 и поддержкой `--wait`. Из корня монорепозитория:

```sh
pnpm install
cp applications/backend/.env.example applications/backend/.env
pnpm --filter @gchat/backend db:up
pnpm --filter @gchat/backend start:dev
```

Если `.env` уже существует, пропустите команду копирования и добавьте нужные переменные из примера. `db:up` запускает локальные PostgreSQL и Redis и ждёт готовности обеих зависимостей. Приложение читает `applications/backend/.env` при запуске через команды пакета. Переменные процесса имеют приоритет.

## Сборка и проверки

Команды выполняются из корня репозитория. Версии инструментов задаются package.json и .nvmrc.

```sh
pnpm --filter @gchat/backend typecheck
pnpm --filter @gchat/backend build
pnpm --filter @gchat/backend test --watchman=false
```

start собирает и запускает один раз; start:dev пересобирает при изменениях, start:prod запускает dist после build. Обычные тесты используют подменённые зависимости. Интеграционные тесты включаются отдельными переменными, описанными в контрактах миграций и RedLock.

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

Настройки `REDIS_*` используются RedisModule; `REDLOCK_*` используются RedlockModule. RedLock работает внутри backend и может использоваться CLI, отдельный контейнер ему не нужен. См. [RedisModule](../../docs/backend/modules/redis.md) и [RedlockModule](../../docs/backend/modules/redlock.md).

Проверка Redis без вывода пароля (из корня репозитория):

```sh
docker compose --env-file applications/backend/.env -f applications/backend/docker-compose.yml exec redis sh -ec 'REDISCLI_AUTH="$REDIS_PASSWORD" redis-cli ping'
```

Ожидаемый ответ — `PONG`. `db:down` сохраняет данные; не используйте `down -v` для обычного перезапуска. Восстановление устаревшего тома с сессиями требует процедуры из RedisModule.

## Работа со схемой БД

[Миграции PostgreSQL](../../docs/backend/operations/migrations.md) — единая инструкция генерации, сборки, применения и поставки SQL. Применение выполняется отдельной командой перед запуском новой версии, а не при старте HTTP-сервера.

## Восстановление

При неизвестной актуальности Redis сначала читайте [правила восстановления](../../docs/backend/operations/recovery.md). Обычный перезапуск сохраняет volumes; удаление томов не является штатным способом восстановления доступа.

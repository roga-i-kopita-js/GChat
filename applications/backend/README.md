# GChat Backend

Workspace-проект `@gchat/backend`: базовое NestJS 12-приложение на TypeScript (ESM / NodeNext) с HTTP-сервером Express, конфигурацией окружения модулями PostgreSQL, Redis и healthcheck.

- [Технологический стек](../../docs/backend/README.md): TypeScript, NestJS, PostgreSQL, Drizzle ORM / Drizzle Kit, WebSocket, WebRTC / coturn и APNs.
- [Настройки репозитория](../../docs/repository-settings/README.md).
- [Обзор приложения](../../docs/application-overview.md).

Исходники и конфигурация сервера размещаются здесь. Документация архитектуры остаётся в `docs/backend`.

## Запуск приложения

Требуются Node.js 24.15+ (ветка 24.x), pnpm 10.33.0 и запущенный Docker Engine / Docker Desktop с Docker Compose v2 с поддержкой `--wait`. Из корня монорепозитория:

```sh
pnpm install
cp applications/backend/.env.example applications/backend/.env
pnpm --filter @gchat/backend db:up
pnpm --filter @gchat/backend start:dev
```

Если `.env` уже существует, пропустите команду копирования и добавьте нужные переменные из примера. `db:up` запускает локальные PostgreSQL и Redis и ждёт готовности обеих зависимостей. Приложение читает `applications/backend/.env` при запуске через команды пакета. Переменные процесса имеют приоритет.

По умолчанию сервер слушает `127.0.0.1:3000`. Параметры `HOST` и `PORT` переопределяют адрес и порт; некорректный `PORT` останавливает запуск. `DATABASE_URL` обязателен и проверяется при старте; его отсутствие или неверный формат останавливают приложение. `REDIS_URL` и `REDIS_KEY_PREFIX` также обязательны и проверяются при старте. Redis подключается при инициализации с PING; если подключение не установлено за `REDIS_STARTUP_TIMEOUT_MS`, запуск завершается ошибкой без вывода секретов. Соединения с PostgreSQL создаются по запросу, поэтому недоступная БД не мешает запуску HTTP-сервера. Для доступа извне, например с телефона в локальной сети, можно задать `HOST=0.0.0.0`.

```sh
curl http://127.0.0.1:3000/health
```

Ожидаемый ответ: `{"status":"ok","service":"gchat-backend"}`. Это liveness-проверка HTTP-приложения: она не обращается к PostgreSQL и Redis и продолжает возвращать 200 при отказе БД.

Для readiness запустите PostgreSQL и Redis командой `pnpm --filter @gchat/backend db:up` и выполните:

```sh
curl -i http://127.0.0.1:3000/ready
```

| Endpoint | Проверка | Ответ |
| --- | --- | --- |
| `GET /health` | HTTP-приложение работает | 200, `{"status":"ok","service":"gchat-backend"}` |
| `GET /ready` | `SELECT 1` через Drizzle / PostgreSQL и PING Redis параллельно | 200, `{"status":"ok","service":"gchat-backend","checks":{"database":"up","redis":"up"}}` |
| `GET /ready` при ошибке БД | Ошибка подключения, запроса или таймаут | 503, `{"status":"error","service":"gchat-backend","checks":{"database":"down","redis":"up"}}` |

Результат readiness не кешируется. Ошибка подключения и секреты не включаются в HTTP-ответ. Для пула заданы лимит 5 соединений, ожидание соединения до 2 секунд и таймаут запроса 2 секунды; суммарно проверка может занять около 4 секунд. Пул закрывается при завершении приложения. Readiness проверяет доступность обеих зависимостей, без проверки схемы, миграций, persistence или возможности записи. Для недоступного Redis поле `checks.redis` равно `down`; при отказе любой зависимости ответ — 503. Корневой URL и бизнес-маршруты пока возвращают 404.

Команды из корня:

```sh
pnpm --filter @gchat/backend build
pnpm --filter @gchat/backend typecheck
pnpm --filter @gchat/backend test
pnpm --filter @gchat/backend start:prod
```

`start:dev` пересобирает приложение при изменениях. `start` собирает и запускает один раз. `start:prod` запускает `dist/main.js` после `build`. Nest CLI установлен локально, глобальная установка не нужна. Тесты Jest / Supertest проверяют HTTP через Nest-модули и реальный слой Drizzle с подменённым пулом: успешную проверку БД, отказ, восстановление, независимость liveness и закрытие пула. Рабочие PostgreSQL и Redis для тестов не требуются: клиенты подменяются.

```text
src/
  main.ts                    # Запуск HTTP-сервера и обработка завершения
  app.module.ts              # Корневой модуль и ConfigModule
  config/environment.ts      # Значения по умолчанию и проверка окружения
  database/                  # Пул PostgreSQL, Drizzle и управление подключением
  redis/                     # RedisModule, клиент, namespace ключей и жизненный цикл
  redlock/                   # RedlockModule, аренда ресурса и отмена при потере
  logger/                    # Глобальный JSON-логгер, DI-контекст и маскирование
  error/                     # Глобальная фабрика ошибок, HTTP-фильтр и ValidationPipe
  healthcheck/               # HealthcheckModule, GET /health и GET /ready
test/
  app.e2e.spec.ts             # HTTP smoke-тесты
  error.e2e.spec.ts           # HTTP-контракт ошибок
  redlock.integration.spec.ts # Интеграция с настоящим Redis
```

Юнит-тесты `*.spec.ts` располагаются рядом с исходниками соответствующих модулей в `src`. HTTP- и интеграционные тесты находятся в `test`. При production-сборке тесты из `src` исключаются.

Авторизация, контакты, звонки, бизнес-схема БД, WebSocket и push ещё не реализованы. `DatabaseModule` экспортирует `DatabaseService` с Drizzle-клиентом для следующих модулей.

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

Настройки `REDIS_*` используются RedisModule; `REDLOCK_*` используются RedlockModule. RedLock работает внутри backend и может использоваться CLI, отдельный контейнер ему не нужен. См. [RedisModule](../../docs/backend/redis.md) и [RedlockModule](../../docs/backend/redlock.md).

Проверка Redis без вывода пароля (из корня репозитория):

```sh
docker compose --env-file applications/backend/.env -f applications/backend/docker-compose.yml exec redis sh -ec 'REDISCLI_AUTH="$REDIS_PASSWORD" redis-cli ping'
```

Ожидаемый ответ — `PONG`. `db:down` сохраняет данные; не используйте `down -v` для обычного перезапуска. Восстановление устаревшего тома с сессиями требует процедуры из RedisModule.

## Использование RedisModule

Зарегистрируйте `RedisModule.forRoot()` один раз в корневом модуле (уже сделано в AppModule). Регистрация экспортирует `RedisService` глобально; в модулях-потребителях, включая Healthcheck и Redlock, достаточно внедрить сервис без повторного импорта или создания клиента. `client` предоставляет типизированный node-redis API, а `key(logicalKey)` добавляет `REDIS_KEY_PREFIX`. Пример: `await redis.client.get(redis.key('auth:session:123'))`. Префикс автоматически к командам клиента не добавляется: все ключи должны проходить через `key()`.

Клиент отключает очередь команд при потере соединения, ограничивает очередь 1000 командами и задаёт общий таймаут команды через `REDIS_COMMAND_TIMEOUT_MS`. После сбоя переподключается с задержкой до 3,1 секунды и случайным разбросом. Истёкший таймаут не отменяет запись на сервере; бизнес-модуль должен учитывать неизвестный результат. При остановке клиент закрывается с ограничением времени, затем при необходимости принудительно уничтожается.

## Использование RedlockModule

RedlockModule регистрируется в модулях-потребителях через `forFeature()`. В AppModule он не подключён. Пример регистрации:

```ts
@Module({
  imports: [RedlockModule.forFeature()],
  providers: [AuthService],
})
export class AuthModule {}
```

После регистрации внедрите `RedlockService` в сервис-потребитель:

```ts
await this.redlock.withLock(`auth:user:${userId}`, async (context) => {
  context.assertHeld();
  // Повторно проверить актуальные данные и выполнить бизнес-операцию.
  // Передавать context.signal в операции с поддержкой отмены.
});
```

Передавайте ресурс без `lock:`: сервис сам добавляет его и префикс Redis. Вложенные захваты запрещены. Callback запускается один раз; при отмене обязан прекратить новые побочные эффекты. Сервис ждёт его завершения, поскольку AbortSignal не может физически остановить JavaScript или отменить уже выполненную запись.

`LockError` из `src/redlock/redlock.errors.ts` содержит `code` (`LOCK_ACQUIRE_FAILED`, `LOCK_LOST`, `LOCK_RELEASE_FAILED`, `LOCK_SHUTTING_DOWN`) и `mayHaveExecuted`. Это ошибки сервиса; отображение в HTTP выполняет вызывающий бизнес-модуль. При остановке новые захваты запрещены, активные callback отменяются; ожидание их завершения ограничено двумя таймаутами команды Redis. Незавершённые аренды истекают по TTL.

Настройки `REDLOCK_*` валидируются при старте. Запас продления должен превышать таймаут команды плюс поправку на дрейф, а срок аренды — запас продления плюс поправку. Используется односерверный протокол `SET NX PX` и Lua с проверкой владельца поверх существующего node-redis; дополнительного клиента и кворума нет. Подробнее: [контракт и ограничения](../../docs/backend/redlock.md).

Интеграционные тесты Redlock включаются отдельно переменной `REDLOCK_INTEGRATION_URL` с URL тестового Redis. Запуск: `pnpm --filter @gchat/backend test --watchman=false`. Без этой переменной интеграционные тесты пропускаются. Они используют уникальный префикс ключей и не очищают общую базу.

## Использование ErrorModule

[ErrorModule](../../docs/backend/errors.md) зарегистрирован глобально в AppModule. Фабрика внедряется через конструктор без повторного импорта модуля:

```ts
constructor(private readonly error: ErrorService) {}

// В методе сервиса:
throw this.error.rateLimited({ retryAfterSeconds: 60 });
```

`ErrorService` импортируется из `src/error/error.service.ts`. Глобальный фильтр возвращает `{ "error": { "code": "RATE_LIMITED", "message": "…" } }` с HTTP 429 и `Retry-After`. DTO проверяются глобальным ValidationPipe с class-validator и class-transformer; неизвестные свойства отклоняются. Для ошибок валидации используется HTTP 400 и дополнительный список `error.fields`. Контракты `/health` и `/ready` сохранены.

## Использование LoggerModule

[LoggerModule](../../docs/backend/logger.md) зарегистрирован глобально через `LoggerModule.forRoot()` один раз в AppModule. Обычный импорт LoggerModule не создаёт провайдеры. Внедрите `LoggerService` из `src/logger/logger.service.ts` через конструктор и вызывайте `this.logger.log('Event', { callId })`. Поля `module` и `context` добавляются автоматически для внедрённого провайдера; Nest и bootstrap без владельца получают `module: null`.

`LOG_REDACTION_ENABLED=true` включает маскирование по умолчанию. При `false` чувствительные данные не скрываются; обработка циклов, ограничение размеров и защита от ошибок сериализации сохраняются. Неверное значение останавливает запуск. Вывод — JSON в stdout/stderr, без автоматической корреляции запросов.

## Миграции PostgreSQL

[Контракт миграций](../../docs/backend/migrations.md). Схемы размещаются в `src/<module>/<module>.schema.ts`, SQL и метаданные хранятся в `drizzle/` и коммитятся вместе с кодом. Генерация не требует БД:

```sh
pnpm --filter @gchat/backend db:generate --name=add_users
```

Проверьте сгенерированный SQL. Перед запуском новой версии соберите backend и отдельно примените миграции:

```sh
pnpm --filter @gchat/backend build
pnpm --filter @gchat/backend db:migrate
pnpm --filter @gchat/backend start:prod
```

`db:migrate` читает `.env` приложения, переменные процесса имеют приоритет. Требуется PostgreSQL по DATABASE_URL; Redis и HTTP-приложение не запускаются. При пустой истории команда завершается без подключения, при ошибке — с ненулевым кодом и безопасным сообщением. В production-артефакт включайте каталог `drizzle/` рядом с `dist/`. Миграции не запускаются автоматически вместе с backend, параллельные запуски на одну БД не допускаются. Уже применённый SQL не редактируется; исправление оформляется новой миграцией.

---
doc_type: module
decision_status: accepted
implementation_status: implemented
source: applications/backend/src/healthcheck/
tests: ["applications/backend/test/app.e2e.spec.ts"]
---

# Healthcheck

## Назначение и границы

Liveness процесса и readiness PostgreSQL/Redis. Проверки не подтверждают наличие бизнес-схемы, сохранность данных или возможность записи.

## Публичный API

Публичные маршруты и тела ответов:

| Endpoint | Проверка | Ответ |
| --- | --- | --- |
| `GET /health` | HTTP-приложение работает | 200, `{"status":"ok","service":"gchat-backend"}` |
| `GET /ready` | `SELECT 1` через Drizzle / PostgreSQL и PING Redis параллельно | 200, `{"status":"ok","service":"gchat-backend","checks":{"database":"up","redis":"up"}}` |
| `GET /ready` при ошибке БД | Ошибка подключения, запроса или таймаут | 503, `{"status":"error","service":"gchat-backend","checks":{"database":"down","redis":"up"}}` |

Результат readiness не кешируется. Ошибка подключения и секреты не включаются в HTTP-ответ. Readiness ограничена бюджетами подключений [Database](database.md) и [Redis](redis.md). Readiness проверяет доступность обеих зависимостей, без проверки схемы, миграций, persistence или возможности записи. Для недоступного Redis поле `checks.redis` равно `down`; при отказе любой зависимости ответ — 503.

## Правила и инварианты

Readiness выполняет проверки параллельно при каждом запросе и не кеширует результат. Успех возвращается только при доступности обеих зависимостей.

## Зависимости и регистрация

HealthcheckModule импортирует DatabaseModule и использует глобальный RedisService. Контракт ответов применяется также в Swagger и специальной обработке ReadinessError в ErrorModule.

## Ошибки и частичное выполнение

Отказ любой зависимости возвращает 503 с её полем down. Сообщения драйверов и секреты в ответ не включаются. Оболочка error из ErrorModule для readiness не используется.

## Конфигурация

Адрес HTTP задаётся HOST/PORT; параметры подключений принадлежат Database и Redis. Численные значения по умолчанию проверяются по исходникам и .env.example.

## Критерии приёмки и проверки

HTTP-тесты проверяют liveness без обращения к БД, успешную readiness, отказ и восстановление обеих зависимостей. Полная OpenAPI-схема проверяется после Nest CLI build.

## Открытые решения

Отдельных открытых решений нет.

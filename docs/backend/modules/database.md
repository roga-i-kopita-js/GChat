---
doc_type: module
decision_status: accepted
implementation_status: implemented
source: applications/backend/src/database/
tests: ["applications/backend/src/database/migrations.spec.ts", "applications/backend/test/migrations.integration.spec.ts", "applications/backend/test/app.e2e.spec.ts"]
---

# Database

## Назначение и границы

DatabaseModule предоставляет PostgreSQL-пул и Drizzle-клиент. Бизнес-схемы и запросы принадлежат соответствующим модулям.

## Публичный API

`DatabaseService.db` — Drizzle-клиент. `ping()` выполняет SELECT 1.

```ts
constructor(private readonly database: DatabaseService) {}
```

## Правила и инварианты

Пул создаёт соединения по запросу. Недоступность PostgreSQL сама по себе не блокирует запуск HTTP; readiness отражает отказ. Миграции не выполняются при старте HTTP-приложения.

## Зависимости и регистрация

DatabaseModule импортируется потребителями; экспортирует DatabaseService. Фабрика пула использует ConfigService и глобальный LoggerService.

## Ошибки и частичное выполнение

Ошибка простаивающего соединения перехватывается без вывода исходных подробностей. Пул закрывается через onModuleDestroy. Ошибки запросов преобразует в публичные ошибки вызывающий бизнес-модуль.

## Конфигурация

DATABASE_URL обязателен и валидируется. Настройки пула определены в [database.module.ts](../../../applications/backend/src/database/database.module.ts): лимит 5, ожидание соединения 2 секунды, query_timeout и statement_timeout по 2 секунды. У отдельного мигратора свой пул и бюджет, см. [миграции](../operations/migrations.md).

## Критерии приёмки и проверки

HTTP-тесты проверяют доступ через Drizzle, отказ, восстановление и закрытие пула. Проверки мигратора описаны в его эксплуатационном документе.

## Открытые решения

Бизнес-таблицы добавляются вместе с модулями. Параметры production-пула уточняются по нагрузке.

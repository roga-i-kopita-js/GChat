# Карта документации GChat

Начните с строки нужной задачи. Не требуется читать все документы перед каждой правкой.

| Задача                         | Читать по порядку                                                                                                                                |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Подготовить окружение          | [Разработка](development.md) → [Запуск backend](../applications/backend/README.md)                                                               |
| Проектировать веб-бэк-офис | [Бизнес-требования бэк-офиса](product/backoffice.md) → [Дизайн](design/README.md) → [Auth](backend/modules/auth.md) и [Groups](backend/modules/groups.md) → [Технический проект](backend/modules/backoffice.md) |
| Понять продукт                 | [Требования](product/requirements.md) → [Сценарии](product/overview.md) → [Дизайн](design/README.md)                                             |
| Изменить архитектуру           | [Система](architecture/system.md) → [Решения](architecture/decisions/README.md) → контракт владельца                                             |
| Добавить HTTP endpoint         | [Соглашения](backend/conventions.md) → [OpenAPI](backend/openapi.md) → [Error](backend/modules/errors.md) → контракт модуля                      |
| Реализовать Auth               | [Auth](backend/modules/auth.md) → [Redis](backend/modules/redis.md) → [RedLock](backend/modules/redlock.md) → [Error](backend/modules/errors.md) |
| Работать с группами          | [Groups](backend/modules/groups.md) → [Требования](product/requirements.md) |
| Проектировать DirectCalls | [DirectCallsModule](backend/modules/direct-calls/README.md) → [Solution record и диаграммы C1–C3](backend/modules/direct-calls/D003-direct-calls-transport.md) |
| Работать с WS и SDP / ICE | [Signaling](backend/modules/signaling.md) → [DirectCalls](backend/modules/direct-calls/README.md) → [Auth](backend/modules/auth.md#websocket) |
| Работать с устройствами и VoIP push | [Devices](backend/modules/devices.md) → [Push](backend/modules/push.md) → [DirectCalls](backend/modules/direct-calls/README.md) |
| Изменить PostgreSQL или схему  | [Database](backend/modules/database.md) → [Миграции](backend/operations/migrations.md) → схема бизнес-модуля                                     |
| Изменить Redis или блокировки  | [Redis](backend/modules/redis.md) → [RedLock](backend/modules/redlock.md) → [Восстановление](backend/operations/recovery.md)                     |
| Изменить логирование           | [Logger](backend/modules/logger.md) → его исходники и тесты                                                                                      |
| Изменить проверки готовности   | [Healthcheck](backend/modules/healthcheck.md) → [Database](backend/modules/database.md) и [Redis](backend/modules/redis.md)                      |
| Восстановить доступ после сбоя | [Ограничения восстановления](backend/operations/recovery.md) → контракт владельца данных                                                         |
| Работать над веб-клиентом | [Веб-клиент](web/README.md) → [D005](architecture/decisions/D005-web-client.md) → контракты Auth, Groups и Signaling |
| Проверить систему целиком | [E2E-пакет и стенд](../tests/e2e/README.md) → [DirectCalls](backend/modules/direct-calls/README.md) → [Signaling](backend/modules/signaling.md) |
| Работать над iOS               | [Каталог iOS](../applications/ios/README.md) → [Требования](product/requirements.md) → [HTML-прототип](design/index.html)                        |
| Обслуживать Mattermost         | [Legacy-инструкция](legacy/mattermost.md)                                                                                                        |

## Источники истины

| Вопрос                              | Источник                                                                                      |
| ----------------------------------- | --------------------------------------------------------------------------------------------- |
| Что должен уметь продукт            | Требования продукта                                                                           |
| Какой контракт принят               | Профильный документ модуля со статусом accepted                                               |
| Что реально работает                | Код и относящиеся тесты; implementation_status — указатель для навигации                      |
| Версии, команды, значения окружения | Манифесты, lock-файл, .env.example и конфигурация                                             |
| Реализованный HTTP-контракт         | Генерируемый OpenAPI и контроллеры; описание будущих маршрутов не означает наличия реализации |
| Почему принято решение              | Записи решений, ссылающиеся на действующие контракты                                          |

При противоречии сообщить о расхождении. Не считать незавершённый код автоматическим согласованием контракта и не считать принятый будущий контракт существующей реализацией.

## Поддержка документации

- Одна связная тема имеет один основной документ. Из других документов ставятся ссылки, а не копии алгоритмов, команд и настроек.
- Контракт фичи и относящиеся записи решений можно хранить вместе в `backend/modules/<feature>/`: контракт — в `README.md`, решения — в отдельных файлах с метаданными `doc_type: decision` и `decision_status: draft/accepted/deprecated`. Общий каталог архитектурных решений ссылается на эти записи.
- Контракты backend-модулей используют [единый шаблон](backend/module-template.md). Метаданные: decision_status = draft/accepted/deprecated, implementation_status = absent/partial/implemented. Эти статусы независимы.
- source и tests содержат существующие пути от корня репозитория. Для будущего модуля source = null, tests = [], ожидаемый каталог можно указать в planned_source.
- Критерии приёмки — требования, не отчёт о выполненных проверках. В отчёте задачи указывается, что реально запускалось; текущие числа успешных тестов не закрепляются в документах.
- Открытые вопросы хранятся в контракте владельца. Общепродуктовые — в требованиях, системные — в архитектуре. Индекс не дублирует их и статусы реализации.
- Новые архитектурные решения сначала обсуждаются. Запись решения хранит мотивацию и ссылку на контракт; сам контракт описывает действующее правило без истории переписки.
- После переноса документа обновляйте ссылки, включая README приложений и дизайн. Запускайте `pnpm docs:check` из корня: проверяются ссылки, якоря, метаданные модулей и пути. Проверка не доказывает смысловую согласованность с кодом.

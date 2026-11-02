# Настройки репозитория

GChat организован как монорепозиторий на pnpm. Код проектов находится в `applications`, описание продукта и технические решения — в `docs`.

## Структура

```text
applications/
  backend/                 # @gchat/backend — сервер, локальный Compose и .env.example
  ios/                     # @gchat/ios — нативное iOS-приложение
docs/
  application-overview.md  # Обзор системы
  business-requirements.md # Бизнес-требования
  backend/                 # Документация серверной части
  design/                  # Базовый дизайн и HTML-макет
  repository-settings/    # Настройки репозитория
package.json               # Общие команды и версии инструментов
pnpm-workspace.yaml        # Два workspace-проекта
pnpm-lock.yaml             # Единый lock-файл
.nvmrc                     # Node.js 24.15.0
.npmrc                     # Строгая проверка engines
```

Существующие `docker-compose.yml`, `setup.sh` и конфигурация Mattermost / Jitsi остаются в корне. Они относятся к текущему мессенджеру; перенос или интеграция с новой звонилкой пока не выполняются.

## Инструменты

- Node.js 24.15+ (ветка 24.x): минимальная версия определена в `engines`, версия для nvm зафиксирована в `.nvmrc`.
- pnpm **10.33.0**: точная версия указана в `packageManager`. Обновление версии выполняется отдельно с обновлением документации и lock-файла при необходимости.
- Для нативной разработки iOS понадобится macOS с Xcode. Версии Xcode и минимальной iOS будут выбраны при создании мобильного проекта.

Если используется nvm, из корня репозитория:

```sh
nvm install
nvm use
```

Установите pnpm 10.33.0 подходящим способом. Например, при отсутствии конфликтующего Corepack shim:

```sh
npm install --global pnpm@10.33.0
```

Если pnpm уже управляется Corepack, используйте актуальный Corepack: он должен выбрать версию из `packageManager`. Не требуется одновременно устанавливать pnpm обоими способами.

Проверьте версии и установите workspace из корня:

```sh
node --version
pnpm --version
pnpm install
pnpm projects
```

В выводе списка проектов должны присутствовать `@gchat/backend` и `@gchat/ios`. Backend — базовое NestJS-приложение с внешними зависимостями, сборкой, проверкой типов и HTTP-тестами. iOS пока содержит каркас пакета без нативного проекта. У backend также есть команды `db:up`, `db:down`, `db:logs` и `db:ps` для локальной PostgreSQL.

Команды backend из корня:

```sh
pnpm --filter @gchat/backend start:dev
pnpm --filter @gchat/backend build
pnpm --filter @gchat/backend typecheck
pnpm --filter @gchat/backend test
pnpm --filter @gchat/backend start:prod
```

Перед `start:prod` выполните `build`. Детали конфигурации, `GET /health`, `GET /ready` и текущие ограничения — в [README backend](../../applications/backend/README.md#запуск-приложения).

## Локальная база backend

Отдельный `applications/backend/docker-compose.yml` запускает только PostgreSQL 17, по умолчанию на `127.0.0.1:5433`. Требуются Docker и Docker Compose v2. Из корня:

```sh
cp applications/backend/.env.example applications/backend/.env
pnpm --filter @gchat/backend db:up
```

Параметры подключения, команды и правила сохранения данных описаны в [README backend](../../applications/backend/README.md#локальная-postgresql). Корневой Compose с Mattermost / Jitsi этой командой не запускается.

## Зависимости и команды

Установка выполняется из корня, используется один `pnpm-lock.yaml`. Lock-файл хранится в Git. В CI используется `pnpm install --frozen-lockfile`. Отдельные `package-lock.json`, `yarn.lock` и вложенные pnpm lock-файлы не создаём.

Зависимости backend добавляются адресно, например:

```sh
pnpm --filter @gchat/backend add <package>
pnpm --filter @gchat/backend add -D <dev-package>
```

Общие инструменты разработки при необходимости добавляются в корень через `pnpm add -Dw <package>`. Корневой пакет и оба проекта отмечены `private: true`.

pnpm управляет JS/TS-зависимостями и общими командами монорепозитория. Исходники iOS, Xcode-проект и его нативные зависимости будут находиться в `applications/ios`, но собираться средствами Apple. Инструмент управления нативными зависимостями будет выбран отдельно.

## Что хранить в Git

Храним исходники, манифесты пакетов, общий lock-файл, конфигурацию и миграции. `node_modules`, результаты сборок, Xcode DerivedData, пользовательские настройки Xcode и локальные секреты исключены через `.gitignore`.

Примеры переменных окружения можно хранить в `.env.example` без действующих секретов. Для новых проектов локальные `.env` размещаются в соответствующем каталоге приложения.

## Связанные документы

- [Обзор приложения](../application-overview.md).
- [Backend: технологический стек](../backend/README.md).
- [Каталог backend](../../applications/backend/README.md).
- [Каталог iOS](../../applications/ios/README.md).
- [pnpm: workspaces](https://pnpm.io/workspaces).

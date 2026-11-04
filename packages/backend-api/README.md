# @gchat/backend-api

Внутренний HTTP-клиент GChat. [Контракт, примеры и процесс обновления](../../docs/packages/backend-api.md).

Из корня репозитория:

```sh
pnpm api:generate
pnpm api:check
pnpm --filter @gchat/backend-api build
pnpm --filter @gchat/backend-api test
```

Потребитель добавляет `"@gchat/backend-api": "workspace:*"` в зависимости и собирает пакет перед своим приложением. Экспортёр backend нужен только для обновления схемы; обычная сборка SDK использует сохранённые исходники.

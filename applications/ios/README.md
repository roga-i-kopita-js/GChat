# GChat iOS

Каталог нативного iOS-приложения. Xcode-проект, исходники и зависимости ещё не созданы; мобильный технологический стек предстоит детализировать.

Пакет `@gchat/ios` включает каталог в pnpm workspace для общей структуры и будущих команд автоматизации. Наличие `package.json` не означает использование React Native или JavaScript для интерфейса. Нативная сборка выполняется инструментами Xcode; pnpm не устанавливает Xcode и не управляет Swift-зависимостями.

- [Настройки репозитория](../../docs/development.md).
- [Обзор приложения](../../docs/product/overview.md).
- [Бизнес-требования](../../docs/product/requirements.md).
- [Базовый дизайн](../../docs/design/README.md).

Подготовлен [AppIcon asset catalog](Resources/Assets.xcassets/AppIcon.appiconset/) для будущего Xcode target: размеры iPhone/iPad и App Store 1024 × 1024. Источник и пересчёт размеров — в [описании брендинга](../../docs/design/branding/README.md). Каталог пока не включён в собранное приложение.

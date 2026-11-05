# GChat iOS

Каталог нативного iOS-приложения. Xcode-проект, исходники и зависимости ещё не созданы; мобильный технологический стек предстоит детализировать.

План переиспользования Web-клиента через Capacitor и запуска полностью нативного звонка, включая фон и заблокированный экран, ведётся в [черновике D008](../../docs/architecture/decisions/D008-capacitor-bridge.md). Capacitor и нативный call engine пока не реализованы и не добавлены в зависимости.

Пакет `@gchat/ios` включает каталог в pnpm workspace для общей структуры и будущих команд автоматизации. Наличие `package.json` не означает использование React Native или JavaScript для интерфейса. Нативная сборка выполняется инструментами Xcode; pnpm не устанавливает Xcode и не управляет Swift-зависимостями.

- [План автоматизации](automated-tests.md): Web/native/протокол и автоматические прогоны в Simulator; тесты будущей интеграции ещё не реализованы.
- [План ручной приёмки](manual-tests.md): только физические iPhone, аудио, CallKit/PushKit, фон и Gate 1/2; проверки пока не выполнены.
- [Настройки репозитория](../../docs/development.md).
- [Обзор приложения](../../docs/product/overview.md).
- [Бизнес-требования](../../docs/product/requirements.md).
- [Базовый дизайн](../../docs/design/README.md).

Подготовлен [AppIcon asset catalog](Resources/Assets.xcassets/AppIcon.appiconset/) для будущего Xcode target: размеры iPhone/iPad и App Store 1024 × 1024. Источник и пересчёт размеров — в [описании брендинга](../../docs/design/branding/README.md). Каталог пока не включён в собранное приложение.

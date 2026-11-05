# GChat iOS

Нативная iOS-оболочка общего Web-клиента по [D008](../../docs/architecture/decisions/D008-capacitor-bridge.md). Минимальная версия — iOS 16.0. Xcode-проект создан на основе официального SPM-шаблона Capacitor 8.6.0, зависимость закреплена в [Package.swift](App/CapApp-SPM/Package.swift). Для этой версии Capacitor требуется [Xcode 26+](https://capacitorjs.com/docs/getting-started/environment-setup).

## Что реализовано

- Локальное стартовое Web-приложение `gchat-bootstrap://localhost/server`: одно поле HTTPS-адреса, работает без backend. Native обслуживает только три включённых в bundle файла; этому WebView доступен только `selectServer`.
- Сохранённый адрес в UserDefaults и загрузка основного Web по `/apps/client/login?serverUrl=...`. Адрес хранится отдельно от сессии. При ошибке доступны повтор загрузки и смена адреса, если сохранённой сессии нет. При наличии сессии сначала нужен подтверждённый logout.
- Swift-плагин `GChat`: capabilities, `webReady`, login, logout, получение access token, события маршрута и полного снимка. События относятся к текущему `cycleId`; результаты прежней авторизации не восстанавливают UI после выхода. При foreground Web инициирует новый цикл, при завершении WebContent-процесса оболочка повторно загружает документ.
- Нативные HTTP Auth и Keychain с `AfterFirstUnlockThisDeviceOnly`. Сессия привязана к выбранному серверу. Login завершается после записи Keychain; refresh/logout сериализованы. Незавершённый refresh сохраняется до отправки и повторяется с теми же токеном и request ID, включая перезапуск. Logout сначала разрешает неопределённый refresh и удаляет сессию после серверного подтверждения. `Retry-After` ограничивает следующие сетевые операции текущего процесса.
- Основной документ ограничен выбранным HTTPS-origin и путями `/apps/client`. Внешние переходы, вложенные документы и новые окна блокируются; native Auth не следует HTTP-редиректам. Перед Capacitor проверяются источник сообщения и main frame, допускается только плагин `GChat`. Браузерный микрофон, встроенные HTTP/cookie-плагины, инспекция WebView и Capacitor-логи отключены.
- Иконки из [каталога ресурсов](Resources/Assets.xcassets/) подключены к target приложения.

Оболочка возвращает `nativeCalls: false`, снимок `call: null` и runtime `offline`. Web показывает недоступность звонков и не включает браузерный engine. `placeCall` отклоняется: libwebrtc, WSS, устройства, CallKit и PushKit ещё не реализованы. Это не закрывает Gate 1/2 или приёмку production-загрузки.

## Запуск

Из корня репозитория:

```sh
pnpm --filter @gchat/ios open
pnpm --filter @gchat/ios build
pnpm --filter @gchat/ios build:core
pnpm --filter @gchat/ios test
```

`open` открывает `App/App.xcodeproj`. Выберите схему `GChat` и iOS Simulator либо физический iPhone. Для устройства настройте свой Signing Team; `com.gchat.app` в target и Capacitor config — идентификатор текущего каркаса, provisioning и APNs не настроены. Команда `build` собирает Simulator без подписи. `test` выполняет XCTest-пакет NativeCore на macOS; это не UI-тесты iOS. Полный Xcode нужен для XCTest и Simulator; Command Line Tools позволяют отдельно собрать NativeCore. pnpm не устанавливает Xcode и Swift-зависимости.

Перед загрузкой основного Web нужен HTTPS-стенд с валидным системным сертификатом, API под `/api`, HTML/SPA fallback под `/apps/client` и assets под `/apps/static`. Сборка Web:

```sh
pnpm --filter @gchat/web build:server
```

Серверная раздача `/apps/client` в backend пока не реализована. Используйте отдельный настроенный reverse proxy; детали сборки — в [README Web](../web/README.md#сборка-для-серверного-web). Не отключайте TLS-проверку для стенда.

Проект ведётся вручную: локальные стартовые assets уже находятся в `App/App/public`. Не запускайте `cap sync/copy`: эти команды могут перезаписать assets и SPM-манифест, заменив стартовый экран основным Web. Основной Web доставляется сервером, в bundle он не копируется.

## Проверки и ограничения

[NativeCore](NativeCore/) не зависит от Capacitor/UIKit: XCTest проверяет доверенный origin, повтор неопределённой ротации после перезапуска, конкуренцию refresh/logout, отказ Keychain через fixture, подтверждённый отзыв и привязку к серверу. Реальный Keychain, WKWebView/Capacitor, редиректы и холодный запуск требуют отдельных интеграционных тестов в Xcode.

Production remote loading пока является реализацией для технического spike, а не подтверждённым механизмом релиза. Наличие исходников и успешная сборка NativeCore не подтверждают сборку iOS-target, работу bridge или приёмку на устройстве. Native/UI Simulator runner ещё не создан.

- [План автоматизации](automated-tests.md).
- [Ручная приёмка](manual-tests.md): физические iPhone, аудио, CallKit/PushKit, фон и Gate 1/2.
- [Веб-контракт bridge](../../docs/web/README.md#встроенный-web-и-capacitor-bridge).
- [Настройки репозитория](../../docs/development.md).

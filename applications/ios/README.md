# GChat iOS

Нативная iOS-оболочка общего Web-клиента по [D008](../../docs/architecture/decisions/D008-capacitor-bridge.md). Минимальная версия — iOS 16.0. Xcode-проект создан на основе официального SPM-шаблона Capacitor 8.6.0, зависимость закреплена в [Package.swift](App/CapApp-SPM/Package.swift). Для этой версии Capacitor требуется [Xcode 26+](https://capacitorjs.com/docs/getting-started/environment-setup).

## Что реализовано

- Локальное стартовое Web-приложение `gchat-bootstrap://localhost/server`: одно поле HTTPS-адреса, работает без backend. Native обслуживает только три включённых в bundle файла; этому WebView доступен только `selectServer`.
- Сохранённый адрес в UserDefaults и загрузка основного Web по `/apps/client/login?serverUrl=...`. Адрес хранится отдельно от сессии. При ошибке доступны повтор загрузки и смена адреса, если сохранённой сессии нет. При наличии сессии сначала нужен подтверждённый logout.
- Swift-плагин `GChat`: capabilities, `webReady`, login, logout, получение access token, события маршрута и полного снимка. События относятся к текущему `cycleId`; результаты прежней авторизации не восстанавливают UI после выхода. При foreground Web инициирует новый цикл, при завершении WebContent-процесса оболочка повторно загружает документ.
- Нативные HTTP Auth и Keychain с `AfterFirstUnlockThisDeviceOnly`. Сессия привязана к выбранному серверу. Login завершается после записи Keychain; refresh/logout сериализованы. Незавершённый refresh сохраняется до отправки и повторяется с теми же токеном и request ID, включая перезапуск. Logout сначала разрешает неопределённый refresh и удаляет сессию после серверного подтверждения. `Retry-After` ограничивает следующие сетевые операции текущего процесса.
- Основной документ ограничен выбранным HTTPS-origin и путями `/apps/client`. Внешние переходы, вложенные документы и новые окна блокируются; native Auth не следует HTTP-редиректам. Перед Capacitor проверяются источник сообщения и main frame, допускается только плагин `GChat`. Браузерный микрофон, встроенные HTTP/cookie-плагины, инспекция WebView и Capacitor-логи отключены.
- Иконки из [каталога ресурсов](Resources/Assets.xcassets/) подключены к target приложения.

Оболочка возвращает `nativeCalls: false`, снимок `call: null` и runtime `offline`. Web показывает недоступность звонков и не включает браузерный engine. `placeCall` отклоняется: libwebrtc, CallKit и PushKit ещё не реализованы. Это не закрывает Gate 1/2 или приёмку production-загрузки.

Реализовано [расширение bridge общим нативным WebSocket](../../docs/web/README.md#общий-websocket-через-native): NativeCore владеет WSS, авторизацией, регистрацией устройства, переподключением и применением политики из БД. `wsState` отделён от runtime звонка. UUID устройства сохраняется отдельно для выбранного сервера и native-сессии; чужая учётная запись не использует прежнюю привязку. Соединение восстанавливается из сохранённой сессии независимо от загрузки Web и переживает навигацию/перезапуск WebView. Фоновая работа требует отдельного контура звонков и проверки iOS. Мотивация — в [D008](../../docs/architecture/decisions/D008-capacitor-bridge.md#общий-нативный-wss-и-доступ-web-через-bridge).

## Запуск

Из корня репозитория:

```sh
pnpm --filter @gchat/ios open
pnpm --filter @gchat/ios build
pnpm --filter @gchat/ios build:core
pnpm --filter @gchat/ios test
```

`open` открывает `App/App.xcodeproj`. Выберите схему `GChat` и iOS Simulator либо физический iPhone. Для физического устройства выполните [отдельную настройку подписи](#установка-на-физический-iphone). `com.gchat.app` в target и Capacitor config — идентификатор текущего каркаса; APNs не настроены. Команда `build` собирает Simulator с локальной ad-hoc подписью без Signing Team. Не отключайте `CODE_SIGNING_ALLOWED`: Xcode должен сформировать simulator entitlements для доступа к Keychain, иначе native-сессия получает `errSecMissingEntitlement` (`-34018`). `test` выполняет XCTest-пакет NativeCore на macOS; это не UI-тесты iOS. Полный Xcode нужен для XCTest и Simulator; Command Line Tools позволяют отдельно собрать NativeCore. pnpm не устанавливает Xcode и Swift-зависимости.

Перед загрузкой основного Web нужен HTTPS-стенд с валидным системным сертификатом, API под `/api`, HTML/SPA fallback под `/apps/client` и assets под `/apps/static`. Сборка Web:

```sh
pnpm --filter @gchat/web build:server
```

Серверная раздача `/apps/client` в backend пока не реализована. Используйте отдельный настроенный reverse proxy; детали сборки — в [README Web](../web/README.md#сборка-для-серверного-web). Не отключайте TLS-проверку для стенда.

Проект ведётся вручную: локальные стартовые assets уже находятся в `App/App/public`. Не запускайте `cap sync/copy`: эти команды могут перезаписать assets и SPM-манифест, заменив стартовый экран основным Web. Основной Web доставляется сервером, в bundle он не копируется.

## Установка на физический iPhone

1. Подключите iPhone к Mac кабелем, разблокируйте и подтвердите доверие к компьютеру.
2. Включите на iPhone «Настройки → Конфиденциальность и безопасность → Режим разработчика». После перезагрузки подтвердите включение и снова разблокируйте устройство.
3. Добавьте Apple ID в Xcode → Settings → Accounts и выберите доступный Personal Team либо команду разработчика. Вход в аккаунт и системные подтверждения выполняет владелец устройства.
4. Выберите уникальный bundle identifier для своего Team. Идентификатор каркаса может быть уже занят в Apple Developer; смена bundle identifier создаёт отдельную установку и отдельное хранилище native-сессии.

Проверка подключённых устройств и доступных сертификатов:

```sh
xcrun devicectl list devices
security find-identity -v -p codesigning
```

Отсутствие сертификата сразу после добавления аккаунта не означает отсутствия Team: Xcode может создать сертификат и профиль при автоматической подписи. Для регистрации подключённого iPhone укажите его конкретный UDID в `-destination`, а не `generic/platform=iOS`.

Установите переменные `GCHAT_IOS_DEVICE_ID` (UDID из списка устройств), `GCHAT_IOS_TEAM_ID` (Signing Team в Xcode) и `GCHAT_IOS_BUNDLE_ID` (уникальный bundle identifier). Из корня репозитория:

```sh
xcodebuild \
  -project applications/ios/App/App.xcodeproj \
  -scheme GChat -configuration Debug \
  -destination "id=${GCHAT_IOS_DEVICE_ID:?Set iPhone UDID}" \
  -derivedDataPath /tmp/gchat-ios-device \
  DEVELOPMENT_TEAM="${GCHAT_IOS_TEAM_ID:?Set Signing Team}" \
  PRODUCT_BUNDLE_IDENTIFIER="${GCHAT_IOS_BUNDLE_ID:?Set unique bundle identifier}" \
  -allowProvisioningUpdates -allowProvisioningDeviceRegistration build

xcrun devicectl device install app \
  --device "$GCHAT_IOS_DEVICE_ID" \
  /tmp/gchat-ios-device/Build/Products/Debug-iphoneos/App.app

xcrun devicectl device process launch \
  --device "$GCHAT_IOS_DEVICE_ID" "$GCHAT_IOS_BUNDLE_ID"
```

Автоматическая подпись обращается в Apple Developer и при необходимости регистрирует устройство и создаёт профиль в выбранном Team. Эти параметры относятся только к данной сборке и не сохраняют личный Team/UDID в проекте. Каталог DerivedData не переносите между сборками: кеш SwiftPM может содержать абсолютные пути к XCFramework. При смене каталога используйте новый, чтобы Xcode заново разрешил зависимости. Зависимости закреплены в [SPM lock-файле](App/CapApp-SPM/Package.resolved) и lock-файле Xcode workspace; при обновлении Capacitor сохраняйте согласованность их pins с `Package.swift`.

Если приложение установлено, но запуск отклонён из-за недоверенного профиля, на iPhone откройте «Настройки → Основные → VPN и управление устройством» и подтвердите доверие к профилю своего разработчика. После подтверждения повторите команду запуска. Доверие к разработчику приложения и доверие к HTTPS-сертификату стенда настраиваются независимо.

## HTTPS-стенд для Simulator и iPhone

В стартовую форму вводится только HTTPS-origin: схема, имя сервера или IP и необязательный порт. Не добавляйте `/api`, `/apps/client`, query или fragment. Например, `https://localhost:8443` описывает формат, а не готовый адрес развёрнутого сервера.

- В Simulator loopback-адрес Mac доступен через `127.0.0.1`. Сертификату нужно доверять именно в выбранном симуляторе, а не только в macOS. Для локального тестового сертификата: `xcrun simctl keychain <SIMULATOR_UDID> add-root-cert <CERTIFICATE_FILE>`.
- На физическом iPhone `127.0.0.1` и `localhost` относятся к телефону. Используйте доступный телефону HTTPS-домен либо LAN-адрес Mac; при LAN-проверке устройства должны иметь сетевую связность. Сертификат должен включать выбранное имя или IP в Subject Alternative Name и быть действующим.
- Reverse proxy должен слушать нужный сетевой интерфейс Mac. Открытие тестового стенда в LAN даёт доступ к его портам другим устройствам этой сети; включайте его только осознанно, сохраняя авторизацию и изоляцию от рабочих данных. Backend может оставаться на loopback за proxy.
- Для вручную установленного тестового корневого сертификата на iPhone нужны установка профиля и отдельное включение полного доверия: «Настройки → Основные → Об этом устройстве → Настройки доверия сертификатов». См. [инструкцию Apple](https://support.apple.com/ru-ru/102390). Устанавливайте только свой тестовый сертификат; приватный ключ на телефон не передаётся. После тестирования удалите ненужный тестовый профиль.

Проверка ответа Web/API с Mac не подтверждает сетевую доступность и доверие к TLS на телефоне. Проверяйте загрузку основного Web на целевом устройстве. Ошибка «Не удалось загрузить GChat» требует проверки адреса, доступности proxy, сертификата и маршрутов из [раздела запуска](#запуск); ошибка secure storage после загрузки Web требует проверки подписи/Keychain.

Временный HTTPS-прокси и сертификаты, подготовленные вручную в `/tmp` или игнорируемом `.local/`, не являются воспроизводимым стендом репозитория. Их процессы и адреса не гарантируются после перезапуска Mac; для постоянной разработки отдельно подготовьте и документируйте свой стенд. Команды iOS-пакета не запускают backend или HTTPS-proxy.

## Проверки и ограничения

[NativeCore](NativeCore/) не зависит от Capacitor/UIKit: XCTest проверяет доверенный origin, повтор неопределённой ротации после перезапуска, конкуренцию refresh/logout, отказ Keychain через fixture, подтверждённый отзыв и привязку к серверу. Реальный Keychain, WKWebView/Capacitor, редиректы и холодный запуск требуют отдельных интеграционных тестов в Xcode.

Production remote loading пока является реализацией для технического spike, а не подтверждённым механизмом релиза. Подтверждены сборка и запуск в Simulator, загрузка основного Web до формы входа в Simulator, а также подписанная сборка, установка и запуск на физическом iPhone. Сквозная загрузка Web/авторизация/общий WSS на физическом устройстве ещё не прошли приёмку; установка и доверие к тестовому HTTPS-сертификату на телефоне не подтверждены. Сборка и тесты NativeCore не заменяют интеграционную приёмку bridge. Native/UI Simulator runner ещё не создан. [Тесты общего WSS](NativeCore/Tests/GChatCoreTests/SharedWebSocketTests.swift) используют сетевой fixture: проверяют фильтрацию, корреляцию, циклы WebView, закрытие сессии и ограничения. Они не подтверждают URLSession/WSS на iOS или реальный Capacitor.

- [План автоматизации](automated-tests.md).
- [Ручная приёмка](manual-tests.md): физические iPhone, аудио, CallKit/PushKit, фон и Gate 1/2.
- [Веб-контракт bridge](../../docs/web/README.md#встроенный-web-и-capacitor-bridge).
- [Настройки репозитория](../../docs/development.md).

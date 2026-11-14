# GChat iOS

**Временно deprecated с 2026-11-14.** По [решению о приоритетах платформ](../../docs/product/requirements.md#текущий-приоритет-платформ) разработка и приёмка iOS отложены; текущий приоритет — backend и Web/PWA. Сборка iOS не блокирует их коммиты, обязательность системных E2E сохраняется. Описание ниже фиксирует сохранённую реализацию и прежние ограничения.

Нативная iOS-оболочка общего Web-клиента по [D008](../../docs/architecture/decisions/D008-capacitor-bridge.md). Минимальная версия — iOS 16.0. Xcode-проект создан на основе официального SPM-шаблона Capacitor 8.6.0, зависимость закреплена в [Package.swift](App/CapApp-SPM/Package.swift). Для этой версии Capacitor требуется [Xcode 26+](https://capacitorjs.com/docs/getting-started/environment-setup).

## Что реализовано

- Локальное стартовое Web-приложение `gchat-bootstrap://localhost/server`: одно поле HTTPS-адреса, работает без backend. Native обслуживает только три включённых в bundle файла; этому WebView доступен только `selectServer`.
- Сохранённый адрес в UserDefaults и загрузка основного Web по `/apps/client/login?serverUrl=...`. Адрес хранится отдельно от сессии. При ошибке доступны повтор загрузки и смена адреса, если сохранённой сессии нет. При наличии сессии сначала нужен подтверждённый logout.
- Swift-плагин `GChat`: capabilities, `webReady`, login, logout, получение access token, события маршрута и полного снимка. События относятся к текущему `cycleId`; результаты прежней авторизации не восстанавливают UI после выхода. При foreground Web инициирует новый цикл, при завершении WebContent-процесса оболочка повторно загружает документ.
- Нативные HTTP Auth и Keychain с `AfterFirstUnlockThisDeviceOnly`. Сессия привязана к выбранному серверу. Login завершается после записи Keychain; refresh/logout сериализованы. Незавершённый refresh сохраняется до отправки и повторяется с теми же токеном и request ID, включая перезапуск. Logout сначала разрешает неопределённый refresh и удаляет сессию после серверного подтверждения. `Retry-After` ограничивает следующие сетевые операции текущего процесса.
- Основной документ ограничен выбранным HTTPS-origin и путями `/apps/client`. Внешние переходы, вложенные документы и новые окна блокируются; native Auth не следует HTTP-редиректам. Перед Capacitor проверяются источник сообщения и main frame, допускается только плагин `GChat`. Браузерный микрофон, встроенные HTTP/cookie-плагины, инспекция WebView и Capacitor-логи отключены.
- Иконки из [каталога ресурсов](Resources/Assets.xcassets/) подключены к target приложения.

Добавлен [командный bridge устройства](../../docs/web/device-bridge.md): разрешения микрофона/камеры/геопозиции, краткие аудиотесты, чтение push-настроек, системные файловые диалоги и файловые команды NativeCore с сохранением bookmarks. Общий [модуль настроек Web](../../docs/web/settings.md) использует один `execute`, а native восстанавливает его маршруты после foreground. Разрешения и предоставленные файловые доступы не привязаны к аккаунту или серверу; незавершённые операции отменяются при смене сессии. Системные сценарии этого расширения на физическом устройстве ещё требуют приёмки.

Подключена [основная звонковая композиция](../../docs/ios/native-app.md): оболочка возвращает `nativeCalls: true`, использует общие с Audio Test libwebrtc/CallKit-адаптеры и нативный DirectCallController поверх единственного WSS. PWA и iOS показывают [один Web-экран звонка](../../docs/design/call-screen.md); ответ, отклонение, отмена, завершение и mute передаются нативному владельцу через bridge. Отдельная нативная панель удалена. Движок принадлежит оболочке и не пересоздаётся при смене Web cycle. PushKit и полный Gate 1/2 ещё не приняты; локальная интеграция не означает готовности публичного релиза.

Реализовано [расширение bridge общим нативным WebSocket](../../docs/web/README.md#общий-websocket-через-native): NativeCore владеет WSS, авторизацией, регистрацией устройства, переподключением и применением политики из БД. `wsState` отделён от runtime звонка. UUID устройства сохраняется отдельно для выбранного сервера и native-сессии; чужая учётная запись не использует прежнюю привязку. Соединение восстанавливается из сохранённой сессии независимо от загрузки Web и переживает навигацию/перезапуск WebView. Фоновая работа требует отдельного контура звонков и проверки iOS. Мотивация — в [D008](../../docs/architecture/decisions/D008-capacitor-bridge.md#общий-нативный-wss-и-доступ-web-через-bridge).

## Диалоги и обычные уведомления

Добавлены системная SQLite без сторонних библиотек, контроль поколений/CAS, очистка при завершении native-сессии и storage bridge v2 с миграцией существующего кеша по [контракту редактирования](../../docs/backend/modules/dialogs/message-editing.md) и [bootstrap](../../docs/web/bootstrap.md). Control metadata живёт отдельно в UserDefaults; отказ SQLite не препятствует сохранению постоянного выбора IndexedDB WebView. Незавершённая физическая очистка остаётся отдельным состоянием.

Обычный APNs-токен регистрируется NativeCore через device.apns_token после binding; Web получает только безопасный intent диалога. Настройки push.enable/disable используют обычные уведомления, не VoIP. UI/bridge, XCTest и Simulator-сборка не заменяют приёмку доставки и работы на физическом iPhone.

## Тестовое приложение bridge

[BridgeHarness](BridgeHarness/README.md) собирает отдельное приложение `GChat Bridge` с тем же Swift-плагином. Реализован нативный HTTP v1 по [API device](../../docs/web/device-api.md#профиль-native-http-первой-версии): URLSession без cookies/кеша/редиректов, лимит 8 МиБ, native-токен и отмена по requestId/циклу/сессии. Диагностический HTTPS-экран проверяет HTTP и существующие системные команды. SDK основного Web подключён к Fetch-совместимому адаптеру native HTTP; сеть WebView не используется. Добавлены нативные области Data/Temporary/Cache через тот же диспетчер: постоянные внутренние ссылки, usage и очистка Temporary с защитой живых владельцев. Добавлен navigation v1: проверка маршрутов, readiness/cycle, коррелированные результаты, вытеснение и дедупликация команд; Web-адаптер проверяется на Data router в harness. Добавлены Web-фасад StorageService, browser OPFS и подключение основных экранов к Data router. Публичная композиция device подключена в Web. Native media v1 поддерживает камеру View lifetime, preview под WKWebView, JPEG и потоковую запись H.264/MP4 в Data, чтение системной громкости/текущего выхода и системный выбор аудиомаршрута. Общие Call lifetime/PiP-компоненты подключены к настоящему владельцу DirectCalls в CallHarness, системная громкость доступна только при активном VoIP owner. Общий blocker реализован в Web. Звонковая интеграция основной оболочки подключена по отдельному контракту; пропущенная физическая матрица остаётся непройденной. Query удалён из Web; контакты/admin используют loaders/actions, диалоги — live-модели runtime.

## Запуск

Из корня репозитория:

```sh
pnpm --filter @gchat/ios open
pnpm --filter @gchat/ios build
pnpm --filter @gchat/ios build:core
pnpm --filter @gchat/ios test
```

`open` открывает `App/App.xcodeproj`. Выберите схему `GChat` и iOS Simulator либо физический iPhone. Для физического устройства выполните [отдельную настройку подписи](#установка-на-физический-iphone). `com.gchat.app` в target и Capacitor config — идентификатор текущего каркаса; для обычных APNs диалогов добавлены entitlements (Debug development, Release production), но реальная доставка требует подходящего App ID, профиля подписи и backend credentials. Команда `build` собирает Simulator с локальной ad-hoc подписью без Signing Team. Не отключайте `CODE_SIGNING_ALLOWED`: Xcode должен сформировать simulator entitlements для доступа к Keychain, иначе native-сессия получает `errSecMissingEntitlement` (`-34018`). `test` выполняет XCTest-пакет NativeCore на macOS; это не UI-тесты iOS. Полный Xcode нужен для XCTest и Simulator; Command Line Tools позволяют отдельно собрать NativeCore. pnpm не устанавливает Xcode и Swift-зависимости.

Перед загрузкой основного Web нужен HTTPS-стенд с валидным системным сертификатом, API под `/api`, HTML/SPA fallback под `/apps/client` и assets под `/apps/static`. Сборка Web:

```sh
pnpm --filter @gchat/web build:server
```

Backend раздаёт `/apps/client` и статику из каталога, заданного в `GCHAT_WEB_ROOT`; детали сборки — в [README Web](../web/README.md#сборка-для-серверного-web). Для HTTPS используйте настроенный reverse proxy. Не отключайте TLS-проверку для стенда.

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

## Отдельное приложение «GChat Тест»

[Контракт тестовой установки](../../docs/ios/native-app.md#отдельная-тестовая-установка) сохраняет основной GChat и его сессию. Используйте отдельный bundle identifier `com.gchat.bridgeharness.dev.<суффикс команды>` из существующего тестового provisioning-профиля. Задайте его как GCHAT_IOS_TEST_BUNDLE_ID; остальные параметры подписи — из раздела установки выше.

```sh
xcodebuild \
  -project applications/ios/App/App.xcodeproj \
  -scheme GChat -configuration Debug \
  -destination "id=${GCHAT_IOS_DEVICE_ID:?Set iPhone UDID}" \
  -derivedDataPath applications/ios/DerivedData \
  DEVELOPMENT_TEAM="${GCHAT_IOS_TEAM_ID:?Set Signing Team}" \
  PRODUCT_BUNDLE_IDENTIFIER="${GCHAT_IOS_TEST_BUNDLE_ID:?Set separate test bundle identifier}" \
  GCHAT_DISPLAY_NAME='GChat Тест' GCHAT_TEST_BUILD=YES \
  CODE_SIGN_ENTITLEMENTS=../BridgeHarness/BridgeHarness.entitlements build

xcrun devicectl device install app \
  --device "$GCHAT_IOS_DEVICE_ID" \
  applications/ios/DerivedData/Build/Products/Debug-iphoneos/App.app

xcrun devicectl device process launch \
  --device "$GCHAT_IOS_DEVICE_ID" "$GCHAT_IOS_TEST_BUNDLE_ID" \
  -- --bridge-server https://192.168.178.22:8449
```

Сборка использует полный интерфейс основного приложения. Зарезервированный тестовый identifier и пустые APNs entitlements позволяют использовать существующий профиль стенда; установку production-профиля и проверку push это не заменяет. Сертификат HTTPS должен быть доверенным на iPhone. Web публикуется отдельно под `/apps/client` и `/apps/static`.

## HTTPS-стенд для Simulator и iPhone

В стартовую форму вводится только HTTPS-origin: схема, имя сервера или IP и необязательный порт. Не добавляйте `/api`, `/apps/client`, query или fragment. Например, `https://localhost:8443` описывает формат, а не готовый адрес развёрнутого сервера.

- В Simulator loopback-адрес Mac доступен через `127.0.0.1`. Сертификату нужно доверять именно в выбранном симуляторе, а не только в macOS. Для локального тестового сертификата: `xcrun simctl keychain <SIMULATOR_UDID> add-root-cert <CERTIFICATE_FILE>`.
- На физическом iPhone `127.0.0.1` и `localhost` относятся к телефону. Используйте доступный телефону HTTPS-домен либо LAN-адрес Mac; при LAN-проверке устройства должны иметь сетевую связность. Сертификат должен включать выбранное имя или IP в Subject Alternative Name и быть действующим.
- Reverse proxy должен слушать нужный сетевой интерфейс Mac. Открытие тестового стенда в LAN даёт доступ к его портам другим устройствам этой сети; включайте его только осознанно, сохраняя авторизацию и изоляцию от рабочих данных. Backend может оставаться на loopback за proxy.
- Для вручную установленного тестового корневого сертификата на iPhone нужны установка профиля и отдельное включение полного доверия: «Настройки → Основные → Об этом устройстве → Настройки доверия сертификатов». См. [инструкцию Apple](https://support.apple.com/ru-ru/102390). Устанавливайте только свой тестовый сертификат; приватный ключ на телефон не передаётся. После тестирования удалите ненужный тестовый профиль.

Проверка ответа Web/API с Mac не подтверждает сетевую доступность и доверие к TLS на телефоне. Проверяйте загрузку основного Web на целевом устройстве. Ошибка «Не удалось загрузить GChat» требует проверки адреса, доступности proxy, сертификата и маршрутов из [раздела запуска](#запуск); ошибка secure storage после загрузки Web требует проверки подписи/Keychain.

Временный HTTPS-прокси и сертификаты, подготовленные вручную в `/tmp` или игнорируемом `.local/`, не являются воспроизводимым стендом репозитория. Их процессы и адреса не гарантируются после перезапуска Mac; для постоянной разработки отдельно подготовьте и документируйте свой стенд. Команды iOS-пакета не запускают backend или HTTPS-proxy.

## Проверки и ограничения

Согласованный первый этап нативного аудиодвижка без APNs описан в [контракте Native Calls](../../docs/ios/native-calls.md). Основной target теперь подключает тот же SDK и общие CallKit/WebRTC-адаптеры по [контракту интеграции](../../docs/ios/native-app.md). Текущие физические результаты остаются частичными; ручные прогоны Audio Test завершены по поручению пользователя.

Согласованный [эксперимент Web Push → нативное приложение](web-push-launch-spike.md) проверяет запуск по ссылке без APNs-ключей. Это отдельная тестовая Web-сборка и подтверждение в Debug-приложении; звонковый движок этим не добавляется.

[NativeCore](NativeCore/) не зависит от Capacitor/UIKit: XCTest проверяет доверенный origin, повтор неопределённой ротации после перезапуска, конкуренцию refresh/logout, отказ Keychain через fixture, подтверждённый отзыв и привязку к серверу. Реальный Keychain, WKWebView/Capacitor, редиректы и холодный запуск требуют отдельных интеграционных тестов в Xcode.

Production remote loading пока является реализацией для технического spike, а не подтверждённым механизмом релиза. Подтверждены сборка и запуск в Simulator, загрузка основного Web до формы входа в Simulator, а также подписанная сборка, установка и запуск на физическом iPhone. Сквозная загрузка Web/авторизация/общий WSS на физическом устройстве ещё не прошли приёмку; установка и доверие к тестовому HTTPS-сертификату на телефоне не подтверждены. Сборка и тесты NativeCore не заменяют интеграционную приёмку bridge. Native/UI Simulator runner ещё не создан. [Тесты общего WSS](NativeCore/Tests/GChatCoreTests/SharedWebSocketTests.swift) используют сетевой fixture: проверяют фильтрацию, корреляцию, циклы WebView, закрытие сессии и ограничения. Они не подтверждают URLSession/WSS на iOS или реальный Capacitor.

- [План автоматизации](automated-tests.md).
- [Ручная приёмка](manual-tests.md): физические iPhone, аудио, CallKit/PushKit, фон и Gate 1/2.
- [Веб-контракт bridge](../../docs/web/README.md#встроенный-web-и-capacitor-bridge).
- [Настройки репозитория](../../docs/development.md).

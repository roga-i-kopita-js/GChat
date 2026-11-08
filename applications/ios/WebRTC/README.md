# Официальный WebRTC SDK для iOS

Сборочная часть принятого [первого этапа](../../../docs/ios/native-calls.md). Официальный XCFramework собран для iPhone arm64 и Simulator arm64, лицензии включены в архив; `build-lock.json` фиксирует upstream, инструменты и SHA-256 полученного архива. Статус `built_not_accepted` означает, что сборка завершена, но физическая аудиоприёмка Gate 1 не подтверждена.

Сборка использует официальный [WebRTC iOS build script](https://webrtc.googlesource.com/src/+/main/tools_webrtc/ios/build_ios_libs.py). depot_tools закреплён отдельно, его автоматическое обновление отключено. Исходники и зависимости скачиваются в явно выбранные каталоги вне дерева приложения; чужие изменения и файлы не удаляются.

В `.gclient` отключён только безымянный hook скачивания `chromium-webrtc-resources`: это аудио/видео upstream-тестов, не используемые при `rtc_include_tests=false`. Перед настройкой скрипт проверяет, что в DEPS закреплённой ревизии существует ровно один такой hook с ожидаемой командой. Используется штатный `custom_hooks`, исходный DEPS не изменяется; остальные hooks выполняются.

На Mac с Xcode из lock-файла:

```sh
python3 applications/ios/WebRTC/build.py --work-dir /tmp/gchat-webrtc-sdk --depot-tools /tmp/gchat-webrtc-depot-tools --stage prepare
python3 applications/ios/WebRTC/build.py --work-dir /tmp/gchat-webrtc-sdk --depot-tools /tmp/gchat-webrtc-depot-tools --stage sync
python3 applications/ios/WebRTC/build.py --work-dir /tmp/gchat-webrtc-sdk --depot-tools /tmp/gchat-webrtc-depot-tools --stage hooks
python3 applications/ios/WebRTC/build.py --work-dir /tmp/gchat-webrtc-sdk --depot-tools /tmp/gchat-webrtc-depot-tools --stage build
python3 applications/ios/WebRTC/build.py --work-dir /tmp/gchat-webrtc-sdk --depot-tools /tmp/gchat-webrtc-depot-tools --stage package
```

По умолчанию сохраняется резерв 8 ГиБ: при достижении порога текущая операция останавливается без удаления файлов. Это защитный резерв стенда, а не оценка полного размера исходников или сборки. Команды sync/hooks требуют сети и загружают зависимости, закреплённые upstream DEPS. SDK строится без подписи приложения; физический Swift harness подписывается отдельно по README iOS.

Результат упаковки — архив XCFramework и `build-result.json` с SHA-256, pin и статусом `built_not_accepted`. Проверяются обе arm64-секции (iPhone и Simulator). Статус не разрешает объявить Gate 1 пройденным: нужен отдельный harness и реальные физические проверки. Публикация архива и подключение в основную оболочку этим скриптом не выполняются.

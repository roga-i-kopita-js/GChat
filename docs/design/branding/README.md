# Знак и иконки GChat

Основной знак — белая буква G в форме телефонной трубки на синем фоне. Он используется в веб-клиенте, favicon, метаданных и подготовленных ресурсах приложений. Скругление внешних углов задают интерфейс и операционная система, исходник квадратный и непрозрачный.

[Сгенерированный оригинал](gchat-icon-generated.png) создан встроенным ImageGen 2026-11-04. Все размеры получаются из одного оригинала, без повторной генерации знака. Шаблон запроса сохранён ниже.

## Файлы

- [Веб-иконки](../../../applications/web/public/icons/): PNG 16, 32, 48, 64, 144, 180, 192, 256, 512 и 1024 px, maskable 512 px. Favicon ICO содержит размеры 16, 32, 48 и 256 px; Apple Touch Icon — 180 px. Подключены в [index.html](../../../applications/web/index.html) и [site.webmanifest](../../../applications/web/public/site.webmanifest). Иконка также используется в метаданных Open Graph и Twitter summary. При публичном размещении URL изображения в социальных метаданных нужно заменить на абсолютный HTTPS URL своего домена; локальный стенд недоступен внешним сервисам превью.
- [Каталог iOS](../../../applications/ios/Resources/Assets.xcassets/AppIcon.appiconset/): PNG для iPhone/iPad и App Store, включая непрозрачный 1024 × 1024, с `Contents.json`. Xcode-проекта пока нет; каталог нужно включить в будущий target приложения. Размеры каталога следуют [формату Apple](https://developer.apple.com/library/archive/documentation/Xcode/Reference/xcode_ref-Asset_Catalog_Format/AppIconType.html).
- [Набор Android](android/): `mipmap-mdpi` 48, `hdpi` 72, `xhdpi` 96, `xxhdpi` 144, `xxxhdpi` 192 px и Play Store 512 px. Это подготовленные растровые ресурсы, Android-проект не создаётся.

Maskable-вариант сохраняет значимую часть знака внутри центрального круга с диаметром 80% стороны по [правилам manifest](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/How_to/Define_app_icons). Web manifest задаёт название, стартовый адрес, цвета и иконки для ярлыка/установленного веб-приложения; офлайн-режим, push и фоновая телефония этим не реализуются.

## Перегенерация размеров

Из корня репозитория с Node из `.nvmrc` на macOS:

```sh
node scripts/generate-brand-icons.mjs
```

Скрипт использует встроенный `sips` для PNG и стандартные модули Node для ICO и JSON. Исходник не изменяется. Результаты коммитятся вместе с исходником и скриптом; сетевых обращений при пересчёте размеров нет.

## Запрос ImageGen

```text
Create one production-ready square 1024x1024 app icon for GChat, a private voice calling app. A single bold WHITE uppercase letter G cleverly constructed from ONE continuous stylized telephone handset: the thick rounded curved receiver body forms the circular open G silhouette, with its right lower earpiece turning inward into the short horizontal G crossbar. Must immediately read BOTH as G and as a telephone receiver, with confident geometric optical balance, friendly rounded terminals, generous negative space, exceptional legibility at 16px. Flat solid vivid azure blue #087CF0 background, full bleed square with NO outer corner rounding (OS masks it), pure white foreground centered occupying about 62% of canvas with at least 18% padding each side for maskable app use. Clean minimal vector-like edges, uniform confident thick strokes, crisp professional brand symbol, absolutely no lettering beyond the G-shaped symbol, no wordmark, no labels, no mockup, no shadows, no gradients, no 3D, no border, no watermark. Only one icon, not a contact sheet. The G should be upright, open to the right, not a generic tilted telephone pictogram.
```

# Каталог стикеров диалогов

Принятый состав, лицензия и правила совместимости — в [контракте Dialogs](../../docs/backend/modules/dialogs/README.md#каталог-стикеров-и-unicode). Версия 1: пять фиксированных IDs. Backend импортирует только `stickerIds`; пакет не имеет runtime-зависимостей.

`originals/` содержит SVG автора AssetPolish, `images/` — прозрачные PNG 512×512, экспортированные без изменения пропорций через Chromium canvas. В `manifest.json` сохранены URL исходников, SHA-256 оригиналов и PNG. SHA-256 оригиналов сверены с каталогом автора; `LICENSE.txt` — полученная копия CC0. Клиентская визуальная приёмка остаётся отдельной задачей. Production-image публикует PNG по `/apps/static/dialog-stickers/<sticker_id>.png`. IDs и изображения старой истории не переиспользуются.

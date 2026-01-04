#!/usr/bin/env bash
set -Eeuo pipefail

# Настройки: подставь свой порт, БД и юзера
PGHOST="${PGHOST:-127.0.0.1}"     # куда проброшено (обычно 127.0.0.1)
PGPORT="${PGPORT:-62957}"         # локальный порт port-forward'а
PGUSER="${PGUSER:-strapi}"
PGDATABASE="${PGDATABASE:-postgres}"
OUT="${OUT:-./${PGDATABASE}-$(date +%Y%m%d_%H%M%S).dump}"

command -v pg_dump >/dev/null || { echo "pg_dump не найден в PATH"; exit 1; }

echo "→ Делаю дамп ${PGDATABASE} с ${PGHOST}:${PGPORT} → ${OUT}"
pg_dump -w -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$PGDATABASE" \
  -Fc -Z 9 --no-owner --no-acl -f "$OUT"

[[ -s "$OUT" ]] || { rm -f "$OUT"; echo "Файл дампа пуст — проверь host/port/user/db"; exit 1; }
ls -lh "$OUT"
echo "Готово ✔️"

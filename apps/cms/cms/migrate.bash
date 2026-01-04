#!/usr/bin/env bash
set -Eeuo pipefail

### --- ПАРАМЕТРЫ (меняйте при необходимости) ---
NS_PROD="jackpoker-websites-test"
NS_DEV="jackpoker-websites-prod"
FROM_POD="cms-dev-postgres-0"
TO_POD="cms-croreplay-postgres-0"
PG_USER="postgres"
PG_DB="strapi"

# Если в подах нужен пароль – раскомментируйте и заполните:
# PGPASSWORD_PROD="..."
# PGPASSWORD_DEV="..."

# Где хранить дамп
DUMP_NAME="${PG_DB}.dump"
DUMP_LOCAL="./${DUMP_NAME}-dev"
DUMP_PROD="/tmp/${DUMP_NAME}"
DUMP_DEV="/tmp/${DUMP_NAME}"

### --- Утилиты ---
log() { printf "\n\033[1;36m[INFO]\033[0m %s\n" "$*"; }
die() { printf "\n\033[1;31m[ERROR]\033[0m %s\n" "$*" >&2; exit 1; }

### --- ПРОВЕРКИ ---
command -v kubectl >/dev/null || die "kubectl не найден"
log "Проверяю доступ к подам…"
kubectl -n "$NS_PROD" get pod "$FROM_POD" >/dev/null
kubectl -n "$NS_DEV"  get pod "$TO_POD"  >/dev/null

### --- 1) Дамп в PROD ---
log "Создаю дамп в PROD: ${NS_PROD}/${FROM_POD}:${DUMP_PROD}"
kubectl -n "$NS_PROD" exec "$FROM_POD" -- bash -lc "
  set -e
  export PGPASSWORD=\${PGPASSWORD_PROD:-${PGPASSWORD_PROD-}}
  pg_dump -U ${PG_USER} -d ${PG_DB} -Fc -Z 9 -f '${DUMP_PROD}'
  ls -lh '${DUMP_PROD}'
"

### --- 2) Копирую дамп локально и в DEV ---
log "Скачиваю дамп локально → ${DUMP_LOCAL}"
kubectl -n "$NS_PROD" cp "${FROM_POD}:${DUMP_PROD}" "${DUMP_LOCAL}"

log "Заливаю дамп в DEV → ${NS_DEV}/${TO_POD}:${DUMP_DEV}"
kubectl -n "$NS_DEV" cp "${DUMP_LOCAL}" "${TO_POD}:${DUMP_DEV}"

### --- 3) Полностью обнуляю БД в DEV ---
log "Снимаю коннекты к ${PG_DB} в DEV и пересоздаю БД"
kubectl -n "$NS_DEV" exec "$TO_POD" -- psql -X -U "$PG_USER" -d postgres -v ON_ERROR_STOP=1 -c \
  "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='${PG_DB}' AND pid <> pg_backend_pid();"

kubectl -n "$NS_DEV" exec "$TO_POD" -- psql -X -U "$PG_USER" -d postgres -v ON_ERROR_STOP=1 -c \
  "DROP DATABASE IF EXISTS ${PG_DB};"

kubectl -n "$NS_DEV" exec "$TO_POD" -- psql -X -U "$PG_USER" -d postgres -v ON_ERROR_STOP=1 -c \
  "CREATE DATABASE ${PG_DB};"

### --- 4) Восстановление в DEV ---
log "Восстанавливаю дамп в DEV (pg_restore --clean --if-exists -j 4)"
# Параллельный рестор из файла; если вдруг образ не поддерживает -j, fallback на одиночный
set +e
kubectl -n "$NS_DEV" exec "$TO_POD" -- bash -lc "
  set -e
  export PGPASSWORD=\${PGPASSWORD_DEV:-${PGPASSWORD_DEV-}}
  pg_restore -U ${PG_USER} -d ${PG_DB} --clean --if-exists --no-owner --no-acl -j 4 '${DUMP_DEV}'
"
rc=$?
set -e
if [[ $rc -ne 0 ]]; then
  log "Похоже, параллельный рестор не поддерживается. Повторяю без -j…"
  kubectl -n "$NS_DEV" exec "$TO_POD" -- bash -lc "
    set -e
    export PGPASSWORD=\${PGPASSWORD_DEV:-${PGPASSWORD_DEV-}}
    pg_restore -U ${PG_USER} -d ${PG_DB} --clean --if-exists --no-owner --no-acl '${DUMP_DEV}'
  "
fi

### --- 5) Проверки ---
log "Проверяю размер и примерное число строк"
kubectl -n "$NS_DEV" exec "$TO_POD" -- psql -U "$PG_USER" -d "$PG_DB" -c \
  "SELECT pg_size_pretty(pg_database_size(current_database())) AS size;"

kubectl -n "$NS_DEV" exec "$TO_POD" -- psql -U "$PG_USER" -d "$PG_DB" -c \
  "SELECT SUM(n_live_tup) AS approx_rows FROM pg_stat_user_tables;"

### --- 6) Уборка ---
#log "Удаляю временные файлы дампа"
#kubectl -n "$NS_PROD" exec "$FROM_POD" -- rm -f "${DUMP_PROD}" || true
#kubectl -n "$NS_DEV"  exec "$TO_POD"  -- rm -f "${DUMP_DEV}"  || true
#rm -f "${DUMP_LOCAL}" || true

log "Готово ✔️  База ${PG_DB} из PROD перелита в DEV."

#!/usr/bin/env bash
set -euo pipefail
umask 077
ROOT=${1:?Installation root required}
RELEASE=${2:?Release directory required}
[[ "$ROOT" =~ ^/[a-zA-Z0-9/_-]+$ && "$RELEASE" == "$ROOT"/incoming/* ]]
[[ -d "$ROOT/shared" && -d "$RELEASE" && ! -L "$RELEASE" ]]
exec 9>"$ROOT/deploy.lock"
flock -n 9 || {
  printf 'failed stage=lock; another deployment is running\n' > "$RELEASE/result"
  exit 1
}
STAGE=verify
NGINX_CHANGED=false
STOPPED=false
NGINX_TARGET=/etc/nginx/conf.d/gchat.conf
restore_nginx() {
  if [[ -f "$RELEASE/previous-nginx.conf" ]]; then
    sudo -n install -m 644 "$RELEASE/previous-nginx.conf" "$NGINX_TARGET"
  else
    sudo -n rm -f "$NGINX_TARGET"
  fi
}
finish() {
  local code=$?
  trap - EXIT
  if [[ "$NGINX_CHANGED" == true ]]; then
    restore_nginx || true
    sudo -n nginx -t && sudo -n systemctl reload nginx || true
  fi
  if (( code == 0 )); then
    printf 'success\n' > "$RELEASE/result.tmp"
  else
    printf 'failed stage=%s app_stopped_during_deploy=%s; inspect server state\n' "$STAGE" "$STOPPED" > "$RELEASE/result.tmp"
  fi
  mv "$RELEASE/result.tmp" "$RELEASE/result"
  exit "$code"
}
trap finish EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
read -r RELEASE_ID IMAGE IMAGE_ID PLATFORM < <(python3 "$RELEASE/verify-release.py" "$RELEASE")
[[ -n "$IMAGE" && "${RELEASE##*/}" == "$RELEASE_ID" ]]
STAGE=config
export GCHAT_SHARED_DIR="$ROOT/shared"
SETTINGS="$GCHAT_SHARED_DIR/compose.env"
MISSING_CONFIG=false
for file in compose.env backend.env turnserver.conf; do
  if [[ ! -r "$GCHAT_SHARED_DIR/$file" || ! -s "$GCHAT_SHARED_DIR/$file" ]]; then
    printf 'Missing or unreadable server configuration: %s/%s\n' "$GCHAT_SHARED_DIR" "$file" >&2
    MISSING_CONFIG=true
  fi
done
if [[ "$MISSING_CONFIG" == true ]]; then
  echo 'Prepare the server configuration before deploying; GitHub SSH variables and secrets do not create these files.' >&2
  exit 1
fi
# Only nonsecret, single-line plain values are consumed by this script.
setting() { sed -n "s/^$1=//p" "$SETTINGS"; }
DOMAIN=$(setting GCHAT_DOMAIN)
PORT=$(setting GCHAT_HTTP_PORT)
TIMEOUT=$(setting GCHAT_READY_TIMEOUT)
[[ "$PORT" =~ ^[0-9]+$ && "$TIMEOUT" =~ ^[0-9]+$ && "$TIMEOUT" -ge 10 && "$TIMEOUT" -le 1800 ]]
python3 "$RELEASE/render-nginx.py" "$RELEASE/nginx.conf.template" "$RELEASE/nginx.conf" "$DOMAIN" "$PORT"
printf 'GCHAT_IMAGE=%s\n' "$IMAGE" > "$RELEASE/image.env"
dc() { env -u DATABASE_URL docker compose -p gchat --env-file "$GCHAT_SHARED_DIR/backend.env" --env-file "$SETTINGS" --env-file "$RELEASE/image.env" -f "$RELEASE/compose.yaml" "$@"; }
dc config --quiet
ARCH=$(docker version --format '{{.Server.Arch}}')
[[ "$PLATFORM" == "linux/$ARCH" ]]
AVAILABLE=$(df -Pk "$ROOT" | awk 'NR==2 {print $4}')
ARCHIVE_KB=$(du -k "$RELEASE/gchat-image.tar.gz" | awk '{print $1}')
(( AVAILABLE > ARCHIVE_KB * 4 + 1048576 ))
STAGE=load
docker load -i "$RELEASE/gchat-image.tar.gz" >/dev/null
[[ "$(docker image inspect "$IMAGE" --format '{{.Id}}')" == "$IMAGE_ID" ]]
[[ "$(docker image inspect "$IMAGE" --format '{{.Os}}/{{.Architecture}}')" == "$PLATFORM" ]]
STAGE=config
dc run --rm --no-deps app node --input-type=module -e '
  import { ConfigService } from "@nestjs/config";
  import { validateEnvironment } from "./dist/config/environment.js";
  import { PushClient } from "./dist/push/push.client.js";
  try {
    new PushClient(new ConfigService(validateEnvironment(process.env)));
  } catch {
    console.error("Backend configuration validation failed; inspect server settings and APNs key if enabled");
    process.exit(1);
  }
'
STAGE=preflight
sudo -n test -d /etc/nginx/conf.d
if sudo -n test -f "$NGINX_TARGET"; then
  # The destination belongs to the deployment user; only the source needs sudo.
  # shellcheck disable=SC2024
  sudo -n cat "$NGINX_TARGET" > "$RELEASE/previous-nginx.conf"
fi
NGINX_CHANGED=true
sudo -n install -m 644 "$RELEASE/nginx.conf" "$NGINX_TARGET"
sudo -n nginx -t
restore_nginx
NGINX_CHANGED=false
# Expand credentials only inside the container, never in the host command line.
# shellcheck disable=SC2016
dc exec -T postgres sh -ec 'pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB"' >/dev/null
# shellcheck disable=SC2016
dc exec -T redis sh -ec 'REDISCLI_AUTH="$REDIS_PASSWORD" redis-cli ping | grep -qx PONG'
ALREADY_CURRENT=false
if [[ -L "$ROOT/current" && "$(readlink "$ROOT/current")" == "$RELEASE" ]]; then
  ALREADY_CURRENT=true
fi
if [[ "$ALREADY_CURRENT" == false ]]; then
  STAGE=backup
  mkdir -p "$ROOT/shared/backups"
  BACKUP="$ROOT/shared/backups/$RELEASE_ID.dump"
  # shellcheck disable=SC2016
  dc exec -T postgres sh -ec 'pg_dump -Fc -U "$POSTGRES_USER" "$POSTGRES_DB"' > "$BACKUP.tmp"
  [[ -s "$BACKUP.tmp" ]]
  dc exec -T postgres pg_restore --list < "$BACKUP.tmp" >/dev/null
  mv "$BACKUP.tmp" "$BACKUP"
  STAGE=migrate
  dc stop app
  STOPPED=true
  # Background server execution and this lock survive a disconnected Actions SSH session.
  dc run --rm --no-deps migrate
  STAGE=start
  dc up -d --no-deps --wait --wait-timeout "$TIMEOUT" app
else
  STAGE=readiness
  dc exec -T app node -e "fetch('http://127.0.0.1:3000/ready',{signal:AbortSignal.timeout(3000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
fi
STAGE=nginx
NGINX_CHANGED=true
sudo -n install -m 644 "$RELEASE/nginx.conf" "$NGINX_TARGET"
sudo -n nginx -t
if sudo -n systemctl is-active --quiet nginx; then
  sudo -n systemctl reload nginx
else
  sudo -n systemctl start nginx
fi
STAGE=https
curl --fail --silent --max-time 15 "https://$DOMAIN/api/ready" >/dev/null
curl --fail --silent --max-time 15 "https://$DOMAIN/apps/client" -o "$RELEASE/checked.html"
curl --fail --silent --max-time 15 "https://$DOMAIN/apps/client/admin/users?offset=0" -o "$RELEASE/checked-route.html"
cmp "$RELEASE/checked.html" "$RELEASE/checked-route.html"
ASSET=$(python3 - "$RELEASE/checked.html" <<'PY'
import pathlib, re, sys
html = pathlib.Path(sys.argv[1]).read_text()
assets = re.findall(r'(?:src|href)="(/apps/static/[^"\s]+)"', html)
if not assets or not all(re.fullmatch(r'/apps/static/[a-zA-Z0-9_.-]+', a) for a in assets):
    sys.exit('Built Web assets not found')
print('\n'.join(assets))
PY
)
while IFS= read -r asset; do
  curl --fail --silent --max-time 15 "https://$DOMAIN$asset" >/dev/null
done <<< "$ASSET"
[[ "$(curl --silent --output /dev/null --write-out '%{http_code}' --max-time 10 "https://$DOMAIN/apps/static/missing-$RELEASE_ID.js")" == 404 ]]
STAGE=record
if [[ "$ALREADY_CURRENT" == false && -L "$ROOT/current" ]]; then
  ln -sfn "$(readlink "$ROOT/current")" "$ROOT/previous.tmp"
  mv -Tf "$ROOT/previous.tmp" "$ROOT/previous"
fi
ln -sfn "$RELEASE" "$ROOT/current.tmp"
mv -Tf "$ROOT/current.tmp" "$ROOT/current"
NGINX_CHANGED=false
echo "Deployed $RELEASE_ID ($PLATFORM)"

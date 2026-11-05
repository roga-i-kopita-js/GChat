#!/usr/bin/env bash
# Disposable CI dependencies only; never uses a developer or production database.
set -euo pipefail
: "${IMAGE:?}"
export GCHAT_SHARED_DIR
GCHAT_SHARED_DIR=$(mktemp -d)
PROJECT="gchat-release-smoke-${GITHUB_RUN_ID:-$$}"
NGINX="$PROJECT-nginx"
TURN="$PROJECT-turn"
dc() { docker compose -p "$PROJECT" --env-file "$GCHAT_SHARED_DIR/compose.env" -f deployment/gchat/compose.yaml "$@"; }
cleanup() {
  docker rm -f "$NGINX" >/dev/null 2>&1 || true
  docker rm -f "$TURN" >/dev/null 2>&1 || true
  # Only the uniquely named disposable smoke project is removed with its volumes.
  dc --profile infrastructure --profile tools down -v >/dev/null 2>&1 || true
  rm -rf "$GCHAT_SHARED_DIR"
}
trap cleanup EXIT
mkdir -p "$GCHAT_SHARED_DIR/secrets" "$GCHAT_SHARED_DIR/tls/live/smoke.invalid"
export SMOKE_DIR="$GCHAT_SHARED_DIR"
node --input-type=module <<'JS'
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
const root = process.env.SMOKE_DIR;
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const apns = generateKeyPairSync('ec', { namedCurve: 'P-256' });
writeFileSync(root + '/secrets/apns.p8', apns.privateKey.export({ type: 'pkcs8', format: 'pem' }));
const config = {
  DATABASE_URL: 'postgresql://smoke:smoke@postgres:5432/smoke',
  REDIS_URL: 'redis://:smoke@redis:6379/0', REDIS_KEY_PREFIX: 'gchat:release-smoke:',
  AUTH_PASSWORD_PEPPER: randomBytes(32).toString('base64'),
  AUTH_JWT_ACTIVE_KID: 'smoke', AUTH_ROTATION_ACTIVE_KID: 'smoke',
  AUTH_JWT_PRIVATE_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString().replaceAll('\n', '\\n'),
  AUTH_JWT_PUBLIC_KEYS: JSON.stringify({ smoke: publicKey.export({ type: 'spki', format: 'pem' }) }),
  AUTH_ROTATION_KEYS: JSON.stringify({ smoke: randomBytes(32).toString('base64') }),
  DIRECT_CALLS_TURN_URLS: '["turn:smoke.invalid:3478"]',
  DIRECT_CALLS_TURN_SHARED_SECRET: randomBytes(32).toString('hex'),
  APNS_TEAM_ID: 'smoke', APNS_KEY_ID: 'smoke', APNS_BUNDLE_ID: 'invalid.smoke.gchat',
  APNS_ENVIRONMENT: 'sandbox', SIGNALING_BROWSER_ORIGINS: '["https://smoke.invalid"]',
};
// Compose single quotes preserve JSON and literal backslash-n sequences.
writeFileSync(root + '/backend.env', Object.entries(config).map(([k, v]) => `${k}='${v}'`).join('\n') + '\n');
writeFileSync(root + '/compose.env', `GCHAT_IMAGE=${process.env.IMAGE}\nGCHAT_HTTP_PORT=38080\nPOSTGRES_DB=smoke\nPOSTGRES_USER=smoke\nPOSTGRES_PASSWORD=smoke\nREDIS_PASSWORD=smoke\n`);
JS
chmod 755 "$GCHAT_SHARED_DIR" "$GCHAT_SHARED_DIR/secrets"
chmod 644 "$GCHAT_SHARED_DIR/secrets/apns.p8"
dc config --quiet
dc --profile infrastructure up -d --wait postgres redis
dc run --rm --no-deps migrate
dc run --rm --no-deps migrate
dc up -d --no-deps --wait --wait-timeout 120 app
APP=$(dc ps -q app)
docker exec "$APP" sh -ec 'test -s web/index.html && test -s drizzle/meta/_journal.json && test "$(id -u)" != 0 && test ! -d node_modules/typescript && test ! -f .env'
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj /CN=smoke.invalid \
  -keyout "$GCHAT_SHARED_DIR/tls/live/smoke.invalid/privkey.pem" \
  -out "$GCHAT_SHARED_DIR/tls/live/smoke.invalid/fullchain.pem" >/dev/null 2>&1
python3 deployment/gchat/render-nginx.py deployment/gchat/nginx.conf.template "$GCHAT_SHARED_DIR/nginx.conf" smoke.invalid 3000
docker run --rm -v "$GCHAT_SHARED_DIR/nginx.conf:/etc/nginx/conf.d/default.conf:ro" \
  -v "$GCHAT_SHARED_DIR/tls:/etc/letsencrypt:ro" nginx:stable-alpine nginx -t
docker run -d --name "$NGINX" --network "container:$APP" \
  -v "$GCHAT_SHARED_DIR/nginx.conf:/etc/nginx/conf.d/default.conf:ro" \
  -v "$GCHAT_SHARED_DIR/tls:/etc/letsencrypt:ro" nginx:stable-alpine >/dev/null
for ((i=0; i<20; i++)); do
  if docker exec "$NGINX" wget -q --spider --no-check-certificate https://127.0.0.1/api/ready 2>/dev/null; then break; fi
  sleep 1
done
docker exec -i -e NODE_TLS_REJECT_UNAUTHORIZED=0 "$APP" node --input-type=module < deployment/gchat/smoke-client.mjs
sed 's/REPLACE_PUBLIC_IP/127.0.0.1/; s/REPLACE_ON_SERVER/smoke-only-secret/' deployment/gchat/turnserver.conf.example > "$GCHAT_SHARED_DIR/turnserver.conf"
docker run -d --name "$TURN" -v "$GCHAT_SHARED_DIR/turnserver.conf:/etc/coturn/turnserver.conf:ro" \
  coturn/coturn:4.18.0-r0 -c /etc/coturn/turnserver.conf >/dev/null
sleep 2
[[ "$(docker inspect "$TURN" --format '{{.State.Running}}')" == true ]]
if docker logs "$TURN" 2>&1 | grep -Ei 'unknown|unrecognized|bad configuration|error'; then
  echo 'coturn configuration rejected'
  exit 1
fi
echo 'Packaged migrations, readiness, HTTPS, Web assets, SPA and authenticated WSS passed.'

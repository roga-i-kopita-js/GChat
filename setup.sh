#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker is not installed or is not available in PATH."
  exit 1
fi

if ! docker compose version >/dev/null 2>&1; then
  echo "Docker Compose plugin is not available."
  exit 1
fi

if ! command -v openssl >/dev/null 2>&1; then
  echo "openssl is required to generate local secrets."
  exit 1
fi

if [ ! -f .env ]; then
  cp .env.example .env

  POSTGRES_PASSWORD="$(openssl rand -hex 24)"
  JICOFO_AUTH_PASSWORD="$(openssl rand -hex 24)"
  JVB_AUTH_PASSWORD="$(openssl rand -hex 24)"

  perl -0pi -e "s/POSTGRES_PASSWORD=GENERATE_ME/POSTGRES_PASSWORD=${POSTGRES_PASSWORD}/" .env
  perl -0pi -e "s/JICOFO_AUTH_PASSWORD=GENERATE_ME/JICOFO_AUTH_PASSWORD=${JICOFO_AUTH_PASSWORD}/" .env
  perl -0pi -e "s/JVB_AUTH_PASSWORD=GENERATE_ME/JVB_AUTH_PASSWORD=${JVB_AUTH_PASSWORD}/" .env

  echo ".env created with generated secrets."
else
  echo ".env already exists; existing secrets are preserved."
fi

docker compose pull
docker compose up -d

echo
echo "Mattermost: http://localhost:8065"
echo "Jitsi:      https://localhost:8443"
echo
echo "Jitsi uses a local self-signed certificate. The browser will show a warning."
echo "To inspect containers: docker compose ps"
echo "To follow logs:        docker compose logs -f"

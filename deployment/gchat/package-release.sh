#!/usr/bin/env bash
set -euo pipefail
# Run from the repository root after building IMAGE.
: "${IMAGE:?}" "${VERSION:?}" "${SOURCE_SHA:?}" "${GITHUB_RUN_ID:?}" "${GITHUB_RUN_ATTEMPT:?}" "${PLATFORM:?}"
export RELEASE_ID="$SOURCE_SHA-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT"
[[ "$VERSION" =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9.-]+)?$ ]]
[[ "$SOURCE_SHA" =~ ^[a-f0-9]{40}$ ]]
[[ "$IMAGE" == "gchat:$RELEASE_ID" ]]
mkdir release
cp deployment/gchat/{compose.yaml,nginx.conf.template,deploy.sh,render-nginx.py,verify-release.py} release/
docker save "$IMAGE" | gzip -1 > release/gchat-image.tar.gz
export IMAGE_ID
IMAGE_ID=$(docker image inspect "$IMAGE" --format '{{.Id}}')
node --input-type=module <<'JS'
import { writeFileSync } from 'node:fs';
const e = process.env;
writeFileSync('release/release.json', JSON.stringify({
  formatVersion: 1, version: e.VERSION, releaseId: e.RELEASE_ID,
  sourceSha: e.SOURCE_SHA, runId: e.GITHUB_RUN_ID, runAttempt: e.GITHUB_RUN_ATTEMPT,
  platform: e.PLATFORM, image: e.IMAGE, imageId: e.IMAGE_ID,
}, null, 2) + '\n');
JS
(cd release && sha256sum gchat-image.tar.gz compose.yaml nginx.conf.template deploy.sh render-nginx.py verify-release.py release.json > SHA256SUMS)
python3 release/verify-release.py release

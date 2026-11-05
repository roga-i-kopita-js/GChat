#!/usr/bin/env bash
# Called by Actions only after the complete release has been published.
set -euo pipefail
umask 077
: "${SSH_HOST:?}" "${SSH_PORT:?}" "${SSH_USER:?}" "${SSH_KEY:?}" "${SSH_KNOWN_HOSTS:?}" "${INSTALL_ROOT:?}"
[[ "$SSH_HOST" =~ ^[a-zA-Z0-9.-]+$ && "$SSH_USER" =~ ^[a-zA-Z0-9_-]+$ ]]
[[ "$SSH_PORT" =~ ^[0-9]+$ && "$INSTALL_ROOT" =~ ^/[a-zA-Z0-9/_-]+$ ]]
read -r RELEASE_ID _ < <(python3 release/verify-release.py release)
[[ "$RELEASE_ID" =~ ^[a-f0-9]{40}-[0-9]+-[0-9]+$ ]]
SSH_DIR=$(mktemp -d)
trap 'rm -rf "$SSH_DIR"' EXIT
printf '%s\n' "$SSH_KEY" > "$SSH_DIR/key"
printf '%s\n' "$SSH_KNOWN_HOSTS" > "$SSH_DIR/known_hosts"
chmod 600 "$SSH_DIR/key"
OPTIONS=(-i "$SSH_DIR/key" -o BatchMode=yes -o StrictHostKeyChecking=yes -o "UserKnownHostsFile=$SSH_DIR/known_hosts" -o ConnectTimeout=15 -o ServerAliveInterval=15 -o ServerAliveCountMax=3)
TARGET="$SSH_USER@$SSH_HOST"
DEST="$INSTALL_ROOT/incoming/$RELEASE_ID"
# Parameters interpolated into remote shell commands are restricted above.
ssh "${OPTIONS[@]}" -p "$SSH_PORT" "$TARGET" "mkdir -p '$INSTALL_ROOT/incoming' && mkdir '$DEST'"
scp "${OPTIONS[@]}" -P "$SSH_PORT" release/* "$TARGET:$DEST/"
ssh "${OPTIONS[@]}" -p "$SSH_PORT" "$TARGET" \
  "nohup bash '$DEST/deploy.sh' '$INSTALL_ROOT' '$DEST' > '$DEST/deploy.log' 2>&1 < /dev/null &"
for ((i=0; i<360; i++)); do
  # A transport failure fails Actions; the server continues holding its own lock.
  RESULT=$(ssh "${OPTIONS[@]}" -p "$SSH_PORT" "$TARGET" "if test -f '$DEST/result'; then cat '$DEST/result'; else printf pending; fi")
  if [[ "$RESULT" == success ]]; then
    echo "Deployed $RELEASE_ID"
    exit 0
  fi
  if [[ "$RESULT" != pending ]]; then
    echo "Deployment $RELEASE_ID: $RESULT. Inspect $DEST/deploy.log on the server."
    exit 1
  fi
  sleep 5
done
echo "Server operation did not finish within 30 minutes; inspect $DEST before retrying."
exit 1

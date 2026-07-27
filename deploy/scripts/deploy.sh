#!/usr/bin/env bash
# Deploy script for Pauken on Debian server.
# Usage: ./deploy/scripts/deploy.sh [host]

set -euo pipefail

HOST="${1:-pauken.example.com}"
REMOTE_DIR="/opt/pauken"
SSH_KEY="${SSH_KEY:-}"

echo "==> Building Pauken..."
npm run build

echo "==> Syncing to ${HOST}:${REMOTE_DIR}..."
RSYNC_OPTS="-avz --delete"
if [ -n "$SSH_KEY" ]; then
  RSYNC_OPTS="$RSYNC_OPTS -e 'ssh -i $SSH_KEY'"
fi

rsync $RSYNC_OPTS \
  --exclude 'node_modules' \
  --exclude 'src' \
  --exclude 'src-tauri' \
  --exclude '.git' \
  --exclude '.env' \
  --exclude 'node_modules/.cache' \
  ./ "${HOST}:${REMOTE_DIR}/"

echo "==> Installing dependencies on remote..."
ssh "${HOST}" "cd ${REMOTE_DIR} && npm ci --omit=dev"

echo "==> Restarting services..."
ssh "${HOST}" "sudo systemctl daemon-reload && sudo systemctl restart pauken-api"

echo "==> Done! Pauken deployed to ${HOST}"

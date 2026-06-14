#!/usr/bin/env bash
# ============================================
# Cykel deploy — rsync the landing + PWA to the VPS.
# No build step; pushes static files over your existing SSH.
#
# Usage:
#   CYKEL_HOST=cykel.health CYKEL_USER=deploy ./deploy/deploy.sh
# or set the defaults below.
# ============================================
set -euo pipefail

REMOTE_USER="${CYKEL_USER:-root}"
REMOTE_HOST="${CYKEL_HOST:-cykel.health}"
REMOTE_ROOT="${CYKEL_ROOT:-/var/www/cykel}"
SSH_PORT="${CYKEL_SSH_PORT:-22}"

HERE="$(cd "$(dirname "$0")/.." && pwd)"
SSH="ssh -p ${SSH_PORT}"

echo "→ Deploying PWA  → ${REMOTE_HOST}:${REMOTE_ROOT}/app/"
rsync -az --delete -e "${SSH}" \
  --exclude '.DS_Store' \
  "${HERE}/pwa/" "${REMOTE_USER}@${REMOTE_HOST}:${REMOTE_ROOT}/app/"

# NOTE: --exclude '/app/' so syncing the site root never deletes the app subdir.
echo "→ Deploying site → ${REMOTE_HOST}:${REMOTE_ROOT}/"
rsync -az --delete -e "${SSH}" \
  --exclude '.DS_Store' \
  --exclude '/app/' \
  "${HERE}/site/" "${REMOTE_USER}@${REMOTE_HOST}:${REMOTE_ROOT}/"

echo "✓ Done — https://${REMOTE_HOST}"
echo "  Reminder: bump CACHE_NAME in pwa/sw.js before deploying app changes,"
echo "  so installed clients pick up the new code."

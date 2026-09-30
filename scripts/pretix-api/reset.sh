#!/bin/bash
# Resets the pretix test instance to completely empty by removing the
# container and its data volume, then starting a fresh one from the
# same image. This is deliberately the "wipe everything" approach - the
# instance is SQLite-backed and throwaway by design (see this repo's
# AGENTS.md), so there is no partial/selective reset; run pretix-seed
# afterward to repopulate test data.
set -euo pipefail

CONTAINER="${PRETIX_CONTAINER_NAME:-pretix}"
VOLUME="${PRETIX_DATA_VOLUME:-pretix_data}"
IMAGE="${PRETIX_IMAGE:-pretix-custom:local}"
CONFIG_FILE="${PRETIX_CONFIG_FILE:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/pretix.cfg}"
PORT="${PRETIX_PORT:-8345}"

echo "[reset] Removing container \"$CONTAINER\" (if it exists)..."
docker rm -f "$CONTAINER" 2>/dev/null || true

echo "[reset] Removing data volume \"$VOLUME\" (if it exists)..."
docker volume rm "$VOLUME" 2>/dev/null || true

echo "[reset] Creating fresh volume..."
docker volume create "$VOLUME" >/dev/null

echo "[reset] Starting fresh container from image \"$IMAGE\"..."
docker run -d --name "$CONTAINER" \
  -v "$VOLUME:/data" \
  -v "$CONFIG_FILE:/etc/pretix/pretix.cfg:ro" \
  -p "$PORT:8345" \
  "$IMAGE"

echo "[reset] Waiting for pretix to finish migrating..."
until curl -sf -o /dev/null "http://localhost:$PORT/control/login/" 2>/dev/null; do
  status=$(docker inspect "$CONTAINER" --format '{{.State.Status}}' 2>/dev/null || echo "missing")
  if [ "$status" != "running" ]; then
    echo "[reset] Container is not running (status: $status). Logs:"
    docker logs "$CONTAINER" 2>&1 | tail -40
    exit 1
  fi
  sleep 2
done

echo "[reset] Done. Instance is empty and ready at http://localhost:$PORT/control/"
echo "[reset] Run the pretix-seed skill/script next to populate test data."

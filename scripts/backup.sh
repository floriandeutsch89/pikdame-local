#!/usr/bin/env sh
# Consistent backup of the pikdame-data volume (profiles, history, SQLite DB).
# Stops the container briefly so the SQLite WAL is checkpointed and every
# JSON store is flushed - a few seconds of downtime for a guaranteed
# consistent archive.
#
# Usage: ./scripts/backup.sh [compose-file]     (default: docker-compose.yml)
set -eu
COMPOSE_FILE="${1:-docker-compose.yml}"
STAMP=$(date +%Y%m%d-%H%M%S)
OUT="pikdame-backup-${STAMP}.tar.gz"

echo ">> Stopping container (graceful shutdown flushes all stores)..."
docker compose -f "$COMPOSE_FILE" stop pikdame

echo ">> Archiving volume to ${OUT} ..."
docker run --rm \
  -v pikdame-data:/data:ro \
  -v "$(pwd)":/backup \
  alpine tar czf "/backup/${OUT}" -C /data .

echo ">> Starting container..."
docker compose -f "$COMPOSE_FILE" start pikdame
echo ">> Done: ${OUT}"

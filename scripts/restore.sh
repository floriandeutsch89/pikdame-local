#!/usr/bin/env sh
# Restore a backup created by scripts/backup.sh into the pikdame-data volume.
# WARNING: replaces the current volume content.
#
# Usage: ./scripts/restore.sh <backup.tar.gz> [compose-file]
set -eu
BACKUP="${1:?usage: restore.sh <backup.tar.gz> [compose-file]}"
COMPOSE_FILE="${2:-docker/docker-compose.yml}"

echo ">> Stopping container..."
docker compose -f "$COMPOSE_FILE" stop pikdame

echo ">> Restoring ${BACKUP} into volume pikdame-data ..."
docker run --rm \
  -v pikdame-data:/data \
  -v "$(pwd)":/backup:ro \
  alpine sh -c "rm -rf /data/* && tar xzf /backup/${BACKUP} -C /data"

echo ">> Starting container..."
docker compose -f "$COMPOSE_FILE" start pikdame
echo ">> Done."

#!/usr/bin/env sh
# Backup of the PostgreSQL database: everything that matters lives there
# (accounts, profiles, matches, Stammtische, challenge, year review, Kartenhaus).
# The app keeps running - pg_dump reads one consistent snapshot.
#
# Usage: ./scripts/backup.sh [compose-file] [out-dir] [--volume]
#   compose-file  default docker/docker-compose.yml
#   out-dir       default . ; dumps older than PIKDAME_BACKUP_KEEP_DAYS (14) are deleted there
#   --volume      also archive the data volume (session snapshot, monitor history,
#                 the bots' move log, crash.log) - runtime files, not needed for a restore
# Env: PIKDAME_DB_SERVICE / PIKDAME_APP_SERVICE (default: the compose file's postgres* / pikdame*
#      service), PIKDAME_DB_USER, PIKDAME_DB_NAME (pikdame),
#      PIKDAME_NOTIFY_CMD (a command that gets the failure message on stdin).
# Check the dumps with scripts/restore-drill.sh; restore one with scripts/restore.sh.
set -eu

COMPOSE_FILE=docker/docker-compose.yml
OUT_DIR=.
WITH_VOLUME=0
N=0
for arg in "$@"; do
  case "$arg" in
    --volume) WITH_VOLUME=1 ;;
    -*) echo "backup.sh: unknown option $arg" >&2; exit 2 ;;
    *) N=$((N + 1)); if [ "$N" = 1 ]; then COMPOSE_FILE=$arg; else OUT_DIR=$arg; fi ;;
  esac
done
compose() { docker compose -f "$COMPOSE_FILE" "$@"; }
fail() {
  echo "BACKUP FAILED: $1" >&2
  if [ -n "${PIKDAME_NOTIFY_CMD:-}" ]; then printf 'Pik Dame backup failed: %s\n' "$1" | sh -c "$PIKDAME_NOTIFY_CMD" || true; fi
  exit 1
}

DB_SERVICE="${PIKDAME_DB_SERVICE:-$(compose config --services | grep -m1 '^postgres' || true)}"
[ -n "$DB_SERVICE" ] || fail "no postgres service in $COMPOSE_FILE (set PIKDAME_DB_SERVICE)"
DB_USER="${PIKDAME_DB_USER:-pikdame}"
DB_NAME="${PIKDAME_DB_NAME:-pikdame}"
KEEP_DAYS="${PIKDAME_BACKUP_KEEP_DAYS:-14}"
STAMP=$(date +%Y%m%d-%H%M%S)
mkdir -p "$OUT_DIR"
OUT="$OUT_DIR/pikdame-db-${STAMP}.dump"
TMP="$OUT.part"
trap 'rm -f "$TMP"' EXIT

echo ">> Dumping $DB_NAME from service $DB_SERVICE ..."
# Custom format: compressed, and pg_restore can list and check it.
( umask 077; compose exec -T "$DB_SERVICE" pg_dump -U "$DB_USER" -Fc "$DB_NAME" > "$TMP" ) || fail "pg_dump did not finish"
[ -s "$TMP" ] || fail "the dump is empty"
compose exec -T "$DB_SERVICE" pg_restore -l < "$TMP" > /dev/null || fail "the dump is not readable (pg_restore -l)"
mv "$TMP" "$OUT"
echo ">> Done: $OUT ($(wc -c < "$OUT" | tr -d ' ') bytes)"

if [ "$WITH_VOLUME" = 1 ]; then
  APP_SERVICE="${PIKDAME_APP_SERVICE:-$(compose config --services | grep -m1 '^pikdame' || true)}"
  APP_ID=$(compose ps -q "$APP_SERVICE" 2>/dev/null | head -1)
  VOLUME=$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/app/data"}}{{.Name}}{{end}}{{end}}' "$APP_ID" 2>/dev/null || true)
  [ -n "$VOLUME" ] || fail "no data volume found on service ${APP_SERVICE:-?} (is it running?)"
  VOL_OUT="pikdame-data-${STAMP}.tar.gz"
  echo ">> Archiving volume $VOLUME to $OUT_DIR/$VOL_OUT ..."
  docker run --rm -v "$VOLUME":/data:ro -v "$(cd "$OUT_DIR" && pwd)":/backup alpine \
    tar czf "/backup/$VOL_OUT" -C /data . || fail "the volume archive did not finish"
fi

# Retention: only our own files, only in the out-dir itself.
find "$OUT_DIR" -maxdepth 1 -type f \( -name 'pikdame-db-*.dump' -o -name 'pikdame-data-*.tar.gz' \) -mtime +"$KEEP_DAYS" -exec rm -f {} +

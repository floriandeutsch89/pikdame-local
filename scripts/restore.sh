#!/usr/bin/env sh
# Restore a backup made by scripts/backup.sh. REPLACES what is there.
#
# Usage: ./scripts/restore.sh <file> [compose-file] --yes
#   pikdame-db-*.dump         the database (pg_dump custom format)
#   *.sql.gz                  a plain SQL dump of an older backup.sh
#   pikdame-data-*.tar.gz     the data volume (runtime files; older versions: the JSON stores)
# A database restore first checks the file, then saves the current database next to it
# (pikdame-db-before-restore-<stamp>.dump), stops the app, replaces the database and starts the app.
# Env: PIKDAME_DB_SERVICE / PIKDAME_APP_SERVICE, PIKDAME_DB_USER, PIKDAME_DB_NAME (see backup.sh).
set -eu

FILE=
COMPOSE_FILE=docker/docker-compose.yml
YES=0
N=0
for arg in "$@"; do
  case "$arg" in
    --yes) YES=1 ;;
    -*) echo "restore.sh: unknown option $arg" >&2; exit 2 ;;
    *) N=$((N + 1)); if [ "$N" = 1 ]; then FILE=$arg; else COMPOSE_FILE=$arg; fi ;;
  esac
done
[ -n "$FILE" ] || { echo "usage: restore.sh <file> [compose-file] --yes" >&2; exit 2; }
[ -f "$FILE" ] || { echo "restore.sh: $FILE not found" >&2; exit 2; }
compose() { docker compose -f "$COMPOSE_FILE" "$@"; }
SERVICES=$(compose config --services)
DB_SERVICE="${PIKDAME_DB_SERVICE:-$(echo "$SERVICES" | grep -m1 '^postgres' || true)}"
APP_SERVICE="${PIKDAME_APP_SERVICE:-$(echo "$SERVICES" | grep -m1 '^pikdame' || true)}"
DB_USER="${PIKDAME_DB_USER:-pikdame}"
DB_NAME="${PIKDAME_DB_NAME:-pikdame}"

case "$FILE" in
  *.dump|*.sql.gz) KIND=database ;;
  *.tar.gz) KIND=volume ;;
  *) echo "restore.sh: do not know what $FILE is (.dump, .sql.gz or .tar.gz)" >&2; exit 2 ;;
esac
if [ "$YES" != 1 ]; then
  echo "This replaces the $KIND of $COMPOSE_FILE with $FILE. Run again with --yes." >&2
  exit 1
fi

if [ "$KIND" = volume ]; then
  APP_ID=$(compose ps -aq "$APP_SERVICE" | head -1)
  VOLUME=$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/app/data"}}{{.Name}}{{end}}{{end}}' "$APP_ID")
  [ -n "$VOLUME" ] || { echo "restore.sh: no data volume found on service $APP_SERVICE" >&2; exit 1; }
  echo ">> Stopping $APP_SERVICE ..."
  compose stop "$APP_SERVICE"
  echo ">> Restoring $FILE into volume $VOLUME ..."
  # The app runs as uid 10001: a volume owned by root is not writable for it.
  docker run --rm -v "$VOLUME":/data -v "$(cd "$(dirname "$FILE")" && pwd)":/backup:ro alpine \
    sh -c "find /data -mindepth 1 -delete && tar xzf '/backup/$(basename "$FILE")' -C /data && chown -R 10001:10001 /data"
  compose start "$APP_SERVICE"
  echo ">> Done."
  exit 0
fi

[ -n "$DB_SERVICE" ] || { echo "restore.sh: no postgres service in $COMPOSE_FILE" >&2; exit 1; }
# Check before anything is dropped.
case "$FILE" in
  *.dump) compose exec -T "$DB_SERVICE" pg_restore -l < "$FILE" > /dev/null || { echo "restore.sh: $FILE is not a readable dump - nothing changed" >&2; exit 1; } ;;
  *) gunzip -t "$FILE" || { echo "restore.sh: $FILE is not a readable gzip - nothing changed" >&2; exit 1; } ;;
esac
SAFETY="$(dirname "$FILE")/pikdame-db-before-restore-$(date +%Y%m%d-%H%M%S).dump"
echo ">> Saving the current database to $SAFETY ..."
( umask 077; compose exec -T "$DB_SERVICE" pg_dump -U "$DB_USER" -Fc "$DB_NAME" > "$SAFETY" ) || { echo "restore.sh: could not save the current database - nothing changed" >&2; exit 1; }
echo ">> Stopping $APP_SERVICE ..."
compose stop "$APP_SERVICE"
echo ">> Replacing database $DB_NAME ..."
compose exec -T "$DB_SERVICE" psql -q -v ON_ERROR_STOP=1 -U "$DB_USER" -d postgres \
  -c "DROP DATABASE IF EXISTS \"$DB_NAME\" WITH (FORCE)" -c "CREATE DATABASE \"$DB_NAME\" OWNER \"$DB_USER\""
case "$FILE" in
  *.dump) compose exec -T "$DB_SERVICE" pg_restore --no-owner --exit-on-error -U "$DB_USER" -d "$DB_NAME" < "$FILE" ;;
  *) gunzip -c "$FILE" | compose exec -T "$DB_SERVICE" psql -q -v ON_ERROR_STOP=1 -U "$DB_USER" -d "$DB_NAME" > /dev/null ;;
esac
echo ">> Starting $APP_SERVICE ..."
compose start "$APP_SERVICE"
echo ">> Done. The database from before is in $SAFETY."

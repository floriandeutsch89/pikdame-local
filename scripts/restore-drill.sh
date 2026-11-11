#!/usr/bin/env sh
# Restore drill: proves that the newest database dump can be restored, without touching
# the running stack. A backup nobody ever restored is a hope, not a backup.
#
# It restores the dump into a throwaway PostgreSQL container (no network, data in memory,
# removed afterwards), then compares it with the live database:
#   - the newest dump is not older than PIKDAME_DRILL_MAX_AGE_HOURS (36): the backup job runs
#   - pg_restore finishes without an error
#   - the schema version is there and not ahead of the live one
#   - no core table is empty while the live one has rows
#
# Usage: ./scripts/restore-drill.sh [dump-file | dump-dir] [compose-file]
#   default: the newest pikdame-db-*.dump in . ; docker/docker-compose.yml
# Exit 0 and a line "RESTORE DRILL OK ..." on success; 1 and "RESTORE DRILL FAILED: ..." otherwise.
# Env: PIKDAME_DB_SERVICE, PIKDAME_DB_USER, PIKDAME_DB_NAME (see backup.sh),
#      PIKDAME_DRILL_IMAGE (default: the live database's image, else postgres:18-alpine),
#      PIKDAME_NOTIFY_CMD (a command that gets the failure message on stdin).
set -eu

SOURCE="${1:-.}"
COMPOSE_FILE="${2:-docker/docker-compose.yml}"
DB_USER="${PIKDAME_DB_USER:-pikdame}"
DB_NAME="${PIKDAME_DB_NAME:-pikdame}"
MAX_AGE_HOURS="${PIKDAME_DRILL_MAX_AGE_HOURS:-36}"
NAME="pikdame-restore-drill-$$"
TABLES="users players games stammtische"
compose() { docker compose -f "$COMPOSE_FILE" "$@"; }
cleanup() { docker rm -f "$NAME" > /dev/null 2>&1 || true; }
trap cleanup EXIT
fail() {
  echo "RESTORE DRILL FAILED: $1" >&2
  if [ -n "${PIKDAME_NOTIFY_CMD:-}" ]; then printf 'Pik Dame restore drill failed: %s\n' "$1" | sh -c "$PIKDAME_NOTIFY_CMD" || true; fi
  exit 1
}

if [ -d "$SOURCE" ]; then
  DUMP=$(ls -1t "$SOURCE"/pikdame-db-*.dump 2> /dev/null | grep -v -- '-before-restore-' | head -1 || true)
  [ -n "$DUMP" ] || fail "no pikdame-db-*.dump in $SOURCE"
else
  DUMP=$SOURCE
  [ -f "$DUMP" ] || fail "$DUMP not found"
fi
if [ -n "$(find "$DUMP" -mmin +$((MAX_AGE_HOURS * 60)) 2> /dev/null)" ]; then
  fail "the newest dump $DUMP is older than $MAX_AGE_HOURS h - is the backup job still running?"
fi

# The live database, if this host runs one: its image and its numbers.
DB_SERVICE="${PIKDAME_DB_SERVICE:-$(compose config --services 2> /dev/null | grep -m1 '^postgres' || true)}"
LIVE_ID=
if [ -n "$DB_SERVICE" ]; then LIVE_ID=$(compose ps -q "$DB_SERVICE" 2> /dev/null | head -1 || true); fi
IMAGE="${PIKDAME_DRILL_IMAGE:-}"
if [ -z "$IMAGE" ] && [ -n "$LIVE_ID" ]; then IMAGE=$(docker inspect --format '{{.Config.Image}}' "$LIVE_ID" 2> /dev/null || true); fi
IMAGE="${IMAGE:-postgres:18-alpine}"

# One line per fact: "migration=14", "users=120", ... A missing table reads -1.
SQL="SELECT 'migration=' || COALESCE((SELECT MAX(version) FROM schema_migrations), 0)"
for t in $TABLES; do
  SQL="$SQL UNION ALL SELECT '$t=' || CASE WHEN to_regclass('$t') IS NULL THEN -1 ELSE (xpath('/row/n/text()', query_to_xml('SELECT count(*) AS n FROM $t', false, true, '')))[1]::text::bigint END"
done

echo ">> Restoring $DUMP into a throwaway $IMAGE ..."
docker run -d --name "$NAME" --network none --tmpfs /var/lib/postgresql \
  -e POSTGRES_USER="$DB_USER" -e POSTGRES_DB="$DB_NAME" -e POSTGRES_PASSWORD=drill "$IMAGE" > /dev/null \
  || fail "could not start a $IMAGE container"
# TCP answers only after the image's init restart; the socket would answer too early.
i=0
until docker exec "$NAME" pg_isready -q -h 127.0.0.1 -U "$DB_USER" -d "$DB_NAME" 2> /dev/null; do
  i=$((i + 1))
  [ "$i" -lt 60 ] || fail "the throwaway database did not come up in 60 s"
  sleep 1
done
docker exec -i "$NAME" pg_restore --no-owner --exit-on-error -U "$DB_USER" -d "$DB_NAME" < "$DUMP" \
  || fail "pg_restore of $DUMP ended with an error"
RESTORED=$(docker exec "$NAME" psql -At -v ON_ERROR_STOP=1 -U "$DB_USER" -d "$DB_NAME" -c "$SQL") \
  || fail "the restored database has no schema_migrations table"
LIVE=
if [ -n "$LIVE_ID" ]; then
  LIVE=$(docker exec "$LIVE_ID" psql -At -v ON_ERROR_STOP=1 -U "$DB_USER" -d "$DB_NAME" -c "$SQL" 2> /dev/null || true)
fi
value() { printf '%s\n' "$1" | sed -n "s/^$2=//p"; }

R_MIG=$(value "$RESTORED" migration)
[ "${R_MIG:-0}" -ge 1 ] || fail "the restored database has no applied migration"
SUMMARY="schema $R_MIG"
if [ -n "$LIVE" ]; then
  L_MIG=$(value "$LIVE" migration)
  [ "$R_MIG" -le "$L_MIG" ] || fail "the dump's schema ($R_MIG) is ahead of the live one ($L_MIG) - wrong dump?"
fi
for t in $TABLES; do
  r=$(value "$RESTORED" "$t")
  if [ -n "$LIVE" ]; then
    l=$(value "$LIVE" "$t")
    [ "$l" -le 0 ] || [ "$r" -gt 0 ] || fail "table $t is empty in the dump, the live one has $l rows"
    SUMMARY="$SUMMARY, $t $r (live $l)"
  else
    SUMMARY="$SUMMARY, $t $r"
  fi
done
[ -n "$LIVE" ] || SUMMARY="$SUMMARY, no live database here to compare with"
echo "RESTORE DRILL OK: $(basename "$DUMP") - $SUMMARY"

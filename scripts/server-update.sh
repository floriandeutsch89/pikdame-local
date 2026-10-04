#!/usr/bin/env bash
# Pik Dame - update the production stack from the repo and roll it out.
# Counterpart to server-bootstrap.sh. Never touches .env or secrets/*.txt.
# Run as root on the server:
#   curl -fsSL https://raw.githubusercontent.com/floriandeutsch89/pikdame-local/main/scripts/server-update.sh | bash
#
# Optional environment (used by the automatic deploy, see pikdame-deploy.sh):
#   PIKDAME_REF  commit or branch to take the stack files from (default: main)
#   PIKDAME_DIR  stack directory (default: /opt/pikdame/docker)
set -euo pipefail
REF="${PIKDAME_REF:-main}"
DIR="${PIKDAME_DIR:-/opt/pikdame/docker}"
BASE="https://raw.githubusercontent.com/floriandeutsch89/pikdame-local/$REF"
cd "$DIR"

echo "== 1/4 Fetching stack files from $REF (keeps .env and secrets/) =="
for f in docker-compose.prod.yml .env.example caddy/Caddyfile caddy/Dockerfile crowdsec/acquis.yaml; do
  mkdir -p "$(dirname "$f")"
  curl -fsSL "$BASE/docker/$f" -o "$f"
done
mkdir -p /opt/pikdame/scripts
for s in backup.sh restore.sh server-update.sh server-bootstrap.sh; do
  curl -fsSL "$BASE/scripts/$s" -o "/opt/pikdame/scripts/$s"
done
chmod +x /opt/pikdame/scripts/*.sh
echo "   Hint: diff your .env against the refreshed .env.example for new variables."

echo "== 2/4 Secret file permissions (app runs as UID 10001) =="
chown 10001:10001 secrets/*.txt 2>/dev/null || true
chmod 400 secrets/*.txt 2>/dev/null || true

echo "== 3/4 Pulling images =="
docker compose -f docker-compose.prod.yml pull --ignore-buildable
# Caddy comes prebuilt from GHCR. Only a stack switched back to building it
# on the server (build: ./caddy) rebuilds it here.
if grep -qE '^[[:space:]]+build:[[:space:]]*\./caddy' docker-compose.prod.yml; then
  docker compose -f docker-compose.prod.yml build --pull caddy
fi

echo "== 4/4 Rolling out =="
docker compose -f docker-compose.prod.yml up -d --remove-orphans
echo
docker compose -f docker-compose.prod.yml ps
echo
echo "Update done. Watch the logs with:"
echo "  docker compose -f docker-compose.prod.yml logs -f --tail 20"

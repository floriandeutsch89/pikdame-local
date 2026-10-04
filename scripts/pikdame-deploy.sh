#!/usr/bin/env bash
# Pik Dame - entry point for the automatic deploy after a merge to main.
#
# What it does: pull the images of YOUR compose file on this host and recreate
# what changed - Watchtower's job, right away instead of at 04:00. It never
# downloads or changes stack files (compose, .env, Caddyfile); for those run
# server-update.sh by hand when a release asks for it.
#
# Installed ONCE by hand as /usr/local/bin/pikdame-deploy (root:root, 0755);
# a deploy never replaces it. The GitHub workflow reaches it through a
# dedicated user:
#
#   /home/deploy/.ssh/authorized_keys:
#     command="sudo -n /usr/local/bin/pikdame-deploy",restrict ssh-ed25519 AAAA... github-deploy
#   /etc/sudoers.d/pikdame-deploy:
#     Defaults!/usr/local/bin/pikdame-deploy env_keep += "SSH_ORIGINAL_COMMAND"
#     deploy ALL=(root) NOPASSWD: /usr/local/bin/pikdame-deploy
#
# The key can do exactly one thing: run this script. No shell, no forwarding,
# no Docker access of its own.
#
# Input: the merged commit id, sent as the SSH command (SSH_ORIGINAL_COMMAND).
# It only labels the log - the images come from the registry tags in your
# compose file - but anything that is not a 40-character commit id is refused.
#
# Optional /etc/pikdame-deploy.conf (sourced):
#   PIKDAME_DIR=/opt/stacks/pikdame          # default: /opt/pikdame/docker
#   PIKDAME_COMPOSE_FILE=compose.yaml        # default: docker-compose.prod.yml
set -euo pipefail

REF="${SSH_ORIGINAL_COMMAND:-${1:-}}"
if ! [[ "$REF" =~ ^[0-9a-f]{40}$ ]]; then
  echo "pikdame-deploy: expected a 40-character commit id, got '${REF:0:60}'" >&2
  exit 2
fi

if [ -r /etc/pikdame-deploy.conf ]; then
  # shellcheck disable=SC1091
  . /etc/pikdame-deploy.conf
fi
DIR="${PIKDAME_DIR:-/opt/pikdame/docker}"
FILE="${PIKDAME_COMPOSE_FILE:-docker-compose.prod.yml}"
cd "$DIR"
if [ ! -f "$FILE" ]; then
  echo "pikdame-deploy: $DIR/$FILE not found - set PIKDAME_DIR / PIKDAME_COMPOSE_FILE in /etc/pikdame-deploy.conf" >&2
  exit 5
fi

# One deploy at a time: a second merge right after the first waits instead of
# racing it on the same compose project.
exec 9>/run/pikdame-deploy.lock
if ! flock -w 600 9; then
  echo "pikdame-deploy: another deploy is still running after 10 minutes - giving up" >&2
  exit 3
fi

echo "pikdame-deploy: deploying images for commit $REF ($DIR/$FILE)"
# --ignore-buildable: services built on this host (if any) are left alone -
# nothing is compiled here.
docker compose -f "$FILE" pull --ignore-buildable
docker compose -f "$FILE" up -d
# Old image layers, like Watchtower's WATCHTOWER_CLEANUP.
docker image prune -f >/dev/null
docker compose -f "$FILE" ps
echo "pikdame-deploy: done ($REF)"

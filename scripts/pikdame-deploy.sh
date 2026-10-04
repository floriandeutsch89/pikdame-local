#!/usr/bin/env bash
# Pik Dame - entry point for the automatic deploy after a merge to main.
#
# Installed ONCE by hand as /usr/local/bin/pikdame-deploy (root:root, 0755) and
# never replaced by a deploy - so what the deploy key may trigger only changes
# when you change it. The GitHub workflow reaches it through a dedicated user:
#
#   /home/deploy/.ssh/authorized_keys:
#     command="sudo -n /usr/local/bin/pikdame-deploy",restrict ssh-ed25519 AAAA... github-deploy
#   /etc/sudoers.d/pikdame-deploy:
#     Defaults!/usr/local/bin/pikdame-deploy env_keep += "SSH_ORIGINAL_COMMAND"
#     deploy ALL=(root) NOPASSWD: /usr/local/bin/pikdame-deploy
#
# The key can do exactly one thing: roll out a commit of main. No shell, no
# forwarding, no Docker access of its own.
#
# Input: the commit to deploy, sent as the SSH command (sshd puts it into
# SSH_ORIGINAL_COMMAND). Only a full 40-character commit id is accepted;
# anything else is refused before a single file is fetched.
#
# Optional /etc/pikdame-deploy.conf (sourced):
#   PIKDAME_DIR=/opt/stacks/pikdame   # stack directory if not /opt/pikdame/docker
set -euo pipefail

REF="${SSH_ORIGINAL_COMMAND:-${1:-}}"
if ! [[ "$REF" =~ ^[0-9a-f]{40}$ ]]; then
  echo "pikdame-deploy: expected a 40-character commit id, got '${REF:0:60}'" >&2
  exit 2
fi

# The commit must be ON main. Without this check a leaked key could roll out
# any commit GitHub serves for this repository - an unmerged branch included.
# "identical"/"ahead" = main contains it. Public API, no token needed.
STATUS=$(curl -fsS --max-time 15 "https://api.github.com/repos/floriandeutsch89/pikdame-local/compare/$REF...main" \
  | grep -o '"status": *"[a-z]*"' | head -1 | grep -o '[a-z]*"$' | tr -d '"' || true)
if [ "$STATUS" != "identical" ] && [ "$STATUS" != "ahead" ]; then
  echo "pikdame-deploy: $REF is not part of main (compare status: '${STATUS:-unknown}') - refused" >&2
  exit 4
fi

if [ -r /etc/pikdame-deploy.conf ]; then
  # shellcheck disable=SC1091
  . /etc/pikdame-deploy.conf
fi
export PIKDAME_DIR="${PIKDAME_DIR:-/opt/pikdame/docker}"
export PIKDAME_REF="$REF"

# One deploy at a time: a second merge right after the first waits instead of
# racing it on the same compose project.
exec 9>/run/pikdame-deploy.lock
if ! flock -w 600 9; then
  echo "pikdame-deploy: another deploy is still running after 10 minutes - giving up" >&2
  exit 3
fi

echo "pikdame-deploy: rolling out $REF into $PIKDAME_DIR"
TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT
curl -fsSL "https://raw.githubusercontent.com/floriandeutsch89/pikdame-local/$REF/scripts/server-update.sh" -o "$TMP"
bash "$TMP"
echo "pikdame-deploy: done ($REF)"

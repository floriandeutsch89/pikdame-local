# Operations Guide (Docker & Kubernetes)

## Start (Docker)

Everything Docker-specific lives under `docker/` (Dockerfile, compose files,
Caddyfile, `.env.example`, `secrets/`).

```sh
# Production (Caddy with automatic TLS/ACME -> app -> PostgreSQL):
cd docker
cp .env.example .env                              # PIKDAME_DOMAIN, ACME_EMAIL
echo -n 'strong-password' > secrets/db_password.txt
echo -n 'smtp-password'   > secrets/smtp_password.txt   # optional
docker compose -f docker-compose.prod.yml up -d

# Minimal without a domain (prebuilt image):
docker compose -f docker/docker-compose.ghcr.yml up -d
# Local build:
docker compose -f docker/docker-compose.yml up -d
```

### Secrets policy (which mechanism for what)

- **Compose file secrets** (`docker/secrets/*.txt` → `/run/secrets/…`) for
  real secrets: DB password, SMTP password. They never appear in the
  container environment or `docker inspect`; the app and the Postgres image
  read them via `*_FILE` variables. Files are git-ignored.
- **`.env`** only for non-sensitive configuration: domain, ACME e-mail,
  feature toggles. Also git-ignored, but treated as config, not as a vault.
- **Docker (Swarm) secrets** would add encrypted-at-rest distribution - only
  relevant if you ever run Swarm; plain Compose file secrets are the right
  fit for a single host.

### Network layout (prod stack, least privilege)

`caddy_egress` (internet: ACME, future CrowdSec) ← Caddy → `caddy_pikdame`
(internal) ← app → `pikdame` (internal) ← PostgreSQL. The app and the
database have **no route to the internet**. Note: that also blocks outbound
SMTP - to send confirmation mails, attach the app to an egress network or
run an internal mail relay.

## Server bootstrap (fresh Ubuntu/Debian host)

One command as root - system updates, unattended-upgrades with a nightly
reboot window (04:30), fail2ban for SSH, UFW (22/80/443), Docker from the
official repository, and the production stack files under
`/opt/pikdame/docker`:

```sh
curl -fsSL https://raw.githubusercontent.com/floriandeutsch89/pikdame-local/main/scripts/server-bootstrap.sh | bash
```

The script prints the remaining one-time steps (fill `.env`, write the two
secret files, `up -d`, create the CrowdSec bouncer key). After switching to
SSH keys: set `PasswordAuthentication no` and `PermitRootLogin
prohibit-password`, reload sshd, and rotate the root password.

### DNS

Point an **A record** for your domain at the server's IPv4 address
(e.g. `play.pikdame.online -> <server IP>`, TTL 300-3600). A CNAME is only
for pointing at another *name*; for a bare IP an A record is the correct
type. Add an AAAA record only if the host has IPv6. Caddy fetches the TLS
certificate automatically once the record resolves.

## Auto-updates for the stack

Kept deliberately simple: **Watchtower** (the maintained
`nickfedor/watchtower` fork - the original `containrrr` image is
unmaintained and crash-loops on Docker Engine >= 29 with "client version
1.25 is too old") runs inside the prod stack, polls the registry daily at
04:00 and recreates containers that opted in via label (the app image and
PostgreSQL minor updates). The custom-built Caddy
image is excluded - rebuild it explicitly on plugin updates:
`docker compose -f docker-compose.prod.yml build --pull caddy && docker
compose -f docker-compose.prod.yml up -d caddy`.

Alternatives, if you outgrow this: **Portainer** (web UI, manual pulls,
stack management - nice for visibility, no automation by default) or
GitOps-style tools (Komodo, Dokploy). For a single host, Watchtower +
versioned GHCR tags is the sweet spot; pin exact versions instead and drop
Watchtower if you ever need change control.

## CrowdSec (bouncer in Caddy)

Caddy is a custom build (`docker/caddy/Dockerfile`, via xcaddy) with the
CrowdSec bouncer compiled in - plugins cannot be loaded at runtime. The
`crowdsec` service tails Caddy's JSON access log (shared volume) with the
`crowdsecurity/caddy` collection and bans attacking IPs; Caddy checks every
request against the local API. One-time bootstrap after the first start:

```sh
docker compose -f docker-compose.prod.yml exec crowdsec cscli bouncers add caddy-bouncer
# -> put the printed key into .env as CROWDSEC_API_KEY, then:
docker compose -f docker-compose.prod.yml up -d --force-recreate caddy
# Inspect decisions/bans:
docker compose -f docker-compose.prod.yml exec crowdsec cscli decisions list
```

### Troubleshooting: bouncer gets `403` on `/v1/decisions/stream`

The API key Caddy carries does not match any bouncer registered in
CrowdSec. Check `cscli bouncers list`: if `caddy-bouncer` is missing (or
the key was issued by an earlier CrowdSec instance), (re)create it via
`cscli bouncers delete caddy-bouncer` + `cscli bouncers add caddy-bouncer`
and put the new key into `.env`. Then recreate Caddy with
`docker compose -f docker-compose.prod.yml up -d --force-recreate caddy` -
a plain `restart` does NOT re-read `.env`. Success looks like a fresh
"last pull" timestamp in `cscli bouncers list` and no more 403 lines in
the Caddy log.

## SMTP egress (app stays offline)

The app has **no internet route**. Outbound mail works through a dedicated
`smtp-egress` proxy (socat) that can reach exactly ONE destination:
`smtp.eu.mailgun.org:587`. The app talks to it over the internal
`pikdame_smtp` network; TLS is verified against the real Mailgun hostname
(`PIKDAME_SMTP_TLS_SERVERNAME`), so the proxy cannot be silently swapped.
Different provider? Change the `tcp-connect:` target in the `smtp-egress`
service and the servername env.

## Update & rollback

```sh
cd docker
docker compose -f docker-compose.prod.yml pull
docker compose -f docker-compose.prod.yml up -d
```

Running games survive the update: on stop the server writes a session
snapshot (`stop_grace_period: 30s` gives it time) and restores it on the next
start. **Rollback:** pin the image tag in the compose file from `:latest` to
the last good version (e.g. `:v1.12.0`) and run `up -d` again — every release
version is available as its own tag on GHCR.

## Backup & restore

```sh
./scripts/backup.sh docker/docker-compose.prod.yml     # creates pikdame-backup-<stamp>.tar.gz
./scripts/restore.sh pikdame-backup-<stamp>.tar.gz docker/docker-compose.prod.yml
```

The backup stops the app container for a few seconds — this guarantees a
consistent archive of the data volume (flushed JSON stores; SQLite WAL
checkpoint when running the fallback). If the compose stack contains the
PostgreSQL service, the script additionally writes a `pg_dump` of the
accounts database (`pikdame-pgdump-<stamp>.sql.gz`).
Recommendation: run nightly via cron and copy the archive off-site.

## Observability

- `GET /healthz` — liveness (also used by the Docker healthcheck)
- `GET /statusz` — version, session/player counts, memory, accountsEnabled
- Logs: `docker logs -f pikdame` (rotation 10 MB × 3 is configured)
- Crash diagnostics: `data/crash.log` inside the volume

## Kubernetes

The recommended path is the Helm chart (`helm/pikdame`, published as an OCI
artifact on GHCR with every release):
`helm install pikdame oci://ghcr.io/floriandeutsch89/charts/pikdame`.
Raw manifests are available as an alternative under `k8s/` (Deployment,
Service, Ingress with WebSocket timeouts, PVC). **Key point: one replica,
strategy Recreate** — sessions live in RAM, SQLite on the PVC; details in
`k8s/README.md`.

## Best-practice checklist (beyond the stack itself)

- **Off-site backups**: `scripts/backup.sh` via nightly cron, copy the
  archives off the host (object storage, another machine).
  `0 3 * * * cd /opt/pikdame && ./scripts/backup.sh docker/docker-compose.prod.yml`
- **Uptime monitoring**: point an external monitor at `https://<domain>/healthz`.
- **SSH keys** instead of passwords; rotate any password that was ever
  shared in plain text.
- **Mail deliverability**: set up SPF/DKIM/DMARC for the sending domain in
  Mailgun - confirmation mails land in spam otherwise.
- **Public server?** Consider `PIKDAME_PUBLIC_MODE=1` (disables profiles/
  teams/statistics for anonymous strangers).
- **Image pinning**: replace `:latest` with `:vX.Y.Z` once the setup is
  stable and let Watchtower handle only conscious tag bumps - or keep
  `:latest` for convenience on a low-stakes host.

## Security

OWASP hardening, CI scans and host responsibilities: see `SECURITY.md`.

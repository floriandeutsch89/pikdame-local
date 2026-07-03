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

## Security

OWASP hardening, CI scans and host responsibilities: see `SECURITY.md`.

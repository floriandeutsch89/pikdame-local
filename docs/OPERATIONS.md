# Operations Guide (Docker & Kubernetes)

## Start (Docker)

```sh
# With the prebuilt image from GHCR (recommended):
docker compose -f docker-compose.ghcr.yml up -d
# Or build locally:
docker compose up -d
```

Secrets (SMTP password, base URL): copy `.env.example` to `.env`, fill it in
and uncomment the `env_file` block in the compose file. `.env` is git-ignored.

## Update & rollback

```sh
docker compose -f docker-compose.ghcr.yml pull
docker compose -f docker-compose.ghcr.yml up -d
```

Running games survive the update: on stop the server writes a session
snapshot (`stop_grace_period: 30s` gives it time) and restores it on the next
start. **Rollback:** pin the image tag in the compose file from `:latest` to
the last good version (e.g. `:v1.12.0`) and run `up -d` again — every release
version is available as its own tag on GHCR.

## Backup & restore

```sh
./scripts/backup.sh docker-compose.ghcr.yml     # creates pikdame-backup-<stamp>.tar.gz
./scripts/restore.sh pikdame-backup-<stamp>.tar.gz docker-compose.ghcr.yml
```

The backup stops the container for a few seconds — this guarantees a
consistent archive (SQLite WAL checkpoint + flushed JSON stores).
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

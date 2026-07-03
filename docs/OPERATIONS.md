# Betriebshandbuch (Docker & Kubernetes)

## Start (Docker)

```sh
# Mit fertigem Image von GHCR (empfohlen):
docker compose -f docker-compose.ghcr.yml up -d
# Oder lokal bauen:
docker compose up -d
```

Secrets (SMTP-Passwort, Basis-URL): `.env.example` nach `.env` kopieren,
ausfüllen und den `env_file`-Block in der Compose-Datei einkommentieren.
`.env` ist git-ignoriert.

## Update & Rollback

```sh
docker compose -f docker-compose.ghcr.yml pull
docker compose -f docker-compose.ghcr.yml up -d
```

Laufende Spiele überleben das Update: Der Server schreibt beim Stoppen
einen Sitzungs-Snapshot (`stop_grace_period: 30s` gibt ihm Zeit) und liest
ihn beim Start wieder ein. **Rollback:** In der Compose-Datei das
Image-Tag von `:latest` auf die letzte gute Version pinnen
(z. B. `:v1.12.0`) und erneut `up -d` — jede Release-Version liegt als
eigener Tag auf GHCR.

## Backup & Restore

```sh
./scripts/backup.sh docker-compose.ghcr.yml     # erzeugt pikdame-backup-<stamp>.tar.gz
./scripts/restore.sh pikdame-backup-<stamp>.tar.gz docker-compose.ghcr.yml
```

Das Backup stoppt den Container für wenige Sekunden — so sind SQLite
(WAL-Checkpoint) und alle JSON-Stores garantiert konsistent. Empfehlung:
per Cron nachts + Archiv außer Haus kopieren.

## Beobachten

- `GET /healthz` — Liveness (nutzt auch der Docker-Healthcheck)
- `GET /statusz` — Version, Session-/Spielerzahlen, Speicher, accountsEnabled
- Logs: `docker logs -f pikdame` (Rotation: 10 MB × 3 ist konfiguriert)
- Absturz-Diagnose: `data/crash.log` im Volume

## Kubernetes

Manifeste und Anleitung unter `k8s/` (Deployment, Service, Ingress mit
WebSocket-Timeouts, PVC). **Kernpunkt: eine Replika, Strategy Recreate** —
Sessions leben im RAM, SQLite auf dem PVC; Details in `k8s/README.md`.

## Sicherheit

OWASP-Härtung, CI-Scans und Host-Pflichten: siehe `SECURITY.md`.

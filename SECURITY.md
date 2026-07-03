# Sicherheit — OWASP Docker Security

Umsetzung des [OWASP Docker Security Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Docker_Security_Cheat_Sheet.html).
Die Container-Regeln sind in `docker-compose.yml` **und** `docker-compose.ghcr.yml`
identisch umgesetzt und werden in der CI (`docker-smoke`) bei jedem PR mit der
vollen Härtung hochgefahren und geprüft.

## Im Repository umgesetzt

| OWASP-Regel | Umsetzung |
| --- | --- |
| #1 Daemon-Socket schützen | Kein `docker.sock`-Mount, Daemon wird nicht exponiert |
| #2 Kein Root im Container | `USER pikdame` im Dockerfile (unprivilegierter User, eigene Gruppe) |
| #3 Capabilities begrenzen | `cap_drop: ALL` — der Server braucht keine einzige Capability |
| #4 Keine Privilegien-Eskalation | `no-new-privileges:true` + AppArmor-Profil `docker-default` explizit |
| #6 Ressourcen begrenzen | CPU-/RAM-Limits, `pids_limit: 256` (Fork-Bomb-Schutz), `ulimits.nofile 4096`, `restart: unless-stopped` |
| #7 Read-only-Dateisystem | `read_only: true`; beschreibbar nur `data/`-Volume + `/tmp` als tmpfs (`noexec,nosuid,16m`) |
| #8 Schwachstellen-Scan | CI-Job `docker-security`: Trivy (fail ab HIGH, fixbare CVEs) |
| #10 Logging | json-file mit Rotation (10 MB × 3), App loggt nach stdout |
| #11 Dockerfile-Lint | CI-Job `docker-security`: hadolint |

Weitere Bausteine: minimales Alpine-Basisimage mit gepinnter Node-Major-Version
(CI erzwingt Dockerfile-Node == CI-Node), `tini` als PID 1, Healthcheck gegen
`/healthz`, Registry-Bezug ausschließlich über GHCR mit versionierten Tags.

## Verantwortung des Hosts (nicht per Compose erzwingbar)

- **Docker & Host aktuell halten** (Rule #0) — regelmäßige Updates von Engine und Kernel.
- **Rootless Mode** (Rule #12) erwägen: <https://docs.docker.com/engine/security/rootless/>
- Den **TCP-Docker-Socket niemals öffnen** (`-H tcp://…`), keine Socket-Mounts in andere Container.
- Optional: [Docker Bench for Security](https://github.com/docker/docker-bench-security) gegen den Host laufen lassen.
- Auf SELinux-Hosts (Fedora/RHEL): die `apparmor=docker-default`-Zeile in den
  Compose-Dateien auskommentieren — SELinux übernimmt dort dieselbe Rolle.

## Anwendungsseitige Härtung (Auszug)

Passwörter mit scrypt+Salt und zeitkonstanten Vergleichen, IP-Rate-Limits auf
Join- und Konto-API, Session-Obergrenze (`PIKDAME_MAX_SESSIONS`),
Namensschutz für verifizierte Konten, atomare Datei-Persistenz, SQLite im
WAL-Modus, Prozess-Sicherheitsnetze mit Crash-Log statt Absturz.

## Meldungen

Sicherheitsprobleme bitte als GitHub-Issue mit dem Label `security` melden.

# Security — OWASP Docker Security

Implementation of the [OWASP Docker Security Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Docker_Security_Cheat_Sheet.html).
The container rules are implemented identically in `docker-compose.yml` **and**
`docker-compose.ghcr.yml`, mirrored by the Kubernetes manifests (`k8s/`) and
the Helm chart defaults (`helm/pikdame/values.yaml`), and verified in CI
(`docker-smoke`) by booting the fully hardened configuration on every PR.

## Implemented in this repository

| OWASP rule | Implementation |
| --- | --- |
| #1 Protect the daemon socket | No `docker.sock` mount, the daemon is never exposed |
| #2 No root inside the container | `USER pikdame` in the Dockerfile (unprivileged user, own group) |
| #3 Limit capabilities | `cap_drop: ALL` — the server needs no capability at all |
| #4 No privilege escalation | `no-new-privileges:true` + explicit AppArmor profile `docker-default` |
| #6 Limit resources | CPU/RAM limits, `pids: 256` (fork-bomb guard), `ulimits.nofile 4096`, `restart: unless-stopped` |
| #7 Read-only filesystem | `read_only: true`; writable only the `data/` volume + `/tmp` as tmpfs (`noexec,nosuid,16m`) |
| #8 Vulnerability scanning | CI job `docker-security`: Trivy (fails from HIGH, fixable CVEs); CI job `dependency-check` fails on any outdated npm package, and `deps-update.yml` updates them weekly on its own (PR, reviewer, auto-merge only when every check is green) |
| #10 Logging | json-file with rotation (10 MB × 3), the app logs to stdout |
| #11 Dockerfile linting | CI job `docker-security`: hadolint |

Further building blocks: minimal Alpine base image with a pinned Node major
version (CI enforces Dockerfile Node == CI Node), npm/corepack removed from
the final image (smaller attack surface), `tini` as PID 1, healthcheck
against `/healthz`, registry pulls exclusively from GHCR with versioned tags
and OCI labels (version + revision traceable).

## Provisioned host hardening (`terraform/`)

The Hetzner setup in `terraform/` brings the host up hardened by default:
a **cloud firewall** that only allows SSH, 80, 443 and ICMP — it sits in
front of the host and therefore also covers Docker-published ports that a
host firewall such as ufw would bypass; **key-only SSH** (password and
keyboard-interactive authentication disabled, root by key only,
`MaxAuthTries 3`); **fail2ban** on the systemd journal (5 failures in
10 minutes earn a one-hour ban — the journal backend matters because the
Ubuntu cloud image may ship without rsyslog and a file-based jail would
silently never match); and **unattended security upgrades**. The Dockge
management UI is deliberately not exposed — port 5001 stays closed and is
reached through an SSH tunnel.

## Host responsibilities (not enforceable via compose)

- **Keep Docker & host up to date** (rule #0) — regular engine and kernel updates.
- Consider **rootless mode** (rule #12): <https://docs.docker.com/engine/security/rootless/>
- **Never open the TCP Docker socket** (`-H tcp://…`), never mount the socket into containers.
- Optional: run [Docker Bench for Security](https://github.com/docker/docker-bench-security) against the host.
- On SELinux hosts (Fedora/RHEL): comment out the `apparmor=docker-default`
  line in the compose files — SELinux plays the same role there.

## Application-level hardening (excerpt)

Passwords with scrypt + salt and constant-time comparisons, **double opt-in
for accounts** (registration sends a confirmation mail, the link expires
after 48 h, login is refused until the address is confirmed, and expired
unconfirmed accounts are purged so they cannot block a name or address
forever), IP rate limits on the join and account APIs, session cap (`PIKDAME_MAX_SESSIONS`), name
protection for verified accounts, atomic file persistence, parameterized
SQL queries against PostgreSQL (SQLite fallback in WAL mode), process-level
safety nets with a crash log instead of a crash.

## Reporting

Please report security issues as a GitHub issue with the `security` label.

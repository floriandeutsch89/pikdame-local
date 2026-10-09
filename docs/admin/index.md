# Admin manual

Everything needed to run Pik Dame for other people.

```{toctree}
:hidden:

configuration
admin-page
mail
backup-restore
auto-deploy
shared-caddy
beta
onnx
operations
```

## Where to start

| Task | Page |
| --- | --- |
| Which environment variables exist, and what do they do? | {doc}`configuration` |
| **What is missing in my setup?** Startup report, `/admin` page, test mail | {doc}`admin-page` |
| Send account-confirmation mails (SMTP) | {doc}`mail` |
| **Back up my data — and prove the restore works** | {doc}`backup-restore` |
| Run a trained (ONNX) bot instead of the heuristic one | {doc}`onnx` |
| **Deploy automatically after every merge** (instead of nightly) | {doc}`auto-deploy` |
| Try every pull request on a beta site before merging | {doc}`beta` |
| Reverse proxy: the shared Caddy stack (TLS, CrowdSec) | {doc}`shared-caddy` |
| Upgrades, monitoring, CrowdSec, the full ops runbook | {doc}`operations` |

## The one thing to get right

All persistent data lives in **one directory**, mounted into the container at
`/app/data`:

| File | Contents |
| --- | --- |
| `*.json.imported` | Old statistics files after the import into PostgreSQL — keep as a backup or delete |
| `pending-stats.json` | Only after a shutdown while the database was unreachable; applied on the next start |
| `sessions-snapshot.json` | Running tables, written every minute and on shutdown so games survive a restart or crash |

If that directory is not writable, **nothing is saved** and everything is lost on
restart. Since v1.54.4 the server checks this at startup and says so loudly:

```
Datenverzeichnis beschreibbar: /app/data [sessions-snapshot.json 2310B, pending-stats.json –]
```

or, if something is wrong:

```
*** ⚠️  DATENVERZEICHNIS NICHT BESCHREIBBAR ***
```

The usual cause is a volume owned by `root` while the app runs as the non-root
user **UID 10001**. Fix it once:

```bash
docker compose down
docker run --rm -v <project>_pikdame-data:/d alpine chown -R 10001:10001 /d
docker compose up -d
```

## Public servers

On a server open to the internet, consider:

```bash
PIKDAME_PUBLIC_MODE=1     # no player profiles are persisted, no player list in the lobby
PIKDAME_ALLOWED_ORIGIN=https://play.example.com   # only accept WebSockets from your own origin
PIKDAME_TRUST_PROXY=1     # read client IPs from X-Forwarded-For (behind Caddy/nginx)
```

Anonymous aggregate statistics are still counted in public mode; individual
profiles are not.

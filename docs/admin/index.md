# Admin manual

Everything needed to run Pik Dame for other people.

```{toctree}
:hidden:

configuration
admin-page
play-events
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
| Where players get stuck in the Kartenhaus, and why (90 days of attempts) | {doc}`play-events` |
| Send account-confirmation mails (SMTP) | {doc}`mail` |
| **Back up my data — and prove the restore works** | {doc}`backup-restore` |
| Run a trained (ONNX) bot instead of the heuristic one | {doc}`onnx` |
| **Deploy automatically after every merge** (instead of nightly) | {doc}`auto-deploy` |
| Releases from changelog fragments: the automatic release PR (one-time setup) | {doc}`auto-deploy` |
| Try every pull request on a beta site before merging | {doc}`beta` |
| Reverse proxy: the shared Caddy stack (TLS, CrowdSec) | {doc}`shared-caddy` |
| Upgrades, monitoring, CrowdSec, the full ops runbook | {doc}`operations` |

## The one thing to get right

All persistent data lives in **one directory**, mounted into the container at
`/app/data`:

| File | Contents |
| --- | --- |
| `players.json` | Player profiles, statistics, achievements |
| `stats.json` | Anonymous global server statistics |
| `games.json` | Game history |
| `sessions-snapshot.json` | Running tables, written every minute and on shutdown so games survive a restart or crash |

Accounts, the daily challenge (leaderboard and the day's ranked attempts,
14-day retention) and the Kartenhaus attempts ({doc}`play-events`, 90 days)
live in PostgreSQL.

If that directory is not writable, **nothing is saved** and everything is lost on
restart. Since v1.54.4 the server checks this at startup and says so loudly:

```
Datenverzeichnis beschreibbar: /app/data [players.json 4821B, stats.json 812B, ...]
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

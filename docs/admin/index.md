# Admin manual

Everything needed to run Pik Dame for other people.

```{toctree}
:hidden:

configuration
backup-restore
onnx
operations
```

## Where to start

| Task | Page |
| --- | --- |
| Which environment variables exist, and what do they do? | {doc}`configuration` |
| **Back up my data — and prove the restore works** | {doc}`backup-restore` |
| Run a trained (ONNX) bot instead of the heuristic one | {doc}`onnx` |
| Upgrades, monitoring, CrowdSec, the full ops runbook | {doc}`operations` |

## The one thing to get right

All persistent data lives in **one directory**, mounted into the container at
`/app/data`:

| File | Contents |
| --- | --- |
| `players.json` | Player profiles, statistics, achievements |
| `stats.json` | Anonymous global server statistics |
| `games.json` | Game history |
| `challenges.json` | Daily-challenge leaderboard (7-day retention) |
| `users.db` | Accounts — **only** when using SQLite (with PostgreSQL they live in the database) |
| `sessions-snapshot.json` | Running tables, written on shutdown so games survive a restart |

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

# Backup & restore

:::{important}
A backup you have never restored is not a backup. Do the restore drill at the
bottom of this page once — it takes five minutes and is the only way to know.
:::

## What actually needs backing up

| What | Where | Lose it and… |
| --- | --- | --- |
| Accounts, player profiles, Stammtische, daily challenge, game history | the PostgreSQL database (`users`, `login_sessions`, `players` with its `player_*` tables, `stammtische` with its `stammtisch_*` tables, `challenge_results`, `challenge_attempts`, `games`, `game_seats`, `global_stats`, `player_years`, `tower_floors`, …) | …people can't log in, everyone's statistics, badges and progress are gone, so are the groups' tables, the challenge board, today's attempts, "Meine Partien", the server-wide numbers and the year review; the Kartenhaus months from 2027 are picked again (the same deals). Guests can still play. It lives outside the volume. |
| Running games | `sessions-snapshot.json` | …nothing, long-term. Rewritten every minute while tables change and on shutdown; deleted once restored. |

| Bot move log | `human-moves.jsonl` in the data volume | …training data for the bots is gone (only if you train them). |

Everything else — the image, the code, the config — is reproducible from Git and
the registry. **The database is the one thing that is irreplaceable.** Since
v2.131 no game data lives in the data volume any more.

## Backing up

```bash
cd /opt/pikdame
./scripts/backup.sh docker/docker-compose.prod.yml /var/backups/pikdame
```

`backup.sh` writes `pikdame-db-<stamp>.dump` (`pg_dump`, custom format) into the
directory, checks that the file can be read back, and deletes its own dumps older
than `PIKDAME_BACKUP_KEEP_DAYS` (14). **The app keeps running**: `pg_dump` reads
one consistent snapshot. A dump holds e-mail addresses and password hashes; the
file is created readable by its owner only — keep it that way off-site too.

`--volume` also archives the data volume (`pikdame-data-<stamp>.tar.gz`: session
snapshot, monitor history, the bots' move log). You only need it for the move log.

Copy the directory off the host (`rsync`/`rclone` to another machine or object
storage): a dump on the disk that died is no backup.

## The restore drill

```bash
./scripts/restore-drill.sh /var/backups/pikdame docker/docker-compose.prod.yml
```

It restores the newest dump into a **throwaway** PostgreSQL container (no
network, data in memory, removed afterwards) and never touches the running
stack. It fails, with exit code 1 and a line `RESTORE DRILL FAILED: …`, when

- the newest dump is older than `PIKDAME_DRILL_MAX_AGE_HOURS` (36) — the backup
  job stopped running,
- `pg_restore` ends with an error (a truncated or damaged file),
- the schema version is missing, or ahead of the live database (a wrong dump),
- a core table (`users`, `players`, `games`, `stammtische`) is empty in the dump
  while the live one has rows.

On success it prints what came back next to the live numbers:

```
RESTORE DRILL OK: pikdame-db-20261111-030001.dump - schema 14, users 212 (live 213), players 840 (live 843), games 5120 (live 5131), stammtische 9 (live 9)
```

Run both from cron, the drill after the backup:

```
0 3 * * *  cd /opt/pikdame && ./scripts/backup.sh docker/docker-compose.prod.yml /var/backups/pikdame
30 3 * * 1 cd /opt/pikdame && ./scripts/restore-drill.sh /var/backups/pikdame docker/docker-compose.prod.yml
```

A failing job must reach you. Either let cron mail its output (`MAILTO=`), or set
`PIKDAME_NOTIFY_CMD`: both scripts pipe the failure message into that command,
e.g. `PIKDAME_NOTIFY_CMD='curl -fsS -d @- https://ntfy.example/pikdame'`.

The drill needs room for one more PostgreSQL in memory for a minute; on a small
host run it at night.

## Restoring

```bash
./scripts/restore.sh /var/backups/pikdame/pikdame-db-<stamp>.dump docker/docker-compose.prod.yml --yes
```

`restore.sh` checks the file first (a damaged dump changes nothing), saves the
current database next to it (`pikdame-db-before-restore-<stamp>.dump`), stops the
app, replaces the database and starts the app again. Without `--yes` it only says
what it would do. It also takes a plain `*.sql.gz` dump of an older `backup.sh`
and a `pikdame-data-*.tar.gz` volume archive (restored with the ownership the
non-root container needs, `10001:10001`).

On a fresh host: bring the stack up once (`docker compose up -d`), then restore
the dump. Schema migrations newer than the dump run on the app's next start.

## What is *not* backed up

- **Running games.** The snapshot is a convenience for restarts, not a backup.
  If the host dies mid-round, that round is gone. This is by design.
- **Caddy's certificates.** They are re-obtained automatically from Let's
  Encrypt. (Do keep an eye on rate limits if you rebuild often.)

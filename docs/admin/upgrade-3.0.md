# Upgrading to 3.0.0

Version 3.0.0 moves all player statistics from JSON files in the data volume
into PostgreSQL and removes the SQLite account fallback. This page is the
runbook for operators. The tracker app is not affected by this release.

## What changes, and who is affected

| Your setup | What happens |
| --- | --- |
| Compose or Helm stack **with** `PIKDAME_DATABASE_URL` (the prod, ghcr and dev compose files set it) | On the first start the JSON files are imported into PostgreSQL automatically. |
| **No** `PIKDAME_DATABASE_URL` (family server, Kubernetes without a database) | The game runs **play-only**: no accounts, nothing is saved, and your old JSON files are not loaded. Add PostgreSQL first (see step 1). |

- Imported files: `stats.json`, `players.json`, `challenges.json`,
  `stammtisch.json`, `games.json`.
- Accounts in `users.db` (SQLite) are **not** taken over. Accounts that already
  live in PostgreSQL are untouched.
- Profiles, games, Stammtisch tables and challenge days are no longer capped or
  pruned by inactivity.

## 1. Before the upgrade

The examples use the production stack (`docker-compose.prod.yml`, services
`pikdame` and `postgres`). The other compose files use the same service names;
drop the `-f` option there.

Check that the database is configured:

```bash
cd /opt/pikdame/docker
docker compose -f docker-compose.prod.yml exec pikdame printenv PIKDAME_DATABASE_URL
```

Back up the database **and** the data volume (details: {doc}`backup-restore`):

```bash
docker compose -f docker-compose.prod.yml exec -T postgres \
  pg_dump -U pikdame pikdame | gzip > pikdame-db-pre-3.0-$(date +%F).sql.gz

docker compose -f docker-compose.prod.yml stop pikdame
docker run --rm \
  -v <project>_pikdame-data:/data:ro -v "$PWD":/backup \
  alpine tar czf /backup/pikdame-data-pre-3.0-$(date +%F).tar.gz -C /data .
docker compose -f docker-compose.prod.yml start pikdame
```

Find the volume name with `docker volume ls`. Copy both archives off the host.

**No database yet?** Add PostgreSQL before upgrading: set
`PIKDAME_DATABASE_URL` (and optionally `PIKDAME_DATABASE_PASSWORD_FILE`) as
described in {doc}`configuration`. For Kubernetes set `database.url` or
`database.existingSecret` in the Helm values. The JSON files stay in the data
volume and are imported on the first start with a database.

## 2. Try it on the beta site first

If you run a beta site ({doc}`beta`), deploy 3.0.0 there before production.
Copy your JSON files into the beta data volume to see a realistic import. The
beta database persists between deploys, so a second import attempt is skipped
(see "already has data" below); use
`docker compose -f docker-compose.beta.yml down -v` to start from a clean
beta database.

## 3. Upgrade and first start

```bash
docker compose -f docker-compose.prod.yml pull
docker compose -f docker-compose.prod.yml up -d
docker compose -f docker-compose.prod.yml logs -f pikdame | grep '\[stats\]'
```

The server finishes the import **before** it opens its port, so the site is
unreachable until the import is done (Docker may show `unhealthy` meanwhile).
Each file is imported in one transaction. For a family-sized data set this takes
seconds; it grows with the size of the files.

The log shows one line per file that exists, in this order, then the final line:

```
[stats] imported stats.json: 1 rows, 0 dropped
[stats] imported players.json: 42 rows, 0 dropped
...
[stats] statistics loaded from PostgreSQL
```

- **Entries that are not carried over** are logged in full, one line each,
  before the file's summary:
  `[stats] players.json: dropped <reason>: <the JSON entry>`. The `M dropped`
  count in the summary matches them. Copy these lines if you need to restore
  an entry by hand.
- **Renamed files:** every imported file becomes `<name>.json.imported` in the
  volume. Keep them as a backup or delete them later.
- **`already has data - not imported, file left as is`:** the target table is
  not empty (a repeated start after a partial run, or a persistent beta
  database). That file is **not** imported and stays as `.json`. This is a
  safety check, not an error. If you expected an import, the database is not
  the one you think it is: check `PIKDAME_DATABASE_URL`.

## 4. Verify

1. `/healthz` answers `ok`:

   ```bash
   docker compose -f docker-compose.prod.yml exec pikdame \
     node -e "fetch('http://localhost:8080/healthz').then(r=>r.text()).then(console.log)"
   ```

2. On the `/admin` page ({doc}`admin-page`) the **Benutzer** list shows your
   accounts with their XP.
3. In the game, open a few profiles and the game history, and compare them
   with what you remember from before the upgrade.
4. The data volume now contains the `*.json.imported` files.

## 5. Troubleshooting

**The start is refused.** The log ends with
`[stats] startup failed, refusing to start: <reason>` and the container exits
(with `restart: unless-stopped` it restarts in a loop; stop it with
`docker compose ... stop pikdame` while you fix this). The offending file is
left untouched.

- `<file>: not valid JSON (...) - fix or move the file, then restart`: that
  file is corrupt. Restore it from the volume backup, repair it, or move it
  away (its data is then not imported), then start again. An **empty** file is
  fine and is simply renamed.
- `<file>: verification failed - ...`: the rows read back from the database
  did not match the file. That file's import was rolled back; files imported
  earlier in the same run stay imported. Start once more; if it repeats, keep
  the log, roll back (step 6) and report it.
- `pending stats file ... is corrupt`: see `pending-stats.json` below.

**The database is unreachable at start.** The server waits and retries
without giving up, pausing 1 s longer after each failure (up to 30 s), and logs
every attempt: `[stats] database not reachable (...) - retrying in Ns`. Fix the
database or the URL and the start continues by itself. The port stays closed
meanwhile.

**`/healthz` says `ok (stats degraded)`.** The server is up, but statistics
cannot be written to PostgreSQL. Rows are kept and retried (log:
`write failed, will retry`, later `database reachable again`). If it persists,
check the database container and the URL.

**`pending-stats.json` is in the volume.** It is written only at shutdown, and
only when statistics were still unsaved (typically because the database was
down). The next start applies it before the import (log:
`re-applied N unsaved statement(s)`) and removes it. Statements that are not
plain stats writes are rejected and logged
(`pending-stats: rejected statement, not executed`). If the file itself is
corrupt, the start is refused and the error names it; move it away only if you
accept losing those last changes.

**Play-only warning listing old files.** The log shows
`*** ALTE STATISTIK-DATEIEN GEFUNDEN - NICHT GELADEN ***` followed by the file
names. The server has no `PIKDAME_DATABASE_URL`. Set it and restart; the JSON
files are then imported. `users.db` is listed too, but it is never imported.

## 6. Rollback

Games played on 3.0.0 are **lost** when you roll back, because the restored
database predates them.

1. Stop the app and pin the previous image tag (for example `:v2.58.2`) in the
   compose file ({doc}`operations`).
2. Recreate the database and restore the pre-upgrade dump, so the 3.0 stats
   tables do not clash:

   ```bash
   docker compose -f docker-compose.prod.yml stop pikdame
   docker compose -f docker-compose.prod.yml exec -T postgres \
     psql -U pikdame -d postgres -c 'DROP DATABASE pikdame WITH (FORCE)'
   docker compose -f docker-compose.prod.yml exec -T postgres \
     psql -U pikdame -d postgres -c 'CREATE DATABASE pikdame OWNER pikdame'
   gunzip -c pikdame-db-pre-3.0-<date>.sql.gz \
     | docker compose -f docker-compose.prod.yml exec -T postgres psql -U pikdame pikdame
   ```

3. Rename the imported files back (or restore the volume archive), and delete
   `pending-stats.json` if present:

   ```bash
   docker run --rm -v <project>_pikdame-data:/data alpine sh -c \
     'cd /data && for f in *.json.imported; do mv "$f" "${f%.imported}"; done; rm -f pending-stats.json'
   ```

4. `docker compose -f docker-compose.prod.yml up -d` and check `/healthz`.

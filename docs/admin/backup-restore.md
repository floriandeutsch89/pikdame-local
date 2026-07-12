# Backup & restore

:::{important}
A backup you have never restored is not a backup. Do the restore drill at the
bottom of this page once — it takes five minutes and is the only way to know.
:::

## What actually needs backing up

| What | Where | Lose it and… |
| --- | --- | --- |
| Profiles, stats, achievements, history | `players.json`, `stats.json`, `games.json`, `challenges.json` in the data volume | …everyone's statistics and badges are gone. The game still works. |
| Accounts (SQLite) | `users.db` in the data volume | …people can't log in. Guests unaffected. |
| Accounts (PostgreSQL) | the database | …same, but it lives outside the volume. |
| Running games | `sessions-snapshot.json` | …nothing, long-term. It only exists between shutdown and the next start. |

Everything else — the image, the code, the config — is reproducible from Git and
the registry. **The volume is the only thing that is irreplaceable.**

## Backing up the data volume

Stop the app first so the JSON files are not mid-write. (The server flushes and
writes a clean snapshot on `SIGTERM`, which is exactly what `docker compose stop`
sends — so a graceful stop is enough; do not `kill -9`.)

```bash
cd docker
docker compose stop app

# Tar the named volume into a dated archive
docker run --rm \
  -v <project>_pikdame-data:/data:ro \
  -v "$PWD":/backup \
  alpine tar czf /backup/pikdame-data-$(date +%F).tar.gz -C /data .

docker compose start app
```

Find the exact volume name with `docker volume ls`.

:::{tip}
The whole volume is small — kilobytes to a few megabytes. Keep dated archives and
copy them off the host (that is the point). A daily cron job plus
`rsync`/`rclone` to somewhere else is plenty.
:::

## Backing up PostgreSQL (if you use accounts with Postgres)

```bash
docker compose exec -T db pg_dump -U pikdame pikdame \
  | gzip > pikdame-db-$(date +%F).sql.gz
```

This can run while the app is up.

## Restoring

### Data volume

```bash
cd docker
docker compose down

# Recreate the volume and unpack the archive into it
docker volume rm <project>_pikdame-data
docker volume create <project>_pikdame-data
docker run --rm \
  -v <project>_pikdame-data:/data \
  -v "$PWD":/backup \
  alpine sh -c "tar xzf /backup/pikdame-data-2026-07-12.tar.gz -C /data && chown -R 10001:10001 /data"

docker compose up -d
```

:::{warning}
Note the `chown -R 10001:10001`. The container runs as a **non-root user**; a
freshly created volume belongs to root, and the app would silently fail to write
(see {doc}`index`). Restoring without the `chown` is the single most common way
to break this.
:::

### PostgreSQL

```bash
gunzip -c pikdame-db-2026-07-12.sql.gz \
  | docker compose exec -T db psql -U pikdame pikdame
```

## Verify the restore (the drill)

Do this **once**, on a throwaway host or locally — not for the first time during
an actual outage.

1. Take a backup as above.
2. `docker compose down` and **delete** the volume (`docker volume rm …`).
3. Restore from the archive, including the `chown`.
4. `docker compose up -d`, then check the startup log:

   ```bash
   docker compose logs app | grep -i Datenverzeichnis
   ```

   You want the line saying the data directory is **writable**, with non-zero
   file sizes listed — that proves both the permissions and the data are back.
5. Open the app and check that the lobby statistics show the old profiles.

If step 4 prints the loud "NICHT BESCHREIBBAR" warning, the `chown` was missed.

## What is *not* backed up

- **Running games.** The snapshot is a convenience for restarts, not a backup.
  If the host dies mid-round, that round is gone. This is by design.
- **Caddy's certificates.** They are re-obtained automatically from Let's
  Encrypt. (Do keep an eye on rate limits if you rebuild often.)

# Game stats in the database — design

Status: draft for review · 2026-10-09 · sub-project 1 of 2 (sub-project 2:
[shared login](2026-10-09-shared-login-design.md))

## Goal

Every player statistic lives in PostgreSQL instead of JSON files in `data/`.
No player loses a stat in the move. This also prepares the shared login
(sub-project 2), which needs stats tied to account ids rather than files.

## Decisions (agreed in brainstorming)

| Topic | Decision |
|---|---|
| Store API | In-memory cache + asynchronous write-behind to Postgres; the synchronous store API stays |
| Retention | Keep everything: no caps on profiles, games, Stammtisch tables or challenge days |
| Guests | Guest stats are stored too, keyed by nickname; carried over on registration (as `importProfile` today) |
| No database | Postgres is required for persistence. Without `PIKDAME_DATABASE_URL` the game runs play-only: guests, no accounts, nothing persisted. The SQLite account backend is removed |
| Import | Automatic on startup: empty tables + existing JSON → one-transaction import, verified, files renamed to `*.imported` |

## Scope

Moves into Postgres (the game's existing `pikdame` database, same pool as
`PgAccountStore`):

- `players.json` (PlayerStore)
- `games.json` (GameHistoryStore)
- `challenges.json` (ChallengeStore)
- `stammtisch.json` (StammtischStore)
- `stats.json` (GlobalStatsStore)

Stays as files (operational state, not stats): `sessions-snapshot.json`,
`monitor-history.json`, `crash.log`.

Removed: `game/AccountStore.js` (SQLite), `node:sqlite` usage,
`createAccountStoreAuto`'s SQLite branch, `data/users.db`.

Out of scope: progression columns on `users` (`xp`, `games`, `wins`, `season`,
`season_xp`) stay where they are. Sub-project 2 moves them.

## Architecture

### Persistence layer

Today every stats store reads one in-memory document (`file.read()`), mutates
it, and hands it back (`file.write(doc)`). `AtomicJsonFile` writes the file
800 ms later. The new backend keeps exactly that **document interface**, so
the store logic barely changes:

- **`game/PgDocument.js`:** `createPgDocument({ pool, codec })` →
  `{ read(), write(doc), flushSync(), load(), flush(), pendingStatements(), status() }`.
  - **`codec.rows(doc)`** turns the document into keyed upsert statements. On
    a flush, only rows whose serialized values changed since the last
    successful flush are written, in one transaction. A row that vanished
    from the document is deleted only if the codec says so (Stammtisch
    tables); pruned windows (challenge days) stay in the DB.
  - **DB error during a flush:** the rows stay dirty and are retried with
    backoff (1 s → 30 s). The error is logged once per outage, and `/healthz`
    answers `ok (stats degraded)`. Nothing is dropped.
- **`createMemoryDocument()`** keeps the same interface in RAM only. It is
  used when no database is configured.
- **File paths** (a string argument) still give the `AtomicJsonFile` backend.
  Only tests and tools use it; the server never does.
- **Shutdown** (`SIGTERM`): `await flush()` of every persister, with a 5 s
  timeout. Statements that are still unflushed are written to
  `data/pending-stats.json` and re-applied on the next start before
  anything else. This is the only stats file that can still appear.
- **Store API:** each store keeps its **synchronous** public API, and
  `server.js` call sites stay as they are, except game-history reads (below).

### Startup

1. With `PIKDAME_DATABASE_URL` set: create the schema (idempotent `CREATE … IF
   NOT EXISTS`, the same pattern as `PgAccountStore`).
2. Re-apply `data/pending-stats.json` if it exists.
3. Run the import (below).
4. Load the caches.
5. Only then start listening.

If the DB is unreachable at start, retry with backoff and log. Because the
server only listens after the caches are loaded, `/healthz` (and so Caddy
traffic) only comes up once stats are safe. The game service's
`depends_on: postgres (service_healthy)` already covers the normal start.

Without `PIKDAME_DATABASE_URL`, stores run on memory documents: in-memory
only, gone on restart. Accounts stay off (`accountStore = null`; the client
already hides account UI). A startup log line says so.

The game and accounts share one `pg` pool (`game/Db.js`).

### What lives in RAM

| Store | Cached | Read from DB on demand |
|---|---|---|
| PlayerStore | all profiles (small rows) | — |
| GlobalStatsStore | the single counter row | — |
| ChallengeStore | the last 14 days (board, weekly, trend windows) | older days are only kept, nothing reads them yet |
| StammtischStore | all tables with all their games | — |
| GameHistoryStore | nothing | `historyFor(name, limit)` is an **async** query |

Game history is the one store that grows without bound and whose records are
large. Its Postgres variant queues an insert per finished game, flushed like
the documents, and reads asynchronously. Its only reader is the
`getGameHistory` WebSocket handler (`server.js` ~1730), which awaits the
query. Every other call site is unchanged.

## Schema (database `pikdame`)

Times stay **epoch milliseconds (`BIGINT`)** and day keys stay
**`'YYYY-MM-DD'` text**, as in the in-memory shapes and the existing `users`
table. That rules out timezone conversions (`pg` turns `DATE` into a local
JS `Date`).

```sql
CREATE TABLE IF NOT EXISTS player_profiles (
  name_key    TEXT PRIMARY KEY,            -- name.toLowerCase(), today's lookup key
  seq         BIGINT GENERATED ALWAYS AS IDENTITY,  -- keeps list order
  name        TEXT NOT NULL,
  profile_id  TEXT,                        -- "profile-<ts>-<rand>"
  games_played INT, games_won INT, games_lost INT, total_score BIGINT,
  win_streak INT, best_game_score INT, best_round_score INT,
  total_queens_laid INT, total_queens_caught INT, total_jokers_laid INT,
  total_hand_aus INT, last_place_streak INT, total_challenges INT,
  total_stammtisch_games INT, total_puzzles_solved INT, xp BIGINT, daily_streak INT,
  badges JSONB, favorite_badges JSONB, seasonal_backs JSONB,
  quests JSONB, daily JSONB, puzzles JSONB,
  extra JSONB                              -- any other field, so nothing is lost
);

CREATE TABLE IF NOT EXISTS game_records (
  id          TEXT PRIMARY KEY,            -- "game-<ts>-<rand>"
  finished_at BIGINT,
  record      JSONB NOT NULL               -- the stored record, id included
);
CREATE INDEX IF NOT EXISTS game_records_finished ON game_records (finished_at DESC);
CREATE TABLE IF NOT EXISTS game_record_players (
  game_id  TEXT NOT NULL REFERENCES game_records(id) ON DELETE CASCADE,
  seat     SMALLINT NOT NULL,
  name_key TEXT NOT NULL,
  is_bot   BOOLEAN NOT NULL,
  PRIMARY KEY (game_id, seat)
);
CREATE INDEX IF NOT EXISTS game_record_players_name ON game_record_players (name_key) WHERE NOT is_bot;

CREATE TABLE IF NOT EXISTS challenge_scores (
  day TEXT NOT NULL, name_key TEXT NOT NULL, name TEXT NOT NULL,
  score INT NOT NULL, at BIGINT NOT NULL,
  PRIMARY KEY (day, name_key)              -- best score per name and day
);

CREATE TABLE IF NOT EXISTS stammtisch_tables (
  code TEXT PRIMARY KEY, name TEXT, owner TEXT,
  created_at BIGINT, last_activity BIGINT,
  members JSONB NOT NULL, series JSONB, extra JSONB
);
CREATE TABLE IF NOT EXISTS stammtisch_games (
  code TEXT NOT NULL REFERENCES stammtisch_tables(code) ON DELETE CASCADE,
  idx  INT NOT NULL,                       -- position in the table's game list
  at BIGINT, series_no INT, players JSONB NOT NULL, extra JSONB,
  PRIMARY KEY (code, idx)
);

CREATE TABLE IF NOT EXISTS global_stats (
  id BOOLEAN PRIMARY KEY CHECK (id),       -- single row
  games BIGINT NOT NULL, rounds BIGINT NOT NULL, pik_dames_laid_out BIGINT NOT NULL,
  pik_dames_caught BIGINT NOT NULL, hand_aus_rounds BIGINT NOT NULL
);
```

- **Counters are real columns**, so they stay queryable (e.g. for a future
  ladder).
- **Profile counters are nullable**, because the code tells "never set"
  (`undefined`) apart from 0. `NULL` loads back as a missing field.
- **Nested maps** whose shape changes with features stay JSONB.
- **Profiles with a duplicate lower-case name** in an old file were never
  reachable (`find` returns the first one). The import keeps the first one and
  logs the dropped ones.

### Accounts

Profiles stay keyed by name, and the account link works as today:
`importGuestProfile` runs after sign-in and takes the profile by username. The
link from a profile to an account id is added by sub-project 2.

## Retention changes

| Was | Now |
|---|---|
| 500 profiles, least active dropped | no cap |
| 200 games | no cap |
| 14 challenge days, 100 entries/day | all days and entries kept; reads still show 7/14-day windows |
| 300 Stammtisch tables, 180 days inactive, 100 games/table | no cap, nothing evicted |
| quests/puzzles 7 days | unchanged (they are daily state, not stats; their totals are counters) |

## Import from JSON

It runs at startup, per store, only when that store's table is empty and its
file exists:

1. Read the file and normalize it the way the store's own loader does, so
   legacy shapes are handled the same way as today.
2. Insert everything in one transaction per store.
3. Verify inside the transaction: row counts, plus summed `games_played`,
   `games_won`, `xp` and `total_score` equal the file's totals. On mismatch,
   roll back, log loudly, leave the file untouched, and **refuse to start**
   (exit 1). Running on empty tables would let new stats fill them, the
   import would never retry, and the old stats would be stranded. Restarting
   after a fix retries.
4. Commit, then rename the file to `<name>.json.imported`. It is kept and
   never read again.

The import is idempotent per store: tables with rows are never re-imported.

## Bug fixed on the way

`ChallengeStore` has no `flushSync` and is missing from `flushStoresSafely()`
and the shutdown flush, so a challenge submit made in the last 800 ms before a
restart is lost. With the shared persister, every store flushes on shutdown.

## Removing SQLite accounts

- The SQLite store in `game/AccountStore.js` is deleted. The file keeps only
  `createAccountStoreAuto`, which returns `PgAccountStore` (on the shared
  pool) or `null`.
- The CLAUDE.md rule "every account change in both stores" becomes "Postgres
  only". The test rule "accounts tests run against SQLite AND Postgres"
  becomes Postgres only (`PIKDAME_TEST_PG_URL`, already in CI). DB tests skip
  locally without it, as today.
- Docs (`docs/admin/configuration.md`, getting-started): no database means
  play-only. Self-hosting with accounts and stats means running the compose
  stack with Postgres.
- Existing SQLite `users.db` installs: there is no automatic migration. The
  docs already say SQLite → Postgres is not migrated. Production uses Postgres.

## Testing

- **Persister:** batching, last-write-wins, retry on a failing pool,
  shutdown dump to `pending-stats.json` and re-apply on start.
- **Each store:** existing tests keep running on the file backend. New
  codec round-trip tests (write → flush → a fresh store loads identical data)
  run against Postgres, each in its own schema.
- **Import:** fixtures from real-shaped JSON (including legacy profiles with
  `teams` and Stammtisch tables without `owner`) import with identical totals.
  A broken total rolls back and keeps the file.
- **Server:** an end-to-end bot game with Postgres. The profile, game record,
  global stats, Stammtisch game and challenge score appear in their tables.
  `getGameHistory` returns the game.
- **No DB:** the server starts, games play, accounts are hidden, and nothing
  is written to `data/` except the snapshot and monitor files.

## Rollout

- **Major version (3.0.0):** dropping SQLite accounts and file stats breaks
  setups without Postgres. The CHANGELOG notes it under "Removed".
- **Order:** beta (`beta.play.pikdame.online`) first, then prod.
- **Before deploying:** `pg_dump` plus a copy of the `pikdame-data` volume.
- **After deploying:** compare the import log line (counts and totals) with
  the admin page.
- **Rollback:** the previous image plus renaming `*.json.imported` back.
  Games played on the new version are lost in that case, which is acceptable
  for a beta rollback window.

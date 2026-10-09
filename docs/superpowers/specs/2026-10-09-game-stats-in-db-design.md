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

A new `game/PgPersist.js` replaces `AtomicJsonFile` for the stats stores:

- `createPersister(pool, { name, flushDelayMs = 800 })` → `{ markDirty(key, row), flush(), close() }`.
- Dirty rows collect in a map keyed by primary key (last write wins). 800 ms
  after the first change, one transaction upserts them all, as today's file
  debounce does.
- **DB error during flush:** the rows stay dirty and are retried with backoff
  (1 s → 30 s). The error is logged once per outage, and `/healthz` reports
  `stats: degraded`. Nothing is dropped.
- **Shutdown** (`SIGTERM`): `await flush()` with a 5 s timeout. If rows are
  still unflushed, they are written to `data/pending-stats.json` and re-applied
  on the next start before anything else. This is the only stats file that
  can still appear.
- Each store keeps its current **synchronous** public API: reads come from
  RAM, writes update RAM and call `markDirty`. `server.js` call sites stay as
  they are, except the cold reads listed below.

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

Without `PIKDAME_DATABASE_URL`, stores run with a `null` persister: in-memory
only, gone on restart. Accounts stay off (`accountStore = null`; the client
already hides account UI). A startup log line says so.

### What lives in RAM

| Store | Cached | Read from DB on demand |
|---|---|---|
| PlayerStore | all profiles (small rows) | — |
| GlobalStatsStore | the single counter row | — |
| ChallengeStore | the last 14 days (board, weekly, trend windows) | older days are only kept, nothing reads them yet |
| StammtischStore | all tables with the last 100 games each (display window) | — |
| GameHistoryStore | nothing | `listGames`, `getGame` and `historyForPlayer` become **async** queries |

Game history is the one store that grows without bound and whose records are
large, so it is write-through (insert per finished game, via the persister)
with async reads. Its readers are request handlers (`server.js` ~1730 and the
export), which become `await`ed. All other call sites are unchanged.

## Schema (database `pikdame`)

```sql
CREATE TABLE player_profiles (
  name_key     TEXT PRIMARY KEY,          -- LOWER(TRIM(name)), today's lookup key
  name         TEXT NOT NULL,             -- display case as last seen
  user_id      BIGINT REFERENCES users(id) ON DELETE SET NULL,  -- set once linked to an account
  games_played INT NOT NULL DEFAULT 0,  games_won INT NOT NULL DEFAULT 0,
  games_lost   INT NOT NULL DEFAULT 0,  total_score BIGINT NOT NULL DEFAULT 0,
  win_streak   INT NOT NULL DEFAULT 0,  best_game_score INT, best_round_score INT,
  -- … one INT column per existing counter (totalQueensLaid, totalQueensCaught,
  -- totalJokersLaid, totalHandAus, lastPlaceStreak, totalChallenges,
  -- totalStammtischGames, totalPuzzlesSolved, xp, dailyStreak)
  badges          JSONB NOT NULL DEFAULT '{}',   -- {id: ts}
  favorite_badges JSONB NOT NULL DEFAULT '[]',
  seasonal_backs  JSONB NOT NULL DEFAULT '{}',
  quests          JSONB NOT NULL DEFAULT '{}',   -- 7-day window, pruned as today
  daily           JSONB,
  puzzles         JSONB NOT NULL DEFAULT '{}',   -- 7-day window, pruned as today
  legacy_id       TEXT,                          -- old "profile-<ts>-<rand>"
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX player_profiles_user ON player_profiles (user_id) WHERE user_id IS NOT NULL;

CREATE TABLE game_records (
  id             TEXT PRIMARY KEY,           -- "game-<ts>-<rand>"
  finished_at    TIMESTAMPTZ NOT NULL,
  started_at     TIMESTAMPTZ,
  challenge_date DATE,
  stammtisch     BOOLEAN NOT NULL DEFAULT FALSE,
  record         JSONB NOT NULL               -- the full gameRecord as today
);
CREATE INDEX game_records_finished ON game_records (finished_at DESC);
CREATE TABLE game_record_players (            -- for historyForPlayer
  game_id  TEXT REFERENCES game_records(id) ON DELETE CASCADE,
  seat     SMALLINT, name_key TEXT NOT NULL, is_bot BOOLEAN NOT NULL,
  PRIMARY KEY (game_id, seat)
);
CREATE INDEX game_record_players_name ON game_record_players (name_key) WHERE NOT is_bot;

CREATE TABLE challenge_scores (
  day      DATE NOT NULL, name_key TEXT NOT NULL, name TEXT NOT NULL,
  score    INT NOT NULL,  at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (day, name_key)                 -- best score per name and day
);

CREATE TABLE stammtisch_tables (
  code TEXT PRIMARY KEY, name TEXT, owner TEXT,
  created_at TIMESTAMPTZ NOT NULL, last_activity TIMESTAMPTZ NOT NULL,
  members JSONB NOT NULL, series JSONB
);
CREATE TABLE stammtisch_games (
  id   BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code TEXT NOT NULL REFERENCES stammtisch_tables(code) ON DELETE CASCADE,
  at TIMESTAMPTZ NOT NULL, series_no INT, players JSONB NOT NULL
);
CREATE INDEX stammtisch_games_code ON stammtisch_games (code, at DESC);

CREATE TABLE global_stats (
  id BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),  -- single row
  games BIGINT, rounds BIGINT, pik_dames_laid_out BIGINT,
  pik_dames_caught BIGINT, hand_aus_rounds BIGINT
);
```

Counters are real columns, so they stay queryable (e.g. for a future ladder).
Nested maps whose shape changes with features stay JSONB. Timestamps are
converted from epoch ms on import and back when loaded, so in-memory shapes are
unchanged.

### Guest → account link

`player_profiles.user_id` is set when `importGuestProfile` runs (after verify,
login, code-verify, passkey, login link), and on import for every profile whose
`name_key` equals a verified account's `LOWER(username)`. The existing
`profile_imported` guard and the max-merge into account progression stay as
they are. Admin `deleteUser` keeps clearing favourite badges; `ON DELETE SET
NULL` turns the profile back into a guest profile, as today.

## Retention changes

| Was | Now |
|---|---|
| 500 profiles, least active dropped | no cap |
| 200 games | no cap |
| 14 challenge days, 100 entries/day | all days and entries kept; reads still show 7/14-day windows |
| 300 Stammtisch tables, 180 days inactive, 100 games/table | no cap, nothing evicted; RAM keeps the last 100 games per table |
| quests/puzzles 7 days | unchanged (they are daily state, not stats; their totals are counters) |

## Import from JSON

It runs at startup, per store, only when that store's table is empty and its
file exists:

1. Read the file through the existing loaders, so legacy shapes are handled
   the same way as today.
2. Insert everything in one transaction per store.
3. Verify inside the transaction: row counts, plus summed `games_played`,
   `games_won`, `xp` and `total_score` equal the file's totals. On mismatch,
   roll back, log loudly, and keep running on an empty cache **without**
   renaming the file. Restarting after a fix retries.
4. Commit, then rename the file to `<name>.json.imported`. It is kept and
   never read again.

The import is idempotent per store: tables with rows are never re-imported.

## Bug fixed on the way

`ChallengeStore` has no `flushSync` and is missing from `flushStoresSafely()`
and the shutdown flush, so a challenge submit made in the last 800 ms before a
restart is lost. With the shared persister, every store flushes on shutdown.

## Removing SQLite accounts

- `game/AccountStore.js` (SQLite) is deleted, and `createAccountStoreAuto`
  returns `PgAccountStore` or `null`.
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
- **Each store:** existing tests run against the cache with a `null`
  persister; new DB round-trip tests (write → flush → fresh store loads
  identical data) run against Postgres.
- **Import:** fixtures from real-shaped JSON (including legacy profiles with
  `teams` and Stammtisch tables without `owner`) import with identical totals.
  A broken total rolls back and keeps the file.
- **Server:** an end-to-end bot game with Postgres. The profile, game record,
  global stats, Stammtisch game and challenge score appear in their tables.
  `historyForPlayer` returns the game.
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

# Database migrations

The PostgreSQL schema lives in numbered SQL files in `migrations/`, applied by a
small runner of our own (`game/Migrations.js`, no migration tool). Every store
calls `ensureMigrated(pool)` on the shared pool from `game/Database.js` before
its first query; all stores of one process await the same run.

## How a start works

1. **Fast path, no lock:** if `schema_migrations` exists and its highest
   `version` is the highest file number, nothing happens. This is the normal
   start and it takes no lock at all.
2. **Otherwise one transaction** under `pg_advisory_xact_lock(726813)`: create
   `schema_migrations` if needed, re-read the applied versions, run every
   missing file in order and record it (`version`, `name`, `applied_at`).
   Several replicas or parallel test files starting at once wait for each
   other; the second one finds everything applied.
3. **All or nothing:** a failing file rolls the whole transaction back, so no
   half-applied file and no recorded version stays behind. The server's account
   calls answer "database unavailable" and the next call tries again.

Why the fast path matters: DDL on a live table — even
`ALTER TABLE … ADD COLUMN IF NOT EXISTS` on a column that exists — takes an
exclusive lock and deadlocked running transactions when every start ran the
whole schema (release CI, v2.102.1).

## Adding a migration

1. Add `migrations/NNN_what_it_does.sql` with the next number (three digits,
   lowercase `a-z0-9_` name). Numbers run 001, 002, … without gaps; the runner
   refuses to start otherwise.
2. Plain SQL, several statements are fine. Keep it short: it runs inside one
   transaction while other replicas wait. Large data rewrites belong in a
   separate, deliberate step.
3. Add a test that the change works on a database that already has data
   (`test/migrations.test.js` shows the pattern with a temp directory).
4. Follow the naming, type and index rules in {doc}`schema`.

Files from `005` on run exactly once and need not be idempotent (`005`
renames columns). Only `001`–`004` use `IF NOT EXISTS`, for databases from
before the runner.

`005_schema_conventions.sql` moved the tables of `003`/`004` onto those rules:
DATE `game_day`, TIMESTAMPTZ `*_at`, `player_key`/`player_name`, and
`play_events` became `play_attempts` (`target` split into `period` + `stage`,
`duration_ms` replaced by `started_at`). It rewrites `play_events` once while
the other replicas wait (about 2 s per 200,000 rows). An old container still
running during the deploy fails on the renamed columns: challenge calls answer
with an error and play attempts are logged as not stored until it is replaced.

`006_players.sql` creates `players` and its child tables (see {doc}`schema`),
gives every name already in the challenge and play-attempt tables a player row
and adds `player_id NOT NULL` with a foreign key to those three tables (one
rewrite of `play_attempts`, like 005). The profiles themselves come from
`players.json` on the first start of the new version: a one-time import in
`game/PlayerStore.js` (marker `players.json` in `legacy_imports`), not a
migration, because the file lives on the app's volume. An old container still
running during the deploy can no longer insert challenge rows or play
attempts (no `player_id`) until it is replaced.

`007_stammtische.sql` creates the Stammtisch tables (see {doc}`schema`);
`stammtisch.json` is imported on the first start like `players.json` (marker
`stammtisch.json`).

`008_account_conventions.sql` moves the account tables of `001` onto the
conventions: epoch milliseconds become `TIMESTAMPTZ` (`to_timestamp(ms / 1000.0)`,
exact to the millisecond), bare and unclear names get their entity
(`sessions` → `login_sessions`), mutable rows get `updated_at`, and the mail-link
lookups get indexes. `users.player_id` is added empty: `PgAccountStore` links
the confirmed accounts on its first start (in JavaScript, see {doc}`schema`).
An old container still running during the deploy can no longer read accounts:
sign-ins fail, and a client that opens the page there loses its sign-in. Deploy
by stopping the old container first (Compose `up -d`, Kubernetes `Recreate`).

`009_admin_role.sql` adds the admin access tables (`user_roles`,
`admin_sessions`, `admin_audit_events`, see {doc}`schema`). It only creates new
tables: nothing is rewritten and an old container keeps running unchanged; it
just knows nothing of them (its `/admin` still asks for the old token). The
roles come from `PIKDAME_ADMINS` on the first start of the new version.

`010_stammtisch_teams.sql` lets a Stammtisch keep "2 gegen 2" matches
({doc}`team-mode`): `stammtisch_games` gets `team_mode` (default `FALSE`) and
the two team names, `stammtisch_game_seats` a `team_no` (0 or 1, NULL in a solo
match). Constant defaults, so no table is rewritten; every kept match stays a
solo match. An old container still running during the deploy books solo
matches as before and refuses "2 gegen 2" at a Stammtisch.

## Rules

- **Forward-only.** There are no down migrations; undo a change with a new file.
- **Never edit or rename a file once it is on `main`.** Production has recorded
  its number and never runs it again — a changed file silently differs between
  databases.
- **Code must tolerate one version ahead:** during a deploy an old container may
  still run against the new schema, so add columns with defaults and drop
  things only after the code stopped using them.
- The image copies `migrations/` next to `game/` (`docker/Dockerfile`); the
  container only reads it.

## Upgrade from the hash setup

Before the runner, `PgAccountStore` ran its whole schema whenever a SHA-256 of
it was missing from a `schema_version` table. `001_baseline.sql` is exactly that
schema and fully idempotent (`CREATE … IF NOT EXISTS`,
`ADD COLUMN IF NOT EXISTS`), so on an existing database it changes nothing and is
merely recorded. `002_drop_schema_version.sql` then removes the old table. The
runner uses the same advisory-lock key as the hash setup, so an old and a new
container starting together still take turns.

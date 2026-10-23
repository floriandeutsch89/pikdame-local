# Database schema conventions

Rules for every new PostgreSQL table or column (changes go through
{doc}`migrations`). The tables from `001_baseline.sql` (`users`, `sessions`,
`season_*`, `webauthn_credentials`) predate these rules and still use epoch
milliseconds; they move over together with a future `players` table.

## Naming

- **Tables:** plural nouns (`challenge_results`, `play_attempts`).
- **Columns:** say which entity they belong to. `player_key`, `player_name`,
  `session_code`, `status` — never a bare `name`, `key`, `code`, `state`,
  `area` or `target`.
- **One fact per column.** No composite strings like `'2026-11/7'`: that is
  `period = '2026-11'` and `stage = 7`.
- **Constraints and indexes:** `<table>_<columns>_idx`, `<table>_<columns>_key`
  (unique), `<table>_<column>_check`, `<table>_pkey`. Name a `CHECK` yourself
  when PostgreSQL's default would not follow this pattern.

## Time

- **Instants are `TIMESTAMPTZ`**, named `<verb>_at` after the event:
  `started_at`, `finished_at`, `ended_at`, `imported_at`. Never a bare `at`, and
  **no epoch integers** in new tables.
- **Calendar days are `DATE`**, named `*_day` or `*_date` (`game_day`). A game
  day is German midnight; compute it only with `game/GameDay.js` and store the
  result, never derive it in SQL from a timestamp.
- **Mutable rows carry `updated_at TIMESTAMPTZ NOT NULL DEFAULT now()`**, set by
  every `UPDATE` that changes them. Insert-only rows (results, attempts that
  are written once) don't need it.
- No `created_by`/`updated_by`: only the server writes these rows. Add them
  once a human edits rows through the admin page.
- Durations are derived (`ended_at - started_at`), not stored.

## Driver boundary

- `game/Database.js` registers a type parser so `DATE` comes back as the
  `'YYYY-MM-DD'` string (pg's default is a `Date` at local midnight, which
  shifts the day with the server's time zone). Every store requires
  `Database.js`, so the parser is in place before the first query.
- `TIMESTAMPTZ` comes back as a JS `Date`. Stores convert it to milliseconds
  (`getTime()`) and pass `new Date(ms)` as a parameter: the game logic keeps
  working in milliseconds.

## Players

Guests have no account, so player rows are keyed by `player_key` (the name in
lower case, `TEXT`) next to `player_name` (as typed). Once a `players` table
exists, these columns become a foreign key to it.

## Indexes

Every index serves a named query; an index without one is removed. Small
tables (a few thousand rows) are read by their primary key or a sequential
scan, and sorting 100 rows costs microseconds: no extra index there. Measured
with `EXPLAIN (ANALYZE, BUFFERS)` on seeded data (challenge: 14 days × 100
players; play attempts: 200,000 Kartenhaus rows, 2,000 players, 3 months, plus
297,000 puzzle rows, 90 days × 3,300 players, and 20,000 tutorial rows),
PostgreSQL 16:

| Query | Index | Plan | ms |
| --- | --- | --- | --- |
| Challenge board, rank, result, magnet, player count (one day) | `challenge_results_pkey` (game_day, …) | bitmap scan, in-memory sort of ≤ 100 rows | 0.05–0.1 |
| History 7 days, weekly best 5, trend 14 days | none (half to all of the table) | seq scan, 11 pages | ~0.9 |
| Was champion / Damen-Magnet (all kept days of a player) | none (1,400 rows) | seq scan | ~1.1 |
| Attempt or result of a player on a day, insert, `ON CONFLICT` | `challenge_*_pkey` | index scan | < 0.03 |
| Running attempts (`markLostAttempts`, every challenge request) | `challenge_attempts_session_code_idx` (partial, `status = 'running'`) | bitmap scan of the few running rows | 0.03 |
| 100-per-day trim, 14-day retention | `challenge_results_pkey` | index scan | 0.1 |
| Months with tower data, tutorial versions | `play_attempts_mode_period_stage_idx` | recursive CTE, one index probe per period | 0.08 |
| Floors of a month, stuck players | `play_attempts_mode_period_stage_idx` | bitmap scan of the month, in-memory sort | 50–80 |
| Puzzle days, mistakes, players, solve times, stuck players (14 days, 46,000 rows) | `play_attempts_mode_period_stage_idx` (mode, period range) | bitmap scan of the range, hash aggregates | 16–37 each, page 48 |
| The same over 90 days (297,000 rows, most of the table) | none | seq scan, hash aggregates; the stuck list sorts narrow rows | 70–215 each, page 285 |
| Tutorial totals, funnel, where it ends (one version, 20,000 rows) | `play_attempts_mode_period_stage_idx` | bitmap scan; the funnel reads the lesson facts once (materialized CTE) | 13–36, funnel ~200 |
| A player's last 50 attempts (any mode) | `play_attempts_player_key_mode_ended_at_idx` (player_key, mode, ended_at, id) | backward index scan, no sort | 0.06–0.09 |
| Delete a player's attempts | same (player_key prefix) | bitmap scan | 0.4 |
| 90-day retention | `play_attempts_ended_at_idx` (BRIN) | bitmap scan of the oldest block ranges | 2 |
| Insert, `ON CONFLICT (attempt_id)` | `play_attempts_attempt_id_key` | unique probe | 0.07 |

`play_attempts` is insert-heavy, so it keeps four indexes. The retention index
is BRIN (24 kB instead of ~4 MB): rows arrive in time order and freed space is
refilled in time order too. A wider index `(mode, period, stage, player_key,
ended_at DESC)` would remove the sort of the month report but not its time
(the aggregates dominate) and costs every insert, so it is not built.

The puzzle and tutorial modes added no index: their reports filter on the
`(mode, period)` prefix of the existing one, and a 90-day puzzle range is most
of the table, where a sequential scan is the right plan. Their time goes into
reading `facts`, so the queries are shaped instead: a day is grouped by
`period` alone (one kind per day; `(period, facts->>'kind')` made the planner
expect 50,000 groups, sort and spill 21 MB), medians come from a histogram of
seconds (a hash aggregate; `percentile_cont` with `GROUP BY` sorted every row
past `work_mem`), players and stuck players share one `GROUP BY player_key`
instead of two `count(DISTINCT)` sorts, and the stuck list sorts narrow rows,
not `facts`. That took the 90-day puzzle report from 480 to 285 ms and the
tutorial report from 520 to 240 ms. An expression index cannot help here: the
reports need several `facts` fields of every row in the range.

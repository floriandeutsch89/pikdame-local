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
players; play attempts: 200,000 rows, 2,000 players, 3 months), PostgreSQL 16:

| Query | Index | Plan | ms |
| --- | --- | --- | --- |
| Challenge board, rank, result, magnet, player count (one day) | `challenge_results_pkey` (game_day, …) | bitmap scan, in-memory sort of ≤ 100 rows | 0.05–0.1 |
| History 7 days, weekly best 5, trend 14 days | none (half to all of the table) | seq scan, 11 pages | ~0.9 |
| Was champion / Damen-Magnet (all kept days of a player) | none (1,400 rows) | seq scan | ~1.1 |
| Attempt or result of a player on a day, insert, `ON CONFLICT` | `challenge_*_pkey` | index scan | < 0.03 |
| Running attempts (`markLostAttempts`, every challenge request) | `challenge_attempts_session_code_idx` (partial, `status = 'running'`) | bitmap scan of the few running rows | 0.03 |
| 100-per-day trim, 14-day retention | `challenge_results_pkey` | index scan | 0.1 |
| Months with tower data | `play_attempts_mode_period_stage_idx` | recursive CTE, one index probe per month | 0.08 |
| Floors of a month, stuck players | `play_attempts_mode_period_stage_idx` | bitmap scan of the month, in-memory sort | 50–80 |
| A player's last 50 attempts | `play_attempts_player_key_mode_ended_at_idx` (player_key, mode, ended_at, id) | backward index scan, no sort | 0.06 |
| Delete a player's attempts | same (player_key prefix) | bitmap scan | 0.4 |
| 90-day retention | `play_attempts_ended_at_idx` (BRIN) | bitmap scan of the oldest block ranges | 2 |
| Insert, `ON CONFLICT (attempt_id)` | `play_attempts_attempt_id_key` | unique probe | 0.07 |

`play_attempts` is insert-heavy, so it keeps four indexes. The retention index
is BRIN (24 kB instead of ~4 MB): rows arrive in time order and freed space is
refilled in time order too. A wider index `(mode, period, stage, player_key,
ended_at DESC)` would remove the sort of the month report but not its time
(the aggregates dominate) and costs every insert, so it is not built.

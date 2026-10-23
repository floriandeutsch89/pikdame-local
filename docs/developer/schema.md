# Database schema conventions

Rules for every new PostgreSQL table or column (changes go through
{doc}`migrations`). The account tables of `001_baseline.sql` predate them and
were moved over by `008_account_conventions.sql`; only the runner's own
`schema_migrations.applied_at` still counts milliseconds.

## Naming

- **Tables:** plural nouns (`challenge_results`, `play_attempts`).
- **Columns:** say which entity they belong to. `player_key`, `player_name`,
  `session_code`, `status` — never a bare `name`, `key`, `code`, `state`,
  `area` or `target`.
- **One fact per column.** No composite strings like `'2026-11/7'`: that is
  `period = '2026-11'` and `stage = 7`.
- **Constraints and indexes:** `<table>_<columns>_idx`, `<table>_<columns>_key`
  (unique), `<table>_<column>_check`, `<table>_pkey`. Name a `CHECK` yourself
  when PostgreSQL's default would not follow this pattern. PostgreSQL 18 also
  names `NOT NULL` (`<table>_<column>_not_null`) and keeps that name through a
  rename (`users_salt_not_null` on `password_salt`); harmless, not renamed.

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

Guests have no account, so a player is a name: `players` holds one row per
`player_key` (the name in lower case, unique, never empty) with its
`player_name` (the first spelling) and a surrogate `id` that other tables
reference. `created_at` is NULL where the age is unknown (rows imported from
`players.json` without a time in the old id, made for names that only
appeared in the challenge or play attempts, or for an account's name before
its first game); the year review reads it.

- `challenge_results`, `challenge_attempts` and `play_attempts` carry
  `player_id` (`ON DELETE CASCADE`) next to `player_key`/`player_name`. The key
  stays their lookup column (primary keys, indexes, the board's tie-break);
  the name is the spelling of that day. Each insert creates or touches the
  player in the same statement (a CTE).
- Deleting a `players` row deletes the person: profile, badges, quests,
  puzzles, tower stars, challenge rows and play attempts. Deleting an account
  keeps the player (the guest profile stays, see the admin page).
- There is no profile cap: the old store deleted the profiles with the fewest
  games beyond 500 to bound its file. Instead the profiles message lists the
  statistics board's best 500 plus the asking player and the table.

How a profile is stored (`game/PlayerStore.js`):

| Data | Where | Why there |
| --- | --- | --- |
| Counters, records, the daily and the perfect-puzzle streak, the celebration | columns of `players` | one value each; a match is booked with `games_played = games_played + 1` in one upsert |
| Favourite badges (up to 3, ordered) | `players.favorite_badges TEXT[]` | a small list always read and written whole, never queried inside |
| Badges | `player_badges (player_id, badge_id, earned_at)` | the primary key makes "only new badges" one `INSERT … ON CONFLICT DO NOTHING RETURNING` |
| Seasonal card backs | `player_card_backs (player_id, card_back_id, unlocked_day)` | the same: the first unlock day stays |
| Daily quests | `player_quests (player_id, game_day, quest_id, progress)` | increments without a read (two games at once); a week is kept |
| Daily puzzle | `player_puzzles (player_id, game_day, tries, solved, revealed, stars)` | one row per day; days without stars a week, the newest 60 starred days for the archive |
| Kartenhaus | `player_tower_stars (player_id, tower_month, stage, stars)` | best stars per month and floor, summed per month for totals and crowns |

No JSONB: each nested part of the old document is either read per day or
month, or updated by two writers at once. A read-modify-write (streak,
puzzle, tower floor, favourites) runs in one transaction holding the
player's row lock; a match locks its players in `player_key` order, so two
tables booking the same names cannot deadlock.

## Stammtische

A Stammtisch is found by its secret `stammtisch_code` (unique, the lookup
shape `^[A-Z0-9]{2,6}$`); the code lives in `stammtische` only, never in the
game history. Players are referenced by `player_id`:

| Data | Where | Why there |
| --- | --- | --- |
| Name, owner, last use, the running series, the group goals' points and reached weeks | columns of `stammtische` | one value each; `owner_player_id` is the founding account (`ON DELETE SET NULL`: then the earliest member owns it) |
| Members and their head-to-head counters | `stammtisch_members (stammtisch_id, player_id, player_name, games_played, games_won, points, joined_at, last_seen_at)` | one row per person and table; the name as spelled there |
| Matches (the newest 100) and their seats | `stammtisch_games (stammtisch_id, game_no, …)`, `stammtisch_game_seats (stammtisch_id, game_no, seat_no, player_id NULL, player_name, is_bot, score, won)` | the pairwise record is aggregated over seats; `game_no` counts per table, so seats need no surrogate key |
| Series wins of the running series | `stammtisch_series_wins (stammtisch_id, player_id, wins)` | an atomic `wins = wins + 1` decides the series; cleared when the next one starts |
| Matches per game week (60 weeks) | `stammtisch_weeks (stammtisch_id, week_start_day DATE, games_played)` | the weekly target and the streak; `StammtischGoals.js` stays a pure function on them |

A match is booked in one transaction holding the table's row lock (members
in `player_key` order, like the profiles). Deleting a player removes the
memberships and series wins; the seats keep the name as played (the group's
record) without the link. Deleting a table cascades to everything in it. The
caps stay as before: tables unused for 180 days go, beyond the 300 most
recently used too, and that is why `stammtisch_members` needs no `player_id`
index for "my Stammtische" (300 tables are a sequential scan).

## Accounts

An account (`users`) is a confirmed e-mail address that owns a name. Its
`player_id` points at that name's player (`players.player_key` = the name in
lower case, like every store): set when the address is confirmed, NULL before.
Accounts confirmed before `008` are linked by `PgAccountStore` on its first
start, in JavaScript, because SQL `lower()` follows the database's locale (with
`C`, `Öma` stays `Öma`) while the stores use `toLowerCase()`. The link is
`UNIQUE` and `ON DELETE RESTRICT`: a player with an account is deleted only
after the account, and deleting the account keeps the player (the guest
profile). There is no `CHECK` "confirmed means linked": two names that only
`lower()` tells apart (possible in a `C` database: `Öma` and `öma`) would share
one player, so the second account stays unlinked and the link pass logs it.

| Table | What changed in `008` |
| --- | --- |
| `users` | `password_salt`, `email_verified`, `games_played`, `games_won`; `created_at`, `verify_expires_at`, `verify_code_expires_at`, `login_expires_at`, `review_mail_changed_at` as `TIMESTAMPTZ`; `updated_at`, `player_id` |
| `login_sessions` (was `sessions`) | `session_token`, `created_at TIMESTAMPTZ`; a "session" in the code is a game table |
| `webauthn_credentials` | `credential_id`, `credential_name`, `sign_count` (the WebAuthn signature counter), instants as `TIMESTAMPTZ`, `updated_at` |
| `season_finals`, `season_results`, `season_meta` | `finalized_at TIMESTAMPTZ`; `updated_at` (`seen` changes); `meta_key`, `meta_value` |

`PgAccountStore` passes `new Date(…)` and returns `getTime()`, so its API and
the game logic keep milliseconds; expiry is still decided by the app's clock.

## Admin access

The admin area belongs to accounts with the admin role ({doc}`../admin/admin-page`).
`009_admin_role.sql` adds three tables; `game/AdminStore.js` is their only
writer, `scripts/admin-role.js` its break-glass front end.

| Table | What it holds | Why so |
| --- | --- | --- |
| `user_roles (user_id, role_name, grant_source, granted_at)` | one row per grant: `role_name` `admin`, `grant_source` `env` (`PIKDAME_ADMINS`, synced on every start) or `cli` | a table, not `users.is_admin`: the source decides who may take the role away (the start sync removes only `env` rows, the CLI only `cli` rows and refuses while an `env` row exists); rows exist only for the few admins, `ON DELETE CASCADE` ends the role with the account, and a second role is a `CHECK` change |
| `admin_sessions (session_token_hash, user_id, login_session_hash, step_up_method, created_at, last_seen_at)` | an admin sign-in after a step-up: the SHA-256 of the cookie value, the SHA-256 of the game sign-in it came from | no raw token stored (unlike `login_sessions`); idle (15 min, `last_seen_at`) and absolute (8 h, `created_at`) expiry by the app clock; signing out of the game deletes by `login_session_hash`; `last_seen_at` is the only column that changes and doubles as `updated_at` |
| `admin_audit_events (id, occurred_at, user_id, user_name, action, action_target, details JSONB, client_network CIDR)` | who did what in the admin area, 365 days | `user_id` is `ON DELETE SET NULL` and `user_name` a copy, so the trail outlives the account; `client_network` is the address cut to `/24` or `/48` by PostgreSQL (`network(set_masklen(…))`), never the full address; `action_target`, not a bare `target`; `details` is free-form context for the page only, never queried inside |

The role is read on every admin request (one query joins the session, the
account and `user_roles`), so taking it away works at once even where no
session row was deleted.

## Indexes

Every index serves a named query; an index without one is removed. Small
tables (a few thousand rows) are read by their primary key or a sequential
scan, and sorting 100 rows costs microseconds: no extra index there.

Write list queries so the planner expects the real number of rows: the
profiles list as `id IN (top 500) OR player_key = ANY(…)` was estimated at
10,000 rows and JIT-compiled (340 ms); collecting the ids first and reading
them by primary key takes 4 ms.

Measured with `EXPLAIN (ANALYZE, BUFFERS)` on seeded data (challenge: 14 days
× 100 players; play attempts: 200,000 Kartenhaus rows, 2,000 players, 3 months,
plus 297,000 puzzle rows, 90 days × 3,300 players, and 20,000 tutorial rows;
players: 20,000, a quarter without a match, with 300,000 badges, 200,000 tower
floors, 105,000 quest and 120,000 puzzle rows; Stammtische: 300 with 6 members,
100 games of 4 seats and 60 weeks each; accounts: 18,000, a fifth unconfirmed,
with 48,000 sign-ins, 8,000 passkeys and 48,000 season results; admin access: 3 admins, 15 admin sessions,
50,000 audit rows), PostgreSQL 16:

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
| Insert, `ON CONFLICT (attempt_id)`, with the player upsert | `play_attempts_attempt_id_key`, `players_player_key_key` | unique probes | 0.2 |
| Profiles message: the board's best 500 | `players_games_won_total_score_idx` (games_won DESC, total_score DESC, id, partial: games_played > 0) | index-only scan of 500 entries (4.9 ms without: seq scan + top-N sort) | 0.1 |
| Profiles message: 504 rows, badges where favourites show, details of the asker | `players_pkey` (`id = ANY(…)`), `player_badges_pkey` and the other children's keys | index scans, correlated aggregates | 4 |
| One profile by name (badges, quests, puzzles, card backs) | `players_player_key_key`, children's `_pkey` (player_id first) | index scans | 0.2 |
| Lock a profile, book a match, award badges, a quest step | `players_player_key_key`, children's `_pkey` (`ON CONFLICT`) | unique probes | 0.03–0.1 |
| Tower stars of a player (a month or all), a puzzle day, a day's quests | `players_player_key_key` + children's `_pkey` | nested loop, index scans | 0.02–0.04 |
| Prune a player's quests (a week) and puzzle days (60 starred) | children's `_pkey` (player_id prefix) | index scan | 0.01–0.1 |
| Delete a player (cascade) | children's `_pkey`; no `player_id` index on `play_attempts` | the FK trigger scans `play_attempts` | 20 |
| A Stammtisch by code (join, probe, chip) | `stammtische_stammtisch_code_key` | unique probe | 0.01 |
| A whole Stammtisch (summary, chip sheet, before booking a match): 6 members, 100 games, 400 seats, 60 weeks | `stammtische_stammtisch_code_key`, children's `_pkey` (stammtisch_id first) | index scans, JSON aggregates | 2 |
| Its last winner | `stammtisch_games_pkey`, `stammtisch_game_seats_pkey` | index-only probe of the newest game | 0.04 |
| My Stammtische (300 tables) | `players_player_key_key`, `stammtisch_members_pkey` per table | seq scan of `stammtische`, probes | 0.4 |
| Prune unused / beyond 300, trim a table's games | seq scan of 300 rows; `stammtisch_games_pkey` | | 0.1 |
| Sign in by name or e-mail, name or e-mail taken, an account by name (booking, rank, results) | `users_lower_username_key`, `users_lower_email_key` (`LOWER(…)`) | bitmap or index scan | 0.01–0.07 |
| A sign-in (`/api/me`, every account request) | `login_sessions_pkey`, `users_pkey` | nested loop | 0.02 |
| Prune sign-ins older than 90 days (every sign-in) | `login_sessions_created_at_idx` | index range scan (10 ms as a sequential scan) | 0.01 |
| Mail links: confirm, sign in (`FOR UPDATE`), unsubscribe | `users_verify_token_idx`, `users_login_token_hash_idx`, `users_review_unsub_hash_idx` (partial: token set) | index scan (1.5–2.9 ms as sequential scans) | 0.01–0.1 |
| Purge expired unconfirmed sign-ups (every sign-up) | `users_verify_expires_at_idx` (partial: not confirmed) | index scan (9–13 ms as a sequential scan) | 0.06–0.09 |
| Season ladder top 50, rank in the season | `users_season_season_xp_idx` (season, season_xp DESC) | index scan, incremental sort; bitmap count | 0.07; 0.45 |
| An account's passkeys, a passkey by id | `webauthn_credentials_user_id_idx`, `webauthn_credentials_pkey` | index scans | 0.02–0.03 |
| Admin list: the newest 500 with passkey counts | `users_pkey` (backward: id = sign-up order) | index scan, 500 probes | 0.7 (8 ms ordered by `created_at`) |
| Delete an account (cascade) | `login_sessions_user_id_idx`, the season tables' `_pkey`, `webauthn_credentials_user_id_idx` | index scans (2.8 ms with a sequential scan of the sign-ins) | 0.14 |
| Confirm: is the player another account's? Delete a player (FK check) | `users_player_id_key` | index scan | 0.07; 0.3 |
| First start: confirmed accounts without a player | `users_player_id_key` (NULLs) | index scan | 0.5 |
| Year-review recipients (once a year), the season finale's pending seasons (once per season) | none; `users_season_season_xp_idx` | seq scan; bitmap scan | 2.8; 1.8 |
| Is this account admin (`/api/me`, every step-up) | none needed (a few rows; `user_roles_pkey` exists) | seq scan | 0.02 |
| `PIKDAME_ADMINS` sync (once per start): the listed confirmed accounts | `users_lower_email_key` (`LOWER(email) IN (…)`) | index scan per listed address | 0.07 |
| An admin request: session, account, role in one query | `users_pkey` | seq scans of the tiny admin tables, index scan of `users` | 0.04 |
| Sign-out of the game, role removal, housekeeping of expired sessions | none (admins × 8 h of sessions) | seq scan | 0.01 |
| "Protokoll" page (newest first, 50 per page) | `admin_audit_events_occurred_at_idx` | backward index scan, incremental sort | 0.09 (page 10: 0.17) |
| 365-day audit retention | `admin_audit_events_occurred_at_idx` | index-only range scan | 0.01 |

Deleting a player is a rare manual step (a guest's request; an account
deletion removes attempts by `player_key`, indexed), so `play_attempts` gets no
fifth B-tree on `player_id` that every insert would pay for.

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

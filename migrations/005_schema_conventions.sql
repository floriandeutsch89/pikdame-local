-- Schema conventions (docs/developer/schema.md) for the tables of 003 and 004:
-- DATE game days, TIMESTAMPTZ instants named after their event, entity-prefixed
-- names, no composite strings, updated_at on mutable rows. Rows are kept.

-- Day strings that are no real date (the old regex let 2026-13-45 through) cannot
-- be cast; such rows were never written by the code and are dropped.
DELETE FROM challenge_results WHERE NOT pg_input_is_valid(day, 'date');
DELETE FROM challenge_attempts WHERE NOT pg_input_is_valid(day, 'date');
DELETE FROM play_events WHERE NOT pg_input_is_valid(day, 'date');

-- challenge_results: one ranked result per player and game day.
ALTER TABLE challenge_results DROP CONSTRAINT IF EXISTS challenge_results_day_check;
ALTER TABLE challenge_results RENAME COLUMN day TO game_day;
ALTER TABLE challenge_results RENAME COLUMN name_key TO player_key;
ALTER TABLE challenge_results RENAME COLUMN name TO player_name;
ALTER TABLE challenge_results RENAME COLUMN queens TO queens_caught;
ALTER TABLE challenge_results RENAME COLUMN at TO finished_at;
ALTER TABLE challenge_results
  ALTER COLUMN game_day TYPE DATE USING game_day::date,
  ALTER COLUMN finished_at TYPE TIMESTAMPTZ USING to_timestamp(finished_at / 1000.0);
-- At most 100 rows per day: the primary key finds a day, sorting it costs nothing.
DROP INDEX IF EXISTS challenge_results_board;

-- challenge_attempts: the one ranked attempt per player and game day.
ALTER TABLE challenge_attempts DROP CONSTRAINT IF EXISTS challenge_attempts_day_check;
ALTER TABLE challenge_attempts RENAME COLUMN day TO game_day;
ALTER TABLE challenge_attempts RENAME COLUMN name_key TO player_key;
ALTER TABLE challenge_attempts RENAME COLUMN name TO player_name;
ALTER TABLE challenge_attempts RENAME COLUMN code TO session_code;
ALTER TABLE challenge_attempts RENAME COLUMN state TO status;
ALTER TABLE challenge_attempts RENAME COLUMN at TO started_at;
ALTER TABLE challenge_attempts RENAME CONSTRAINT challenge_attempts_state_check TO challenge_attempts_status_check;
ALTER TABLE challenge_attempts
  ALTER COLUMN game_day TYPE DATE USING game_day::date,
  ALTER COLUMN started_at TYPE TIMESTAMPTZ USING to_timestamp(started_at / 1000.0),
  ADD COLUMN updated_at TIMESTAMPTZ;
UPDATE challenge_attempts SET updated_at = started_at;
ALTER TABLE challenge_attempts ALTER COLUMN updated_at SET NOT NULL, ALTER COLUMN updated_at SET DEFAULT now();
-- Partial: markLostAttempts reads the few running rows on every challenge request.
ALTER INDEX IF EXISTS challenge_attempts_running RENAME TO challenge_attempts_session_code_idx;

-- legacy_imports: one row per JSON file moved into the database.
ALTER TABLE legacy_imports RENAME COLUMN name TO source;
ALTER TABLE legacy_imports ALTER COLUMN imported_at TYPE TIMESTAMPTZ USING to_timestamp(imported_at / 1000.0);

-- play_events -> play_attempts: rebuilt (new columns, two dropped), ids kept.
-- target 'YYYY-MM/floor' splits into period + stage; started_at = end - duration.
CREATE TABLE play_attempts (
  id BIGINT GENERATED ALWAYS AS IDENTITY,
  attempt_id TEXT,
  player_key TEXT NOT NULL,
  player_name TEXT NOT NULL,
  mode TEXT NOT NULL,
  period TEXT NOT NULL,
  stage INTEGER,
  outcome TEXT NOT NULL,
  game_day DATE NOT NULL,
  started_at TIMESTAMPTZ NOT NULL,
  ended_at TIMESTAMPTZ NOT NULL,
  turns INTEGER,
  facts JSONB NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT play_attempts_pkey PRIMARY KEY (id),
  CONSTRAINT play_attempts_attempt_id_key UNIQUE (attempt_id),
  CONSTRAINT play_attempts_outcome_check CHECK (outcome IN ('won', 'lost', 'abandoned'))
);
INSERT INTO play_attempts (id, attempt_id, player_key, player_name, mode, period, stage, outcome,
  game_day, started_at, ended_at, turns, facts)
OVERRIDING SYSTEM VALUE
SELECT id, attempt_id, name_key, name, area,
  CASE WHEN target ~ '^\d{4}-\d{2}/\d{1,2}$' THEN split_part(target, '/', 1) ELSE target END,
  CASE WHEN target ~ '^\d{4}-\d{2}/\d{1,2}$' THEN split_part(target, '/', 2)::int END,
  outcome, day::date,
  to_timestamp((at - GREATEST(COALESCE(duration_ms, 0), 0)) / 1000.0),
  to_timestamp(at / 1000.0), turns, facts
FROM play_events;
SELECT setval(pg_get_serial_sequence('play_attempts', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM play_attempts;
DROP TABLE play_events;
-- Admin "Festhänger": a month's rows (bitmap scan, sorted in memory) and the months list.
CREATE INDEX play_attempts_mode_period_stage_idx ON play_attempts (mode, period, stage);
-- Support: one player's latest attempts (newest first, no sort); deletion by player.
CREATE INDEX play_attempts_player_key_mode_ended_at_idx ON play_attempts (player_key, mode, ended_at, id);
-- Retention (ended_at < now - 90 days). BRIN: rows arrive in time order, so it
-- stays tiny and costs inserts next to nothing.
CREATE INDEX play_attempts_ended_at_idx ON play_attempts USING brin (ended_at);

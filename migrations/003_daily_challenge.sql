-- Daily challenge (was data/challenges.json). `day` is the game day as text
-- (YYYY-MM-DD, game/GameDay.js): a DATE column would come back as a JS Date
-- in the server's time zone. `name_key` is the lower-case name. IF NOT EXISTS:
-- a database rebuilt from before the runner may run this file again.
CREATE TABLE IF NOT EXISTS challenge_results (
  day TEXT NOT NULL CHECK (day ~ '^\d{4}-\d{2}-\d{2}$'),
  name_key TEXT NOT NULL,
  name TEXT NOT NULL,
  score INTEGER NOT NULL,
  queens INTEGER NOT NULL DEFAULT 0,
  at BIGINT NOT NULL,
  PRIMARY KEY (day, name_key)
);
CREATE INDEX IF NOT EXISTS challenge_results_board ON challenge_results (day, score DESC, at ASC);

-- One ranked attempt per name and day: the primary key makes "begun = used" atomic.
CREATE TABLE IF NOT EXISTS challenge_attempts (
  day TEXT NOT NULL CHECK (day ~ '^\d{4}-\d{2}-\d{2}$'),
  name_key TEXT NOT NULL,
  name TEXT NOT NULL,
  code TEXT NOT NULL DEFAULT '',
  at BIGINT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('running', 'done', 'lost')),
  PRIMARY KEY (day, name_key)
);
CREATE INDEX IF NOT EXISTS challenge_attempts_running ON challenge_attempts (code) WHERE state = 'running';

-- One row per JSON file moved into the database, so it is never imported twice.
CREATE TABLE IF NOT EXISTS legacy_imports (
  name TEXT PRIMARY KEY,
  imported_at BIGINT NOT NULL
);

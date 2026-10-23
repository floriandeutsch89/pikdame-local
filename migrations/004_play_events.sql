-- Play attempts for balancing and support (game/PlayEvents.js, admin tab
-- "Festhänger"): one row per finished or abandoned attempt, deleted after 90
-- days. `day` is the game day (game/GameDay.js) as text, `name_key` the
-- lower-case name, `target` what was tried (Kartenhaus: 'YYYY-MM/floor'),
-- `facts` the area's details (scores, why it failed). `attempt_id` keeps a
-- replayed snapshot from writing an attempt twice.
CREATE TABLE IF NOT EXISTS play_events (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at BIGINT NOT NULL,
  day TEXT NOT NULL CHECK (day ~ '^\d{4}-\d{2}-\d{2}$'),
  name_key TEXT NOT NULL,
  name TEXT NOT NULL,
  area TEXT NOT NULL,
  target TEXT NOT NULL,
  outcome TEXT NOT NULL CONSTRAINT play_events_outcome CHECK (outcome IN ('won', 'lost', 'abandoned')),
  turns INTEGER,
  duration_ms INTEGER,
  attempt_id TEXT,
  facts JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE UNIQUE INDEX IF NOT EXISTS play_events_attempt ON play_events (attempt_id);
CREATE INDEX IF NOT EXISTS play_events_target ON play_events (area, target);
CREATE INDEX IF NOT EXISTS play_events_player ON play_events (name_key, area, at);
CREATE INDEX IF NOT EXISTS play_events_at ON play_events (at);

-- Finished matches ("Meine Partien"), until now data/games.json (last 200 only), and the
-- anonymous server counters of data/stats.json. Both files are imported once by GameHistoryStore.js.
CREATE TABLE games (
  id BIGINT GENERATED ALWAYS AS IDENTITY,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ NOT NULL,
  challenge_day DATE,
  is_stammtisch BOOLEAN NOT NULL DEFAULT FALSE,
  is_team_mode BOOLEAN NOT NULL DEFAULT FALSE,
  -- Rounds, totals, winners, house rules: always read whole, never queried inside. Names live in game_seats.
  game_record JSONB NOT NULL,
  CONSTRAINT games_pkey PRIMARY KEY (id)
);

CREATE TABLE game_seats (
  game_id BIGINT NOT NULL REFERENCES games (id) ON DELETE CASCADE,
  seat_no SMALLINT NOT NULL,
  seat_ref TEXT NOT NULL, -- the in-game id the record's totals are keyed by ('p1')
  -- NULL for a bot, a seat given up mid-game and a deleted account; player_name NULL = anonymised.
  player_id BIGINT REFERENCES players (id) ON DELETE SET NULL,
  player_name TEXT,
  is_bot BOOLEAN NOT NULL DEFAULT FALSE,
  left_game BOOLEAN NOT NULL DEFAULT FALSE,
  bot_difficulty TEXT,
  final_total INTEGER,
  is_winner BOOLEAN NOT NULL DEFAULT FALSE,
  CONSTRAINT game_seats_pkey PRIMARY KEY (game_id, seat_no),
  CONSTRAINT game_seats_game_id_seat_ref_key UNIQUE (game_id, seat_ref)
);
CREATE INDEX game_seats_player_id_idx ON game_seats (player_id, game_id) WHERE player_id IS NOT NULL;

-- Exactly one row of counters, without names (also kept in public mode).
CREATE TABLE global_stats (
  singleton BOOLEAN NOT NULL DEFAULT TRUE,
  games_played BIGINT NOT NULL DEFAULT 0,
  rounds_played BIGINT NOT NULL DEFAULT 0,
  pik_dames_laid_out BIGINT NOT NULL DEFAULT 0,
  pik_dames_caught BIGINT NOT NULL DEFAULT 0,
  hand_aus_rounds BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT global_stats_pkey PRIMARY KEY (singleton),
  CONSTRAINT global_stats_singleton_check CHECK (singleton)
);
INSERT INTO global_stats DEFAULT VALUES;

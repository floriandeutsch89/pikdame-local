-- Stammtisch tables (was data/stammtisch.json): a group's lasting table, found by
-- its secret code. The code lives here only (never in the game history). Members,
-- the matches played there (the newest 100), the rematch series and the group
-- goals reference the table and the players. Choices: docs/developer/schema.md.
CREATE TABLE stammtische (
  id BIGINT GENERATED ALWAYS AS IDENTITY,
  stammtisch_code TEXT NOT NULL,
  stammtisch_name TEXT NOT NULL,
  -- Who may delete it: the founding account (NULL: the earliest member).
  owner_player_id BIGINT REFERENCES players (id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- A join or a match; tables unused for 180 days are deleted.
  last_used_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- The running rematch series (best of 3); its wins per player in stammtisch_series_wins.
  series_no INTEGER NOT NULL DEFAULT 1,
  series_games INTEGER NOT NULL DEFAULT 0,
  series_winner_name TEXT,
  series_finished_at TIMESTAMPTZ,
  -- Group goals (game/StammtischGoals.js): points and the weeks that reached the target.
  goal_xp INTEGER NOT NULL DEFAULT 0,
  goal_weeks_reached INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT stammtische_pkey PRIMARY KEY (id),
  CONSTRAINT stammtische_stammtisch_code_key UNIQUE (stammtisch_code),
  CONSTRAINT stammtische_stammtisch_code_check CHECK (stammtisch_code ~ '^[A-Z0-9]{2,6}$')
);

-- Who sits at a table: the name as spelled there, the head-to-head counters.
CREATE TABLE stammtisch_members (
  stammtisch_id BIGINT NOT NULL REFERENCES stammtische (id) ON DELETE CASCADE,
  player_id BIGINT NOT NULL REFERENCES players (id) ON DELETE CASCADE,
  player_name TEXT NOT NULL,
  games_played INTEGER NOT NULL DEFAULT 0,
  games_won INTEGER NOT NULL DEFAULT 0,
  points INTEGER NOT NULL DEFAULT 0,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT stammtisch_members_pkey PRIMARY KEY (stammtisch_id, player_id)
);

-- The matches of a table, numbered per table; seats keep the names as played.
CREATE TABLE stammtisch_games (
  stammtisch_id BIGINT NOT NULL REFERENCES stammtische (id) ON DELETE CASCADE,
  game_no INTEGER NOT NULL,
  series_no INTEGER NOT NULL,
  finished_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT stammtisch_games_pkey PRIMARY KEY (stammtisch_id, game_no)
);
CREATE TABLE stammtisch_game_seats (
  stammtisch_id BIGINT NOT NULL,
  game_no INTEGER NOT NULL,
  seat_no SMALLINT NOT NULL,
  -- NULL for a bot; a deleted player's seat stays in the group's record without the link.
  player_id BIGINT REFERENCES players (id) ON DELETE SET NULL,
  player_name TEXT NOT NULL,
  is_bot BOOLEAN NOT NULL DEFAULT FALSE,
  score INTEGER NOT NULL,
  won BOOLEAN NOT NULL DEFAULT FALSE,
  CONSTRAINT stammtisch_game_seats_pkey PRIMARY KEY (stammtisch_id, game_no, seat_no),
  CONSTRAINT stammtisch_game_seats_stammtisch_id_game_no_fkey FOREIGN KEY (stammtisch_id, game_no)
    REFERENCES stammtisch_games (stammtisch_id, game_no) ON DELETE CASCADE
);

-- Series wins of the running series only (cleared when the next one starts).
CREATE TABLE stammtisch_series_wins (
  stammtisch_id BIGINT NOT NULL REFERENCES stammtische (id) ON DELETE CASCADE,
  player_id BIGINT NOT NULL REFERENCES players (id) ON DELETE CASCADE,
  wins INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT stammtisch_series_wins_pkey PRIMARY KEY (stammtisch_id, player_id)
);

-- Matches per game week (Monday, Europe/Berlin) for the weekly target; 60 weeks kept.
CREATE TABLE stammtisch_weeks (
  stammtisch_id BIGINT NOT NULL REFERENCES stammtische (id) ON DELETE CASCADE,
  week_start_day DATE NOT NULL,
  games_played INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT stammtisch_weeks_pkey PRIMARY KEY (stammtisch_id, week_start_day)
);

-- Players (was data/players.json): one row per name, referenced by id from the
-- other tables. Guests have no account, so a player is found by player_key (the
-- name in lower case). Counters are columns; per-day and per-item data are
-- child tables. Choices: docs/developer/schema.md ("Players").
CREATE TABLE players (
  id BIGINT GENERATED ALWAYS AS IDENTITY,
  player_key TEXT NOT NULL,
  player_name TEXT NOT NULL,
  -- NULL: imported without a known creation time (the year review reads it).
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ,
  xp INTEGER NOT NULL DEFAULT 0,
  games_played INTEGER NOT NULL DEFAULT 0,
  games_won INTEGER NOT NULL DEFAULT 0,
  total_score INTEGER NOT NULL DEFAULT 0,
  best_game_score INTEGER,
  best_round_score INTEGER,
  win_streak INTEGER NOT NULL DEFAULT 0,
  last_place_streak INTEGER NOT NULL DEFAULT 0,
  queens_laid INTEGER NOT NULL DEFAULT 0,
  queens_caught INTEGER NOT NULL DEFAULT 0,
  jokers_laid INTEGER NOT NULL DEFAULT 0,
  hand_aus_wins INTEGER NOT NULL DEFAULT 0,
  challenges_played INTEGER NOT NULL DEFAULT 0,
  stammtisch_games INTEGER NOT NULL DEFAULT 0,
  daily_streak INTEGER NOT NULL DEFAULT 0,
  daily_best_streak INTEGER NOT NULL DEFAULT 0,
  daily_last_day DATE,
  daily_grace_day DATE,
  puzzles_solved INTEGER NOT NULL DEFAULT 0,
  perfect_puzzles INTEGER NOT NULL DEFAULT 0,
  perfect_puzzle_streak INTEGER NOT NULL DEFAULT 0,
  best_perfect_puzzle_streak INTEGER NOT NULL DEFAULT 0,
  last_perfect_puzzle_day DATE,
  tower_stars INTEGER NOT NULL DEFAULT 0,
  tower_floors_cleared INTEGER NOT NULL DEFAULT 0,
  tower_crowned_months INTEGER NOT NULL DEFAULT 0,
  celebration TEXT,
  favorite_badges TEXT[] NOT NULL DEFAULT '{}',
  CONSTRAINT players_pkey PRIMARY KEY (id),
  CONSTRAINT players_player_key_key UNIQUE (player_key),
  CONSTRAINT players_player_key_check CHECK (player_key <> ''),
  CONSTRAINT players_favorite_badges_check CHECK (cardinality(favorite_badges) <= 3)
);
-- The statistics board in the profiles message: the best 500 by wins, then score.
CREATE INDEX players_games_won_total_score_idx ON players (games_won DESC, total_score DESC, id) WHERE games_played > 0;

-- Earned badges; the primary key keeps the first award (awardBadges returns only new ones).
CREATE TABLE player_badges (
  player_id BIGINT NOT NULL REFERENCES players (id) ON DELETE CASCADE,
  badge_id TEXT NOT NULL,
  earned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT player_badges_pkey PRIMARY KEY (player_id, badge_id)
);

-- Seasonal card backs; the first unlock day stays.
CREATE TABLE player_card_backs (
  player_id BIGINT NOT NULL REFERENCES players (id) ON DELETE CASCADE,
  card_back_id TEXT NOT NULL,
  unlocked_day DATE NOT NULL,
  CONSTRAINT player_card_backs_pkey PRIMARY KEY (player_id, card_back_id)
);

-- Daily quest counters per game day, pruned to a week on write.
CREATE TABLE player_quests (
  player_id BIGINT NOT NULL REFERENCES players (id) ON DELETE CASCADE,
  game_day DATE NOT NULL,
  quest_id TEXT NOT NULL,
  progress INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT player_quests_pkey PRIMARY KEY (player_id, game_day, quest_id)
);

-- Daily puzzle per game day: tries, solve, reveal and the stars of the solve
-- (the archive shows them). A week of days without stars, 60 starred days.
CREATE TABLE player_puzzles (
  player_id BIGINT NOT NULL REFERENCES players (id) ON DELETE CASCADE,
  game_day DATE NOT NULL,
  tries INTEGER NOT NULL DEFAULT 0,
  solved BOOLEAN NOT NULL DEFAULT FALSE,
  revealed BOOLEAN NOT NULL DEFAULT FALSE,
  stars SMALLINT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT player_puzzles_pkey PRIMARY KEY (player_id, game_day),
  CONSTRAINT player_puzzles_stars_check CHECK (stars BETWEEN 1 AND 3)
);

-- Kartenhaus: the best stars per month and floor; a row exists from the first star.
CREATE TABLE player_tower_stars (
  player_id BIGINT NOT NULL REFERENCES players (id) ON DELETE CASCADE,
  tower_month TEXT NOT NULL,
  stage SMALLINT NOT NULL,
  stars SMALLINT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT player_tower_stars_pkey PRIMARY KEY (player_id, tower_month, stage),
  CONSTRAINT player_tower_stars_tower_month_check CHECK (tower_month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  CONSTRAINT player_tower_stars_stars_check CHECK (stars BETWEEN 1 AND 3)
);

-- Every name already in the challenge and play-attempt tables gets a player
-- (no profile yet, age unknown), then those tables point at it.
INSERT INTO players (player_key, player_name, created_at, last_seen_at)
SELECT DISTINCT ON (player_key) player_key, player_name, NULL, seen_at
  FROM (SELECT player_key, player_name, finished_at AS seen_at FROM challenge_results
        UNION ALL SELECT player_key, player_name, started_at FROM challenge_attempts
        UNION ALL SELECT player_key, player_name, ended_at FROM play_attempts) named
 WHERE player_key <> ''
 ORDER BY player_key, seen_at DESC;
-- The code never wrote an empty key; such a row could not get a player.
DELETE FROM challenge_results WHERE player_key = '';
DELETE FROM challenge_attempts WHERE player_key = '';
DELETE FROM play_attempts WHERE player_key = '';

ALTER TABLE challenge_results ADD COLUMN player_id BIGINT;
UPDATE challenge_results c SET player_id = p.id FROM players p WHERE p.player_key = c.player_key;
ALTER TABLE challenge_results ALTER COLUMN player_id SET NOT NULL,
  ADD CONSTRAINT challenge_results_player_id_fkey FOREIGN KEY (player_id) REFERENCES players (id) ON DELETE CASCADE;

ALTER TABLE challenge_attempts ADD COLUMN player_id BIGINT;
UPDATE challenge_attempts c SET player_id = p.id FROM players p WHERE p.player_key = c.player_key;
ALTER TABLE challenge_attempts ALTER COLUMN player_id SET NOT NULL,
  ADD CONSTRAINT challenge_attempts_player_id_fkey FOREIGN KEY (player_id) REFERENCES players (id) ON DELETE CASCADE;

ALTER TABLE play_attempts ADD COLUMN player_id BIGINT;
UPDATE play_attempts a SET player_id = p.id FROM players p WHERE p.player_key = a.player_key;
ALTER TABLE play_attempts ALTER COLUMN player_id SET NOT NULL,
  ADD CONSTRAINT play_attempts_player_id_fkey FOREIGN KEY (player_id) REFERENCES players (id) ON DELETE CASCADE;

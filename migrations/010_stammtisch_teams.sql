-- "2 gegen 2" at a Stammtisch (docs/developer/team-mode.md): a team match is kept in the
-- match list with its teams, but never counts in the head-to-head record or the series.
-- Constant defaults: no rewrite, and an old container keeps booking solo matches unchanged.
ALTER TABLE stammtisch_games
  ADD COLUMN team_mode BOOLEAN NOT NULL DEFAULT FALSE,
  -- The names the teams gave themselves in the lobby (A: seats 0 and 2, B: 1 and 3).
  ADD COLUMN team_a_name TEXT,
  ADD COLUMN team_b_name TEXT;

-- The seat's team in a team match (0 = A, 1 = B), NULL in a solo match; both winners are won.
ALTER TABLE stammtisch_game_seats
  ADD COLUMN team_no SMALLINT,
  ADD CONSTRAINT stammtisch_game_seats_team_no_check CHECK (team_no IN (0, 1));

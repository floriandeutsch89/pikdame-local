-- Career counters behind the badge families of v2.136 (game/Badges.js): one
-- value each, booked with the match like the counters next to them.
-- A constant default adds no table rewrite; an older container keeps booking
-- matches without naming these columns.
ALTER TABLE players
  ADD COLUMN full_sets INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN ace_rounds INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN joker_swaps INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN blitz_rounds INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN short_wins INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN exact_finishes INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN pile_takes INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN team_wins INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN early_games INTEGER NOT NULL DEFAULT 0;

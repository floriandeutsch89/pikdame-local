-- A bot seat's level (game/Bot.js BOT_LEVELS) for the sheet's "Letzte Partien", like "Meine Partien".
-- NULL for a human, for a bot of an older container and for every match from before: those read "Bot".
-- No default: no table rewrite, and an old container keeps booking seats unchanged.
ALTER TABLE stammtisch_game_seats
  ADD COLUMN bot_difficulty TEXT,
  ADD CONSTRAINT stammtisch_game_seats_bot_difficulty_check
    CHECK (bot_difficulty IS NULL OR (is_bot AND bot_difficulty IN ('easy', 'medium', 'hard', 'zen')));

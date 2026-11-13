-- The table pet a player chose (game/Pets.js), NULL for none: one fact per
-- player, like the victory celebration next to it. No default, no rewrite.
ALTER TABLE players ADD COLUMN pet TEXT;

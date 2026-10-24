-- Badge unlock cards (docs/developer/schema.md, "Players"): when the owner was shown a
-- badge. NULL = not yet; the first device to receive it claims it, no other repeats it.
-- now() is STABLE, so the default is stored once in the catalogue (no table rewrite):
-- every badge earned before this release reads as shown at the migration, new ones start NULL.
ALTER TABLE player_badges ADD COLUMN notified_at TIMESTAMPTZ DEFAULT now();
ALTER TABLE player_badges ALTER COLUMN notified_at DROP DEFAULT;

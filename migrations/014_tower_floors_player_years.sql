-- Kartenhaus deals the server picks itself (months from 2027-01), until now data/tower-months.json,
-- and the year review counters of data/years.json. Both files are imported once (TowerMonthStore.js, YearStatsStore.js).
CREATE TABLE tower_floors (
  tower_month TEXT NOT NULL,
  stage SMALLINT NOT NULL,
  gen_version SMALLINT NOT NULL,
  -- The picked deal with its proofs, or {"locked": true}: read whole by the generator, never queried inside.
  floor_entry JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT tower_floors_pkey PRIMARY KEY (tower_month, stage),
  CONSTRAINT tower_floors_tower_month_check CHECK (tower_month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  CONSTRAINT tower_floors_stage_check CHECK (stage BETWEEN 1 AND 20)
);

CREATE TABLE player_years (
  player_id BIGINT NOT NULL REFERENCES players (id) ON DELETE CASCADE,
  stats_year SMALLINT NOT NULL,
  -- YearReview.bumpYear's bucket (counters plus small capped maps of opponents, bots, tables): one pure function reads and writes it whole.
  year_stats JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT player_years_pkey PRIMARY KEY (player_id, stats_year)
);

-- The first day anything was counted (the review flags years that began before it); one row.
CREATE TABLE year_tracking (
  singleton BOOLEAN NOT NULL DEFAULT TRUE,
  since_day DATE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT year_tracking_pkey PRIMARY KEY (singleton),
  CONSTRAINT year_tracking_singleton_check CHECK (singleton)
);
INSERT INTO year_tracking DEFAULT VALUES;

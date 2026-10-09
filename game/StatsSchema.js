// game/StatsSchema.js
// Stats tables (see docs/superpowers/specs/2026-10-09-game-stats-in-db-design.md).
// Times are epoch ms, days 'YYYY-MM-DD' text: pg would turn DATE into a local Date.
const STATS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS player_profiles (
    name_key TEXT PRIMARY KEY,
    seq BIGINT GENERATED ALWAYS AS IDENTITY,
    name TEXT NOT NULL,
    profile_id TEXT,
    games_played INT, games_won INT, games_lost INT, total_score BIGINT,
    win_streak INT, best_game_score INT, best_round_score INT,
    total_queens_laid INT, total_queens_caught INT, total_jokers_laid INT,
    total_hand_aus INT, last_place_streak INT, total_challenges INT,
    total_stammtisch_games INT, total_puzzles_solved INT, xp BIGINT, daily_streak INT,
    badges JSONB, favorite_badges JSONB, seasonal_backs JSONB,
    quests JSONB, daily JSONB, puzzles JSONB,
    extra JSONB
  );
  CREATE TABLE IF NOT EXISTS game_records (
    id TEXT PRIMARY KEY,
    finished_at BIGINT,
    record JSONB NOT NULL
  );
  CREATE INDEX IF NOT EXISTS game_records_finished ON game_records (finished_at DESC);
  CREATE TABLE IF NOT EXISTS game_record_players (
    game_id TEXT NOT NULL REFERENCES game_records(id) ON DELETE CASCADE,
    seat SMALLINT NOT NULL,
    name_key TEXT NOT NULL,
    is_bot BOOLEAN NOT NULL,
    PRIMARY KEY (game_id, seat)
  );
  CREATE INDEX IF NOT EXISTS game_record_players_name ON game_record_players (name_key) WHERE NOT is_bot;
  CREATE TABLE IF NOT EXISTS challenge_scores (
    day TEXT NOT NULL, name_key TEXT NOT NULL, name TEXT NOT NULL,
    score INT NOT NULL, at BIGINT NOT NULL,
    PRIMARY KEY (day, name_key)
  );
  CREATE TABLE IF NOT EXISTS stammtisch_tables (
    code TEXT PRIMARY KEY, name TEXT, owner TEXT,
    created_at BIGINT, last_activity BIGINT,
    members JSONB NOT NULL, series JSONB, extra JSONB
  );
  CREATE TABLE IF NOT EXISTS stammtisch_games (
    code TEXT NOT NULL REFERENCES stammtisch_tables(code) ON DELETE CASCADE,
    idx INT NOT NULL,
    at BIGINT, series_no INT, players JSONB NOT NULL, extra JSONB,
    PRIMARY KEY (code, idx)
  );
  CREATE TABLE IF NOT EXISTS global_stats (
    id BOOLEAN PRIMARY KEY CHECK (id),
    games BIGINT NOT NULL, rounds BIGINT NOT NULL, pik_dames_laid_out BIGINT NOT NULL,
    pik_dames_caught BIGINT NOT NULL, hand_aus_rounds BIGINT NOT NULL
  );
`;

const STATS_TABLES = ['player_profiles', 'game_records', 'game_record_players', 'challenge_scores',
  'stammtisch_tables', 'stammtisch_games', 'global_stats'];

async function ensureStatsSchema(q) {
  await q.query(STATS_SCHEMA);
}

module.exports = { ensureStatsSchema, STATS_TABLES, STATS_SCHEMA };

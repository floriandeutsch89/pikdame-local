// game/PlayerStore.js
// Player profiles in PostgreSQL (migrations/006): one `players` row per name
// with the counters as columns; badges, card backs, quests, puzzle days and
// Kartenhaus stars in child tables (docs/developer/schema.md). Every method is
// async and awaited: a change is committed before the caller reports it. A
// read-modify-write runs in one transaction holding the player's row lock, so
// two tabs or two tables never lose an update. Instants are ms at this
// boundary, game days 'YYYY-MM-DD'.
'use strict';
const fs = require('fs');
const path = require('path');
const { inTransaction } = require('./Database'); // also registers the DATE parser
const { ensureMigrated } = require('./Migrations');
const { starsFor } = require('./DailyPuzzle');
const { addDays, gameDay } = require('./GameDay');
const BotTower = require('./BotTower');
const { BADGE_IDS, BADGE_FAMILIES } = require('./Badges');
const { isCelebration, celebrationLevel } = require('./Celebrations');
const { levelFromXp, advanceDailyStreak, streakGraceAvailable, isWelcomeBack, xpForTowerStage, XP_TOWER_CROWN } = require('./Progression');

const DEFAULT_DATA_FILE = path.join(process.env.PIKDAME_DATA_DIR || path.join(__dirname, '..', 'data'), 'players.json');
const FAVORITE_BADGES_MAX = 3;
const QUEST_DAYS = 7; // only today's are shown
const PUZZLE_DAYS = 7; // tries/solved/revealed without stars
const PUZZLE_STARS_DAYS = 60; // starred days kept for the archive
// The profiles message lists the statistics board's best (plus the asking
// player and the table): every client gets them, so the list stays bounded.
const PROFILES_LISTED = 500;
const IMPORT_NAME = 'players.json';
const IMPORT_LOCK_KEY = 726815;
const IMPORT_RETRY_MS = 10 * 60 * 1000;
const INT_MAX = 2147483647;

const keyOf = (name) => String(name || '').trim().toLowerCase();
const nameOf = (name) => String(name || '').trim();
const clampInt = (v) => Math.max(-INT_MAX, Math.min(INT_MAX, Math.round(v)));
const int = (v) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? clampInt(Number(v)) : 0);
const count = (v) => Math.max(0, int(v));
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// A real calendar day: '2026-13-45' would fail the DATE cast of a whole import.
function isDay(s) {
  const t = typeof s === 'string' && DATE_RE.test(s) ? Date.parse(`${s}T00:00:00Z`) : NaN;
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === s;
}

// The columns of a profile, for one row or a list in one statement: the
// counters, and for the player keyed $1 what the client reads from its OWN
// profile. Badges of others only where favourites are shown (the one thing the
// client draws from them). $2 is today's game day.
const PROFILE_COLUMNS = `p.*, p.player_key = $1 AS details,
  CASE WHEN p.player_key = $1 OR cardinality(p.favorite_badges) > 0 THEN (SELECT
     jsonb_object_agg(b.badge_id, floor(extract(epoch FROM b.earned_at) * 1000)::bigint)
     FROM player_badges b WHERE b.player_id = p.id) END AS badges,
  CASE WHEN p.player_key = $1 THEN (SELECT jsonb_object_agg(c.card_back_id, to_char(c.unlocked_day, 'YYYY-MM-DD'))
     FROM player_card_backs c WHERE c.player_id = p.id) END AS card_backs,
  CASE WHEN p.player_key = $1 THEN (SELECT jsonb_object_agg(d.day, d.progress) FROM (
     SELECT to_char(q.game_day, 'YYYY-MM-DD') AS day, jsonb_object_agg(q.quest_id, q.progress) AS progress
       FROM player_quests q WHERE q.player_id = p.id GROUP BY q.game_day) d) END AS quests,
  CASE WHEN p.player_key = $1 THEN (SELECT jsonb_object_agg(to_char(z.game_day, 'YYYY-MM-DD'), jsonb_strip_nulls(
       jsonb_build_object('tries', z.tries, 'solved', z.solved, 'revealed', z.revealed, 'stars', z.stars)))
     FROM player_puzzles z WHERE z.player_id = p.id AND z.game_day > $2::date - ${PUZZLE_DAYS}) END AS puzzles`;

/** A players row (PROFILE_COLUMNS) as the profile object the game and the client know. */
function toProfile(r) {
  const p = {
    id: Number(r.id),
    name: r.player_name,
    createdAt: r.created_at ? r.created_at.getTime() : null,
    xp: r.xp,
    gamesPlayed: r.games_played,
    gamesWon: r.games_won,
    gamesLost: r.games_played - r.games_won,
    totalScore: r.total_score,
    winStreak: r.win_streak,
    lastPlaceStreak: r.last_place_streak,
    totalQueensLaid: r.queens_laid,
    totalQueensCaught: r.queens_caught,
    totalJokersLaid: r.jokers_laid,
    totalHandAus: r.hand_aus_wins,
    totalChallenges: r.challenges_played,
    totalStammtischGames: r.stammtisch_games,
    dailyStreak: r.daily_streak,
    totalPuzzlesSolved: r.puzzles_solved,
    totalPerfectPuzzles: r.perfect_puzzles,
    perfectPuzzleStreak: r.perfect_puzzle_streak,
    bestPerfectPuzzleStreak: r.best_perfect_puzzle_streak,
    towerStars: r.tower_stars,
    towerCleared: r.tower_floors_cleared,
    towerCrownedMonths: r.tower_crowned_months,
    favoriteBadges: r.favorite_badges || [],
    badges: r.badges || {},
  };
  if (r.best_game_score !== null) p.bestGameScore = r.best_game_score;
  if (r.best_round_score !== null) p.bestRoundScore = r.best_round_score;
  if (r.celebration) p.celebration = r.celebration;
  if (r.last_perfect_puzzle_day) p.lastPerfectPuzzleDay = r.last_perfect_puzzle_day;
  if (r.daily_last_day) p.daily = { streak: r.daily_streak, last: r.daily_last_day, graceAt: r.daily_grace_day, best: r.daily_best_streak };
  if (r.details) {
    p.seasonalBacks = r.card_backs || {};
    p.quests = r.quests || {};
    p.puzzles = r.puzzles || {};
  }
  return p;
}

const dayStatus = (r) => (r
  ? { tries: r.tries, solved: r.solved, revealed: r.revealed, ...(r.stars ? { stars: r.stars } : {}) }
  : { tries: 0, solved: false, revealed: false });

/** Kartenhaus rows -> the profile shape BotTower reads ({ towers: { month: { stage: stars } } }). */
function towersOf(rows) {
  const towers = {};
  for (const r of rows) (towers[r.tower_month] = towers[r.tower_month] || {})[r.stage] = r.stars;
  return { towers };
}

// Creates the row or marks the player as seen; ON CONFLICT DO UPDATE also takes the row lock.
const UPSERT_PLAYER = `INSERT INTO players AS p (player_key, player_name, created_at, updated_at, last_seen_at)
  VALUES ($1, $2, $3, $3, $3)
  ON CONFLICT (player_key) DO UPDATE SET last_seen_at = GREATEST(p.last_seen_at, EXCLUDED.last_seen_at), updated_at = EXCLUDED.updated_at
  RETURNING *`;

/** The id of `name`'s player (created, or marked seen at `at`); for stores that reference players. */
async function upsertPlayerId(q, name, at) {
  const { rows } = await q.query(`INSERT INTO players AS p (player_key, player_name, created_at, updated_at, last_seen_at)
    VALUES ($1, $2, $3, $3, $3)
    ON CONFLICT (player_key) DO UPDATE SET last_seen_at = GREATEST(p.last_seen_at, EXCLUDED.last_seen_at), updated_at = EXCLUDED.updated_at
    RETURNING id`, [keyOf(name), nameOf(name), at]);
  return rows[0].id;
}

const RECORD_GAME = `INSERT INTO players AS p (player_key, player_name, created_at, updated_at, last_seen_at,
    games_played, games_won, total_score, best_game_score, best_round_score, win_streak, last_place_streak,
    queens_laid, queens_caught, jokers_laid, hand_aus_wins, challenges_played, stammtisch_games)
  VALUES ($1, $2, $13, $13, $13, 1, $3, $4, $4, $5, $3, $6, $7, $8, $9, $10, $11, $12)
  ON CONFLICT (player_key) DO UPDATE SET
    games_played = p.games_played + 1,
    games_won = p.games_won + EXCLUDED.games_won,
    total_score = p.total_score + EXCLUDED.total_score,
    best_game_score = GREATEST(p.best_game_score, EXCLUDED.best_game_score),
    best_round_score = GREATEST(p.best_round_score, EXCLUDED.best_round_score),
    win_streak = CASE WHEN EXCLUDED.games_won > 0 THEN p.win_streak + 1 ELSE 0 END,
    last_place_streak = CASE WHEN EXCLUDED.last_place_streak > 0 THEN p.last_place_streak + 1 ELSE 0 END,
    queens_laid = p.queens_laid + EXCLUDED.queens_laid,
    queens_caught = p.queens_caught + EXCLUDED.queens_caught,
    jokers_laid = p.jokers_laid + EXCLUDED.jokers_laid,
    hand_aus_wins = p.hand_aus_wins + EXCLUDED.hand_aus_wins,
    challenges_played = p.challenges_played + EXCLUDED.challenges_played,
    stammtisch_games = p.stammtisch_games + EXCLUDED.stammtisch_games,
    updated_at = EXCLUDED.updated_at,
    last_seen_at = GREATEST(p.last_seen_at, EXCLUDED.last_seen_at)
  RETURNING games_played, games_won`;

/** Creation time from an old profile id ("profile-<ms>-…"), else null (unknown). */
function createdFromId(id) {
  const m = /^profile-(\d{12,})-/.exec(String(id || ''));
  const at = m ? Number(m[1]) : NaN;
  return Number.isFinite(at) && at > 0 && at < 8.64e15 ? new Date(at).toISOString() : null;
}

/** Parsed players.json -> rows per table (keyed by player_key); malformed entries are skipped. */
function legacyRows(parsed) {
  const out = { players: [], badges: [], cardBacks: [], quests: [], puzzles: [], towerStars: [] };
  const seen = new Set();
  const entries = (o) => (o && typeof o === 'object' && !Array.isArray(o) ? Object.entries(o) : []);
  for (const p of Array.isArray(parsed.players) ? parsed.players : []) {
    if (!p || typeof p.name !== 'string') continue;
    const key = keyOf(p.name);
    if (!key || seen.has(key)) continue; // the old store found the first of two equal names
    seen.add(key);
    const daily = p.daily && typeof p.daily === 'object' ? p.daily : {};
    const optional = (v) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? int(v) : null);
    out.players.push({
      player_key: key,
      player_name: nameOf(p.name),
      created_at: createdFromId(p.id),
      xp: count(p.xp),
      games_played: count(p.gamesPlayed),
      games_won: Math.min(count(p.gamesWon), count(p.gamesPlayed)),
      total_score: int(p.totalScore),
      best_game_score: optional(p.bestGameScore),
      best_round_score: optional(p.bestRoundScore),
      win_streak: count(p.winStreak),
      last_place_streak: count(p.lastPlaceStreak),
      queens_laid: count(p.totalQueensLaid),
      queens_caught: count(p.totalQueensCaught),
      jokers_laid: count(p.totalJokersLaid),
      hand_aus_wins: count(p.totalHandAus),
      challenges_played: count(p.totalChallenges),
      stammtisch_games: count(p.totalStammtischGames),
      daily_streak: count(daily.streak !== undefined ? daily.streak : p.dailyStreak),
      daily_best_streak: Math.max(count(daily.best), count(daily.streak)),
      daily_last_day: isDay(daily.last) ? daily.last : null,
      daily_grace_day: isDay(daily.graceAt) ? daily.graceAt : null,
      puzzles_solved: count(p.totalPuzzlesSolved),
      perfect_puzzles: count(p.totalPerfectPuzzles),
      perfect_puzzle_streak: count(p.perfectPuzzleStreak),
      best_perfect_puzzle_streak: count(p.bestPerfectPuzzleStreak),
      last_perfect_puzzle_day: isDay(p.lastPerfectPuzzleDay) ? p.lastPerfectPuzzleDay : null,
      tower_stars: count(p.towerStars),
      tower_floors_cleared: count(p.towerCleared),
      tower_crowned_months: count(p.towerCrownedMonths),
      celebration: typeof p.celebration === 'string' && p.celebration ? p.celebration : null,
      favorite_badges: Array.isArray(p.favoriteBadges) ? [...new Set(p.favoriteBadges.map(String))].slice(0, FAVORITE_BADGES_MAX) : [],
    });
    for (const [badge, at] of entries(p.badges)) {
      const t = Number(at);
      out.badges.push({ player_key: key, badge_id: badge, earned_at: Number.isFinite(t) && t > 0 && t < 8.64e15 ? new Date(t).toISOString() : null });
    }
    for (const [back, day] of entries(p.seasonalBacks)) {
      if (isDay(day)) out.cardBacks.push({ player_key: key, card_back_id: back, unlocked_day: day });
    }
    for (const [day, quests] of entries(p.quests)) {
      if (!isDay(day)) continue;
      for (const [quest, n] of entries(quests)) out.quests.push({ player_key: key, game_day: day, quest_id: quest, progress: count(n) });
    }
    const puzzles = Object.fromEntries(entries(p.puzzles));
    const stars = Object.fromEntries(entries(p.puzzleStars));
    for (const day of new Set([...Object.keys(puzzles), ...Object.keys(stars)])) {
      if (!isDay(day)) continue;
      const d = puzzles[day] && typeof puzzles[day] === 'object' ? puzzles[day] : {};
      const s = count(d.stars || stars[day]);
      out.puzzles.push({ player_key: key, game_day: day, tries: count(d.tries), solved: !!d.solved || s > 0, revealed: !!d.revealed, stars: s >= 1 ? Math.min(3, s) : null });
    }
    // The pre-monthly tower counts as its first month (BotTower.monthBest).
    const towers = {};
    for (const [month, floors] of entries(p.towers)) towers[month] = { ...Object.fromEntries(entries(floors)) };
    if (entries(p.tower).length) towers[BotTower.LEGACY_MONTH] = BotTower.monthBest(p, BotTower.LEGACY_MONTH);
    for (const [month, floors] of Object.entries(towers)) {
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) continue;
      for (const [stage, n] of Object.entries(floors)) {
        const s = Math.min(3, count(n));
        if (Number.isInteger(Number(stage)) && Number(stage) >= 1 && Number(stage) <= 100 && s >= 1) {
          out.towerStars.push({ player_key: key, tower_month: month, stage: Number(stage), stars: s });
        }
      }
    }
  }
  return out;
}

// The import merges into rows written meanwhile (a late import after live play):
// counters add up, records keep the higher value, live streak and day states win.
const IMPORT_SQL = [
  `INSERT INTO players AS p (player_key, player_name, created_at, updated_at, xp, games_played, games_won, total_score,
     best_game_score, best_round_score, win_streak, last_place_streak, queens_laid, queens_caught, jokers_laid,
     hand_aus_wins, challenges_played, stammtisch_games, daily_streak, daily_best_streak, daily_last_day, daily_grace_day,
     puzzles_solved, perfect_puzzles, perfect_puzzle_streak, best_perfect_puzzle_streak, last_perfect_puzzle_day,
     tower_stars, tower_floors_cleared, tower_crowned_months, celebration, favorite_badges)
   SELECT x.player_key, x.player_name, x.created_at, now(), x.xp, x.games_played, x.games_won, x.total_score,
     x.best_game_score, x.best_round_score, x.win_streak, x.last_place_streak, x.queens_laid, x.queens_caught, x.jokers_laid,
     x.hand_aus_wins, x.challenges_played, x.stammtisch_games, x.daily_streak, x.daily_best_streak, x.daily_last_day,
     x.daily_grace_day, x.puzzles_solved, x.perfect_puzzles, x.perfect_puzzle_streak, x.best_perfect_puzzle_streak,
     x.last_perfect_puzzle_day, x.tower_stars, x.tower_floors_cleared, x.tower_crowned_months, x.celebration,
     ARRAY(SELECT jsonb_array_elements_text(x.favorite_badges))
   FROM jsonb_to_recordset($1::jsonb) AS x(player_key text, player_name text, created_at timestamptz, xp int,
     games_played int, games_won int, total_score int, best_game_score int, best_round_score int, win_streak int,
     last_place_streak int, queens_laid int, queens_caught int, jokers_laid int, hand_aus_wins int, challenges_played int,
     stammtisch_games int, daily_streak int, daily_best_streak int, daily_last_day date, daily_grace_day date,
     puzzles_solved int, perfect_puzzles int, perfect_puzzle_streak int, best_perfect_puzzle_streak int,
     last_perfect_puzzle_day date, tower_stars int, tower_floors_cleared int, tower_crowned_months int,
     celebration text, favorite_badges jsonb)
   ORDER BY x.player_key -- row locks in key order, like recordGameResult
   ON CONFLICT (player_key) DO UPDATE SET
     player_name = EXCLUDED.player_name,
     created_at = EXCLUDED.created_at,
     updated_at = now(),
     xp = p.xp + EXCLUDED.xp,
     games_played = p.games_played + EXCLUDED.games_played,
     games_won = p.games_won + EXCLUDED.games_won,
     total_score = p.total_score + EXCLUDED.total_score,
     best_game_score = GREATEST(p.best_game_score, EXCLUDED.best_game_score),
     best_round_score = GREATEST(p.best_round_score, EXCLUDED.best_round_score),
     win_streak = CASE WHEN p.win_streak = p.games_played THEN p.win_streak + EXCLUDED.win_streak ELSE p.win_streak END,
     last_place_streak = CASE WHEN p.last_place_streak = p.games_played THEN p.last_place_streak + EXCLUDED.last_place_streak ELSE p.last_place_streak END,
     queens_laid = p.queens_laid + EXCLUDED.queens_laid,
     queens_caught = p.queens_caught + EXCLUDED.queens_caught,
     jokers_laid = p.jokers_laid + EXCLUDED.jokers_laid,
     hand_aus_wins = p.hand_aus_wins + EXCLUDED.hand_aus_wins,
     challenges_played = p.challenges_played + EXCLUDED.challenges_played,
     stammtisch_games = p.stammtisch_games + EXCLUDED.stammtisch_games,
     daily_streak = CASE WHEN p.daily_last_day IS NULL THEN EXCLUDED.daily_streak ELSE p.daily_streak END,
     daily_last_day = COALESCE(p.daily_last_day, EXCLUDED.daily_last_day),
     daily_grace_day = CASE WHEN p.daily_last_day IS NULL THEN EXCLUDED.daily_grace_day ELSE p.daily_grace_day END,
     daily_best_streak = GREATEST(p.daily_best_streak, EXCLUDED.daily_best_streak),
     puzzles_solved = p.puzzles_solved + EXCLUDED.puzzles_solved,
     perfect_puzzles = p.perfect_puzzles + EXCLUDED.perfect_puzzles,
     perfect_puzzle_streak = CASE WHEN p.puzzles_solved = 0 THEN EXCLUDED.perfect_puzzle_streak ELSE p.perfect_puzzle_streak END,
     last_perfect_puzzle_day = CASE WHEN p.puzzles_solved = 0 THEN EXCLUDED.last_perfect_puzzle_day ELSE p.last_perfect_puzzle_day END,
     best_perfect_puzzle_streak = GREATEST(p.best_perfect_puzzle_streak, EXCLUDED.best_perfect_puzzle_streak),
     tower_stars = GREATEST(p.tower_stars, EXCLUDED.tower_stars),
     tower_floors_cleared = GREATEST(p.tower_floors_cleared, EXCLUDED.tower_floors_cleared),
     tower_crowned_months = GREATEST(p.tower_crowned_months, EXCLUDED.tower_crowned_months),
     celebration = COALESCE(p.celebration, EXCLUDED.celebration),
     favorite_badges = CASE WHEN cardinality(p.favorite_badges) > 0 THEN p.favorite_badges ELSE EXCLUDED.favorite_badges END`,
  `INSERT INTO player_badges (player_id, badge_id, earned_at)
   SELECT p.id, x.badge_id, COALESCE(x.earned_at, now())
   FROM jsonb_to_recordset($1::jsonb) AS x(player_key text, badge_id text, earned_at timestamptz) JOIN players p USING (player_key)
   ON CONFLICT (player_id, badge_id) DO UPDATE SET earned_at = LEAST(player_badges.earned_at, EXCLUDED.earned_at)`,
  `INSERT INTO player_card_backs (player_id, card_back_id, unlocked_day)
   SELECT p.id, x.card_back_id, x.unlocked_day
   FROM jsonb_to_recordset($1::jsonb) AS x(player_key text, card_back_id text, unlocked_day date) JOIN players p USING (player_key)
   ON CONFLICT (player_id, card_back_id) DO UPDATE SET unlocked_day = LEAST(player_card_backs.unlocked_day, EXCLUDED.unlocked_day)`,
  `INSERT INTO player_quests (player_id, game_day, quest_id, progress)
   SELECT p.id, x.game_day, x.quest_id, x.progress
   FROM jsonb_to_recordset($1::jsonb) AS x(player_key text, game_day date, quest_id text, progress int) JOIN players p USING (player_key)
   ON CONFLICT (player_id, game_day, quest_id) DO UPDATE SET progress = player_quests.progress + EXCLUDED.progress`,
  `INSERT INTO player_puzzles (player_id, game_day, tries, solved, revealed, stars)
   SELECT p.id, x.game_day, x.tries, x.solved, x.revealed, x.stars
   FROM jsonb_to_recordset($1::jsonb) AS x(player_key text, game_day date, tries int, solved boolean, revealed boolean, stars smallint)
   JOIN players p USING (player_key)
   ON CONFLICT (player_id, game_day) DO NOTHING`,
  `INSERT INTO player_tower_stars (player_id, tower_month, stage, stars)
   SELECT p.id, x.tower_month, x.stage, x.stars
   FROM jsonb_to_recordset($1::jsonb) AS x(player_key text, tower_month text, stage smallint, stars smallint) JOIN players p USING (player_key)
   ON CONFLICT (player_id, tower_month, stage) DO UPDATE SET stars = GREATEST(player_tower_stars.stars, EXCLUDED.stars)`,
];

/**
 * One-time move of an old players.json into the tables: one transaction plus
 * a legacy_imports marker, the file is renamed only after the commit. An
 * unreadable file throws (the caller retries later) and nothing is marked.
 */
async function importLegacyFile(pool, file) {
  if (!file || !fs.existsSync(file)) return false;
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${file}: not a player store`);
  const rows = legacyRows(parsed);
  const imported = await inTransaction(pool, async (c) => {
    await c.query('SELECT pg_advisory_xact_lock($1)', [IMPORT_LOCK_KEY]);
    const marked = await c.query('INSERT INTO legacy_imports (source, imported_at) VALUES ($1, now()) ON CONFLICT DO NOTHING RETURNING source', [IMPORT_NAME]);
    if (!marked.rows.length) return false; // imported before (e.g. the rename failed): only move the file
    const order = ['players', 'badges', 'cardBacks', 'quests', 'puzzles', 'towerStars'];
    for (let i = 0; i < order.length; i++) await c.query(IMPORT_SQL[i], [JSON.stringify(rows[order[i]])]);
    return true;
  });
  fs.renameSync(file, `${file}.migrated`);
  console.log(imported
    ? `[db] ${IMPORT_NAME}: imported ${rows.players.length} profiles (badges: ${rows.badges.length}, Kartenhaus floors: ${rows.towerStars.length}), file renamed to ${path.basename(file)}.migrated`
    : `[db] ${IMPORT_NAME}: already imported earlier, file renamed to ${path.basename(file)}.migrated without importing it again`);
  return imported;
}

/**
 * @param {import('pg').Pool} pool the shared pool (game/Database.js)
 * @param {{legacyFile?: string|null, now?: () => number}} [opts] old JSON file to import once (null: none); clock for tests
 */
function createPlayerStore(pool, { legacyFile = DEFAULT_DATA_FILE, now = () => Date.now() } = {}) {
  let importRun = null;
  let importRetryAt = 0;

  function maybeImport() {
    if (importRun) return importRun;
    if (!legacyFile || Date.now() < importRetryAt) return Promise.resolve();
    importRun = importLegacyFile(pool, legacyFile).then(() => {}, (err) => {
      // Never marked done: profiles keep working, the import tries again later.
      console.error(`[db] ${IMPORT_NAME} import failed, retrying in 10 min:`, err.message);
      importRun = null;
      importRetryAt = Date.now() + IMPORT_RETRY_MS;
    });
    return importRun;
  }

  const ready = () => ensureMigrated(pool).then(maybeImport);
  const query = async (sql, params) => {
    await ready();
    return pool.query(sql, params);
  };

  /** fn(client, row) with the player's row locked; null when the name is empty
   *  or (without `create`) unknown. `create` adds the row and marks the player seen. */
  async function withPlayer(name, { create = false } = {}, fn) {
    const key = keyOf(name);
    if (!key) return null;
    await ready();
    return inTransaction(pool, async (c) => {
      const res = create
        ? await c.query(UPSERT_PLAYER, [key, nameOf(name), new Date(now())])
        : await c.query('SELECT * FROM players WHERE player_key = $1 FOR UPDATE', [key]);
      return res.rows[0] ? fn(c, res.rows[0]) : null;
    });
  }

  /** The profile of `name` with everything the client shows of its own profile, or null. */
  async function getPlayerByName(name) {
    const key = keyOf(name);
    if (!key) return null;
    const { rows } = await query(`SELECT ${PROFILE_COLUMNS} FROM players p WHERE p.player_key = $1`, [key, gameDay(now())]);
    return rows[0] ? toProfile(rows[0]) : null;
  }

  /**
   * The profiles message: the statistics board's best `limit` (wins, then
   * score) plus the named players; `me` also gets its per-day details.
   */
  async function listProfiles({ me = '', names = [], limit = PROFILES_LISTED } = {}) {
    const meKey = keyOf(me);
    const keys = [...new Set([meKey, ...names.map(keyOf)].filter(Boolean))];
    // The ids first, then the rows by primary key: an OR of both conditions made the
    // planner expect thousands of rows and JIT-compile (~300 ms instead of 3).
    const { rows } = await query(`SELECT ${PROFILE_COLUMNS} FROM players p WHERE p.id = ANY(ARRAY(
        (SELECT id FROM players WHERE games_played > 0 ORDER BY games_won DESC, total_score DESC, id LIMIT $4)
        UNION SELECT id FROM players WHERE player_key = ANY($3::text[])))
      ORDER BY p.games_won DESC, p.total_score DESC, p.id`, [meKey, gameDay(now()), keys, limit]);
    return rows.map(toProfile);
  }

  /** Creates the profile on first contact. */
  async function upsertPlayerProfile(name) {
    await withPlayer(name, { create: true }, () => true);
    return getPlayerByName(name);
  }

  /**
   * Books a finished match (not a round) for every player by name; unknown
   * names get a profile. Names are locked in key order, so two tables
   * finishing at once with the same names cannot deadlock.
   * @param {Array<{name: string, score: number, won: boolean, facts?: object}>} results
   * @returns {Promise<Object<string, {played:number, won:number}>>} lifetime record per player_key
   */
  async function recordGameResult(results) {
    const list = (results || []).filter((r) => r && keyOf(r.name))
      .sort((a, b) => (keyOf(a.name) < keyOf(b.name) ? -1 : keyOf(a.name) > keyOf(b.name) ? 1 : 0));
    if (!list.length) return {};
    await ready();
    const at = new Date(now());
    return inTransaction(pool, async (c) => {
      const records = {};
      for (const r of list) {
        const f = r.facts || {};
        const { rows } = await c.query(RECORD_GAME, [keyOf(r.name), nameOf(r.name), r.won ? 1 : 0, int(r.score),
          int(f.bestRound) > 0 ? int(f.bestRound) : null, f.lastPlace ? 1 : 0, count(f.pdLaid), count(f.pdCaught),
          count(f.jokersLaid), count(f.handAusWins), f.challenge ? 1 : 0, f.stammtisch ? 1 : 0, at]);
        records[keyOf(r.name)] = { played: rows[0].games_played, won: rows[0].games_won };
      }
      return records;
    });
  }

  /** Badges for a profile; ones already earned are ignored. @returns {Promise<string[]>} only the NEW ids */
  async function awardBadges(name, badgeIds = []) {
    const ids = [...new Set((badgeIds || []).map(String))];
    if (!ids.length || !keyOf(name)) return [];
    const { rows } = await query(`INSERT INTO player_badges (player_id, badge_id, earned_at)
      SELECT p.id, b.badge_id, $3 FROM players p, unnest($2::text[]) AS b(badge_id) WHERE p.player_key = $1
      ON CONFLICT DO NOTHING RETURNING badge_id`, [keyOf(name), ids, new Date(now())]);
    const fresh = new Set(rows.map((r) => r.badge_id));
    return ids.filter((id) => fresh.has(id));
  }

  /**
   * Favourite badges (#317): up to 3 earned badge tiles in the order chosen.
   * A key is a single badge id or a family id (shown as its top tier).
   * The caller checks the account; this only checks the profile.
   * @returns {Promise<{favorites:string[]}|{error:string}>}
   */
  async function setFavoriteBadges(name, keys) {
    const r = await withPlayer(name, {}, async (c, row) => {
      if (!Array.isArray(keys)) return { error: 'Ungültige Auswahl.' };
      const owned = new Set((await c.query('SELECT badge_id FROM player_badges WHERE player_id = $1', [row.id])).rows.map((b) => b.badge_id));
      const earned = (key) => {
        const fam = BADGE_FAMILIES.find((f) => f.id === key);
        if (fam) return fam.tiers.some(([id]) => owned.has(id));
        return BADGE_IDS.includes(key) && owned.has(key);
      };
      const unique = [...new Set(keys.map(String))];
      if (unique.length > FAVORITE_BADGES_MAX) return { error: 'Höchstens 3 Lieblingsabzeichen.' };
      // A stored key that no longer counts (renamed badge) must not block every
      // later change: it may be sent back and is dropped.
      const stored = new Set(row.favorite_badges || []);
      if (!unique.every((k) => earned(k) || stored.has(k))) return { error: 'Nur verdiente Abzeichen können Lieblingsabzeichen sein.' };
      const favorites = unique.filter(earned);
      await c.query('UPDATE players SET favorite_badges = $2, updated_at = $3 WHERE id = $1', [row.id, favorites, new Date(now())]);
      return { favorites };
    });
    return r || { error: 'Profil nicht gefunden.' };
  }

  /**
   * Victory celebration (game/Celebrations.js), unlocked by the profile's level.
   * 'standard' clears the choice. The caller checks the account.
   * @returns {Promise<{celebration:string}|{error:string}>}
   */
  async function setCelebration(name, id) {
    const r = await withPlayer(name, {}, async (c, row) => {
      if (!isCelebration(id)) return { error: 'Diesen Siegesjubel gibt es nicht.' };
      const need = celebrationLevel(id);
      if (levelFromXp(row.xp || 0).level < need) return { error: `Diesen Siegesjubel gibt es ab Stufe ${need}.` };
      await c.query('UPDATE players SET celebration = $2, updated_at = $3 WHERE id = $1', [row.id, id === 'standard' ? null : id, new Date(now())]);
      return { celebration: id };
    });
    return r || { error: 'Profil nicht gefunden.' };
  }

  /** Seasonal card back for this profile (first unlock day kept). @returns {Promise<boolean>} newly unlocked */
  async function unlockSeasonalBack(name, backId, date) {
    if (!backId || !keyOf(name) || !isDay(date)) return false;
    const r = await query(`INSERT INTO player_card_backs (player_id, card_back_id, unlocked_day)
      SELECT id, $2, $3 FROM players WHERE player_key = $1 ON CONFLICT DO NOTHING`, [keyOf(name), String(backId), date]);
    return r.rowCount === 1;
  }

  // --- Progression (XP + daily quests) -------------------------------------
  // Kept on the NAME-based profile so it works where the rest of the
  // statistics work: play without any account. The account store mirrors the
  // XP for the cross-device season ladder.

  /**
   * Adds experience and daily-quest progress for one finished game.
   * @param {string} name
   * @param {{xp?: number, date?: string, quests?: Object<string, number>}} gain
   * @returns {Promise<{xp:number, gainedXp:number, quests:Object<string,number>, before:Object<string,number>, completed:string[]}>}
   *   `before`: the day's counters without this call (exact even when two games end at once)
   */
  async function addProgress(name, gain = {}) {
    const gainedXp = Math.max(0, Math.round(Number(gain.xp) || 0));
    const date = isDay(gain.date) ? gain.date : null;
    const deltas = Object.entries((gain && gain.quests) || {}).map(([id, d]) => [id, Math.max(0, Math.round(Number(d) || 0))]);
    const r = await withPlayer(name, {}, async (c, row) => {
      const at = new Date(now());
      let xp = row.xp;
      if (gainedXp) xp = (await c.query('UPDATE players SET xp = xp + $2, updated_at = $3 WHERE id = $1 RETURNING xp', [row.id, gainedXp, at])).rows[0].xp;
      const completed = [];
      const quests = {};
      const before = {};
      if (date && deltas.length) {
        await c.query(`INSERT INTO player_quests AS q (player_id, game_day, quest_id, progress, updated_at)
          SELECT $1, $2, u.quest_id, u.delta, $5 FROM unnest($3::text[], $4::int[]) AS u(quest_id, delta)
          ON CONFLICT (player_id, game_day, quest_id) DO UPDATE SET progress = q.progress + EXCLUDED.progress, updated_at = EXCLUDED.updated_at`,
        [row.id, date, deltas.map((d) => d[0]), deltas.map((d) => d[1]), at]);
        for (const [id] of deltas) completed.push(id); // the caller compares against the quest's target
        // Only today is ever shown; an unbounded history would grow with every day played.
        await c.query('DELETE FROM player_quests WHERE player_id = $1 AND game_day <= $2::date - $3::int', [row.id, date, QUEST_DAYS]);
      }
      if (date) {
        for (const q of (await c.query('SELECT quest_id, progress FROM player_quests WHERE player_id = $1 AND game_day = $2', [row.id, date])).rows) {
          quests[q.quest_id] = q.progress;
          before[q.quest_id] = q.progress;
        }
        for (const [id, d] of deltas) before[id] = (quests[id] || 0) - d;
      }
      return { xp, gainedXp, quests, before, completed };
    });
    return r || { xp: 0, gainedXp: 0, quests: {}, before: {}, completed: [] };
  }

  /** Quest counters a player has collected on a given day (never null). */
  async function questProgress(name, date) {
    if (!keyOf(name) || !isDay(date)) return {};
    const { rows } = await query(`SELECT q.quest_id, q.progress FROM player_quests q JOIN players p ON p.id = q.player_id
      WHERE p.player_key = $1 AND q.game_day = $2`, [keyOf(name), date]);
    return Object.fromEntries(rows.map((q) => [q.quest_id, q.progress]));
  }

  /**
   * "Played today": advances the daily streak (see Progression.js). The flat
   * dailyStreak is what the badge tiers and the client read.
   * @returns {Promise<{streak:number,best:number,event:string,graceFree:boolean,welcomeBack:boolean}|null>}
   */
  async function touchDailyStreak(name, date) {
    return withPlayer(name, {}, async (c, row) => {
      const prev = { streak: row.daily_streak, last: row.daily_last_day, graceAt: row.daily_grace_day, best: row.daily_best_streak };
      const welcomeBack = isWelcomeBack(prev, date);
      const { state, event } = advanceDailyStreak(prev, date);
      if (event !== 'same') {
        const at = new Date(now());
        await c.query(`UPDATE players SET daily_streak = $2, daily_best_streak = $3, daily_last_day = $4, daily_grace_day = $5,
          updated_at = $6, last_seen_at = GREATEST(last_seen_at, $6) WHERE id = $1`, [row.id, state.streak, state.best, state.last, state.graceAt, at]);
      }
      return { streak: state.streak, best: state.best, event, graceFree: streakGraceAvailable(state, date), welcomeBack };
    });
  }

  // --- Daily puzzle (see game/DailyPuzzle.js) --------------------------------
  // tries / solved / revealed per day; the profile is created on first
  // contact so the puzzle works before the first match.

  async function puzzleRow(c, playerId, date) {
    return (await c.query('SELECT tries, solved, revealed, stars FROM player_puzzles WHERE player_id = $1 AND game_day = $2', [playerId, date])).rows[0] || null;
  }

  async function savePuzzleDay(c, playerId, date, day) {
    const at = new Date(now());
    await c.query(`INSERT INTO player_puzzles AS z (player_id, game_day, tries, solved, revealed, stars, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (player_id, game_day) DO UPDATE SET tries = EXCLUDED.tries, solved = EXCLUDED.solved,
        revealed = EXCLUDED.revealed, stars = EXCLUDED.stars, updated_at = EXCLUDED.updated_at`,
    [playerId, date, day.tries, day.solved, day.revealed, day.stars || null, at]);
    // Days without stars only matter this week; starred days stay for the archive.
    await c.query('DELETE FROM player_puzzles WHERE player_id = $1 AND stars IS NULL AND game_day <= $2::date - $3::int', [playerId, date, PUZZLE_DAYS]);
    await c.query(`DELETE FROM player_puzzles WHERE player_id = $1 AND stars IS NOT NULL AND game_day < (
      SELECT game_day FROM player_puzzles WHERE player_id = $1 AND stars IS NOT NULL ORDER BY game_day DESC OFFSET $2 LIMIT 1)`,
    [playerId, PUZZLE_STARS_DAYS - 1]);
  }

  async function puzzleStatus(name, date) {
    if (!keyOf(name) || !isDay(date)) return dayStatus(null);
    const { rows } = await query(`SELECT z.tries, z.solved, z.revealed, z.stars FROM player_puzzles z
      JOIN players p ON p.id = z.player_id WHERE p.player_key = $1 AND z.game_day = $2`, [keyOf(name), date]);
    return dayStatus(rows[0]);
  }

  /** Stars of a solved day for the archive (0: none). */
  async function puzzleStarsFor(name, date) {
    return (await puzzleStatus(name, date)).stars || 0;
  }

  /** @returns {Promise<{tries,solved,revealed,stars?,justSolved:boolean}>} */
  async function recordPuzzleAttempt(name, date, solved, kind = 'meld') {
    if (!isDay(date)) throw new Error(`bad puzzle date ${date}`);
    return withPlayer(name, { create: true }, async (c, row) => {
      const day = dayStatus(await puzzleRow(c, row.id, date));
      let justSolved = false;
      if (!day.solved) {
        day.tries += 1;
        const set = {};
        if (solved) {
          day.solved = true;
          justSolved = !day.revealed; // a revealed solution earns nothing
          if (justSolved) {
            set.puzzles_solved = row.puzzles_solved + 1;
            day.stars = starsFor(kind, day.tries);
            if (day.stars === 3) {
              set.perfect_puzzles = row.perfect_puzzles + 1;
              set.perfect_puzzle_streak = row.last_perfect_puzzle_day === addDays(date, -1) ? row.perfect_puzzle_streak + 1 : 1;
              set.last_perfect_puzzle_day = date;
              set.best_perfect_puzzle_streak = Math.max(row.best_perfect_puzzle_streak, set.perfect_puzzle_streak);
            } else {
              set.perfect_puzzle_streak = 0;
            }
          }
        }
        await savePuzzleDay(c, row.id, date, day);
        await updatePlayer(c, row.id, set);
      }
      return { ...day, justSolved };
    });
  }

  async function revealPuzzle(name, date) {
    if (!isDay(date)) throw new Error(`bad puzzle date ${date}`);
    return withPlayer(name, { create: true }, async (c, row) => {
      const day = dayStatus(await puzzleRow(c, row.id, date));
      // Today can no longer be perfect: the run ends now, not at midnight.
      if (!day.solved) await updatePlayer(c, row.id, { perfect_puzzle_streak: 0 });
      day.revealed = true;
      await savePuzzleDay(c, row.id, date, day);
      return { ...day };
    });
  }

  /** UPDATE players SET <columns from `set`> (fixed names only, never input). */
  async function updatePlayer(c, playerId, set) {
    const cols = Object.keys(set);
    if (!cols.length) return;
    const assign = cols.map((col, i) => `${col} = $${i + 3}`).join(', ');
    await c.query(`UPDATE players SET ${assign}, updated_at = $2 WHERE id = $1`, [playerId, new Date(now()), ...cols.map((col) => set[col])]);
  }

  // --- Kartenhaus (see game/BotTower.js): best stars per month and floor ---

  async function towerRows(name, month = null) {
    if (!keyOf(name)) return [];
    const { rows } = await query(`SELECT t.tower_month, t.stage, t.stars FROM player_tower_stars t
      JOIN players p ON p.id = t.player_id WHERE p.player_key = $1 AND ($2::text IS NULL OR t.tower_month = $2)`, [keyOf(name), month]);
    return rows;
  }

  /** Best stars of one month, e.g. { "1": 3, "2": 1 } (never null). */
  async function towerBest(name, month) {
    return BotTower.monthBest(towersOf(await towerRows(name, String(month))), String(month));
  }

  /** Every month played, newest first: [{ month, best, stars, cleared, unlocked, crowned }]. */
  async function towerMonths(name) {
    return BotTower.monthsOf(towersOf(await towerRows(name)));
  }

  /** Keeps the best result of a floor in its month; the first star of a floor
   *  in a month pays its XP, the month's crown pays once more. Badge counters only ever grow. */
  async function recordTowerResult(name, month, stage, stars) {
    return withPlayer(name, { create: true }, async (c, row) => {
      const profile = towersOf((await c.query('SELECT tower_month, stage, stars FROM player_tower_stars WHERE player_id = $1', [row.id])).rows);
      const wasCrowned = BotTower.summarize(BotTower.monthBest(profile, month)).crowned;
      const before = BotTower.monthBest(profile, month)[stage] || 0;
      const improved = stars > before;
      const at = new Date(now());
      if (improved) {
        await c.query(`INSERT INTO player_tower_stars AS t (player_id, tower_month, stage, stars, updated_at) VALUES ($1, $2, $3, $4, $5)
          ON CONFLICT (player_id, tower_month, stage) DO UPDATE SET stars = EXCLUDED.stars, updated_at = EXCLUDED.updated_at`,
        [row.id, month, stage, stars, at]);
        profile.towers[month] = { ...(profile.towers[month] || {}), [stage]: stars };
      }
      const best = BotTower.monthBest(profile, month);
      const sum = BotTower.summarize(best);
      const crownedNow = sum.crowned && !wasCrowned;
      const xp = xpForTowerStage(before, stars) + (crownedNow ? XP_TOWER_CROWN : 0);
      // Badge counters: the best month's stars and floors, and the crowned months.
      const total = BotTower.totalsOf(profile);
      const { rows } = await c.query(`UPDATE players SET xp = xp + $2, tower_stars = GREATEST(tower_stars, $3),
          tower_floors_cleared = GREATEST(tower_floors_cleared, $4), tower_crowned_months = GREATEST(tower_crowned_months, $5),
          updated_at = $6 WHERE id = $1 RETURNING xp`,
      [row.id, xp, total.bestStars, total.bestCleared, total.crowned, at]);
      return { best, improved, xp, crownedNow, totalXp: rows[0].xp, ...sum, totalStars: total.totalStars };
    });
  }

  return {
    ready,
    getPlayerByName,
    listProfiles,
    upsertPlayerProfile,
    recordGameResult,
    awardBadges,
    unlockSeasonalBack,
    addProgress,
    questProgress,
    touchDailyStreak,
    setFavoriteBadges,
    setCelebration,
    puzzleStatus,
    puzzleStarsFor,
    recordPuzzleAttempt,
    revealPuzzle,
    towerBest,
    towerMonths,
    recordTowerResult,
  };
}

module.exports = { createPlayerStore, importLegacyFile, legacyRows, upsertPlayerId, keyOf, DEFAULT_DATA_FILE, PROFILES_LISTED };

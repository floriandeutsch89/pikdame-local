// game/GameHistoryStore.js
// Finished matches round by round ("Meine Partien") and the anonymous server
// counters (games, rounds, queens, "Hand aus"). PostgreSQL (migrations/013);
// data/games.json and data/stats.json of older versions are imported once.

const fs = require('fs');
const path = require('path');
require('./Database'); // registers the DATE parser
const { ensureMigrated } = require('./Migrations');
const { isRecordWinner } = require('./Teams');
const { upsertPlayerId } = require('./PlayerStore');

const DATA_DIR = process.env.PIKDAME_DATA_DIR || path.join(__dirname, '..', 'data');
const DEFAULT_GAMES_FILE = path.join(DATA_DIR, 'games.json');
const DEFAULT_STATS_FILE = path.join(DATA_DIR, 'stats.json');
const IMPORT_LOCK_KEY = 726819;
const IMPORT_RETRY_MS = 10 * 60 * 1000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// Kept as columns or in game_seats, so not repeated inside game_record.
const OWN_COLUMNS = ['id', 'players', 'startedAt', 'finishedAt', 'challengeDate', 'stammtisch'];

const EMPTY_STATS = { games: 0, rounds: 0, pikDamesLaidOut: 0, pikDamesCaught: 0, handAusRounds: 0 };
const STATS_COLUMNS = { games: 'games_played', rounds: 'rounds_played', pikDamesLaidOut: 'pik_dames_laid_out', pikDamesCaught: 'pik_dames_caught', handAusRounds: 'hand_aus_rounds' };
const STATS_KEYS = Object.keys(EMPTY_STATS);
const ADD_STATS = `UPDATE global_stats SET ${STATS_KEYS.map((k, i) => `${STATS_COLUMNS[k]} = ${STATS_COLUMNS[k]} + $${i + 1}`).join(', ')}, updated_at = now()
  RETURNING ${STATS_KEYS.map((k) => STATS_COLUMNS[k]).join(', ')}`;
const statsOfRow = (row) => Object.fromEntries(STATS_KEYS.map((k) => [k, Number(row[STATS_COLUMNS[k]]) || 0]));

/** What one finished match adds to the anonymous counters. */
function statsOfGame(record) {
  const s = { ...EMPTY_STATS };
  if (!record || !Array.isArray(record.rounds)) return s;
  s.games = 1;
  s.rounds = record.rounds.length;
  for (const round of record.rounds) {
    if (round && round.isHandAus) s.handAusRounds += 1;
    for (const r of Object.values((round && round.results) || {})) {
      const b = r && r.breakdown;
      if (!b) continue;
      s.pikDamesLaidOut += b.pikDameLaidOut || 0;
      s.pikDamesCaught += b.pikDameCount || 0;
    }
  }
  return s;
}

const ms = (v) => (Number.isFinite(v) ? new Date(Math.round(v)) : null);

async function inTransaction(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/** Inserts one match with its seats; `createdAt(at)` is the age a new player row gets. */
async function insertGame(c, record, { stammtisch = !!record.stammtisch, createdAt = (at) => at } = {}) {
  const finishedAt = ms(record.finishedAt) || new Date();
  const rest = Object.fromEntries(Object.entries(record).filter(([k]) => !OWN_COLUMNS.includes(k)));
  const challengeDay = DATE_RE.test(String(record.challengeDate || '')) ? record.challengeDate : null;
  const { rows } = await c.query(`INSERT INTO games (started_at, finished_at, challenge_day, is_stammtisch, is_team_mode, game_record)
    VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
  [ms(record.startedAt), finishedAt, challengeDay, !!stammtisch, !!record.teamMode, JSON.stringify(rest)]);
  const gameId = rows[0].id;
  const players = Array.isArray(record.players) ? record.players : [];
  for (let i = 0; i < players.length; i++) {
    const p = players[i] || {};
    const human = !p.isBot && String(p.name || '').trim();
    const playerId = human ? await upsertPlayerId(c, p.name, finishedAt, createdAt(finishedAt)) : null;
    const total = Number((record.finalTotals || {})[p.id]);
    await c.query(`INSERT INTO game_seats (game_id, seat_no, seat_ref, player_id, player_name, is_bot, left_game, bot_difficulty, final_total, is_winner)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [gameId, i, String(p.id || `seat${i}`), playerId, String(p.name || ''), !!p.isBot, !!p.leftGame,
      p.isBot && p.botDifficulty ? String(p.botDifficulty) : null, Number.isFinite(total) ? Math.round(total) : null,
      isRecordWinner(record, p.id)]);
  }
  return gameId;
}

async function addStats(c, delta) {
  const { rows } = await c.query(ADD_STATS, STATS_KEYS.map((k) => Math.max(0, Math.round(Number(delta[k]) || 0))));
  return statsOfRow(rows[0]);
}

/** Marks `source` imported in this transaction; false when it was imported before. */
async function claimImport(c, source) {
  await c.query('SELECT pg_advisory_xact_lock($1)', [IMPORT_LOCK_KEY]);
  const marked = await c.query('INSERT INTO legacy_imports (source, imported_at) VALUES ($1, now()) ON CONFLICT DO NOTHING RETURNING source', [source]);
  return marked.rows.length === 1;
}

function readJson(file) {
  if (!file || !fs.existsSync(file)) return null;
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${file}: not an object`);
  return parsed;
}

function moveAway(file, source, imported, what) {
  fs.renameSync(file, `${file}.migrated`);
  console.log(imported
    ? `[db] ${source}: imported ${what}, file renamed to ${path.basename(file)}.migrated`
    : `[db] ${source}: already imported earlier, file renamed to ${path.basename(file)}.migrated without importing it again`);
}

/** One-time move of games.json: one transaction plus a marker, the file is renamed after the commit. */
async function importLegacyGames(pool, file) {
  const parsed = readJson(file);
  if (!parsed) return false;
  const games = (Array.isArray(parsed.games) ? parsed.games : []).filter((g) => g && Array.isArray(g.players) && Number.isFinite(g.finishedAt));
  const imported = await inTransaction(pool, async (c) => {
    if (!(await claimImport(c, 'games.json'))) return false;
    // A name first seen here claims no age (like the other imports).
    for (const g of games) await insertGame(c, g, { createdAt: () => null });
    return true;
  });
  moveAway(file, 'games.json', imported, `${games.length} games`);
  return imported;
}

/** One-time move of stats.json: its counters are added to the row (games of the new version may be in already). */
async function importLegacyStats(pool, file) {
  const parsed = readJson(file);
  if (!parsed) return null;
  const stats = await inTransaction(pool, async (c) => ((await claimImport(c, 'stats.json')) ? addStats(c, parsed) : null));
  moveAway(file, 'stats.json', !!stats, 'the counters');
  return stats;
}

/** A stored match back in the shape GameManager wrote it (historyForPlayer reads that). */
function recordOfRow(row, seats) {
  return {
    ...(row.game_record || {}),
    id: `game-${row.id}`,
    players: seats.map((s) => ({
      id: s.seat_ref,
      name: s.player_name,
      isBot: s.is_bot,
      ...(s.left_game ? { leftGame: true } : {}),
      ...(s.bot_difficulty ? { botDifficulty: s.bot_difficulty } : {}),
    })),
    startedAt: row.started_at ? row.started_at.getTime() : null,
    finishedAt: row.finished_at.getTime(),
    ...(row.challenge_day ? { challengeDate: row.challenge_day } : {}),
    ...(row.is_stammtisch ? { stammtisch: true } : {}),
  };
}

/**
 * @param {import('pg').Pool} pool the shared pool (game/Database.js)
 * @param {{legacyGamesFile?: string|null, legacyStatsFile?: string|null}} [opts] old files to import once (null: none)
 */
function createGameHistoryStore(pool, { legacyGamesFile = DEFAULT_GAMES_FILE, legacyStatsFile = DEFAULT_STATS_FILE } = {}) {
  let stats = { ...EMPTY_STATS };
  let importRun = null;
  let importRetryAt = 0;

  function maybeImport() {
    if (importRun) return importRun;
    if (Date.now() < importRetryAt) return Promise.resolve();
    importRun = (async () => {
      await importLegacyGames(pool, legacyGamesFile);
      await importLegacyStats(pool, legacyStatsFile);
    })().catch((err) => {
      // Never marked done: the history keeps working, the import tries again later.
      console.error('[db] games.json/stats.json import failed, retrying in 10 min:', err.message);
      importRun = null;
      importRetryAt = Date.now() + IMPORT_RETRY_MS;
    });
    return importRun;
  }

  const ready = () => ensureMigrated(pool).then(maybeImport);

  /** Loads the counters into the cache (the profiles message reads them synchronously). */
  async function load() {
    await ready();
    const { rows } = await pool.query('SELECT * FROM global_stats');
    if (rows[0]) stats = statsOfRow(rows[0]);
    return { ...stats };
  }

  /** The counters as last read or written; zeros until the first load() succeeded (retried here). */
  let loaded = null;
  function getStats() {
    if (!loaded) loaded = load().catch(() => { loaded = null; });
    return { ...stats };
  }

  /**
   * One finished match: always the counters, the match itself only with
   * `keepHistory` (public mode stores no names). Both in one transaction.
   */
  async function saveGame(record, { keepHistory = true, stammtisch = false } = {}) {
    await ready();
    return inTransaction(pool, async (c) => {
      const gameId = keepHistory ? await insertGame(c, record, { stammtisch }) : null;
      stats = await addStats(c, statsOfGame(record));
      return gameId;
    });
  }

  /** The newest `limit` matches `name` played as a human, as full records. */
  async function gamesOf(name, limit = 20) {
    const key = String(name || '').trim().toLowerCase();
    if (!key) return [];
    await ready();
    const { rows } = await pool.query(`SELECT g.*, (SELECT json_agg(s ORDER BY s.seat_no) FROM game_seats s WHERE s.game_id = g.id) AS seats
      FROM games g
      WHERE g.id IN (SELECT s.game_id FROM game_seats s JOIN players p ON p.id = s.player_id WHERE p.player_key = $1 AND NOT s.is_bot)
      ORDER BY g.finished_at DESC, g.id DESC LIMIT $2`, [key, Math.max(1, Math.min(200, limit))]);
    return rows.map((r) => recordOfRow(r, r.seats || []));
  }

  /** A deleted account: its seats keep score and result but lose name and link. The count, or null on failure. */
  async function anonymizeName(name) {
    const key = String(name || '').trim().toLowerCase();
    if (!key) return 0;
    try {
      await ready();
      return (await pool.query(`UPDATE game_seats SET player_id = NULL, player_name = NULL
        WHERE player_id = (SELECT id FROM players WHERE player_key = $1)`, [key])).rowCount;
    } catch (e) {
      console.error(`[game-history] anonymize failed: ${e.message}`);
      return null;
    }
  }

  return { ready, load, getStats, saveGame, gamesOf, anonymizeName };
}

/**
 * Personal history for ONE name: the newest finished matches it played as a
 * human (no bot), cut to `limit` and reduced to what the overview list needs.
 * A pure function so it can be tested without a server.
 *
 * @param {Array} allGames full records (gamesOf)
 * @param {string} name    player name (case does not matter)
 * @param {number} limit
 */
function historyForPlayer(allGames, name, limit = 20) {
  const nameLower = String(name || '').trim().toLowerCase();
  if (!nameLower) return [];
  const isMe = (p) => !p.isBot && (p.name || '').toLowerCase() === nameLower;
  return allGames
    .filter((g) => (g.players || []).some(isMe))
    .sort((a, b) => (b.finishedAt || 0) - (a.finishedAt || 0))
    .slice(0, limit)
    .map((g) => {
      const me = (g.players || []).find(isMe);
      return {
        id: g.id,
        finishedAt: g.finishedAt,
        challengeDate: g.challengeDate || null,
        startedAt: g.startedAt || null,
        stammtisch: !!g.stammtisch,
        rounds: (g.rounds || []).length,
        // Totals after each round: the score chart when a game is opened.
        roundTotals: (g.rounds || []).map((r) => r.totalsAfter || {}),
        myId: me ? me.id : null,
        // name null: an anonymised (deleted) account, the client labels it.
        players: (g.players || []).map((p) => ({ id: p.id, name: p.name, isBot: p.isBot, botDifficulty: p.botDifficulty })),
        finalTotals: g.finalTotals,
        winnerId: g.winnerId,
        won: !!(me && isRecordWinner(g, me.id)),
        myScore: me ? (g.finalTotals || {})[me.id] : undefined,
        // "2 gegen 2": the seating, both winners, the shared totals, the names and the target.
        ...(g.teamMode ? { teamMode: true, teams: g.teams, winnerIds: g.winnerIds, winnerTeam: g.winnerTeam, teamTotals: g.teamTotals, teamNames: g.teamNames || null, targetScore: g.targetScore || null } : {}),
      };
    });
}

module.exports = { createGameHistoryStore, historyForPlayer, statsOfGame, importLegacyGames, importLegacyStats, DEFAULT_GAMES_FILE, DEFAULT_STATS_FILE };

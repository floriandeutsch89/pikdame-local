// game/YearStatsStore.js
// Per-name, per-year counters for the December review (game/YearReview.js).
// Their own table instead of the profiles: those are broadcast to every
// client, and opponent lists per year would bloat that message.
// PostgreSQL (migrations/014); data/years.json of older versions is imported once.
const fs = require('fs');
const path = require('path');
require('./Database'); // registers the DATE parser
const { ensureMigrated } = require('./Migrations');
const { upsertPlayerId, keyOf } = require('./PlayerStore');
const { bumpYear, noteStreak, yearOf, strongestBot } = require('./YearReview');

const DEFAULT_DATA_DIR = process.env.PIKDAME_DATA_DIR || path.join(__dirname, '..', 'data');
const DEFAULT_DATA_FILE = path.join(DEFAULT_DATA_DIR, 'years.json');
const IMPORT_NAME = 'years.json';
const IMPORT_LOCK_KEY = 726821;
const IMPORT_RETRY_MS = 10 * 60 * 1000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// The earlier of the stored and the given day; NULL counts as "none yet".
const NOTE_SINCE = `UPDATE year_tracking SET since_day = LEAST(COALESCE(since_day, $1::date), $1::date), updated_at = now()
  WHERE since_day IS NULL OR since_day > $1::date`;

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

/** One-time move of years.json: one transaction plus a marker, the file is renamed after the commit. */
async function importLegacyFile(pool, file) {
  if (!file || !fs.existsSync(file)) return false;
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!parsed || typeof parsed.players !== 'object' || !parsed.players) throw new Error(`${file}: not a year stats file`);
  let count = 0;
  const imported = await inTransaction(pool, async (c) => {
    await c.query('SELECT pg_advisory_xact_lock($1)', [IMPORT_LOCK_KEY]);
    const marked = await c.query('INSERT INTO legacy_imports (source, imported_at) VALUES ($1, now()) ON CONFLICT DO NOTHING RETURNING source', [IMPORT_NAME]);
    if (!marked.rows.length) return false;
    if (DATE_RE.test(String(parsed.since || ''))) await c.query(NOTE_SINCE, [parsed.since]);
    for (const e of Object.values(parsed.players)) {
      if (!e || !keyOf(e.name) || !e.years || typeof e.years !== 'object') continue;
      // A name first seen here claims no age (like the other imports).
      await c.query('INSERT INTO players (player_key, player_name, created_at) VALUES ($1, $2, NULL) ON CONFLICT (player_key) DO NOTHING', [keyOf(e.name), String(e.name).trim()]);
      const playerId = (await c.query('SELECT id FROM players WHERE player_key = $1', [keyOf(e.name)])).rows[0].id;
      for (const [year, bucket] of Object.entries(e.years)) {
        if (!/^\d{4}$/.test(year) || !bucket || typeof bucket !== 'object') continue;
        // A year the new version already counted keeps its row: the file is older.
        const r = await c.query(`INSERT INTO player_years (player_id, stats_year, year_stats) VALUES ($1, $2, $3)
          ON CONFLICT DO NOTHING`, [playerId, Number(year), JSON.stringify(bucket)]);
        count += r.rowCount;
      }
    }
    return true;
  });
  fs.renameSync(file, `${file}.migrated`);
  console.log(imported
    ? `[db] ${IMPORT_NAME}: imported ${count} player years, file renamed to ${path.basename(file)}.migrated`
    : `[db] ${IMPORT_NAME}: already imported earlier, file renamed to ${path.basename(file)}.migrated without importing it again`);
  return imported;
}

/**
 * @param {import('pg').Pool} pool the shared pool (game/Database.js)
 * @param {{legacyFile?: string|null}} [opts] old JSON file to import once (null: none)
 */
function createYearStatsStore(pool, { legacyFile = DEFAULT_DATA_FILE } = {}) {
  let importRun = null;
  let importRetryAt = 0;

  function maybeImport() {
    if (importRun) return importRun;
    if (!legacyFile || Date.now() < importRetryAt) return Promise.resolve();
    importRun = importLegacyFile(pool, legacyFile).then(() => {}, (err) => {
      // Never marked done: counting goes on, the import tries again later.
      console.error(`[db] ${IMPORT_NAME} import failed, retrying in 10 min:`, err.message);
      importRun = null;
      importRetryAt = Date.now() + IMPORT_RETRY_MS;
    });
    return importRun;
  }
  const ready = () => ensureMigrated(pool).then(maybeImport);

  /** Reads the name's bucket of the date's year under a row lock, stores what `change` makes of it. */
  async function update(name, date, change) {
    if (!keyOf(name) || !DATE_RE.test(String(date || ''))) return;
    await ready();
    const year = Number(yearOf(date));
    await inTransaction(pool, async (c) => {
      const playerId = await upsertPlayerId(c, name, new Date());
      await c.query(`INSERT INTO player_years (player_id, stats_year, year_stats) VALUES ($1, $2, '{}') ON CONFLICT DO NOTHING`, [playerId, year]);
      const { rows } = await c.query('SELECT year_stats FROM player_years WHERE player_id = $1 AND stats_year = $2 FOR UPDATE', [playerId, year]);
      const before = rows[0] && Object.keys(rows[0].year_stats).length ? rows[0].year_stats : undefined;
      await c.query('UPDATE player_years SET year_stats = $3, updated_at = now() WHERE player_id = $1 AND stats_year = $2',
        [playerId, year, JSON.stringify(change(before))]);
      // The current and the previous year only (last December stays for a review in January).
      await c.query('DELETE FROM player_years WHERE player_id = $1 AND stats_year < $2', [playerId, year - 1]);
      await c.query(NOTE_SINCE, [date]);
    });
  }

  /** One finished game for one human seat (see YearReview.bumpYear). */
  const recordGame = (name, date, game) => update(name, date, (y) => bumpYear(y, { ...game, date }));

  const recordStreak = (name, date, streak) => update(name, date, (y) => noteStreak(y, streak));

  /**
   * A finished game for every human result (GameManager onGameOver): the other
   * humans are the opponents, the strongest bot sets the level. `table` is the
   * Stammtisch NAME - its code is a secret and never stored here.
   */
  async function recordFinishedGame(results, players, date, { table = null, streaks = {}, teams = null } = {}) {
    const humans = (players || []).filter((p) => !p.isBot);
    const botLevel = strongestBot(players);
    for (const r of results || []) {
      // "2 gegen 2": the partner is no opponent.
      const mine = Array.isArray(teams) ? teams.find((ids) => ids.includes(r.id)) : null;
      const opponents = humans.filter((p) => p.id !== r.id && !(mine && mine.includes(p.id))).map((p) => p.name);
      await recordGame(r.name, date, { won: r.won, score: r.score, facts: r.facts, opponents, botLevel, table });
      const st = streaks[r.id];
      if (st && st.streak) await recordStreak(r.name, date, st.streak);
    }
  }

  async function yearFor(name, year) {
    const key = keyOf(name);
    if (!key || !/^\d{4}$/.test(String(year))) return null;
    await ready();
    const { rows } = await pool.query(`SELECT y.year_stats FROM player_years y JOIN players p ON p.id = y.player_id
      WHERE p.player_key = $1 AND y.stats_year = $2`, [key, Number(year)]);
    return rows[0] && Object.keys(rows[0].year_stats).length ? rows[0].year_stats : null;
  }

  /** The first day anything was counted ('YYYY-MM-DD'), null before that. */
  async function trackingSince() {
    await ready();
    const { rows } = await pool.query('SELECT since_day FROM year_tracking');
    return (rows[0] && rows[0].since_day) || null;
  }

  return { ready, recordGame, recordStreak, recordFinishedGame, yearFor, trackingSince };
}

module.exports = { createYearStatsStore, importLegacyFile, DEFAULT_DATA_FILE };

// game/ChallengeStore.js
// Daily-challenge leaderboard: everyone plays the SAME seeded deck against
// the same medium bots. Only the FIRST game a player starts on a day is ranked
// (begun = used, later games that day are practice), so the board keeps it.
// Retention is deliberately short (14 days: the board shows 7, the own trend
// graph 14) - a daily race, not an archive; only nickname + score are kept.
// PostgreSQL (migrations/003, renamed in 005); every write is awaited. Game days are
// 'YYYY-MM-DD' strings (DATE parser in Database.js), instants ms at this boundary.

const fs = require('fs');
const path = require('path');
require('./Database'); // registers the DATE parser
const { ensureMigrated } = require('./Migrations');
const { gameDay, addDays, weekdayIndex } = require('./GameDay');

const DEFAULT_DATA_FILE = path.join(process.env.PIKDAME_DATA_DIR || path.join(__dirname, '..', 'data'), 'challenges.json');
const KEEP_DAYS = 14;
const BOARD_DAYS = 7;
const MAX_ENTRIES_PER_DAY = 100;
const IMPORT_NAME = 'challenges.json';
const IMPORT_LOCK_KEY = 726814;
const IMPORT_RETRY_MS = 10 * 60 * 1000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// Board order; player_key only breaks exact ties deterministically.
const BOARD_ORDER = 'score DESC, finished_at ASC, player_key ASC';

/** Stable numeric seed from a YYYY-MM-DD string (djb2). */
function seedForDate(dateStr) {
  let h = 5381;
  for (let i = 0; i < dateStr.length; i++) h = ((h << 5) + h + dateStr.charCodeAt(i)) >>> 0;
  return h >>> 0;
}

/** Today's challenge date (German midnight, see GameDay) - one deck for everyone. */
const todayDate = gameDay;

const cleanNameOf = (name) => String(name || '').trim().slice(0, 24) || 'Spieler';
const keyOf = (name) => cleanNameOf(name).toLowerCase();
// Lookups by name: an empty name matches nobody (no 'Spieler' default).
const lookupKey = (name) => String(name || '').trim().toLowerCase();

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

/** Parsed challenges.json -> row arrays; malformed entries are skipped. */
function legacyRows(parsed) {
  const results = [];
  const attempts = [];
  for (const [day, list] of Object.entries(parsed.days || {})) {
    if (!DATE_RE.test(day) || !Array.isArray(list)) continue;
    for (const e of list) {
      if (!e || !Number.isFinite(e.score) || !Number.isFinite(e.at)) continue;
      results.push([day, keyOf(e.name), cleanNameOf(e.name), Math.round(e.score), Number.isFinite(e.queens) ? e.queens : 0, new Date(Math.round(e.at))]);
    }
  }
  for (const [day, map] of Object.entries(parsed.attempts || {})) {
    if (!DATE_RE.test(day) || !map || typeof map !== 'object') continue;
    for (const a of Object.values(map)) {
      if (!a || !['running', 'done', 'lost'].includes(a.state) || !Number.isFinite(a.at)) continue;
      attempts.push([day, keyOf(a.name), cleanNameOf(a.name), String(a.code || ''), new Date(Math.round(a.at)), a.state]);
    }
  }
  return { results, attempts };
}

const columns = (rows) => rows[0] ? rows[0].map((_, i) => rows.map((r) => r[i])) : [[], [], [], [], [], []];

/**
 * One-time move of an old challenges.json into the tables: one transaction
 * plus a legacy_imports marker, the file is renamed only after the commit.
 * An unreadable file throws (the caller retries later), nothing is marked.
 */
async function importLegacyFile(pool, file) {
  if (!file || !fs.existsSync(file)) return false;
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${file}: not a challenge store`);
  const { results, attempts } = legacyRows(parsed);
  const imported = await inTransaction(pool, async (c) => {
    await c.query('SELECT pg_advisory_xact_lock($1)', [IMPORT_LOCK_KEY]);
    const marked = await c.query('INSERT INTO legacy_imports (source, imported_at) VALUES ($1, now()) ON CONFLICT DO NOTHING RETURNING source', [IMPORT_NAME]);
    if (!marked.rows.length) return false; // imported before (e.g. the rename failed): only move the file
    await c.query(`INSERT INTO challenge_results (game_day, player_key, player_name, score, queens_caught, finished_at)
      SELECT * FROM unnest($1::date[], $2::text[], $3::text[], $4::int[], $5::int[], $6::timestamptz[]) ON CONFLICT DO NOTHING`, columns(results));
    await c.query(`INSERT INTO challenge_attempts (game_day, player_key, player_name, session_code, started_at, status, updated_at)
      SELECT *, u.started_at FROM unnest($1::date[], $2::text[], $3::text[], $4::text[], $5::timestamptz[], $6::text[])
        AS u(game_day, player_key, player_name, session_code, started_at, status) ON CONFLICT DO NOTHING`, columns(attempts));
    return true;
  });
  fs.renameSync(file, `${file}.migrated`);
  console.log(imported
    ? `[db] ${IMPORT_NAME}: imported ${results.length} results and ${attempts.length} attempts, file renamed to ${path.basename(file)}.migrated`
    : `[db] ${IMPORT_NAME}: already imported earlier, file renamed to ${path.basename(file)}.migrated without importing it again`);
  return imported;
}

/**
 * @param {import('pg').Pool} pool the shared pool (game/Database.js)
 * @param {{legacyFile?: string|null}} [opts] old JSON file to import once (null: none)
 */
function createChallengeStore(pool, { legacyFile = DEFAULT_DATA_FILE } = {}) {
  let importRun = null;
  let importRetryAt = 0;

  function maybeImport() {
    if (importRun) return importRun;
    if (!legacyFile || Date.now() < importRetryAt) return Promise.resolve();
    importRun = importLegacyFile(pool, legacyFile).then(() => {}, (err) => {
      // Never marked done: the challenge keeps working, the import tries again later.
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

  async function cleanup(q, now) {
    const cutoff = addDays(gameDay(now), -KEEP_DAYS);
    await q.query('DELETE FROM challenge_results WHERE game_day < $1', [cutoff]);
    await q.query('DELETE FROM challenge_attempts WHERE game_day < $1', [cutoff]);
  }

  /** date -> board-ordered results, for the days in [from, to] (or a list). */
  async function loadDays(where, params) {
    const { rows } = await query(`SELECT game_day, player_key, player_name, score, queens_caught, finished_at
      FROM challenge_results WHERE ${where} ORDER BY game_day, ${BOARD_ORDER}`, params);
    const days = {};
    for (const r of rows) {
      (days[r.game_day] = days[r.game_day] || []).push({
        key: r.player_key, name: r.player_name, score: r.score, queens: r.queens_caught, finishedAt: r.finished_at.getTime(),
      });
    }
    return days;
  }
  const loadRange = (from, to) => loadDays('game_day >= $1 AND game_day <= $2', [from, to]);

  /** Records the ranked result; the FIRST one per (day, name) stays. */
  async function submit(date, name, score, now = Date.now(), facts = {}) {
    const cleanName = cleanNameOf(name);
    const key = cleanName.toLowerCase();
    await ready();
    await inTransaction(pool, async (c) => {
      await cleanup(c, now);
      await c.query(`INSERT INTO challenge_results (game_day, player_key, player_name, score, queens_caught, finished_at)
        VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING`,
      [date, key, cleanName, Math.round(score), facts.queens > 0 ? facts.queens : 0, new Date(now)]);
      await c.query(`DELETE FROM challenge_results WHERE game_day = $1 AND player_key NOT IN (
        SELECT player_key FROM challenge_results WHERE game_day = $1 ORDER BY ${BOARD_ORDER} LIMIT ${MAX_ENTRIES_PER_DAY})`, [date]);
      await c.query("UPDATE challenge_attempts SET status = 'done', updated_at = $3 WHERE game_day = $1 AND player_key = $2",
        [date, key, new Date(now)]);
    });
    return getBoard(date, 10);
  }

  /** A challenge game starts: ranked if it is the player's first of the day.
   *  Atomic: a result or an attempt that was not lost by the server uses the day. */
  async function beginAttempt(date, name, code, now = Date.now()) {
    const cleanName = cleanNameOf(name);
    await ready();
    await cleanup(pool, now);
    const { rowCount } = await pool.query(`INSERT INTO challenge_attempts
        (game_day, player_key, player_name, session_code, started_at, status, updated_at)
      SELECT $1::date, $2::text, $3::text, $4::text, $5::timestamptz, 'running', $5::timestamptz
      WHERE NOT EXISTS (SELECT 1 FROM challenge_results WHERE game_day = $1 AND player_key = $2)
      ON CONFLICT (game_day, player_key) DO UPDATE SET player_name = EXCLUDED.player_name, session_code = EXCLUDED.session_code,
        started_at = EXCLUDED.started_at, status = 'running', updated_at = EXCLUDED.updated_at
      WHERE challenge_attempts.status = 'lost'`, [date, cleanName.toLowerCase(), cleanName, String(code || ''), new Date(now)]);
    return { ranked: rowCount === 1 };
  }

  /** The ranked game ended without a result (given up): the day stays used. */
  async function closeAttempt(date, name) {
    await query(`UPDATE challenge_attempts SET status = 'done', updated_at = now()
      WHERE game_day = $1 AND player_key = $2 AND status = 'running'`, [date, keyOf(name)]);
  }

  /** A running ranked game whose session is gone (not back after a restart,
   *  or removed later) was lost by the server, not given up - its player gets
   *  a new ranked attempt. `liveCodes`: anything with has(code). */
  async function markLostAttempts(liveCodes) {
    const { rows } = await query("SELECT game_day, player_key, session_code FROM challenge_attempts WHERE status = 'running'");
    const gone = rows.filter((r) => !liveCodes.has(r.session_code));
    if (!gone.length) return;
    // The code in the WHERE: an attempt begun again meanwhile keeps running.
    await pool.query(`UPDATE challenge_attempts a SET status = 'lost', updated_at = now()
      FROM unnest($1::date[], $2::text[], $3::text[]) AS g(game_day, player_key, session_code)
      WHERE a.game_day = g.game_day AND a.player_key = g.player_key AND a.session_code = g.session_code AND a.status = 'running'`,
    [gone.map((r) => r.game_day), gone.map((r) => r.player_key), gone.map((r) => r.session_code)]);
  }

  async function attemptOf(date, name) {
    const { rows } = await query(`SELECT session_code AS code, status FROM challenge_attempts
      WHERE game_day = $1 AND player_key = $2`, [date, keyOf(name)]);
    return rows[0] || null;
  }
  async function hasResult(date, name) {
    const { rows } = await query('SELECT 1 FROM challenge_results WHERE game_day = $1 AND player_key = $2', [date, keyOf(name)]);
    return rows.length > 0;
  }

  /** The session code of the player's ranked game of `date` while it runs, else null. */
  async function runningAttempt(date, name) {
    const attempt = await attemptOf(date, name);
    return attempt && attempt.status === 'running' ? attempt.code : null;
  }

  async function hasAttempted(date, name) {
    if (await hasResult(date, name)) return true;
    const attempt = await attemptOf(date, name);
    return !!attempt && attempt.status !== 'lost';
  }

  /** Played to the end or given up: only then may the day's scores be seen
   *  (a running game must not peek at the field). */
  async function hasFinished(date, name) {
    if (await hasResult(date, name)) return true;
    const attempt = await attemptOf(date, name);
    return !!attempt && attempt.status === 'done';
  }

  async function playerCount(date) {
    const { rows } = await query('SELECT COUNT(*)::int AS n FROM challenge_results WHERE game_day = $1', [date]);
    return rows[0].n;
  }

  /** "Damen-Magnet des Tages": most Queens of Spades caught in a ranked game
   *  (tie: lower score, then the earlier finish); null while nobody was caught. */
  function magnetOf(list) {
    let best = null;
    for (const e of list || []) {
      if (!(e.queens > 0)) continue;
      const better = !best || e.queens > best.queens ||
        (e.queens === best.queens && (e.score < best.score || (e.score === best.score && e.finishedAt < best.finishedAt)));
      if (better) best = e;
    }
    return best ? { name: best.name, queens: best.queens } : null;
  }
  async function queenMagnet(date) {
    return magnetOf((await loadRange(date, date))[date]);
  }

  async function getBoard(date, top = 10) {
    const limit = Number.isFinite(top) ? Math.max(0, Math.floor(top)) : null;
    const { rows } = await query(`SELECT player_name, score FROM challenge_results WHERE game_day = $1
      ORDER BY ${BOARD_ORDER} LIMIT $2`, [date, limit]);
    return rows.map((e, i) => ({ rank: i + 1, name: e.player_name, score: e.score }));
  }

  /** One player's ranked result of the day, for sharing: rank, score, caught
   *  Queens of Spades and how many played. Null without a ranked game. */
  async function resultOf(date, name) {
    const list = (await loadRange(date, date))[date] || [];
    const idx = list.findIndex((e) => e.key === lookupKey(name));
    if (idx === -1) return null;
    return { rank: idx + 1, score: list[idx].score, queens: list[idx].queens || 0, players: list.length };
  }

  async function rankOf(date, name) {
    const r = await resultOf(date, name);
    return r ? r.rank : null;
  }

  /** The last BOARD_DAYS days at a glance (today first): per day the top
   *  entries plus - if a name is given - that player's own score and rank. */
  async function getHistory(name = null, top = 3, now = Date.now()) {
    const today = gameDay(now);
    const store = await loadRange(addDays(today, -(BOARD_DAYS - 1)), today);
    const key = name ? lookupKey(name) : null;
    const days = [];
    for (let i = 0; i < BOARD_DAYS; i++) {
      const date = addDays(today, -i);
      const list = store[date] || [];
      if (list.length === 0 && i > 0) continue; // empty earlier days are not listed
      const me = key ? list.findIndex((e) => e.key === key) : -1;
      days.push({
        date,
        top: list.slice(0, top).map((e, idx) => ({ rank: idx + 1, name: e.name, score: e.score })),
        yourScore: me === -1 ? null : list[me].score,
        yourRank: me === -1 ? null : me + 1,
        players: list.length,
        magnet: magnetOf(list),
      });
    }
    return days;
  }

  /**
   * Weekly ranking (Mon-Sun, game days): per player the SUM of their best 5 daily
   * scores of the current week. 'Best 5 of 7' keeps one or two missed days
   * from ruining the week and rewards regulars over one lucky spike.
   * `exclude`: a date left out (today, before the caller played it).
   */
  async function getWeekly(name = null, top = 5, now = Date.now(), { exclude = null } = {}) {
    const today = gameDay(now);
    const dow = weekdayIndex(today); // Mon=0 .. Sun=6
    const monday = addDays(today, -dow);
    const store = await loadRange(monday, today);
    const perPlayer = new Map();
    for (let i = 0; i <= dow; i++) {
      const date = addDays(monday, i);
      if (date === exclude) continue;
      for (const e of store[date] || []) {
        if (!perPlayer.has(e.key)) perPlayer.set(e.key, { key: e.key, name: e.name, scores: [] });
        perPlayer.get(e.key).scores.push(e.score);
      }
    }
    const board = [...perPlayer.values()]
      .map((p) => {
        const best5 = p.scores.sort((a, b) => b - a).slice(0, 5);
        return { key: p.key, name: p.name, weekScore: best5.reduce((a, b) => a + b, 0), days: p.scores.length };
      })
      .sort((a, b) => b.weekScore - a.weekScore);
    const meIdx = name ? board.findIndex((e) => e.key === lookupKey(name)) : -1;
    return {
      week: `${monday}..${today}`,
      top: board.slice(0, top).map(({ key, ...e }, i) => ({ rank: i + 1, ...e })),
      yourRank: meIdx === -1 ? null : meIdx + 1,
      yourScore: meIdx === -1 ? null : board[meIdx].weekScore,
      players: board.length,
    };
  }

  /**
   * Trend graph: the player's daily scores plus the `top` OTHER players of
   * the window (sum of their daily bests), oldest day first; a day without a
   * result is null (a gap, not a zero). The top set is fixed for the window.
   * `exclude`: a date left empty (today, before the caller played it).
   */
  async function getTrend(name, { days = KEEP_DAYS, top = 5, exclude = null } = {}, now = Date.now()) {
    const key = lookupKey(name);
    const today = gameDay(now);
    const dates = [];
    for (let i = Math.min(days, KEEP_DAYS) - 1; i >= 0; i--) dates.push(addDays(today, -i));
    const store = await loadRange(dates[0], today);
    const players = new Map(); // lower-case name -> { name, scores[] }
    dates.forEach((date, d) => {
      if (date === exclude) return;
      for (const e of store[date] || []) {
        if (!players.has(e.key)) players.set(e.key, { name: e.name, scores: dates.map(() => null) });
        players.get(e.key).scores[d] = e.score;
      }
    });
    const sum = (p) => p.scores.reduce((a, v) => a + (v || 0), 0);
    const others = [...players.entries()]
      .filter(([k]) => k !== key)
      .map(([, p]) => ({ ...p, total: sum(p), days: p.scores.filter((v) => v != null).length }))
      .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name))
      .slice(0, top);
    const mine = key && players.get(key);
    return {
      dates,
      me: mine ? { ...mine, total: sum(mine), days: mine.scores.filter((v) => v != null).length } : null,
      top: others,
    };
  }

  /** The finished days (still kept) on which `name` has a result, board-ordered. */
  async function pastDaysOf(key, now) {
    if (!key) return {};
    return loadDays('game_day IN (SELECT game_day FROM challenge_results WHERE player_key = $1 AND game_day < $2)', [key, gameDay(now)]);
  }

  /** Was `name` first on a challenge day that is already over (still kept)? */
  async function wasChampion(name, now = Date.now()) {
    const key = lookupKey(name);
    return Object.values(await pastDaysOf(key, now)).some((list) => list[0].key === key);
  }

  /** Was `name` the Damen-Magnet of a challenge day that is already over? */
  async function wasQueenMagnet(name, now = Date.now()) {
    const key = lookupKey(name);
    return Object.values(await pastDaysOf(key, now)).some((list) => {
      const magnet = magnetOf(list);
      return !!magnet && magnet.name.toLowerCase() === key;
    });
  }

  return {
    ready, submit, getBoard, rankOf, resultOf, getHistory, getWeekly, getTrend, wasChampion,
    beginAttempt, closeAttempt, markLostAttempts, runningAttempt, hasAttempted, hasFinished, playerCount, queenMagnet, wasQueenMagnet,
  };
}

module.exports = { createChallengeStore, importLegacyFile, seedForDate, todayDate, DEFAULT_DATA_FILE, KEEP_DAYS, MAX_ENTRIES_PER_DAY };

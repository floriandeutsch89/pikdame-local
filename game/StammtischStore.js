// game/StammtischStore.js
// The "Stammtisch": a table that outlives a single evening. One code for the
// group, forever; a head-to-head record over every match played under it;
// and a rematch series (best of 3) that gives "Revanche!" a scoreboard.
// A "2 gegen 2" match counts as played (list, goals, games) but never as
// "A beat B": no wins, no head-to-head, no series (docs/developer/team-mode.md).
//
// Scoped by its code - only people who hold it see the names in it - so it
// stays available on a public server, unlike the server-wide profiles.
// PostgreSQL (migrations/007, 010, 012): stammtische with members, games and seats, the
// series wins and the weeks of the group goals. Async, every write awaited; a
// match is booked in one transaction holding the table's row lock. A table is
// read in one statement into the shape summarize() and StammtischGoals know.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { inTransaction } = require('./Database'); // also registers the DATE parser
const { ensureMigrated } = require('./Migrations');
const { upsertPlayerId } = require('./PlayerStore');
const { bookGame, goalsOf, goalsView } = require('./StammtischGoals');
const { gameDay } = require('./GameDay');
const Teams = require('./Teams');
const { BOT_LEVELS } = require('./Bot'); // the CHECK of migrations/012 lists the same

const DEFAULT_DATA_FILE = path.join(process.env.PIKDAME_DATA_DIR || path.join(__dirname, '..', 'data'), 'stammtisch.json');

// Codes share the session alphabet (no O/0, I/1/L) but start with a letter
// pair that a random session code is unlikely to produce - a Stammtisch code
// is typed for years, it should be easy to say out loud.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTWXYZ23456789';
const CODE_LENGTH = 6;
const MAX_TABLES = 300;
const MAX_GAMES_PER_TABLE = 100;
const RECENT_GAMES = 5; // at the table (summary)
const SHEET_GAMES = 3; // on the start-screen sheet (chipInfo)
const INACTIVE_DAYS = 180;
const SERIES_BEST_OF = 3;
const SERIES_NEEDED = Math.ceil(SERIES_BEST_OF / 2 + 0.5);
const IMPORT_NAME = 'stammtisch.json';
const IMPORT_LOCK_KEY = 726816;
const IMPORT_RETRY_MS = 10 * 60 * 1000;

function generateCode() {
  const bytes = crypto.randomBytes(CODE_LENGTH);
  let code = 'ST';
  for (let i = 0; i < CODE_LENGTH - 2; i++) code += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return code;
}

function normalizeCode(raw) {
  return String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, CODE_LENGTH);
}

function cleanName(raw, maxLen = 24) {
  return String(raw || '').replace(/[^\p{L}\p{N} ._\-!?&']/gu, '').replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function keyOf(name) {
  return String(name || '').trim().toLowerCase();
}

const ms = (v) => (v == null ? null : Number(v));

// A whole table in one statement: members (in joining order), the kept games
// with their seats, the running series' wins and the goal weeks. $1: the code.
const TABLE_SQL = `SELECT s.id, s.stammtisch_code, s.stammtisch_name,
  floor(extract(epoch FROM s.created_at) * 1000)::bigint AS created_ms,
  floor(extract(epoch FROM s.last_used_at) * 1000)::bigint AS last_used_ms,
  s.series_no, s.series_games, s.series_winner_name,
  floor(extract(epoch FROM s.series_finished_at) * 1000)::bigint AS series_finished_ms,
  s.goal_xp, s.goal_weeks_reached,
  COALESCE(o.player_key, (SELECT p.player_key FROM stammtisch_members m JOIN players p ON p.id = m.player_id
    WHERE m.stammtisch_id = s.id ORDER BY m.joined_at, m.player_id LIMIT 1)) AS owner_key,
  (SELECT COALESCE(json_agg(json_build_object('key', p.player_key, 'name', m.player_name, 'games', m.games_played,
      'wins', m.games_won, 'points', m.points, 'lastSeen', floor(extract(epoch FROM m.last_seen_at) * 1000)::bigint)
      ORDER BY m.joined_at, m.player_id), '[]')
    FROM stammtisch_members m JOIN players p ON p.id = m.player_id WHERE m.stammtisch_id = s.id) AS members,
  (SELECT COALESCE(json_agg(json_build_object('no', g.game_no, 'at', floor(extract(epoch FROM g.finished_at) * 1000)::bigint,
      'seriesNo', g.series_no, 'teamMode', g.team_mode, 'teamNames', json_build_array(g.team_a_name, g.team_b_name),
      'players', (SELECT json_agg(json_build_object('name', x.player_name, 'isBot', x.is_bot,
        'score', x.score, 'won', x.won, 'team', x.team_no, 'botDifficulty', x.bot_difficulty) ORDER BY x.seat_no)
      FROM stammtisch_game_seats x WHERE x.stammtisch_id = g.stammtisch_id AND x.game_no = g.game_no)) ORDER BY g.game_no), '[]')
    FROM stammtisch_games g WHERE g.stammtisch_id = s.id) AS games,
  (SELECT COALESCE(json_object_agg(p.player_key, w.wins), '{}')
    FROM stammtisch_series_wins w JOIN players p ON p.id = w.player_id WHERE w.stammtisch_id = s.id) AS series_wins,
  (SELECT COALESCE(json_object_agg(to_char(k.week_start_day, 'YYYY-MM-DD'), k.games_played), '{}')
    FROM stammtisch_weeks k WHERE k.stammtisch_id = s.id) AS weeks
  FROM stammtische s LEFT JOIN players o ON o.id = s.owner_player_id
  WHERE s.stammtisch_code = $1`;

/** A seat as the client knows it: its team only in a team match, a level only on a bot that has one (012). */
function seatOf({ team, botDifficulty, ...p }, teamMode) {
  return { ...p, ...(teamMode ? { team } : {}), ...(botDifficulty ? { botDifficulty } : {}) };
}

/** A TABLE_SQL row as the table object of the JSON store (plus its id). */
function tableOf(r) {
  const members = {};
  for (const m of r.members) members[m.key] = { name: m.name, games: m.games, wins: m.wins, points: m.points, lastSeen: ms(m.lastSeen) };
  return {
    id: r.id,
    code: r.stammtisch_code,
    name: r.stammtisch_name,
    createdAt: ms(r.created_ms),
    lastActivity: ms(r.last_used_ms),
    owner: r.owner_key || null,
    members,
    games: r.games.map((g) => (g.teamMode
      ? { no: g.no, at: ms(g.at), seriesNo: g.seriesNo, teamMode: true, teamNames: g.teamNames, players: (g.players || []).map((p) => seatOf(p, true)) }
      : { no: g.no, at: ms(g.at), seriesNo: g.seriesNo, players: (g.players || []).map((p) => seatOf(p, false)) })),
    series: {
      no: r.series_no, bestOf: SERIES_BEST_OF, wins: r.series_wins, games: r.series_games,
      winner: r.series_winner_name || null, finishedAt: ms(r.series_finished_ms),
    },
    goals: { xp: r.goal_xp, weeks: r.weeks, weeksReached: r.goal_weeks_reached },
  };
}

/**
 * Everything the client shows: standings, the pairwise record and the
 * series. Pairwise = "in matches where both sat, who finished ahead" -
 * solo matches only: a team match never says who beat whom.
 */
function summarize(t, now = Date.now()) {
  const members = Object.values(t.members || {})
    .map((m) => ({ ...m, avg: m.games ? Math.round(m.points / m.games) : 0 }))
    .sort((a, b) => b.wins - a.wins || b.avg - a.avg || a.name.localeCompare(b.name));
  const games = t.games || [];
  const pairwise = {};
  for (const g of games) {
    if (g.teamMode) continue;
    const hs = g.players.filter((p) => !p.isBot);
    for (const a of hs) {
      for (const b of hs) {
        if (a === b) continue;
        const ka = keyOf(a.name);
        const kb = keyOf(b.name);
        pairwise[ka] = pairwise[ka] || {};
        pairwise[ka][kb] = pairwise[ka][kb] || { ahead: 0, behind: 0 };
        if (a.score > b.score) pairwise[ka][kb].ahead += 1;
        else if (a.score < b.score) pairwise[ka][kb].behind += 1;
      }
    }
  }
  return {
    code: t.code,
    name: t.name,
    createdAt: t.createdAt,
    gamesPlayed: games.length,
    teamGames: games.filter((g) => g.teamMode).length,
    members,
    pairwise,
    series: { ...t.series, needed: SERIES_NEEDED },
    goals: goalsView(t, now),
    // Game days (Europe/Berlin), so the client says "Heute" by the server's clock.
    today: gameDay(now),
    recent: games.slice(-RECENT_GAMES).reverse().map(({ no, ...g }) => ({ ...g, day: gameDay(g.at) })),
  };
}

/** Parsed stammtisch.json -> rows per table (keyed by code / player_key); malformed entries are skipped. */
function legacyRows(parsed, now = Date.now()) {
  const out = { players: new Map(), tables: [], members: [], games: [], seats: [], seriesWins: [], weeks: [] };
  const iso = (v, fallback = null) => (Number.isFinite(Number(v)) && Number(v) > 0 && Number(v) < 8.64e15 ? new Date(Number(v)).toISOString() : fallback);
  const int = (v) => (Number.isFinite(Number(v)) ? Math.max(-2147483647, Math.min(2147483647, Math.round(Number(v)))) : 0);
  const player = (name) => {
    const clean = cleanName(name, 16);
    const key = keyOf(clean);
    if (key && !out.players.has(key)) out.players.set(key, clean);
    return key || null;
  };
  const tables = parsed.tables && typeof parsed.tables === 'object' && !Array.isArray(parsed.tables) ? parsed.tables : {};
  for (const [codeKey, t] of Object.entries(tables)) {
    if (!t || typeof t !== 'object') continue;
    // get() looked a table up by its normalized code: any other key was never reachable.
    const code = codeKey;
    if (normalizeCode(code) !== code || !/^[A-Z0-9]{2,6}$/.test(code)) continue;
    const created = iso(t.createdAt, new Date(now).toISOString());
    const createdMs = Date.parse(created);
    const memberKeys = [];
    Object.entries(t.members && typeof t.members === 'object' ? t.members : {}).forEach(([k, m], i) => {
      const key = player((m && m.name) || k);
      if (!key || memberKeys.includes(key)) return;
      memberKeys.push(key);
      // The file kept no join times: the table's creation plus the position keeps the order.
      out.members.push({ code, player_key: key, player_name: out.players.get(key), games_played: Math.max(0, int(m.games)),
        games_won: Math.max(0, int(m.wins)), points: int(m.points), joined_at: new Date(createdMs + i).toISOString(), last_seen_at: iso(m.lastSeen) });
    });
    // Tables from before owners existed belong to their founder (the first member).
    const ownerKey = t.owner ? player((t.members && t.members[t.owner] && t.members[t.owner].name) || t.owner) : memberKeys[0] || null;
    const series = t.series && typeof t.series === 'object' ? t.series : {};
    for (const [k, n] of Object.entries(series.wins && typeof series.wins === 'object' ? series.wins : {})) {
      const key = player((t.members && t.members[k] && t.members[k].name) || k);
      if (key && int(n) > 0) out.seriesWins.push({ code, player_key: key, wins: int(n) });
    }
    const games = (Array.isArray(t.games) ? t.games : []).filter((g) => g && Array.isArray(g.players)).slice(-MAX_GAMES_PER_TABLE);
    games.forEach((g, i) => {
      out.games.push({ code, game_no: i + 1, series_no: Math.max(1, int(g.seriesNo) || 1), finished_at: iso(g.at, created) });
      g.players.forEach((p, j) => {
        const isBot = !!(p && p.isBot);
        const name = isBot ? String((p && p.name) || 'Bot') : cleanName(p && p.name, 16);
        out.seats.push({ code, game_no: i + 1, seat_no: j, player_key: isBot ? null : player(name), player_name: name,
          is_bot: isBot, score: int(p && p.score), won: !!(p && p.won) });
      });
    });
    // Goals of a table from before them are rebuilt from its matches once (StammtischGoals).
    const goals = goalsOf({ ...t, games });
    for (const [week, n] of Object.entries(goals.weeks || {})) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(week) && Number.isFinite(Date.parse(`${week}T00:00:00Z`))) {
        out.weeks.push({ code, week_start_day: week, games_played: Math.max(0, int(n)) });
      }
    }
    out.tables.push({
      code, name: cleanName(t.name) || 'Stammtisch', owner_key: ownerKey, created_at: created,
      last_used_at: iso(t.lastActivity, created), series_no: Math.max(1, int(series.no) || 1), series_games: Math.max(0, int(series.games)),
      series_winner_name: typeof series.winner === 'string' && series.winner ? cleanName(series.winner, 16) : null,
      series_finished_at: iso(series.finishedAt), goal_xp: Math.max(0, int(goals.xp)), goal_weeks_reached: Math.max(0, int(goals.weeksReached)),
    });
  }
  return { ...out, players: [...out.players].map(([player_key, player_name]) => ({ player_key, player_name })) };
}

/**
 * One-time move of an old stammtisch.json into the tables: one transaction plus
 * a legacy_imports marker, the file is renamed only after the commit. An
 * unreadable file throws (the caller retries later) and nothing is marked. A
 * code taken meanwhile (a table founded before a late import) keeps the live table.
 */
async function importLegacyFile(pool, file, { now = Date.now() } = {}) {
  if (!file || !fs.existsSync(file)) return false;
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${file}: not a Stammtisch store`);
  const rows = legacyRows(parsed, now);
  const imported = await inTransaction(pool, async (c) => {
    await c.query('SELECT pg_advisory_xact_lock($1)', [IMPORT_LOCK_KEY]);
    const marked = await c.query('INSERT INTO legacy_imports (source, imported_at) VALUES ($1, now()) ON CONFLICT DO NOTHING RETURNING source', [IMPORT_NAME]);
    if (!marked.rows.length) return null; // imported before (e.g. the rename failed): only move the file
    const json = (list) => JSON.stringify(list);
    await c.query(`INSERT INTO players (player_key, player_name, created_at)
      SELECT x.player_key, x.player_name, NULL FROM jsonb_to_recordset($1::jsonb) AS x(player_key text, player_name text)
      ORDER BY x.player_key ON CONFLICT (player_key) DO NOTHING`, [json(rows.players)]);
    const inserted = (await c.query(`INSERT INTO stammtische (stammtisch_code, stammtisch_name, owner_player_id, created_at,
        last_used_at, series_no, series_games, series_winner_name, series_finished_at, goal_xp, goal_weeks_reached)
      SELECT x.code, x.name, p.id, x.created_at, x.last_used_at, x.series_no, x.series_games, x.series_winner_name,
        x.series_finished_at, x.goal_xp, x.goal_weeks_reached
      FROM jsonb_to_recordset($1::jsonb) AS x(code text, name text, owner_key text, created_at timestamptz, last_used_at timestamptz,
        series_no int, series_games int, series_winner_name text, series_finished_at timestamptz, goal_xp int, goal_weeks_reached int)
      LEFT JOIN players p ON p.player_key = x.owner_key
      ON CONFLICT (stammtisch_code) DO NOTHING RETURNING stammtisch_code`, [json(rows.tables)])).rows.map((r) => r.stammtisch_code);
    const mine = (list) => json(list.filter((r) => inserted.includes(r.code)));
    await c.query(`INSERT INTO stammtisch_members (stammtisch_id, player_id, player_name, games_played, games_won, points, joined_at, last_seen_at)
      SELECT s.id, p.id, x.player_name, x.games_played, x.games_won, x.points, x.joined_at, x.last_seen_at
      FROM jsonb_to_recordset($1::jsonb) AS x(code text, player_key text, player_name text, games_played int, games_won int,
        points int, joined_at timestamptz, last_seen_at timestamptz)
      JOIN stammtische s ON s.stammtisch_code = x.code JOIN players p ON p.player_key = x.player_key`, [mine(rows.members)]);
    await c.query(`INSERT INTO stammtisch_games (stammtisch_id, game_no, series_no, finished_at)
      SELECT s.id, x.game_no, x.series_no, x.finished_at
      FROM jsonb_to_recordset($1::jsonb) AS x(code text, game_no int, series_no int, finished_at timestamptz)
      JOIN stammtische s ON s.stammtisch_code = x.code`, [mine(rows.games)]);
    await c.query(`INSERT INTO stammtisch_game_seats (stammtisch_id, game_no, seat_no, player_id, player_name, is_bot, score, won)
      SELECT s.id, x.game_no, x.seat_no, p.id, x.player_name, x.is_bot, x.score, x.won
      FROM jsonb_to_recordset($1::jsonb) AS x(code text, game_no int, seat_no smallint, player_key text, player_name text,
        is_bot boolean, score int, won boolean)
      JOIN stammtische s ON s.stammtisch_code = x.code LEFT JOIN players p ON p.player_key = x.player_key`, [mine(rows.seats)]);
    await c.query(`INSERT INTO stammtisch_series_wins (stammtisch_id, player_id, wins)
      SELECT s.id, p.id, x.wins FROM jsonb_to_recordset($1::jsonb) AS x(code text, player_key text, wins int)
      JOIN stammtische s ON s.stammtisch_code = x.code JOIN players p ON p.player_key = x.player_key`, [mine(rows.seriesWins)]);
    await c.query(`INSERT INTO stammtisch_weeks (stammtisch_id, week_start_day, games_played)
      SELECT s.id, x.week_start_day, x.games_played FROM jsonb_to_recordset($1::jsonb) AS x(code text, week_start_day date, games_played int)
      JOIN stammtische s ON s.stammtisch_code = x.code`, [mine(rows.weeks)]);
    return { tables: inserted.length, skipped: rows.tables.length - inserted.length, games: rows.games.filter((g) => inserted.includes(g.code)).length };
  });
  fs.renameSync(file, `${file}.migrated`);
  console.log(imported
    ? `[db] ${IMPORT_NAME}: imported ${imported.tables} Stammtische (matches: ${imported.games}${imported.skipped ? `, ${imported.skipped} with a code taken meanwhile kept as they are` : ''}), file renamed to ${path.basename(file)}.migrated`
    : `[db] ${IMPORT_NAME}: already imported earlier, file renamed to ${path.basename(file)}.migrated without importing it again`);
  return !!imported;
}

/**
 * @param {import('pg').Pool} pool the shared pool (game/Database.js)
 * @param {{legacyFile?: string|null}} [opts] old JSON file to import once (null: none)
 */
function createStammtischStore(pool, { legacyFile = DEFAULT_DATA_FILE } = {}) {
  let importRun = null;
  let importRetryAt = 0;

  function maybeImport() {
    if (importRun) return importRun;
    if (!legacyFile || Date.now() < importRetryAt) return Promise.resolve();
    importRun = importLegacyFile(pool, legacyFile).then(() => {}, (err) => {
      // Never marked done: the Stammtische keep working, the import tries again later.
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

  async function readTable(q, code) {
    const { rows } = await q.query(TABLE_SQL, [code]);
    return rows[0] ? tableOf(rows[0]) : null;
  }

  async function addMember(c, tableId, name, at, joinedAt = at) {
    const id = await upsertPlayerId(c, name, at);
    await c.query(`INSERT INTO stammtisch_members AS m (stammtisch_id, player_id, player_name, joined_at, last_seen_at, updated_at)
      VALUES ($1, $2, $3, $5, $4, $4)
      ON CONFLICT (stammtisch_id, player_id) DO UPDATE SET player_name = EXCLUDED.player_name, last_seen_at = EXCLUDED.last_seen_at,
        updated_at = EXCLUDED.updated_at`, [tableId, id, name, at, joinedAt]);
    return id;
  }

  /** Unused for INACTIVE_DAYS, or beyond the MAX_TABLES most recently used: gone with everything in them. */
  async function prune(c, now) {
    await c.query('DELETE FROM stammtische WHERE last_used_at < $1', [new Date(now - INACTIVE_DAYS * 86400000)]);
    await c.query(`DELETE FROM stammtische WHERE id IN (
      SELECT id FROM stammtische ORDER BY last_used_at DESC, id DESC OFFSET ${MAX_TABLES})`);
  }

  /** @param {string|null} ownerAccount account username; only it may delete
   *  @returns {Promise<{table:{code:string,name:string}}>} */
  async function create(name, founderName, now = Date.now(), ownerAccount = null) {
    const title = cleanName(name) || 'Stammtisch';
    const founder = cleanName(founderName, 16);
    await ready();
    return inTransaction(pool, async (c) => {
      await prune(c, now);
      const at = new Date(now);
      let table = null;
      for (let i = 0; !table; i++) {
        if (i >= 20) throw new Error('no free Stammtisch code');
        table = (await c.query(`INSERT INTO stammtische (stammtisch_code, stammtisch_name, created_at, updated_at, last_used_at)
          VALUES ($1, $2, $3, $3, $3) ON CONFLICT (stammtisch_code) DO NOTHING RETURNING id, stammtisch_code`, [generateCode(), title, at])).rows[0];
      }
      const founderId = founder ? await addMember(c, table.id, founder, at) : null;
      const owner = String(ownerAccount || '').trim();
      const ownerId = owner ? await upsertPlayerId(c, owner, at) : founderId;
      if (ownerId) await c.query('UPDATE stammtische SET owner_player_id = $2 WHERE id = $1', [table.id, ownerId]);
      return { table: { code: table.stammtisch_code, name: title } };
    });
  }

  /** The table behind a code ({ code, name }), or null. */
  async function get(rawCode) {
    const code = normalizeCode(rawCode);
    if (!code) return null;
    const { rows } = await query('SELECT stammtisch_code, stammtisch_name FROM stammtische WHERE stammtisch_code = $1', [code]);
    return rows[0] ? { code: rows[0].stammtisch_code, name: rows[0].stammtisch_name } : null;
  }

  /** Someone sits down: the table counts as used, the name becomes (or stays) a member. */
  async function touch(rawCode, memberName, now = Date.now()) {
    const code = normalizeCode(rawCode);
    if (!code) return null;
    await ready();
    return inTransaction(pool, async (c) => {
      const at = new Date(now);
      const { rows } = await c.query(`UPDATE stammtische SET last_used_at = $2, updated_at = $2 WHERE stammtisch_code = $1
        RETURNING id, stammtisch_code, stammtisch_name`, [code, at]);
      if (!rows[0]) return null;
      const name = cleanName(memberName, 16);
      if (name) await addMember(c, rows[0].id, name, at);
      return { code: rows[0].stammtisch_code, name: rows[0].stammtisch_name };
    });
  }

  /**
   * Books a finished match: head-to-head counters, the game list, the
   * rematch series and the group goals. Only HUMAN seats count - a bot never wins a series.
   * A team match ("2 gegen 2") counts as played but wins nothing: no member win,
   * no head-to-head, and the series neither advances nor restarts.
   * @param {Object} gameRecord GameManager.lastGameRecord
   * @returns {Promise<{summary:Object, seriesEvent:null|{type:'won',winner:string,no:number}, goalEvents:Array}|null>}
   */
  async function recordGame(rawCode, gameRecord, now = Date.now()) {
    const code = normalizeCode(rawCode);
    if (!code || !gameRecord) return null;
    await ready();
    return inTransaction(pool, async (c) => {
      if (!(await c.query('SELECT 1 FROM stammtische WHERE stammtisch_code = $1 FOR UPDATE', [code])).rows.length) return null;
      const t = await readTable(c, code);
      const at = new Date(now);
      const humans = (gameRecord.players || []).filter((p) => !p.isBot);
      const totals = gameRecord.finalTotals || {};
      const teams = gameRecord.teamMode && Array.isArray(gameRecord.teams) ? gameRecord.teams : null;
      const winnerIds = Teams.recordWinnerIds(gameRecord);
      // The one winner of a solo match; a team match has none (both partners won it together).
      const winner = teams ? null : humans.find((p) => p.id === gameRecord.winnerId) || null;
      // Players in key order: a match books the same names in its profiles transaction at once.
      // Games and own points count for every match (neutral), a win only in a solo match.
      const ids = {};
      const seated = humans.map((p) => ({ p, name: cleanName(p.name, 16) })).filter((x) => x.name)
        .sort((a, b) => (keyOf(a.name) < keyOf(b.name) ? -1 : keyOf(a.name) > keyOf(b.name) ? 1 : 0));
      for (const { p, name } of seated) {
        const id = await upsertPlayerId(c, name, at);
        ids[keyOf(name)] = id;
        await c.query(`INSERT INTO stammtisch_members AS m (stammtisch_id, player_id, player_name, games_played, games_won, points,
            joined_at, last_seen_at, updated_at) VALUES ($1, $2, $3, 1, $4, $5, $6, $6, $6)
          ON CONFLICT (stammtisch_id, player_id) DO UPDATE SET player_name = EXCLUDED.player_name,
            games_played = m.games_played + 1, games_won = m.games_won + EXCLUDED.games_won, points = m.points + EXCLUDED.points,
            last_seen_at = EXCLUDED.last_seen_at, updated_at = EXCLUDED.updated_at`,
        [t.id, id, name, winner && winner.id === p.id ? 1 : 0, Math.round(totals[p.id] || 0), at]);
      }

      // A finished series stays visible until the NEXT solo game starts a new one.
      const series = { ...t.series };
      let seriesEvent = null;
      if (!teams) {
        if (series.winner) {
          Object.assign(series, { no: series.no + 1, games: 0, winner: null, finishedAt: null });
          await c.query('DELETE FROM stammtisch_series_wins WHERE stammtisch_id = $1', [t.id]);
        }
        series.games += 1;
        const winnerName = winner ? cleanName(winner.name, 16) : '';
        if (winnerName && humans.length >= 2) {
          const { rows } = await c.query(`INSERT INTO stammtisch_series_wins AS w (stammtisch_id, player_id, wins, updated_at)
            VALUES ($1, $2, 1, $3) ON CONFLICT (stammtisch_id, player_id) DO UPDATE SET wins = w.wins + 1, updated_at = EXCLUDED.updated_at
            RETURNING wins`, [t.id, ids[keyOf(winnerName)], at]);
          if (rows[0].wins >= SERIES_NEEDED) {
            series.winner = winnerName;
            series.finishedAt = now;
            seriesEvent = { type: 'won', winner: winnerName, no: series.no };
          }
        }
      }

      // Group goals: the pure rules of StammtischGoals on the stored weeks, written back.
      const goals = { xp: t.goals.xp, weeks: { ...t.goals.weeks }, weeksReached: t.goals.weeksReached };
      const goalEvents = bookGame({ goals }, humans.length, now);
      const weeks = Object.entries(goals.weeks);
      await c.query(`INSERT INTO stammtisch_weeks AS k (stammtisch_id, week_start_day, games_played, updated_at)
        SELECT $1, u.week, u.games, $4 FROM unnest($2::date[], $3::int[]) AS u(week, games)
        ON CONFLICT (stammtisch_id, week_start_day) DO UPDATE SET games_played = EXCLUDED.games_played, updated_at = EXCLUDED.updated_at
        WHERE k.games_played IS DISTINCT FROM EXCLUDED.games_played`, [t.id, weeks.map((w) => w[0]), weeks.map((w) => w[1]), at]);
      await c.query('DELETE FROM stammtisch_weeks WHERE stammtisch_id = $1 AND NOT (week_start_day = ANY($2::date[]))', [t.id, weeks.map((w) => w[0])]);

      const gameNo = (t.games.length ? t.games[t.games.length - 1].no : 0) + 1;
      // A team match keeps the running series' number but never counts in it.
      const teamName = (i) => (teams && cleanName((gameRecord.teamNames || [])[i], 16)) || null;
      await c.query(`INSERT INTO stammtisch_games (stammtisch_id, game_no, series_no, finished_at, team_mode, team_a_name, team_b_name)
        VALUES ($1, $2, $3, $4, $5, $6, $7)`, [t.id, gameNo, series.no, new Date(gameRecord.finishedAt || now), !!teams, teamName(0), teamName(1)]);
      const seats = (gameRecord.players || []).map((p) => {
        const name = p.isBot ? String(p.name || 'Bot') : cleanName(p.name, 16);
        const team = teams ? Teams.teamIndexOf(teams, p.id) : -1;
        return [p.isBot ? null : ids[keyOf(name)] || null, name, !!p.isBot, Math.round(totals[p.id] || 0), winnerIds.includes(p.id),
          team >= 0 ? team : null, p.isBot && BOT_LEVELS.includes(p.botDifficulty) ? p.botDifficulty : null];
      });
      await c.query(`INSERT INTO stammtisch_game_seats (stammtisch_id, game_no, seat_no, player_id, player_name, is_bot, score, won, team_no,
          bot_difficulty)
        SELECT $1, $2, u.ord - 1, u.player_id, u.player_name, u.is_bot, u.score, u.won, u.team_no, u.bot_difficulty
        FROM unnest($3::bigint[], $4::text[], $5::boolean[], $6::int[], $7::boolean[], $8::smallint[], $9::text[])
          WITH ORDINALITY AS u(player_id, player_name, is_bot, score, won, team_no, bot_difficulty, ord)`,
      [t.id, gameNo, ...[0, 1, 2, 3, 4, 5, 6].map((i) => seats.map((s) => s[i]))]);
      await c.query('DELETE FROM stammtisch_games WHERE stammtisch_id = $1 AND game_no <= $2', [t.id, gameNo - MAX_GAMES_PER_TABLE]);
      await c.query(`UPDATE stammtische SET last_used_at = $2, updated_at = $2, series_no = $3, series_games = $4,
          series_winner_name = $5, series_finished_at = $6, goal_xp = $7, goal_weeks_reached = $8 WHERE id = $1`,
      [t.id, at, series.no, series.games, series.winner, series.finishedAt == null ? null : new Date(series.finishedAt),
        goals.xp, goals.weeksReached]);
      return { summary: summarize(await readTable(c, code), now), seriesEvent, goalEvents };
    });
  }

  /** The account's tables: founded or played at, newest activity first. */
  async function listFor(accountName) {
    const key = keyOf(accountName);
    if (!key) return [];
    const { rows } = await query(`WITH me AS (SELECT id FROM players WHERE player_key = $1)
      SELECT s.stammtisch_code, s.stammtisch_name, floor(extract(epoch FROM s.last_used_at) * 1000)::bigint AS last_used_ms,
        ARRAY(SELECT m.player_name FROM stammtisch_members m WHERE m.stammtisch_id = s.id ORDER BY m.joined_at, m.player_id) AS members,
        (SELECT count(*)::int FROM stammtisch_games g WHERE g.stammtisch_id = s.id) AS games_played,
        COALESCE(s.owner_player_id, (SELECT m.player_id FROM stammtisch_members m WHERE m.stammtisch_id = s.id
          ORDER BY m.joined_at, m.player_id LIMIT 1)) = (SELECT id FROM me) AS is_owner
      FROM stammtische s
      WHERE s.owner_player_id = (SELECT id FROM me)
         OR EXISTS (SELECT 1 FROM stammtisch_members m WHERE m.stammtisch_id = s.id AND m.player_id = (SELECT id FROM me))
      ORDER BY s.last_used_at DESC, s.id DESC`, [key]);
    return rows.map((r) => ({
      code: r.stammtisch_code, name: r.stammtisch_name, members: r.members, lastActivity: Number(r.last_used_ms),
      gamesPlayed: r.games_played, isOwner: !!r.is_owner,
    }));
  }

  /** The owner of a code's table (key) and its id, locked for the change; null when unknown. */
  async function lockTable(c, code) {
    const { rows } = await c.query(`SELECT s.id, s.stammtisch_code, COALESCE(o.player_key, (SELECT p.player_key FROM stammtisch_members m
        JOIN players p ON p.id = m.player_id WHERE m.stammtisch_id = s.id ORDER BY m.joined_at, m.player_id LIMIT 1)) AS owner_key
      FROM stammtische s LEFT JOIN players o ON o.id = s.owner_player_id WHERE s.stammtisch_code = $1 FOR UPDATE OF s`, [code]);
    return rows[0] || null;
  }

  /** Owner only: the table, its record and series are gone for everyone. */
  async function remove(rawCode, accountName) {
    const code = normalizeCode(rawCode);
    await ready();
    return inTransaction(pool, async (c) => {
      const t = code ? await lockTable(c, code) : null;
      if (!t) return { error: 'Diesen Stammtisch gibt es nicht (mehr).' };
      if (t.owner_key !== keyOf(accountName)) return { error: 'Nur wer den Stammtisch gegründet hat, kann ihn löschen.' };
      await c.query('DELETE FROM stammtische WHERE id = $1', [t.id]);
      return { ok: true, code: t.stammtisch_code };
    });
  }

  /** A member drops off the list (games already played stay in the record). */
  async function leave(rawCode, accountName) {
    const code = normalizeCode(rawCode);
    const key = keyOf(accountName);
    await ready();
    return inTransaction(pool, async (c) => {
      const t = code && key ? await lockTable(c, code) : null;
      const member = t ? (await c.query(`SELECT m.player_id FROM stammtisch_members m JOIN players p ON p.id = m.player_id
        WHERE m.stammtisch_id = $1 AND p.player_key = $2`, [t.id, key])).rows[0] : null;
      if (!member) return { error: 'Du bist an diesem Stammtisch nicht eingetragen.' };
      if (t.owner_key === key) return { error: 'Als Gründer kannst du den Stammtisch nur löschen, nicht verlassen.' };
      await c.query('DELETE FROM stammtisch_members WHERE stammtisch_id = $1 AND player_id = $2', [t.id, member.player_id]);
      return { ok: true, code: t.stammtisch_code };
    });
  }

  /** Name of the human who won the table's latest match (a team match: the winning
   *  team's top scorer, like a rematch's dealer), or null. */
  async function lastWinner(rawCode) {
    const code = normalizeCode(rawCode);
    if (!code) return null;
    const { rows } = await query(`SELECT x.player_name FROM stammtische s
      JOIN LATERAL (SELECT g.game_no FROM stammtisch_games g WHERE g.stammtisch_id = s.id ORDER BY g.game_no DESC LIMIT 1) last ON TRUE
      JOIN stammtisch_game_seats x ON x.stammtisch_id = s.id AND x.game_no = last.game_no AND x.won AND NOT x.is_bot
      WHERE s.stammtisch_code = $1 ORDER BY x.score DESC, x.seat_no LIMIT 1`, [code]);
    return rows[0] ? rows[0].player_name : null;
  }

  async function summary(rawCode, now = Date.now()) {
    const code = normalizeCode(rawCode);
    if (!code) return null;
    await ready();
    const t = await readTable(pool, code);
    return t ? summarize(t, now) : null;
  }

  /** Start-screen chip and its sheet: the record and the newest matches by day,
   *  without the activity data (members' last visit, points, times of day). */
  async function chipInfo(rawCode, now = Date.now()) {
    const s = await summary(rawCode, now);
    if (!s) return null;
    return {
      code: s.code,
      name: s.name,
      gamesPlayed: s.gamesPlayed,
      teamGames: s.teamGames,
      series: s.series,
      goals: s.goals,
      pairwise: s.pairwise,
      members: s.members.map((m) => ({ name: m.name, wins: m.wins, games: m.games, avg: m.avg })),
      today: s.today,
      recent: s.recent.slice(0, SHEET_GAMES).map(({ at, seriesNo, ...g }) => g),
    };
  }

  return { ready, create, get, touch, recordGame, lastWinner, summary, chipInfo, listFor, remove, leave, SERIES_BEST_OF };
}

module.exports = { createStammtischStore, importLegacyFile, legacyRows, normalizeCode, generateCode, DEFAULT_DATA_FILE, SERIES_BEST_OF };

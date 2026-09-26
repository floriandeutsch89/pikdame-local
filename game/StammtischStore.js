// game/StammtischStore.js
// The "Stammtisch": a table that outlives a single evening. One code for the
// group, forever; a head-to-head record over every match played under it;
// and a rematch series (best of 3) that gives "Revanche!" a scoreboard.
//
// Scoped by its code - only people who hold it see the names in it - so it
// stays available on a public server, unlike the server-wide profiles.
// Storage is the same atomic JSON file pattern as the other stores.

const path = require('path');
const crypto = require('crypto');
const { createAtomicJsonFile } = require('./AtomicJsonFile');

const DEFAULT_DATA_FILE = path.join(process.env.PIKDAME_DATA_DIR || path.join(__dirname, '..', 'data'), 'stammtisch.json');

// Codes share the session alphabet (no O/0, I/1/L) but start with a letter
// pair that a random session code is unlikely to produce - a Stammtisch code
// is typed for years, it should be easy to say out loud.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTWXYZ23456789';
const CODE_LENGTH = 6;
const MAX_TABLES = 300;
const MAX_GAMES_PER_TABLE = 100;
const INACTIVE_DAYS = 180;
const SERIES_BEST_OF = 3;

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

function newSeries(no) {
  return { no, bestOf: SERIES_BEST_OF, wins: {}, games: 0, winner: null, finishedAt: null };
}

function createStammtischStore(filePath = DEFAULT_DATA_FILE) {
  const file = createAtomicJsonFile(filePath);

  function load() {
    const parsed = file.read();
    return parsed && parsed.tables && typeof parsed.tables === 'object' ? parsed : { tables: {} };
  }

  function prune(store, now) {
    const cutoff = now - INACTIVE_DAYS * 86400000;
    for (const [code, t] of Object.entries(store.tables)) {
      if ((t.lastActivity || t.createdAt || 0) < cutoff) delete store.tables[code];
    }
    const codes = Object.keys(store.tables);
    if (codes.length > MAX_TABLES) {
      codes.sort((a, b) => (store.tables[a].lastActivity || 0) - (store.tables[b].lastActivity || 0));
      for (const code of codes.slice(0, codes.length - MAX_TABLES)) delete store.tables[code];
    }
  }

  /** @returns {{table}|{error:string}} */
  function create(name, founderName, now = Date.now()) {
    const store = load();
    prune(store, now);
    const title = cleanName(name) || 'Stammtisch';
    let code;
    do { code = generateCode(); } while (store.tables[code]);
    const table = {
      code,
      name: title,
      createdAt: now,
      lastActivity: now,
      members: {},
      games: [],
      series: newSeries(1),
    };
    const founder = cleanName(founderName, 16);
    if (founder) table.members[keyOf(founder)] = { name: founder, games: 0, wins: 0, points: 0, lastSeen: now };
    store.tables[code] = table;
    file.write(store);
    return { table };
  }

  function get(rawCode) {
    const code = normalizeCode(rawCode);
    if (!code) return null;
    return load().tables[code] || null;
  }

  function touch(rawCode, memberName, now = Date.now()) {
    const store = load();
    const t = store.tables[normalizeCode(rawCode)];
    if (!t) return null;
    t.lastActivity = now;
    const name = cleanName(memberName, 16);
    if (name) {
      const m = t.members[keyOf(name)] || { name, games: 0, wins: 0, points: 0 };
      m.name = name;
      m.lastSeen = now;
      t.members[keyOf(name)] = m;
    }
    file.write(store);
    return t;
  }

  /**
   * Books a finished match: head-to-head counters, the game list and the
   * rematch series. Only HUMAN seats count - a bot never wins a series.
   * @param {Object} gameRecord GameManager.lastGameRecord
   * @returns {{summary:Object, seriesEvent:null|{type:'won',winner:string,no:number}}|null}
   */
  function recordGame(rawCode, gameRecord, now = Date.now()) {
    const store = load();
    const t = store.tables[normalizeCode(rawCode)];
    if (!t || !gameRecord) return null;
    const humans = (gameRecord.players || []).filter((p) => !p.isBot);
    const totals = gameRecord.finalTotals || {};
    const winner = humans.find((p) => p.id === gameRecord.winnerId) || null;
    for (const p of humans) {
      const name = cleanName(p.name, 16);
      if (!name) continue;
      const m = t.members[keyOf(name)] || { name, games: 0, wins: 0, points: 0 };
      m.name = name;
      m.games += 1;
      m.points += totals[p.id] || 0;
      if (winner && winner.id === p.id) m.wins += 1;
      m.lastSeen = now;
      t.members[keyOf(name)] = m;
    }
    let seriesEvent = null;
    if (!t.series) t.series = newSeries(1);
    // A finished series stays visible until the NEXT game starts a new one.
    if (t.series.winner) t.series = newSeries(t.series.no + 1);
    t.series.games += 1;
    if (winner && humans.length >= 2) {
      const k = keyOf(winner.name);
      t.series.wins[k] = (t.series.wins[k] || 0) + 1;
      if (t.series.wins[k] >= Math.ceil(SERIES_BEST_OF / 2 + 0.5)) {
        t.series.winner = cleanName(winner.name, 16);
        t.series.finishedAt = now;
        seriesEvent = { type: 'won', winner: t.series.winner, no: t.series.no };
      }
    }
    t.games.push({
      at: gameRecord.finishedAt || now,
      seriesNo: t.series.no,
      players: (gameRecord.players || []).map((p) => ({
        name: p.isBot ? p.name : cleanName(p.name, 16),
        isBot: !!p.isBot,
        score: totals[p.id] || 0,
        won: p.id === gameRecord.winnerId,
      })),
    });
    while (t.games.length > MAX_GAMES_PER_TABLE) t.games.shift();
    t.lastActivity = now;
    file.write(store);
    return { summary: summarize(t), seriesEvent };
  }

  /**
   * Everything the client shows: standings, the pairwise record and the
   * series. Pairwise = "in matches where both sat, who finished ahead".
   */
  function summarize(t) {
    const members = Object.values(t.members || {})
      .map((m) => ({ ...m, avg: m.games ? Math.round(m.points / m.games) : 0 }))
      .sort((a, b) => b.wins - a.wins || b.avg - a.avg || a.name.localeCompare(b.name));
    const pairwise = {};
    for (const g of t.games || []) {
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
    const series = t.series || newSeries(1);
    const needed = Math.ceil(SERIES_BEST_OF / 2 + 0.5);
    return {
      code: t.code,
      name: t.name,
      createdAt: t.createdAt,
      gamesPlayed: (t.games || []).length,
      members,
      pairwise,
      series: { ...series, needed },
      recent: (t.games || []).slice(-5).reverse(),
    };
  }

  function summary(rawCode) {
    const t = get(rawCode);
    return t ? summarize(t) : null;
  }

  return { create, get, touch, recordGame, summary, flushSync: file.flushSync, filePath, SERIES_BEST_OF };
}

module.exports = { createStammtischStore, normalizeCode, generateCode, DEFAULT_DATA_FILE, SERIES_BEST_OF };

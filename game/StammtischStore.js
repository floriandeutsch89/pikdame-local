// game/StammtischStore.js
// The "Stammtisch": a table that outlives a single evening. One code for the
// group, forever; a head-to-head record over every match played under it;
// and a rematch series (best of 3) that gives "Revanche!" a scoreboard.
//
// Scoped by its code - only people who hold it see the names in it - so it
// stays available on a public server, unlike the server-wide profiles.
// Storage is a document like the other stores: PostgreSQL (stammtischCodec) in the
// server, memory or an atomic JSON file in tests and scripts.

const path = require('path');
const crypto = require('crypto');
const { createAtomicJsonFile } = require('./AtomicJsonFile');

const DEFAULT_DATA_FILE = path.join(process.env.PIKDAME_DATA_DIR || path.join(__dirname, '..', 'data'), 'stammtisch.json');

// Codes share the session alphabet (no O/0, I/1/L) but start with a letter
// pair that a random session code is unlikely to produce - a Stammtisch code
// is typed for years, it should be easy to say out loud.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTWXYZ23456789';
const CODE_LENGTH = 6;
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

function createStammtischStore(backend = DEFAULT_DATA_FILE) {
  const file = typeof backend === 'string' ? createAtomicJsonFile(backend) : backend;

  function load() {
    const parsed = file.read();
    return parsed && parsed.tables && typeof parsed.tables === 'object' ? parsed : { tables: {} };
  }

  /** @param {string|null} ownerAccount account username; only it may delete
   *  @returns {{table}|{error:string}} */
  function create(name, founderName, now = Date.now(), ownerAccount = null) {
    const store = load();
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
      owner: ownerAccount ? keyOf(ownerAccount) : null,
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

  // Tables from before owners existed: the founder is the first member
  // (create() adds them first), and account names are protected.
  function ownerOf(t) {
    return t.owner || Object.keys(t.members || {})[0] || null;
  }

  /** The account's tables: founded or played at, newest activity first. */
  function listFor(accountName) {
    const key = keyOf(accountName);
    if (!key) return [];
    return Object.values(load().tables)
      .filter((t) => ownerOf(t) === key || (t.members && t.members[key]))
      .sort((a, b) => (b.lastActivity || 0) - (a.lastActivity || 0))
      .map((t) => ({
        code: t.code,
        name: t.name,
        members: Object.values(t.members || {}).map((m) => m.name),
        lastActivity: t.lastActivity || t.createdAt || 0,
        gamesPlayed: (t.games || []).length,
        isOwner: ownerOf(t) === key,
      }));
  }

  /** Owner only: the table, its record and series are gone for everyone. */
  function remove(rawCode, accountName) {
    const store = load();
    const code = normalizeCode(rawCode);
    const t = store.tables[code];
    if (!t) return { error: 'Diesen Stammtisch gibt es nicht (mehr).' };
    if (ownerOf(t) !== keyOf(accountName)) return { error: 'Nur wer den Stammtisch gegründet hat, kann ihn löschen.' };
    delete store.tables[code];
    file.write(store);
    return { ok: true, code };
  }

  /** A member drops off the list (games already played stay in the record). */
  function leave(rawCode, accountName) {
    const store = load();
    const t = store.tables[normalizeCode(rawCode)];
    const key = keyOf(accountName);
    if (!t || !t.members || !t.members[key]) return { error: 'Du bist an diesem Stammtisch nicht eingetragen.' };
    if (ownerOf(t) === key) return { error: 'Als Gründer kannst du den Stammtisch nur löschen, nicht verlassen.' };
    delete t.members[key];
    file.write(store);
    return { ok: true, code: t.code };
  }

  /** Name of the human who won the table's latest match, or null. */
  function lastWinner(rawCode) {
    const t = get(rawCode);
    const last = t && t.games && t.games[t.games.length - 1];
    const w = last && last.players.find((p) => p.won && !p.isBot);
    return w ? w.name : null;
  }

  function summary(rawCode) {
    const t = get(rawCode);
    return t ? summarize(t) : null;
  }

  return {
    create, get, touch, recordGame, lastWinner, summary, listFor, remove, leave, filePath: typeof backend === 'string' ? backend : null, SERIES_BEST_OF,
    flushSync: file.flushSync,
    flush: file.flush || (async () => {}),
    pendingStatements: file.pendingStatements || (() => []),
    status: file.status || (() => 'ok'),
  };
}

// --- Postgres codec: a table row, then one row per game (position = idx) -----
const { upsert, stableJson, num, json } = require('./SqlRows');

const TABLE_FIELDS = new Set(['code', 'name', 'owner', 'createdAt', 'lastActivity', 'members', 'games', 'series']);
const GAME_FIELDS = new Set(['at', 'seriesNo', 'players']);
const extraOf = (obj, known) => {
  const extra = {};
  for (const [k, v] of Object.entries(obj)) if (!known.has(k) && v !== undefined) extra[k] = v;
  return Object.keys(extra).length ? stableJson(extra) : null;
};
const intOrNull = (v) => (v === undefined || v === null ? null : Math.round(Number(v)));

const stammtischCodec = {
  name: 'stammtisch',
  table: 'stammtisch_tables',
  normalize(parsed) {
    return { tables: parsed && parsed.tables && typeof parsed.tables === 'object' ? parsed.tables : {} };
  },
  *rows(doc) {
    for (const [code, t] of Object.entries(doc.tables)) {
      yield [`t|${code}`, upsert('stammtisch_tables',
        ['code', 'name', 'owner', 'created_at', 'last_activity', 'members', 'series', 'extra'], ['code'],
        [code, t.name ?? null, t.owner ?? null, intOrNull(t.createdAt), intOrNull(t.lastActivity),
          stableJson(t.members || {}), stableJson(t.series), extraOf(t, TABLE_FIELDS)])];
      const games = t.games || [];
      for (let idx = 0; idx < games.length; idx++) {
        const g = games[idx];
        // Games are append-only (no cap any more), so the position is a stable key.
        yield [`g|${code}|${idx}`, upsert('stammtisch_games',
          ['code', 'idx', 'at', 'series_no', 'players', 'extra'], ['code', 'idx'],
          [code, idx, intOrNull(g.at), intOrNull(g.seriesNo), stableJson(g.players || []), extraOf(g, GAME_FIELDS)])];
      }
    }
  },
  deleteRow(key) {
    // A removed table takes its games along (ON DELETE CASCADE).
    return key.startsWith('t|') ? { text: 'DELETE FROM stammtisch_tables WHERE code = $1', values: [key.slice(2)] } : null;
  },
  async load(q) {
    const tables = {};
    for (const row of (await q.query('SELECT * FROM stammtisch_tables ORDER BY code')).rows) {
      const t = { code: row.code, name: row.name ?? undefined, createdAt: num(row.created_at), lastActivity: num(row.last_activity),
        members: row.members, games: [], series: json(row.series), owner: row.owner };
      for (const k of Object.keys(t)) if (t[k] === undefined) delete t[k];
      tables[row.code] = Object.assign(t, row.extra || {});
    }
    for (const row of (await q.query('SELECT * FROM stammtisch_games ORDER BY code, idx')).rows) {
      const g = { at: num(row.at), seriesNo: num(row.series_no), players: row.players };
      for (const k of Object.keys(g)) if (g[k] === undefined) delete g[k];
      if (tables[row.code]) tables[row.code].games.push(Object.assign(g, row.extra || {}));
    }
    return { tables };
  },
};

module.exports = { createStammtischStore, stammtischCodec, normalizeCode, generateCode, DEFAULT_DATA_FILE, SERIES_BEST_OF };

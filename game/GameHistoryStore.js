// game/GameHistoryStore.js
// Persistiert abgeschlossene PARTIEN (nicht nur Runden) als vollständige
// Runde-für-Runde-Aufzeichnung in einer JSON-Datei. Dient als Grundlage für
// den Spielverlauf-Export und spätere Auswertungen über mehrere Partien.

const path = require('path');
const { createAtomicJsonFile } = require('./AtomicJsonFile');

const DEFAULT_DATA_DIR = process.env.PIKDAME_DATA_DIR || path.join(__dirname, '..', 'data');
const DEFAULT_DATA_FILE = path.join(DEFAULT_DATA_DIR, 'games.json');
const MAX_STORED_GAMES = 200; // Sicherheitsnetz gegen unbegrenztes Wachstum

function genId() {
  return `game-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function createGameHistoryStore(backend = DEFAULT_DATA_FILE) {
  // File (tests) or memory (no database). Production uses createPgGameHistoryStore.
  const file = typeof backend === 'string' ? createAtomicJsonFile(backend) : backend;

  function loadAll() {
    const parsed = file.read();
    return parsed && Array.isArray(parsed.games) ? parsed.games : [];
  }

  function saveAll(games) {
    file.write({ games });
  }

  /**
   * @param {Object} record { players, rounds, finalTotals, winnerId, houseRules, finishedAt }
   * @returns {Object} der gespeicherte Datensatz inkl. generierter id
   */
  function saveGame(record) {
    const games = loadAll();
    const stored = { id: genId(), ...record };
    games.push(stored);
    while (games.length > MAX_STORED_GAMES) games.shift();
    saveAll(games);
    return stored;
  }

  function listGames() {
    return loadAll();
  }

  function getGame(id) {
    return loadAll().find((g) => g.id === id) || null;
  }

  return {
    flushSync: file.flushSync, filePath: typeof backend === 'string' ? backend : null, loadAll, saveGame, listGames, getGame,
    historyFor: async (name, limit = 20) => historyForPlayer(loadAll(), name, limit),
    flush: file.flush || (async () => {}),
    pendingStatements: file.pendingStatements || (() => []),
    status: file.status || (() => 'ok'),
  };
}

/**
 * Persönliche Spielhistorie für EINEN Spielernamen: die letzten beendeten
 * Partien, in denen er als echter Spieler (kein Bot) dabei war - neueste
 * zuerst, auf `limit` gekürzt und auf das für eine Übersichtsliste Nötige
 * reduziert (nicht die komplette Runde-für-Runde-Aufzeichnung).
 *
 * Als eigene, reine Funktion statt inline im WebSocket-Handler, damit sie
 * ohne einen laufenden Server geprüft werden kann.
 *
 * @param {Array} allGames  Rückgabe von listGames()
 * @param {string} name     Spielername (Groß-/Kleinschreibung egal)
 * @param {number} limit
 */
function historyForPlayer(allGames, name, limit = 20) {
  const nameLower = String(name || '').trim().toLowerCase();
  if (!nameLower) return [];
  return allGames
    .filter((g) => (g.players || []).some((p) => !p.isBot && (p.name || '').toLowerCase() === nameLower))
    .sort((a, b) => (b.finishedAt || 0) - (a.finishedAt || 0))
    .slice(0, limit)
    .map((g) => {
      const me = (g.players || []).find((p) => !p.isBot && (p.name || '').toLowerCase() === nameLower);
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
        players: (g.players || []).map((p) => ({ id: p.id, name: p.name, isBot: p.isBot, botDifficulty: p.botDifficulty })),
        finalTotals: g.finalTotals,
        winnerId: g.winnerId,
        won: !!(me && me.id === g.winnerId),
        myScore: me ? (g.finalTotals || {})[me.id] : undefined,
      };
    });
}

// --- Postgres: append-only queue, async reads ---------------------------------
const { upsert, stableJson } = require('./SqlRows');
const { createWriteBehind } = require('./WriteBehind');

/** Insert statements for one stored game: the record, then one row per seat. */
function gameStatements(stored) {
  const out = [upsert('game_records', ['id', 'finished_at', 'record'], ['id'],
    [stored.id, stored.finishedAt == null ? null : Math.round(Number(stored.finishedAt)), stableJson(stored)])];
  (stored.players || []).forEach((p, seat) => {
    out.push(upsert('game_record_players', ['game_id', 'seat', 'name_key', 'is_bot'], ['game_id', 'seat'],
      [stored.id, seat, String((p && p.name) || '').toLowerCase(), !!(p && p.isBot)]));
  });
  return out;
}

function createPgGameHistoryStore(pool, { flushDelayMs = 800, backoffMs, log = console } = {}) {
  const queue = []; // { record, statements } not yet in the database
  const wb = createWriteBehind({
    pool, name: 'game_records', flushDelayMs, backoffMs, log,
    collect: () => ({ statements: queue.flatMap((g) => g.statements), token: queue.length }),
    commit: (n) => { queue.splice(0, n); },
  });

  function saveGame(record) {
    const stored = { id: genId(), ...record };
    queue.push({ record: stored, statements: gameStatements(stored) });
    wb.markDirty();
    return stored;
  }

  async function historyFor(name, limit = 20) {
    const key = String(name || '').trim().toLowerCase();
    if (!key) return [];
    await wb.flush().catch(() => {}); // DB down: still answer with what is queued
    let rows = [];
    try {
      rows = (await pool.query(
        `SELECT r.record FROM game_records r
         WHERE EXISTS (SELECT 1 FROM game_record_players p WHERE p.game_id = r.id AND p.name_key = $1 AND NOT p.is_bot)
         ORDER BY r.finished_at DESC NULLS LAST LIMIT $2`, [key, limit])).rows;
    } catch (e) {
      log.error(`[stats] game history read failed: ${e.message}`);
    }
    const byId = new Map(rows.map((r) => [r.record.id, r.record]));
    for (const g of queue) byId.set(g.record.id, g.record);
    return historyForPlayer([...byId.values()], name, limit);
  }

  return {
    saveGame,
    historyFor,
    flush: wb.flush,
    flushSync() { wb.flush().catch(() => {}); },
    pendingStatements: () => queue.flatMap((g) => g.statements),
    status: wb.status,
  };
}

// Import only (games.json -> Postgres) and its verification.
const gameHistoryCodec = {
  name: 'game_records',
  table: 'game_records',
  normalize: (parsed) => ({ games: parsed && Array.isArray(parsed.games) ? parsed.games.filter((g) => g && g.id) : [] }),
  *rows(doc) {
    const seen = new Set();
    for (const g of doc.games) {
      if (seen.has(g.id)) continue;
      seen.add(g.id);
      const [rec, ...seats] = gameStatements(g);
      yield [`r|${g.id}`, rec];
      for (let i = 0; i < seats.length; i++) yield [`p|${g.id}|${i}`, seats[i]];
    }
  },
  async load(q) {
    const r = await q.query('SELECT record FROM game_records ORDER BY finished_at NULLS FIRST, id');
    return { games: r.rows.map((x) => x.record) };
  },
};

module.exports = { createGameHistoryStore, createPgGameHistoryStore, gameHistoryCodec, gameStatements, historyForPlayer, DEFAULT_DATA_FILE };

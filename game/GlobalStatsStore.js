// game/GlobalStatsStore.js
// Globale, ANONYME Statistiken über alle Partien auf diesem Server -
// aggregierte Zähler ohne Personenbezug (daher auch im öffentlichen Modus
// unbedenklich). Persistenz über dieselbe atomare, nicht-blockierende
// JSON-Datei wie die Spielerprofile.
const path = require('path');
const { createAtomicJsonFile } = require('./AtomicJsonFile');

const DEFAULT_STATS_FILE = path.join(process.env.PIKDAME_DATA_DIR || path.join(__dirname, '..', 'data'), 'stats.json');

const EMPTY = {
  games: 0, // abgeschlossene Partien
  rounds: 0, // gespielte Runden
  pikDamesLaidOut: 0, // Pik Damen sicher ausgelegt (+100)
  pikDamesCaught: 0, // Pik Damen am Rundenende auf der Hand erwischt (-100)
  handAusRounds: 0, // Runden, die mit "Hand aus" endeten
};

function createGlobalStatsStore(backend = DEFAULT_STATS_FILE) {
  const file = typeof backend === 'string' ? createAtomicJsonFile(backend) : backend;

  function getStats() {
    const raw = file.read();
    return { ...EMPTY, ...(raw || {}) };
  }

  /** Aggregiert eine abgeschlossene Partie (gameRecord aus dem GameManager). */
  function recordGame(gameRecord) {
    if (!gameRecord || !Array.isArray(gameRecord.rounds)) return;
    const s = getStats();
    s.games += 1;
    s.rounds += gameRecord.rounds.length;
    for (const round of gameRecord.rounds) {
      if (round.isHandAus) s.handAusRounds += 1;
      const results = round.results || {};
      for (const r of Object.values(results)) {
        const b = r && r.breakdown;
        if (!b) continue;
        s.pikDamesLaidOut += b.pikDameLaidOut || 0;
        s.pikDamesCaught += b.pikDameCount || 0;
      }
    }
    file.write(s);
  }

  return {
    getStats, recordGame, flushSync: file.flushSync,
    flush: file.flush || (async () => {}),
    pendingStatements: file.pendingStatements || (() => []),
    status: file.status || (() => 'ok'),
  };
}

// --- Postgres codec: one row ------------------------------------------------
const { upsert, num } = require('./SqlRows');

const globalStatsCodec = {
  name: 'global_stats',
  table: 'global_stats',
  normalize: (parsed) => (parsed && typeof parsed === 'object' ? { ...EMPTY, ...parsed } : undefined),
  *rows(doc) {
    const s = { ...EMPTY, ...doc };
    yield ['global', upsert('global_stats',
      ['id', 'games', 'rounds', 'pik_dames_laid_out', 'pik_dames_caught', 'hand_aus_rounds'], ['id'],
      [true, s.games, s.rounds, s.pikDamesLaidOut, s.pikDamesCaught, s.handAusRounds])];
  },
  async load(q) {
    const r = await q.query('SELECT * FROM global_stats WHERE id');
    if (r.rows.length === 0) return undefined;
    const row = r.rows[0];
    return {
      games: num(row.games), rounds: num(row.rounds), pikDamesLaidOut: num(row.pik_dames_laid_out),
      pikDamesCaught: num(row.pik_dames_caught), handAusRounds: num(row.hand_aus_rounds),
    };
  },
};

module.exports = { createGlobalStatsStore, globalStatsCodec };

// game/YearStatsStore.js
// Per-name, per-year counters for the December review (game/YearReview.js).
// Its own small file instead of the profiles: those are broadcast to every
// client, and opponent lists per year would bloat that message.
const path = require('path');
const { createAtomicJsonFile } = require('./AtomicJsonFile');
const { bumpYear, noteStreak, yearOf, strongestBot } = require('./YearReview');

const DEFAULT_DATA_DIR = process.env.PIKDAME_DATA_DIR || path.join(__dirname, '..', 'data');
const DEFAULT_DATA_FILE = path.join(DEFAULT_DATA_DIR, 'years.json');
const MAX_NAMES = 1000;

function createYearStatsStore(filePath = DEFAULT_DATA_FILE) {
  const file = createAtomicJsonFile(filePath);

  function load() {
    const d = file.read();
    if (d && d.players && typeof d.players === 'object') return d;
    return { since: null, players: {} };
  }

  function entryFor(d, name, date) {
    // `since`: the first day anything was counted - the review flags years
    // that started before it (see buildReview).
    if (!d.since) d.since = date;
    const key = String(name).trim().toLowerCase();
    const e = d.players[key] || { name: String(name).trim(), years: {} };
    e.name = String(name).trim();
    d.players[key] = e;
    return e;
  }

  /** Current and previous year only, and at most MAX_NAMES players. */
  function prune(d, year) {
    const keep = new Set([String(year), String(Number(year) - 1)]);
    for (const e of Object.values(d.players)) {
      for (const y of Object.keys(e.years)) if (!keep.has(y)) delete e.years[y];
    }
    const keys = Object.keys(d.players);
    if (keys.length > MAX_NAMES) {
      const games = (k) => ((d.players[k].years || {})[year] || {}).games || 0;
      keys.sort((a, b) => games(b) - games(a));
      for (const k of keys.slice(MAX_NAMES)) delete d.players[k];
    }
  }

  /** One finished game for one human seat (see YearReview.bumpYear). */
  function recordGame(name, date, game) {
    if (!name || !date) return;
    const d = load();
    const e = entryFor(d, name, date);
    const y = yearOf(date);
    e.years[y] = bumpYear(e.years[y], { ...game, date });
    prune(d, y);
    file.write(d);
  }

  function recordStreak(name, date, streak) {
    if (!name || !date) return;
    const d = load();
    const e = entryFor(d, name, date);
    const y = yearOf(date);
    e.years[y] = noteStreak(e.years[y], streak);
    file.write(d);
  }

  /**
   * A finished game for every human result (GameManager onGameOver): the other
   * humans are the opponents, the strongest bot sets the level. `table` is the
   * Stammtisch NAME - its code is a secret and never stored here.
   */
  function recordFinishedGame(results, players, date, { table = null, streaks = {} } = {}) {
    const humans = (players || []).filter((p) => !p.isBot);
    const botLevel = strongestBot(players);
    for (const r of results || []) {
      const opponents = humans.filter((p) => p.id !== r.id).map((p) => p.name);
      recordGame(r.name, date, { won: r.won, score: r.score, facts: r.facts, opponents, botLevel, table });
      const st = streaks[r.id];
      if (st && st.streak) recordStreak(r.name, date, st.streak);
    }
  }

  function yearFor(name, year) {
    const e = load().players[String(name || '').trim().toLowerCase()];
    return (e && e.years && e.years[String(year)]) || null;
  }

  function trackingSince() {
    return load().since || null;
  }

  return { filePath, flushSync: file.flushSync, recordGame, recordStreak, recordFinishedGame, yearFor, trackingSince };
}

module.exports = { createYearStatsStore, DEFAULT_DATA_FILE };

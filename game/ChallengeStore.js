// game/ChallengeStore.js
// Daily-challenge leaderboard: everyone plays the SAME seeded deck against
// the same medium bots; this store keeps each player's BEST score per day.
// Retention is deliberately short (7 days) - it is a daily race, not an
// archive - which also keeps the privacy footprint small (nickname + score).

const path = require('path');
const { createAtomicJsonFile } = require('./AtomicJsonFile');

const DEFAULT_DATA_FILE = path.join(process.env.PIKDAME_DATA_DIR || path.join(__dirname, '..', 'data'), 'challenges.json');
const KEEP_DAYS = 7;
const MAX_ENTRIES_PER_DAY = 100;

/** Stable numeric seed from a YYYY-MM-DD string (djb2). */
function seedForDate(dateStr) {
  let h = 5381;
  for (let i = 0; i < dateStr.length; i++) h = ((h << 5) + h + dateStr.charCodeAt(i)) >>> 0;
  return h >>> 0;
}

/** Today's challenge date in UTC - one deck for the whole planet. */
function todayUTC(now = Date.now()) {
  return new Date(now).toISOString().slice(0, 10);
}

function createChallengeStore(filePath = DEFAULT_DATA_FILE) {
  const file = createAtomicJsonFile(filePath);

  function load() {
    const parsed = file.read();
    return parsed && typeof parsed.days === 'object' ? parsed : { days: {} };
  }

  function cleanup(store, now = Date.now()) {
    const cutoff = todayUTC(now - KEEP_DAYS * 24 * 3600 * 1000);
    for (const day of Object.keys(store.days)) {
      if (day < cutoff) delete store.days[day];
    }
  }

  /** Records a result; keeps only the best score per (day, name). */
  function submit(date, name, score, now = Date.now()) {
    const cleanName = String(name || '').trim().slice(0, 24) || 'Spieler';
    const store = load();
    cleanup(store, now);
    const list = store.days[date] || [];
    const existing = list.find((e) => e.name.toLowerCase() === cleanName.toLowerCase());
    if (existing) {
      if (score > existing.score) {
        existing.score = score;
        existing.at = now;
      }
    } else {
      list.push({ name: cleanName, score, at: now });
    }
    list.sort((a, b) => b.score - a.score || a.at - b.at);
    store.days[date] = list.slice(0, MAX_ENTRIES_PER_DAY);
    file.write(store);
    return getBoard(date, 10, store);
  }

  function getBoard(date, top = 10, preloaded = null) {
    const store = preloaded || load();
    return (store.days[date] || []).slice(0, top).map((e, i) => ({ rank: i + 1, name: e.name, score: e.score }));
  }

  function rankOf(date, name) {
    const store = load();
    const list = store.days[date] || [];
    const idx = list.findIndex((e) => e.name.toLowerCase() === String(name || '').toLowerCase());
    return idx === -1 ? null : idx + 1;
  }

  return { submit, getBoard, rankOf };
}

module.exports = { createChallengeStore, seedForDate, todayUTC, DEFAULT_DATA_FILE };

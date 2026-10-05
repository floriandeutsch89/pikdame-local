// game/ChallengeStore.js
// Daily-challenge leaderboard: everyone plays the SAME seeded deck against
// the same medium bots; this store keeps each player's BEST score per day.
// Retention is deliberately short (14 days: the board shows 7, the own trend
// graph 14) - a daily race, not an archive; only nickname + score are kept.

const path = require('path');
const { createAtomicJsonFile } = require('./AtomicJsonFile');
const { gameDay, addDays, weekdayIndex } = require('./GameDay');

const DEFAULT_DATA_FILE = path.join(process.env.PIKDAME_DATA_DIR || path.join(__dirname, '..', 'data'), 'challenges.json');
const KEEP_DAYS = 14;
const BOARD_DAYS = 7;
const MAX_ENTRIES_PER_DAY = 100;

/** Stable numeric seed from a YYYY-MM-DD string (djb2). */
function seedForDate(dateStr) {
  let h = 5381;
  for (let i = 0; i < dateStr.length; i++) h = ((h << 5) + h + dateStr.charCodeAt(i)) >>> 0;
  return h >>> 0;
}

/** Today's challenge date (German midnight, see GameDay) - one deck for everyone. */
const todayDate = gameDay;

function createChallengeStore(filePath = DEFAULT_DATA_FILE) {
  const file = createAtomicJsonFile(filePath);

  function load() {
    const parsed = file.read();
    return parsed && typeof parsed.days === 'object' ? parsed : { days: {} };
  }

  function cleanup(store, now = Date.now()) {
    const cutoff = addDays(gameDay(now), -KEEP_DAYS);
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

  /**
   * The last BOARD_DAYS days at a glance (today first): per day the top
   * entries plus - if a name is given - that player's own score and rank.
   * This is what makes '7 Tage sichtbar' actually TRUE in the UI: before,
   * only the current day was ever shown and yesterday silently vanished
   * from view although the data was still there.
   */
  function getHistory(name = null, top = 3, now = Date.now()) {
    const store = load();
    const days = [];
    const today = gameDay(now);
    for (let i = 0; i < BOARD_DAYS; i++) {
      const date = addDays(today, -i);
      const list = store.days[date] || [];
      if (list.length === 0 && i > 0) continue; // leere Vortage nicht auflisten
      const me = name
        ? list.findIndex((e) => e.name.toLowerCase() === String(name).toLowerCase())
        : -1;
      days.push({
        date,
        top: list.slice(0, top).map((e, idx) => ({ rank: idx + 1, name: e.name, score: e.score })),
        yourScore: me === -1 ? null : list[me].score,
        yourRank: me === -1 ? null : me + 1,
        players: list.length,
      });
    }
    return days;
  }

  /**
   * Weekly ranking (Mon-Sun, game days): per player the SUM of their best 5 daily
   * scores of the current week. 'Best 5 of 7' keeps one or two missed days
   * from ruining the week and rewards regulars over one lucky spike.
   */
  function getWeekly(name = null, top = 5, now = Date.now()) {
    const store = load();
    const today = gameDay(now);
    const dow = weekdayIndex(today); // Mo=0 .. So=6
    const monday = addDays(today, -dow);
    const perPlayer = new Map();
    for (let i = 0; i <= dow; i++) {
      const date = addDays(monday, i);
      for (const e of store.days[date] || []) {
        const key = e.name.toLowerCase();
        if (!perPlayer.has(key)) perPlayer.set(key, { name: e.name, scores: [] });
        perPlayer.get(key).scores.push(e.score);
      }
    }
    const board = [...perPlayer.values()]
      .map((p) => {
        const best5 = p.scores.sort((a, b) => b - a).slice(0, 5);
        return { name: p.name, weekScore: best5.reduce((a, b) => a + b, 0), days: p.scores.length };
      })
      .sort((a, b) => b.weekScore - a.weekScore);
    const meIdx = name ? board.findIndex((e) => e.name.toLowerCase() === String(name).toLowerCase()) : -1;
    return {
      week: `${monday}..${today}`,
      top: board.slice(0, top).map((e, i) => ({ rank: i + 1, ...e })),
      yourRank: meIdx === -1 ? null : meIdx + 1,
      yourScore: meIdx === -1 ? null : board[meIdx].weekScore,
      players: board.length,
    };
  }

  /**
   * One player's own results for the trend graph, oldest day first; days
   * without a result carry score/rank null (a gap, not a zero).
   */
  function getTrend(name, days = KEEP_DAYS, now = Date.now()) {
    const store = load();
    const key = String(name || '').trim().toLowerCase();
    const today = gameDay(now);
    const out = [];
    for (let i = Math.min(days, KEEP_DAYS) - 1; i >= 0; i--) {
      const date = addDays(today, -i);
      const list = store.days[date] || [];
      const idx = key ? list.findIndex((e) => e.name.toLowerCase() === key) : -1;
      out.push({ date, score: idx === -1 ? null : list[idx].score, rank: idx === -1 ? null : idx + 1, players: list.length });
    }
    return out;
  }

  return { submit, getBoard, rankOf, getHistory, getWeekly, getTrend };
}

module.exports = { createChallengeStore, seedForDate, todayDate, DEFAULT_DATA_FILE };

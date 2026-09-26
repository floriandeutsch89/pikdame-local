// game/Progression.js
// Cross-game progression: experience/levels, the seasonal ladder and the
// daily quests. Deliberately a set of PURE functions over a finished
// gameRecord - no store access, no I/O, no clock reads except where a date
// is passed in. Persistence lives in PlayerStore (local profiles) and
// AccountStore/PgAccountStore (account-bound, survives the device).
//
// Display names live in the CLIENT (bilingual via L()); this module only
// deals in stable ids and numbers - exactly like Badges.js.

// --- Experience ------------------------------------------------------------
// A finished match is worth participating in even when it is lost, so every
// completed game pays a base amount; the winner gets a real bonus and the
// final score adds a slope. Losing a match can never cost XP (a negative
// final total is common and would otherwise feel like a punishment for
// having played at all).
const XP_BASE = 10;
const XP_WIN = 50;
const XP_PER_POINT = 1 / 10;

function xpForGame(gameRecord, playerId) {
  if (!gameRecord) return 0;
  const won = gameRecord.winnerId === playerId;
  const score = ((gameRecord.finalTotals || {})[playerId]) || 0;
  return XP_BASE + (won ? XP_WIN : 0) + Math.max(0, Math.round(score * XP_PER_POINT));
}

// Level curve: each level costs a bit more than the previous one, so the
// early levels arrive quickly (a family player who finishes two games sees
// progress) and later ones stay meaningful.
function xpForLevel(level) {
  return 100 + (level - 1) * 50;
}

/** @returns {{level:number, into:number, need:number, total:number}} */
function levelFromXp(totalXp) {
  let xp = Math.max(0, Math.floor(Number(totalXp) || 0));
  let level = 1;
  // Bounded: level 200 needs ~1.1M XP, far beyond any real profile - the cap
  // only exists so a corrupted value can never spin here forever.
  while (level < 200 && xp >= xpForLevel(level)) {
    xp -= xpForLevel(level);
    level += 1;
  }
  return { level, into: xp, need: xpForLevel(level), total: Math.max(0, Math.floor(Number(totalXp) || 0)) };
}

// --- Seasons ---------------------------------------------------------------
// One calendar month per season, derived from the UTC date string the rest
// of the app already uses ("YYYY-MM-DD"). A season reset gives late starters
// a reachable ladder instead of an all-time list nobody can catch up with.
function seasonForDate(dateStr) {
  const s = String(dateStr || '');
  return /^\d{4}-\d{2}/.test(s) ? s.slice(0, 7) : '1970-01';
}

// --- Daily quests ----------------------------------------------------------
// Every quest counts something that is derivable from the finished
// gameRecord alone - no extra hooks in the game loop, nothing to keep in
// sync with the engine. `count` returns how much progress ONE finished game
// contributes; `need` is the daily target.
const QUEST_DEFS = [
  {
    id: 'finish_game',
    need: 1,
    count: () => 1,
  },
  {
    id: 'win_game',
    need: 1,
    count: (rec, pid) => (rec.winnerId === pid ? 1 : 0),
  },
  {
    id: 'win_rounds_3',
    need: 3,
    count: (rec, pid) => (rec.rounds || []).filter((r) => r.winnerId === pid).length,
  },
  {
    id: 'meld_queen',
    need: 1,
    count: (rec, pid) => sumBreakdown(rec, pid, 'pikDameLaidOut'),
  },
  {
    id: 'meld_jokers_3',
    need: 3,
    count: (rec, pid) => sumBreakdown(rec, pid, 'jokersLaidOut'),
  },
  {
    id: 'round_150',
    need: 1,
    count: (rec, pid) =>
      (rec.rounds || []).filter((r) => ((r.results || {})[pid] || {}).roundScore >= 150).length,
  },
  {
    id: 'clean_hands',
    need: 1,
    // A whole match without ever being caught with a Queen of Spades.
    count: (rec, pid) => (sumBreakdown(rec, pid, 'pikDameCount') === 0 ? 1 : 0),
  },
  {
    id: 'hand_aus',
    need: 1,
    count: (rec, pid) => (rec.rounds || []).filter((r) => r.isHandAus && r.winnerId === pid).length,
  },
  {
    id: 'score_400',
    need: 1,
    count: (rec, pid) => (((rec.finalTotals || {})[pid]) || 0) >= 400 ? 1 : 0,
  },
  {
    id: 'beat_zen',
    need: 1,
    count: (rec, pid) =>
      rec.winnerId === pid && (rec.players || []).some((p) => p.isBot && p.botDifficulty === 'zen')
        ? 1
        : 0,
  },
];

const QUEST_IDS = QUEST_DEFS.map((q) => q.id);
const QUESTS_PER_DAY = 3;

function sumBreakdown(rec, pid, field) {
  let n = 0;
  for (const round of rec.rounds || []) {
    const b = ((round.results || {})[pid] || {}).breakdown;
    if (b) n += b[field] || 0;
  }
  return n;
}

// Same trick as the daily challenge deck: seeded from the UTC date, so every
// player in the world works on the identical three tasks and they can be
// talked about ("hast du die Joker-Aufgabe schon?").
function hashString(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** @returns {string[]} the QUESTS_PER_DAY quest ids for a "YYYY-MM-DD" date */
function questsForDate(dateStr) {
  const pool = QUEST_IDS.slice();
  const picked = [];
  let h = hashString(`pikdame-quests-${dateStr}`);
  for (let i = 0; i < QUESTS_PER_DAY && pool.length > 0; i++) {
    h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
    picked.push(pool.splice(h % pool.length, 1)[0]);
  }
  return picked;
}

function questDef(id) {
  return QUEST_DEFS.find((q) => q.id === id) || null;
}

/**
 * How much each of today's quests advanced through this one finished game.
 * @returns {Object<string, number>} only ids with a positive delta
 */
function evaluateQuests(gameRecord, playerId, questIds = []) {
  const out = {};
  if (!gameRecord) return out;
  for (const id of questIds) {
    const def = questDef(id);
    if (!def) continue;
    let n = 0;
    try {
      n = def.count(gameRecord, playerId) || 0;
    } catch (e) {
      n = 0; // a malformed record must never break the game-over path
    }
    if (n > 0) out[id] = n;
  }
  return out;
}

// --- Badge progress --------------------------------------------------------
// The trophy cabinet shows locked badges with "how far am I" wherever that
// question has a number. Badges that either happen or do not (a comeback, a
// double queen round) have no counter and simply stay locked.
function badgeProgress(profile = {}) {
  const p = profile || {};
  const out = {
    pd_triple: { have: Math.min(p.totalQueensLaid || 0, 3), need: 3 },
    pd_caught: { have: Math.min(p.totalQueensCaught || 0, 1), need: 1 },
    score_500: { have: Math.min(p.bestGameScore || 0, 500), need: 500 },
    round_300: { have: Math.min(p.bestRoundScore || 0, 300), need: 300 },
  };
  // Every tier of every counter family, from the same profile field.
  const { BADGE_FAMILIES } = require('./Badges');
  for (const fam of BADGE_FAMILIES) {
    for (const [id, need] of fam.tiers) out[id] = { have: Math.min(p[fam.field] || 0, need), need };
  }
  return out;
}

// --- Daily streak ------------------------------------------------------------
// "Played today" - any finished match counts (a quest day, a challenge, a
// family table). A streak is consecutive UTC days; ONE missed day per seven
// is bridged by a grace day ("Joker-Tag"), so a single evening off does not
// erase a month. Pure: takes the stored state and the date, returns the new
// state plus what happened, PlayerStore persists it.
const STREAK_GRACE_EVERY_DAYS = 7;

function dayDiff(fromDate, toDate) {
  const a = Date.parse(`${fromDate}T00:00:00Z`);
  const b = Date.parse(`${toDate}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((b - a) / 86400000);
}

/**
 * @param {{streak?:number,last?:string|null,graceAt?:string|null,best?:number}} state
 * @param {string} date "YYYY-MM-DD" (UTC)
 * @returns {{state:Object, event:'same'|'extended'|'bridged'|'started'|'reset'}}
 */
function advanceDailyStreak(state, date) {
  const s = { streak: 0, last: null, graceAt: null, best: 0, ...(state || {}) };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date))) return { state: s, event: 'same' };
  if (s.last === date) return { state: s, event: 'same' };
  const gap = s.last ? dayDiff(s.last, date) : null;
  let event;
  if (gap === 1) {
    s.streak += 1;
    event = 'extended';
  } else if (gap === 2 && (!s.graceAt || dayDiff(s.graceAt, date) >= STREAK_GRACE_EVERY_DAYS)) {
    s.streak += 1;
    s.graceAt = date;
    event = 'bridged';
  } else if (gap !== null && gap <= 0) {
    // Clock went backwards (or a date from a different device): keep the
    // streak, do not count the day twice.
    return { state: s, event: 'same' };
  } else {
    event = s.last ? 'reset' : 'started';
    s.streak = 1;
  }
  s.last = date;
  s.best = Math.max(s.best || 0, s.streak);
  return { state: s, event };
}

/** Is the grace day available on `date`? (for the UI: "Joker-Tag frei") */
function streakGraceAvailable(state, date) {
  const s = state || {};
  return !s.graceAt || (dayDiff(s.graceAt, date) || 0) >= STREAK_GRACE_EVERY_DAYS;
}

module.exports = {
  XP_BASE,
  XP_WIN,
  QUEST_IDS,
  QUESTS_PER_DAY,
  xpForGame,
  xpForLevel,
  levelFromXp,
  seasonForDate,
  questsForDate,
  questDef,
  evaluateQuests,
  badgeProgress,
  advanceDailyStreak,
  streakGraceAvailable,
  STREAK_GRACE_EVERY_DAYS,
};

// game/StammtischGoals.js
// Shared goals of a Stammtisch: points and a level from every finished match,
// and a weekly target. Pure functions on the table; StammtischStore persists.
// Numbers and curve: docs/_generated/progression.md ("Stammtisch goals").

const { gameDay, addDays, weekdayIndex } = require('./GameDay');

const XP_PER_GAME = 10;
const XP_PER_EXTRA_HUMAN = 5; // playing together is what a Stammtisch is for
const LEVEL_BASE = 50;
const LEVEL_STEP = 25;
const LEVEL_CAP = 200;
const WEEKLY_GOAL = 10;
const WEEKS_KEPT = 60;

function gameXp(humanCount) {
  const humans = Math.max(0, Math.floor(Number(humanCount) || 0));
  return humans ? XP_PER_GAME + (humans - 1) * XP_PER_EXTRA_HUMAN : 0;
}

function xpForLevel(level) {
  return LEVEL_BASE + (level - 1) * LEVEL_STEP;
}

/** @returns {{level:number, into:number, need:number}} */
function levelFromXp(totalXp) {
  let xp = Math.max(0, Math.floor(Number(totalXp) || 0));
  let level = 1;
  // Bounded so a corrupted value can never spin here.
  while (level < LEVEL_CAP && xp >= xpForLevel(level)) {
    xp -= xpForLevel(level);
    level += 1;
  }
  return { level, into: xp, need: xpForLevel(level) };
}

/** Monday of the game week (Mon-Sun, Europe/Berlin) that contains `date`. */
function weekOf(date) {
  return addDays(date, -weekdayIndex(date));
}

function trimWeeks(weeks) {
  const keys = Object.keys(weeks).sort();
  for (const k of keys.slice(0, Math.max(0, keys.length - WEEKS_KEPT))) delete weeks[k];
  return weeks;
}

/** Goals of a table from before this feature: rebuilt once from the kept
 *  match list (the newest 100 matches, so long-running tables start close). */
function migrate(t) {
  const goals = { xp: 0, weeks: {}, weeksReached: 0 };
  for (const g of t.games || []) {
    const humans = (g.players || []).filter((p) => !p.isBot).length;
    if (!humans) continue;
    goals.xp += gameXp(humans);
    const week = weekOf(gameDay(g.at || t.createdAt || 0));
    goals.weeks[week] = (goals.weeks[week] || 0) + 1;
  }
  goals.weeksReached = Object.values(goals.weeks).filter((n) => n >= WEEKLY_GOAL).length;
  trimWeeks(goals.weeks);
  return goals;
}

/** The table's goals, migrated on the fly; never writes. */
function goalsOf(t) {
  const g = t && t.goals;
  if (g && typeof g === 'object' && g.weeks && typeof g.weeks === 'object') return g;
  return migrate(t || {});
}

/**
 * Books one finished match (call BEFORE the match joins t.games, so a
 * migration does not count it twice).
 * @returns {Array<{type:'level', level:number}|{type:'week', streak:number, goal:number}>}
 */
function bookGame(t, humanCount, now = Date.now()) {
  const goals = goalsOf(t);
  t.goals = goals;
  const gained = gameXp(humanCount);
  if (!gained) return [];
  const before = levelFromXp(goals.xp).level;
  goals.xp += gained;
  const week = weekOf(gameDay(now));
  goals.weeks[week] = (goals.weeks[week] || 0) + 1;
  trimWeeks(goals.weeks);
  const events = [];
  if (goals.weeks[week] === WEEKLY_GOAL) {
    goals.weeksReached += 1;
    events.push({ type: 'week', streak: streakAt(goals, week), goal: WEEKLY_GOAL });
  }
  const after = levelFromXp(goals.xp).level;
  if (after > before) events.push({ type: 'level', level: after });
  return events;
}

/** Reached weeks in a row, counted back from `from` (bounded by WEEKS_KEPT). */
function streakAt(goals, from) {
  let streak = 0;
  let week = from;
  while (streak < WEEKS_KEPT && (goals.weeks[week] || 0) >= WEEKLY_GOAL) {
    streak += 1;
    week = addDays(week, -7);
  }
  return streak;
}

/** What the clients show. The streak stays alive through the current week
 *  until it ends: it counts from this week if reached, else from the last. */
function goalsView(t, now = Date.now()) {
  const goals = goalsOf(t);
  const week = weekOf(gameDay(now));
  const games = goals.weeks[week] || 0;
  const reached = games >= WEEKLY_GOAL;
  const streak = streakAt(goals, reached ? week : addDays(week, -7));
  return {
    ...levelFromXp(goals.xp),
    xp: goals.xp,
    week: { start: week, games, goal: WEEKLY_GOAL, reached },
    streak,
    weeksReached: goals.weeksReached || 0,
  };
}

module.exports = {
  XP_PER_GAME,
  XP_PER_EXTRA_HUMAN,
  LEVEL_BASE,
  LEVEL_STEP,
  WEEKLY_GOAL,
  gameXp,
  xpForLevel,
  levelFromXp,
  weekOf,
  bookGame,
  goalsOf,
  goalsView,
};

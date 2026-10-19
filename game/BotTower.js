// game/BotTower.js
// "Kartenhaus": a monthly tower of twenty one-round floors against the bots - the
// ONLY definition of floors, modifiers, stars and months (server, tests, client).

// The ladder: bots and head start per floor. Floors 11-20 add rules against the
// human seat (MODS), enforced by GameManager. The deals live in TowerSeeds.js.
const TOWER_STAGES = [
  { stage: 1, bots: ['easy', 'easy'], handicap: 0 },
  { stage: 2, bots: ['easy', 'medium'], handicap: 0 },
  { stage: 3, bots: ['medium', 'medium'], handicap: 0 },
  { stage: 4, bots: ['hard', 'medium'], handicap: 0 },
  { stage: 5, bots: ['hard', 'hard'], handicap: 0 },
  { stage: 6, bots: ['hard', 'hard', 'medium'], handicap: 20 },
  { stage: 7, bots: ['zen', 'hard'], handicap: 20 },
  { stage: 8, bots: ['zen', 'hard', 'hard'], handicap: 40 },
  { stage: 9, bots: ['zen', 'zen', 'hard'], handicap: 60 },
  { stage: 10, bots: ['zen', 'zen', 'zen'], handicap: 100 },
  // "queen" helps the heuristic (+100 when melded), so it pairs with a bigger head start.
  { stage: 11, bots: ['zen', 'zen', 'zen'], handicap: 100, mods: ['queen'] },
  { stage: 12, bots: ['zen', 'zen', 'zen'], handicap: 100, mods: ['goOut'] },
  { stage: 13, bots: ['zen', 'zen', 'zen'], handicap: 100, mods: ['noDiscard'] },
  { stage: 14, bots: ['zen', 'zen', 'zen'], handicap: 140, mods: ['queen'] },
  { stage: 15, bots: ['zen', 'zen', 'zen'], handicap: 120, mods: ['goOut'] },
  { stage: 16, bots: ['zen', 'zen', 'zen'], handicap: 120, mods: ['noDiscard'] },
  { stage: 17, bots: ['zen', 'zen', 'zen'], handicap: 140, mods: ['queen', 'goOut'] },
  { stage: 18, bots: ['zen', 'zen', 'zen'], handicap: 160, mods: ['queen', 'noDiscard'] },
  { stage: 19, bots: ['zen', 'zen', 'zen'], handicap: 160, mods: ['noDiscard', 'goOut'] },
  { stage: 20, bots: ['zen', 'zen', 'zen'], handicap: 160, mods: ['queen', 'noDiscard', 'goOut'] },
];
// queen: you start with a Queen of Spades; noDiscard: you never take the discard
// pile; goOut: stars only when you go out yourself.
const MODS = ['queen', 'noDiscard', 'goOut'];
const TOWER_SIZE = TOWER_STAGES.length;
const MAX_STARS = TOWER_SIZE * 3;
// Two stars: this many points ahead of the best bot (after the handicap).
const CLEAR_MARGIN = 100;

// Deals per month (TowerSeeds.js); months past the list cycle through it. The
// old fixed bot tower lives on as October 2026, floors 1-10: same deals, and
// the profile's pre-monthly `tower` stars count there (monthBest).
const TOWER_SEEDS = require('./TowerSeeds');
const TOWER_MONTHS = Object.keys(TOWER_SEEDS).sort();
const LEGACY_MONTH = '2026-10';
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const monthIndex = (m) => Number(m.slice(0, 4)) * 12 + Number(m.slice(5, 7)) - 1;

const hasMod = (cfg, mod) => !!(cfg && cfg.mods && cfg.mods.includes(mod));

/** 'YYYY-MM' of a game day ('YYYY-MM-DD', GameDay.js). */
function monthOf(day) {
  return String(day).slice(0, 7);
}

/** The twenty seeds of a month: its own list, later (or earlier) months cycle. */
function monthSeeds(month) {
  if (TOWER_SEEDS[month]) return TOWER_SEEDS[month];
  const n = TOWER_MONTHS.length;
  const i = (((monthIndex(month) - monthIndex(TOWER_MONTHS[0])) % n) + n) % n;
  return TOWER_SEEDS[TOWER_MONTHS[i]];
}

/** A floor of a month's tower (no month: the first one, e.g. a pre-monthly snapshot). */
function stageConfig(stage, month = null) {
  const base = TOWER_STAGES.find((s) => s.stage === Number(stage)) || null;
  const m = month == null ? LEGACY_MONTH : String(month);
  if (!base || !MONTH_RE.test(m)) return null;
  return { ...base, seed: monthSeeds(m)[base.stage - 1], month: m };
}

/** One star: more points than every bot after the handicap; two: CLEAR_MARGIN
 *  ahead; three: two stars AND out yourself. With goOut no star without going out. */
function starsFor({ myScore, botScores, wentOut, handicap = 0, goOut = false }) {
  const best = botScores.length ? Math.max(...botScores) : 0;
  const margin = (Number(myScore) || 0) - (Number(handicap) || 0) - best;
  if (margin <= 0 || (goOut && !wentOut)) return 0;
  if (margin < CLEAR_MARGIN) return 1;
  return wentOut ? 3 : 2;
}

/** The match winner of a floor: the human exactly when it earns a star, else the
 *  best bot (a tie among them goes to whoever went out). */
function stageWinner(totals, roundWinnerId, humanId, handicap = 0, goOut = false) {
  const botIds = Object.keys(totals).filter((pid) => pid !== humanId);
  const botScores = botIds.map((pid) => totals[pid]);
  const wentOut = roundWinnerId === humanId;
  if (humanId in totals && starsFor({ myScore: totals[humanId], botScores, wentOut, handicap, goOut }) >= 1) return humanId;
  const best = Math.max(...botScores);
  const leaders = botIds.filter((pid) => totals[pid] === best);
  return leaders.includes(roundWinnerId) ? roundWinnerId : leaders[0];
}

/** The floor outcome from a GameManager game record (one round, one human). */
function outcomeFromRecord(record, humanId) {
  const cfg = stageConfig(record && record.towerStage, (record && record.towerMonth) || null);
  const round = record && record.rounds && record.rounds[0];
  if (!cfg || !round || !round.results || !round.results[humanId]) return null;
  const botIds = ((record.players) || []).filter((p) => p.isBot).map((p) => p.id);
  const botScores = botIds.map((id) => (round.results[id] ? round.results[id].roundScore : 0));
  const myScore = round.results[humanId].roundScore;
  const wentOut = round.winnerId === humanId;
  const bestBot = botScores.length ? Math.max(...botScores) : 0;
  return {
    stage: cfg.stage,
    month: cfg.month,
    stars: starsFor({ myScore, botScores, wentOut, handicap: cfg.handicap, goOut: hasMod(cfg, 'goOut') }),
    myScore,
    bestBot,
    handicap: cfg.handicap,
    margin: myScore - cfg.handicap - bestBot,
    wentOut,
    ...(cfg.mods ? { mods: [...cfg.mods] } : {}),
  };
}

/** Highest floor this player may start: floor 1, then one above every cleared floor in a row. */
function unlockedStage(best = {}) {
  let n = 1;
  while (n < TOWER_SIZE && (best[n] || 0) >= 1) n += 1;
  return n;
}

/** Totals of one month's best stars. */
function summarize(best = {}) {
  let stars = 0;
  let cleared = 0;
  for (const s of TOWER_STAGES) {
    const b = Math.max(0, Math.min(3, Math.floor(Number(best[s.stage]) || 0)));
    stars += b;
    if (b >= 1) cleared += 1;
  }
  // Crowned: every floor of the month holds at least one star.
  return { stars, cleared, unlocked: unlockedStage(best), crowned: cleared >= TOWER_SIZE };
}

/** A profile's best stars of one month; the first month also reads the
 *  pre-monthly `tower` field (the old fixed tower = that month's deals). */
function monthBest(profile, month) {
  const own = (profile && profile.towers && profile.towers[month]) || {};
  if (month !== LEGACY_MONTH || !profile || !profile.tower) return { ...own };
  const merged = { ...profile.tower };
  for (const [k, v] of Object.entries(own)) merged[k] = Math.max(Number(merged[k]) || 0, Number(v) || 0);
  return merged;
}

/** Every month a profile played: [{ month, best, ...summarize }], newest first. */
function monthsOf(profile) {
  const months = new Set(Object.keys((profile && profile.towers) || {}));
  if (profile && profile.tower && Object.keys(profile.tower).length) months.add(LEGACY_MONTH);
  return [...months].filter((m) => MONTH_RE.test(m)).sort().reverse()
    .map((month) => { const best = monthBest(profile, month); return { month, best, ...summarize(best) }; });
}

/** Counters over all months: total stars, the best month's stars and floors
 *  (the badge families, like the old ten-stage tower = one month) and the
 *  crowned months. */
function totalsOf(profile) {
  const out = { totalStars: 0, bestStars: 0, bestCleared: 0, crowned: 0 };
  for (const m of monthsOf(profile)) {
    out.totalStars += m.stars;
    out.bestStars = Math.max(out.bestStars, m.stars);
    out.bestCleared = Math.max(out.bestCleared, m.cleared);
    if (m.crowned) out.crowned += 1;
  }
  return out;
}

/** What the client needs to draw the tower (no seeds: the deals stay a surprise). */
function publicStages() {
  return TOWER_STAGES.map(({ stage, bots, handicap, mods }) => ({ stage, bots: [...bots], handicap, ...(mods ? { mods: [...mods] } : {}) }));
}

module.exports = {
  TOWER_STAGES, TOWER_SIZE, MAX_STARS, CLEAR_MARGIN, MODS, LEGACY_MONTH,
  hasMod, monthOf, monthSeeds, stageConfig, starsFor, stageWinner, outcomeFromRecord,
  unlockedStage, summarize, monthBest, monthsOf, totalsOf, publicStages,
};

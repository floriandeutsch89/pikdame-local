// game/BotTower.js
// Bot tower: ten fixed one-round deals - the ONLY definition of stages and stars
// (server, tests, and the client via the getTower message).

// Seeds chosen by simulation (human seat = "hard" heuristic, stages 7-10 vs the
// Zen net): all beatable, the winning margin shrinks from ~190 to ~15.
const TOWER_STAGES = [
  { stage: 1, seed: 84, bots: ['easy', 'easy'], handicap: 0 },
  { stage: 2, seed: 10, bots: ['easy', 'medium'], handicap: 0 },
  { stage: 3, seed: 78, bots: ['medium', 'medium'], handicap: 0 },
  { stage: 4, seed: 24, bots: ['hard', 'medium'], handicap: 0 },
  { stage: 5, seed: 63, bots: ['hard', 'hard'], handicap: 0 },
  { stage: 6, seed: 131, bots: ['hard', 'hard', 'medium'], handicap: 20 },
  { stage: 7, seed: 34, bots: ['zen', 'hard'], handicap: 20 },
  { stage: 8, seed: 89, bots: ['zen', 'hard', 'hard'], handicap: 40 },
  { stage: 9, seed: 28, bots: ['zen', 'zen', 'hard'], handicap: 60 },
  { stage: 10, seed: 170, bots: ['zen', 'zen', 'zen'], handicap: 100 },
];
const TOWER_SIZE = TOWER_STAGES.length;
const MAX_STARS = TOWER_SIZE * 3;
// Two stars: this many points ahead of the best bot (after the handicap).
const CLEAR_MARGIN = 100;

// Monthly tower "Turmbau zu Babel": the same ladder, ten new deals per month
// (BabelSeeds.js). Months past the list cycle through it, so it never runs dry.
const BABEL_SEEDS = require('./BabelSeeds');
const BABEL_MONTHS = Object.keys(BABEL_SEEDS).sort();
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const monthIndex = (m) => Number(m.slice(0, 4)) * 12 + Number(m.slice(5, 7)) - 1;

/** 'YYYY-MM' of a game day ('YYYY-MM-DD', GameDay.js). */
function babelMonthOf(day) {
  return String(day).slice(0, 7);
}

/** The ten seeds of a month: its own list, later (or earlier) months cycle. */
function babelSeeds(month) {
  if (BABEL_SEEDS[month]) return BABEL_SEEDS[month];
  const n = BABEL_MONTHS.length;
  const i = (((monthIndex(month) - monthIndex(BABEL_MONTHS[0])) % n) + n) % n;
  return BABEL_SEEDS[BABEL_MONTHS[i]];
}

/** A stage of the fixed tower, or with `month` of that month's Babel tower. */
function stageConfig(stage, month = null) {
  const base = TOWER_STAGES.find((s) => s.stage === Number(stage)) || null;
  if (!base || month == null) return base;
  if (!MONTH_RE.test(String(month))) return null;
  return { ...base, seed: babelSeeds(String(month))[base.stage - 1], month: String(month) };
}

/** One star: more points than every bot after the handicap; two: CLEAR_MARGIN
 *  ahead; three: two stars AND out yourself. */
function starsFor({ myScore, botScores, wentOut, handicap = 0 }) {
  const best = botScores.length ? Math.max(...botScores) : 0;
  const margin = (Number(myScore) || 0) - (Number(handicap) || 0) - best;
  if (margin <= 0) return 0;
  if (margin < CLEAR_MARGIN) return 1;
  return wentOut ? 3 : 2;
}

/** The match winner of a stage: the human exactly when it earns a star, else the
 *  best bot (a tie among them goes to whoever went out). */
function stageWinner(totals, roundWinnerId, humanId, handicap = 0) {
  const botIds = Object.keys(totals).filter((pid) => pid !== humanId);
  const botScores = botIds.map((pid) => totals[pid]);
  if (humanId in totals && starsFor({ myScore: totals[humanId], botScores, wentOut: false, handicap }) >= 1) return humanId;
  const best = Math.max(...botScores);
  const leaders = botIds.filter((pid) => totals[pid] === best);
  return leaders.includes(roundWinnerId) ? roundWinnerId : leaders[0];
}

/** The stage outcome from a GameManager game record (one round, one human). */
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
    ...(cfg.month ? { month: cfg.month } : {}),
    stars: starsFor({ myScore, botScores, wentOut, handicap: cfg.handicap }),
    myScore,
    bestBot,
    handicap: cfg.handicap,
    margin: myScore - cfg.handicap - bestBot,
    wentOut,
  };
}

/** Highest stage this player may start: stage 1, then one above every cleared stage in a row. */
function unlockedStage(best = {}) {
  let n = 1;
  while (n < TOWER_SIZE && (best[n] || 0) >= 1) n += 1;
  return n;
}

/** Totals for the profile and the badge families. */
function summarize(best = {}) {
  let stars = 0;
  let cleared = 0;
  for (const s of TOWER_STAGES) {
    const b = Math.max(0, Math.min(3, Math.floor(Number(best[s.stage]) || 0)));
    stars += b;
    if (b >= 1) cleared += 1;
  }
  return { stars, cleared, unlocked: unlockedStage(best) };
}

/** Babel totals over every month played ({ 'YYYY-MM': best }): stars and cleared stages. */
function babelTotals(byMonth = {}) {
  let stars = 0;
  let cleared = 0;
  for (const best of Object.values(byMonth || {})) {
    const sum = summarize(best);
    stars += sum.stars;
    cleared += sum.cleared;
  }
  return { stars, cleared };
}

/** What the client needs to draw the tower (no seeds: the deals stay a surprise). */
function publicStages() {
  return TOWER_STAGES.map(({ stage, bots, handicap }) => ({ stage, bots: [...bots], handicap }));
}

module.exports = {
  TOWER_STAGES, TOWER_SIZE, MAX_STARS, CLEAR_MARGIN,
  babelMonthOf, babelSeeds, stageConfig, starsFor, stageWinner, outcomeFromRecord, unlockedStage, summarize, babelTotals, publicStages,
};

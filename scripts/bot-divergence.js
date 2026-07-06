'use strict';

/**
 * Behavioural divergence between the heuristic bot tiers.
 *
 * For anti-overfitting, opponents in the RL training pool must actually PLAY
 * differently - otherwise a "mixed" pool is secretly uniform. This tool plays
 * self-play games and, at every discard decision, computes what EACH tier would
 * throw from the identical state, then reports how often the tiers disagree.
 *
 *   node scripts/bot-divergence.js
 *
 * Findings (2026-07): medium and hard are behaviourally identical (0% - the old
 * medium queen-dump was removed in v1.36.1); zen differs from hard in ~20% of
 * discards (its counting-based re-ranking of near-equal-value candidates). The
 * draw and meld phases are difficulty-independent above 'easy'. So the only
 * genuinely distinct heuristic styles are: easy, medium==hard, zen. Real
 * training diversity beyond that must come from a self-play league.
 */

const Bot = require('../game/Bot');
const GameManager = require('../game/GameManager');

const TIERS = ['easy', 'medium', 'hard', 'zen'];
const GAMES = Number(process.argv[2]) || 40;

const orig = Bot.chooseDiscard.bind(Bot);
const pairs = {};
for (let i = 0; i < TIERS.length; i++) {
  for (let j = i + 1; j < TIERS.length; j++) pairs[`${TIERS[i]} vs ${TIERS[j]}`] = 0;
}
let calls = 0;

// Spy: at each real discard, evaluate the counterfactual for every tier from
// the identical (hand, melds, opts) and tally pairwise disagreements. 'easy' is
// random, so we seed it out of the pairwise stats by evaluating it too but
// noting it is stochastic (its divergence is trivially ~100% and not useful).
Bot.chooseDiscard = function spy(hand, melds, opts) {
  const o = opts || {};
  try {
    const picks = {};
    for (const t of TIERS) {
      const p = orig(hand, melds, { ...o, difficulty: t });
      picks[t] = p ? p.id : null;
    }
    calls += 1;
    for (let i = 0; i < TIERS.length; i++) {
      for (let j = i + 1; j < TIERS.length; j++) {
        if (picks[TIERS[i]] !== picks[TIERS[j]]) pairs[`${TIERS[i]} vs ${TIERS[j]}`] += 1;
      }
    }
  } catch (e) {
    /* ignore */
  }
  return orig(hand, melds, opts);
};

function play(diffs) {
  const g = new GameManager(() => {});
  g.addOrReconnectPlayer('h', 'H');
  g.fillWithBots();
  g.players = diffs.map((d, i) => ({
    id: `b${i}`, name: `B${i}`, isBot: true, hand: [], connected: true,
    laidOutCards: [], botDifficulty: d, _everLaidThisRound: false, _laidAtTurnStart: false,
  }));
  g.maxSeats = diffs.length;
  g.startNewRound();
  let s = 0;
  while (g.phase !== 'gameOver' && s < 3000) {
    if (g.phase === 'playing') g.runBotTurn(g.currentPlayer().id);
    else if (g.phase === 'roundEnd') g.startNewRound();
    else break;
    s += 1;
  }
  g.destroy();
}

for (let i = 0; i < GAMES; i++) play(['zen', 'hard', 'medium', 'easy']);

console.log(`Discard decisions sampled: ${calls} (${GAMES} games)\n`);
console.log('Pairwise discard disagreement (higher = more distinct):');
for (const [k, v] of Object.entries(pairs)) {
  const pct = calls ? ((100 * v) / calls).toFixed(1) : '0.0';
  const note = k === 'medium vs hard' && v === 0 ? '  <- identical policy' : '';
  const easy = k.includes('easy') ? '  (easy is random; ignore)' : '';
  console.log(`  ${k.padEnd(18)} ${pct}%${note}${easy}`);
}

// scripts/tower-play.js - plays one Kartenhaus floor with a bot in the human
// seat (tooling only: tower-seeds.js and test/tower-proofs.test.js).
// Every floor is deterministic per seed and line of play (easy bots draw their
// randomness from the deal), so one game by Hard or Zen proves a deal.
'use strict';
// Simulated seats are no human moves: without this, data/human-moves.jsonl fills the disk.
process.env.PIKDAME_LOG_GAMES = '0';
const crypto = require('crypto');
const GameManager = require('../game/GameManager');
const BotTower = require('../game/BotTower');

/** murmur3's finalizer: neighbouring inputs give unrelated PRNG seeds. */
function mix(h) {
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** mulberry32. */
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * One game of `seed` as floor `stage` of `month`; the human seat plays `proxy`
 * ('hard', 'zen', 'medium', ...). `slip` > 0 makes it human-like: per turn, with
 * that chance each, a random legal draw source and a random legal discard
 * (seeded by `run`). Returns BotTower's outcome plus a short hash of the moves;
 * `steps` (an array) collects the hashed moves one by one.
 */
async function playFloor({ seed, stage, month, proxy = 'hard', slip = 0, run = 0, steps = null }) {
  const random = Math.random;
  const rnd = prng(mix(mix(seed) ^ mix(stage * 0x9e3779b1 + run * 7 + 13)));
  Math.random = prng(mix(seed ^ 0x2545f491) ^ run); // cosmetic draws only (bot names)
  const g = new GameManager(() => {}, { deckSeed: seed, towerStage: stage, towerMonth: month });
  // This loop plays every turn. The game's own bot timer would play one behind its
  // back whenever an awaited net answer takes longer than ~1 s (proof replays diverged).
  g.maybeRunBotTurn = () => {};
  try {
    g.addOrReconnectPlayer('me', 'Sim');
    g.syncLobbyBots();
    if (g.startTowerRound().error) throw new Error(`floor ${stage} did not start`);
    const me = g.players.find((p) => p.id === 'me');
    me.botDifficulty = proxy;
    const trace = crypto.createHash('sha256');
    let guard = 0;
    while (g.phase === 'playing' && guard++ < 5000) {
      const cp = g.currentPlayer();
      const before = g.turnIndexInRound;
      const human = cp.id === 'me';
      let slipped = false;
      if (human && slip > 0) {
        if (rnd() < slip) {
          const canPile = g.discardPile.length > 0 && g.canTakeDiscardTop(cp, g.discardPile[0]);
          cp.forcedDrawSource = canPile && rnd() < 0.5 ? 'discardPile' : 'drawPile';
        }
        if (rnd() < slip) {
          slipped = true;
          cp.externalDiscard = (game, p, legal) => legal[Math.floor(rnd() * legal.length)].id;
        }
      }
      try {
        if (!slipped && g._botTurnUsesOnnx(cp)) await g._runBotTurnWithOnnx(cp.id, { forced: human });
        else g.runBotTurn(cp.id, { forced: human });
      } finally {
        cp.externalDiscard = null;
        cp.forcedDrawSource = null;
      }
      const top = g.discardPile[0];
      const step = `${cp.id}:${cp.hand.length}:${top ? top.id : '-'};`;
      trace.update(step);
      if (steps) steps.push(step); // debugging a diverging replay
      if (g.phase === 'playing' && g.turnIndexInRound === before && g.currentPlayer().id === cp.id) g.finishRound(null);
    }
    const record = g.lastGameRecord;
    if (!record) throw new Error(`floor ${stage}, seed ${seed}: no game over`);
    const o = BotTower.outcomeFromRecord(record, 'me');
    const r = record.rounds[0];
    trace.update(JSON.stringify(Object.keys(r.results).sort().map((id) => [id, r.results[id].roundScore])));
    return { ...o, turns: guard, hash: trace.digest('hex').slice(0, 12) };
  } finally {
    g.destroy();
    Math.random = random;
  }
}

/** Star rate (0-100) of the medium heuristic with `slip` human-like mistakes over n games.
 *  With `within: [lo, hi]` it stops early and returns null once the rate cannot land inside. */
async function slipRate({ seed, stage, month, n = 100, slip = 0.1, proxy = 'medium', within = null }) {
  let stars = 0;
  for (let run = 0; run < n; run++) {
    if ((await playFloor({ seed, stage, month, proxy, slip, run: 2000 + run })).stars >= 1) stars += 1;
    if (within && ((100 * stars) / n > within[1] || (100 * (stars + n - run - 1)) / n < within[0])) return null;
  }
  return (100 * stars) / n;
}

/** Floors whose opponents include a Zen bot (they need the net to be played as in production). */
const needsNet = (stage) => BotTower.TOWER_STAGES.find((s) => s.stage === stage).bots.includes('zen');

module.exports = { playFloor, slipRate, needsNet, prng, mix };

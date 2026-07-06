'use strict';

/**
 * Determinized rollout search for the discard decision - the "full playout to
 * round end" idea behind ISMCTS, in its most tractable 1-ply form.
 *
 * For each candidate discard we sample several determinizations (a complete,
 * counting-consistent guess at every hidden card: opponents' hands and the
 * draw pile), apply the discard, then play the rest of the round out with the
 * existing heuristic bot policy as the rollout policy. The value of a
 * candidate is the average final score margin (my round score minus the best
 * opponent's) over those playouts. We pick the argmax.
 *
 * This is engine-adjacent but self-contained: it clones the live GameManager
 * into headless copies (no broadcasts, no timers) and never touches the real
 * game. Enabled per-seat via cp.mctsEnabled; production bots never set it.
 */

const { buildUnseenPool } = require('./MonteCarlo');

/** Deep-copy the mutable round state of a live game into a fresh headless GM. */
function cloneHeadless(GameManager, real, rolloutDifficulty) {
  const clone = new GameManager(() => {});
  // Rollout playouts use the PURE heuristic policy - without this flag a zen
  // seat inside the rollout would re-trigger MCTS and recurse exponentially.
  clone._noMcts = true;
  const copy = (v) => structuredClone(v);
  clone.phase = real.phase;
  clone.players = real.players.map((p) => ({
    ...copy({
      id: p.id, name: p.name, hand: p.hand, laidOutCards: p.laidOutCards,
      _everLaidThisRound: p._everLaidThisRound, _laidAtTurnStart: p._laidAtTurnStart,
    }),
    // Every seat is a bot during the rollout so runBotTurn drives all of them.
    isBot: true, connected: true,
    botDifficulty: p.botDifficulty || rolloutDifficulty,
  }));
  clone.totals = copy(real.totals);
  clone.houseRules = copy(real.houseRules);
  clone.maxSeats = real.maxSeats;
  clone.drawPile = copy(real.drawPile);
  clone.discardPile = copy(real.discardPile);
  clone.tableMelds = copy(real.tableMelds);
  clone.retiredJokers = copy(real.retiredJokers);
  clone.currentPlayerIndex = real.currentPlayerIndex;
  clone.dealerIndex = real.dealerIndex;
  clone.turnPhase = real.turnPhase;
  clone.turnIndexInRound = real.turnIndexInRound;
  clone.mustLayOffCardId = real.mustLayOffCardId;
  clone.pendingDiscardRest = real.pendingDiscardRest;
  clone.roundNumber = real.roundNumber;
  clone.publicKnownHands = copy(real.publicKnownHands || {});
  clone.declinedByPlayer = copy(real.declinedByPlayer || {});
  clone.log = [];
  return clone;
}

function shuffleInPlace(a, rng) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * Replace every hidden card on the clone with a concrete, counting-consistent
 * sample: each opponent keeps the cards publicly known to be in their hand and
 * gets random fillers up to their hand size; the remaining pool becomes the
 * draw pile. My own hand and all public cards stay exactly as they are.
 */
function determinize(clone, myId, rng) {
  const me = clone.players.find((p) => p.id === myId);
  const visible = [
    ...clone.tableMelds.flatMap((m) => m.slots.map((s) => s.real || { isJoker: true })),
    ...clone.discardPile,
    ...clone.retiredJokers,
    ...me.hand,
  ];
  const knownByOpp = {};
  for (const p of clone.players) {
    if (p.id === myId) continue;
    const known = (clone.publicKnownHands && clone.publicKnownHands[p.id]) || [];
    knownByOpp[p.id] = known.slice(0, p.hand.length);
    visible.push(...knownByOpp[p.id]);
  }
  const pool = shuffleInPlace(buildUnseenPool(visible), rng);
  let cursor = 0;
  const nextId = (() => {
    let n = 1;
    return () => `sim-${n++}`;
  })();
  for (const p of clone.players) {
    if (p.id === myId) continue;
    const known = knownByOpp[p.id];
    const need = Math.max(0, p.hand.length - known.length);
    const fillers = pool.slice(cursor, cursor + need).map((c) => ({ ...c, id: nextId() }));
    cursor += fillers.length;
    p.hand = [...known.map((c) => ({ ...c })), ...fillers];
  }
  clone.drawPile = pool.slice(cursor).map((c) => ({ ...c, id: nextId() }));
}

/** Static fallback value if a rollout does not terminate within the cap. */
function staticMargin(clone, myId) {
  const { cardValue } = require('./Card');
  const val = (p) =>
    p.laidOutCards.reduce((s, c) => s + cardValue(c), 0) -
    p.hand.reduce((s, c) => s + cardValue(c), 0);
  const me = clone.players.find((p) => p.id === myId);
  const others = clone.players.filter((p) => p.id !== myId);
  return val(me) - Math.max(...others.map(val), -Infinity);
}

/** Play the clone out to round end (or a turn cap) and return my score margin. */
function rolloutMargin(clone, myId, maxTurns) {
  let turns = 0;
  while (clone.phase === 'playing' && turns < maxTurns) {
    const cp = clone.currentPlayer();
    if (!cp) break;
    const before = clone.turnIndexInRound;
    const beforeId = cp.id;
    clone.runBotTurn(cp.id);
    turns += 1;
    if (clone.phase === 'playing' && clone.turnIndexInRound === before && clone.currentPlayer().id === beforeId) {
      break; // no progress guard
    }
  }
  if (clone.phase === 'roundEnd' || clone.phase === 'gameOver') {
    const rr = clone.lastRoundResult || {};
    const mine = rr[myId] ? rr[myId].roundScore : 0;
    const others = Object.entries(rr).filter(([pid]) => pid !== myId).map(([, r]) => r.roundScore);
    return mine - (others.length ? Math.max(...others) : 0);
  }
  return staticMargin(clone, myId);
}

/**
 * Evaluate one candidate discard over N determinizations. Returns the mean
 * score margin (higher = better for me).
 */
function evaluateDiscard(GameManager, real, myId, candidateId, opts) {
  const { determinizations = 12, maxTurns = 160, difficulty = 'zen', rng = Math.random } = opts;
  let sum = 0;
  let n = 0;
  for (let d = 0; d < determinizations; d++) {
    const clone = cloneHeadless(GameManager, real, difficulty);
    determinize(clone, myId, rng);
    const me = clone.players.find((p) => p.id === myId);
    if (!me || !me.hand.some((c) => c.id === candidateId)) {
      clone.destroy();
      continue;
    }
    const res = clone.discard(myId, candidateId);
    if (!res || res.error) {
      clone.destroy();
      continue;
    }
    sum += rolloutMargin(clone, myId, maxTurns);
    n += 1;
    clone.destroy();
  }
  return n > 0 ? sum / n : -Infinity;
}

/**
 * Pick the discard with the best expected margin via determinized rollouts.
 * `candidateCards` limits the search (e.g. the heuristic's shortlist); falls
 * back to null if nothing could be evaluated so the caller keeps its own pick.
 */
function chooseDiscardByRollout(GameManager, real, myId, candidateCards, opts = {}) {
  const budgetMs = opts.budgetMs || 650; // hard ceiling: never blow the think budget
  const start = Date.now();
  let best = null;
  let bestVal = -Infinity;
  for (const card of candidateCards) {
    const val = evaluateDiscard(GameManager, real, myId, card.id, opts);
    if (val > bestVal) {
      bestVal = val;
      best = card;
    }
    if (Date.now() - start > budgetMs) break; // return best evaluated so far
  }
  return best;
}

module.exports = {
  cloneHeadless,
  determinize,
  rolloutMargin,
  evaluateDiscard,
  chooseDiscardByRollout,
};

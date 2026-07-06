'use strict';

/**
 * State encoder for the learned bot policy.
 *
 * CRITICAL PARITY RULE: this exact encoder feeds BOTH sides -
 *   - training: the Node RL env server (scripts/rl-env-server.js) sends these
 *     observations to the Python Gymnasium env,
 *   - inference: game/OnnxPolicy.js encodes the live state and feeds the ONNX
 *     model at runtime.
 * If the two ever diverge, a model trained on one distribution runs on
 * another and silently plays badly. Never encode game state for the model
 * anywhere else - always go through here.
 *
 * Action space (54 discrete actions):
 *   0..51  discard a card of that type (idx = suitIndex*13 + rankIndex,
 *          SUITS = H,D,C,S; RANKS = 2..A). Jokers are never discarded.
 *   52     DRAW decision: draw face-down from the draw pile
 *   53     DRAW decision: take the whole discard pile (only when rule-legal)
 * Each turn has up to two decision points - a draw decision (only offered
 * when taking the pile is legal) and a discard decision. The action mask and
 * an observation flag (isDrawDecision) tell the policy which one it faces.
 */

const { SUITS, RANKS, cardValue } = require('./Card');
const { canFormMeldWithCard } = require('./Rules');

const N_TYPES = 52; // 4 suits * 13 ranks
const MAX_OPP = 3; // observation is padded/truncated to this many opponents
const JOKERS_TOTAL = 6;
const DECK_COPIES = 2;
const ACTION_DRAW_PILE = 52; // draw face-down from the draw pile
const ACTION_TAKE_PILE = 53; // take the whole discard pile

function typeIndex(card) {
  if (card.isJoker) return -1;
  const s = SUITS.indexOf(card.suit);
  const r = RANKS.indexOf(card.rank);
  if (s < 0 || r < 0) return -1;
  return s * RANKS.length + r;
}

/** Inverse of typeIndex: which (suit,rank) a discard action refers to. */
function cardTypeForAction(action) {
  const s = Math.floor(action / RANKS.length);
  const r = action % RANKS.length;
  return { suit: SUITS[s], rank: RANKS[r] };
}

function countsOf(cards) {
  const c = new Array(N_TYPES).fill(0);
  let jokers = 0;
  for (const card of cards || []) {
    const idx = typeIndex(card);
    if (idx >= 0) c[idx] += 1;
    else if (card.isJoker) jokers += 1;
  }
  return { counts: c, jokers };
}

/** All publicly visible standard cards: table meld reals + face-up discards. */
function visibleCards(game) {
  const out = [];
  for (const m of game.tableMelds || []) {
    for (const slot of m.slots) {
      if (slot.real) out.push(slot.real);
    }
  }
  for (const cd of game.discardPile || []) {
    if (!cd.faceDown) out.push(cd);
  }
  return out;
}

/**
 * Encode the game from playerId's point of view into a fixed-length
 * Float32Array. The layout is documented inline; OBS_SIZE is exported and
 * must match the model's input dimension.
 */
function encode(game, playerId, ctx = {}) {
  const me = (game.players || []).find((p) => p.id === playerId);
  const feats = [];
  const push = (x) => feats.push(Number.isFinite(x) ? x : 0);
  const pushCounts = (arr) => {
    for (let i = 0; i < N_TYPES; i++) push((arr[i] || 0) / DECK_COPIES);
  };

  // --- own hand ---
  const hand = countsOf(me ? me.hand : []);
  pushCounts(hand.counts); // 52
  push(hand.jokers / JOKERS_TOTAL); // 1

  // --- visible / table ---
  const vis = countsOf(visibleCards(game));
  pushCounts(vis.counts); // 52

  // --- discard top ---
  const top = (game.discardPile || [])[0];
  const topOneHot = new Array(N_TYPES).fill(0);
  let topFaceDown = 0;
  if (top) {
    if (top.faceDown) topFaceDown = 1;
    else {
      const ti = typeIndex(top);
      if (ti >= 0) topOneHot[ti] = 1;
    }
  }
  for (let i = 0; i < N_TYPES; i++) push(topOneHot[i]); // 52
  push(topFaceDown); // 1

  // --- exhaustion: unseen remaining copies per type ---
  // remaining = 2 - (visible copies + own copies + known-opponent copies)
  const knownOppAll = [];
  const opps = (game.players || []).filter((p) => p.id !== playerId);
  for (const p of opps) {
    const known = (game.publicKnownHands && game.publicKnownHands[p.id]) || [];
    knownOppAll.push(...known);
  }
  const knownCounts = countsOf(knownOppAll).counts;
  const unseen = new Array(N_TYPES).fill(0);
  for (let i = 0; i < N_TYPES; i++) {
    const seen = (vis.counts[i] || 0) + (hand.counts[i] || 0) + (knownCounts[i] || 0);
    unseen[i] = Math.max(0, DECK_COPIES - seen);
  }
  pushCounts(unseen); // 52

  // --- per opponent (padded / truncated to MAX_OPP) ---
  for (let k = 0; k < MAX_OPP; k++) {
    const p = opps[k];
    if (!p) {
      push(0);
      for (let i = 0; i < N_TYPES; i++) push(0);
      continue;
    }
    push((p.hand ? p.hand.length : 0) / 15);
    const known = (game.publicKnownHands && game.publicKnownHands[p.id]) || [];
    const kc = countsOf(known).counts;
    pushCounts(kc);
  } // MAX_OPP * (1 + 52)

  // --- scalars ---
  const laidValue = me ? (me.laidOutCards || []).reduce((s, c) => s + cardValue(c), 0) : 0;
  const handValue = me ? (me.hand || []).reduce((s, c) => s + cardValue(c), 0) : 0;
  const lowestOpp = opps.length ? Math.min(...opps.map((p) => (p.hand ? p.hand.length : 15))) : 15;
  const myTotal = (game.totals && game.totals[playerId]) || 0;
  const bestOpp = opps.length ? Math.max(...opps.map((p) => (game.totals && game.totals[p.id]) || 0)) : 0;
  push((game.drawPile ? game.drawPile.length : 0) / 110);
  push((game.discardPile ? game.discardPile.length : 0) / 110);
  push(laidValue / 300);
  push(handValue / 300);
  push((me && me.hand ? me.hand.length : 0) / 20);
  push(lowestOpp / 15);
  push(Math.max(-1, Math.min(1, (myTotal - bestOpp) / 200))); // scoreLead clipped

  // decision-phase flag: 1 at a draw decision, 0 at a discard decision
  push(ctx.phase === 'draw' ? 1 : 0);

  return Float32Array.from(feats);
}

/** Is taking the whole discard pile rule-legal for this player right now? */
function pileTakeLegal(game, playerId) {
  const me = (game.players || []).find((p) => p.id === playerId);
  const top = (game.discardPile || [])[0];
  if (!me || !top || top.faceDown) return false;
  return canFormMeldWithCard(top, me.hand || []);
}

/**
 * Boolean action mask (length 54), phase-aware:
 *   ctx.phase === 'draw'    -> {DRAW_PILE: true, TAKE_PILE: pileTakeLegal}
 *   ctx.phase === 'discard' -> the non-joker hand card types
 */
function actionMask(game, playerId, ctx = {}) {
  const mask = new Array(ACTION_SIZE).fill(false);
  if (ctx.phase === 'draw') {
    mask[ACTION_DRAW_PILE] = true;
    mask[ACTION_TAKE_PILE] = ctx.pileTakeLegal !== undefined ? !!ctx.pileTakeLegal : pileTakeLegal(game, playerId);
    return mask;
  }
  const me = (game.players || []).find((p) => p.id === playerId);
  for (const c of (me && me.hand) || []) {
    const idx = typeIndex(c);
    if (idx >= 0) mask[idx] = true;
  }
  return mask;
}

/** Pick a concrete hand card matching a chosen action; null if none. */
function cardForAction(game, playerId, action) {
  const me = (game.players || []).find((p) => p.id === playerId);
  if (!me) return null;
  const { suit, rank } = cardTypeForAction(action);
  return me.hand.find((c) => !c.isJoker && c.suit === suit && c.rank === rank) || null;
}

// OBS_SIZE = 52 +1 +52 +52 +1 +52 + MAX_OPP*(1+52) + 7
const OBS_SIZE = N_TYPES + 1 + N_TYPES + N_TYPES + 1 + N_TYPES + MAX_OPP * (1 + N_TYPES) + 7 + 1;
const ACTION_SIZE = N_TYPES + 2; // + draw-pile + take-pile

module.exports = {
  encode,
  actionMask,
  cardForAction,
  cardTypeForAction,
  typeIndex,
  pileTakeLegal,
  OBS_SIZE,
  ACTION_SIZE,
  N_TYPES,
  MAX_OPP,
  ACTION_DRAW_PILE,
  ACTION_TAKE_PILE,
};

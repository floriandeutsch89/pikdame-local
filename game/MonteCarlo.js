'use strict';

/**
 * Monte-Carlo estimation over hidden opponent hands, consistent with card
 * counting (every sample respects all public information).
 *
 * The deterministic zen heuristic already knows a lot: which ranks are
 * exhausted (copies visible on the table), which cards a specific opponent
 * is known to hold (watched pickups, weighted triple), which ranks the next
 * player spurned. What it CANNOT know is the concrete rest of an opponent's
 * hand. That is exactly what this module samples.
 *
 * Primary use: the endgame discard. For a candidate discard C given to the
 * NEXT player, estimate P(they can build a brand-new meld from C plus their
 * hidden hand) - the one thing pure counting can only guess at. Laying C off
 * onto an EXISTING table meld is already deterministic (tryLayOff) and is
 * handled by the caller, so we deliberately do not re-estimate it here.
 *
 * The module is engine-pure: it returns a plain {cardId -> risk} map. Bot.js
 * blends it in; nothing here mutates game state.
 */

const { SUITS, RANKS } = require('./Card');
const { canFormMeldWithCard } = require('./Rules');
const { seededRandom } = require('./Deck');

const DECK_COPIES = 2; // Pik Dame plays with two standard decks
const JOKER_TOTAL = 6; // 110 - 2*52

/** A stable identity key for a physical card value (ignores deck index/id). */
function valueKey(card) {
  return card.isJoker ? 'JOKER' : `${card.suit}${card.rank}`;
}

/**
 * Build the multiset of UNSEEN cards: the full two-deck composition minus
 * everything the counting bot can see or knows the location of. `known` is a
 * flat list of card-like objects ({suit,rank} or {isJoker:true}); duplicates
 * are consumed one copy at a time, so seeing one red king still leaves the
 * second in the pool.
 */
function buildUnseenPool(known) {
  const used = new Map(); // valueKey -> count already accounted for
  for (const c of known) {
    const k = valueKey(c);
    used.set(k, (used.get(k) || 0) + 1);
  }
  const take = (k) => {
    const n = used.get(k) || 0;
    if (n > 0) {
      used.set(k, n - 1);
      return false; // this copy is seen -> not in pool
    }
    return true; // still unseen
  };
  const pool = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      for (let copy = 0; copy < DECK_COPIES; copy++) {
        if (take(`${suit}${rank}`)) pool.push({ suit, rank });
      }
    }
  }
  for (let i = 0; i < JOKER_TOTAL; i++) {
    if (take('JOKER')) pool.push({ isJoker: true });
  }
  return pool;
}

/** Fisher-Yates on a copy, using the provided [0,1) rng. */
function shuffled(arr, rng) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * Estimate, for each candidate discard, the probability that the NEXT player
 * could form a NEW meld with it.
 *
 * opts:
 *   ownHand           - the bot's own cards (excluded from the pool)
 *   visibleCards      - every publicly visible card (table melds, face-up
 *                       discards, retired jokers)
 *   nextHandSize      - number of cards the next opponent holds
 *   nextKnownCards    - cards KNOWN to be in the next opponent's hand
 *                       (watched pickups): pinned into every sample, and of
 *                       course excluded from the pool
 *   candidates        - the discard candidates to score
 *   samples           - MC sample count (default 200)
 *   seed              - optional numeric seed for reproducible runs
 *
 * Returns a Map(cardId -> risk in [0,1]).
 */
function discardMeldRisk(opts) {
  const {
    ownHand = [],
    visibleCards = [],
    nextHandSize = 0,
    nextKnownCards = [],
    candidates = [],
    samples = 200,
    seed,
  } = opts;

  const risk = new Map();
  for (const c of candidates) risk.set(c.id, 0);
  if (candidates.length === 0) return risk;

  // Cards whose location is fully accounted for are removed from the pool.
  const known = [...ownHand, ...visibleCards, ...nextKnownCards];
  const pool = buildUnseenPool(known);

  // How many unknown cards the next opponent still holds beyond what we
  // already know is in their hand. If we somehow "know" their whole hand,
  // there is nothing to sample - risk is a single deterministic check.
  const unknownCount = Math.max(0, nextHandSize - nextKnownCards.length);
  const rng = typeof seed === 'number' ? seededRandom(seed) : Math.random;

  const hits = new Map();
  for (const c of candidates) hits.set(c.id, 0);

  const effectiveSamples = unknownCount === 0 ? 1 : samples;
  for (let s = 0; s < effectiveSamples; s++) {
    const drawn = unknownCount === 0 ? [] : shuffled(pool, rng).slice(0, unknownCount);
    const oppHand = [...nextKnownCards, ...drawn];
    for (const c of candidates) {
      // Would giving them C let them build a fresh combination?
      if (canFormMeldWithCard(c, oppHand)) hits.set(c.id, hits.get(c.id) + 1);
    }
  }
  for (const c of candidates) risk.set(c.id, hits.get(c.id) / effectiveSamples);
  return risk;
}

module.exports = {
  buildUnseenPool,
  discardMeldRisk,
  valueKey,
};

// game/Deck.js
const { SUITS, RANKS, makeStandardCard, makeJoker, isPikDame } = require('./Card');

const JOKER_COUNT = 6;
const HAND_SIZE = 15;

function createDeck() {
  const cards = [];
  for (let deckIndex = 0; deckIndex < 2; deckIndex++) {
    for (const suit of SUITS) {
      for (const rank of RANKS) {
        cards.push(makeStandardCard(suit, rank, deckIndex));
      }
    }
  }
  for (let i = 0; i < JOKER_COUNT; i++) {
    cards.push(makeJoker(i));
  }
  return cards; // 110 Karten
}

/** Optional deterministic shuffle: with a numeric seed every player on
 *  earth gets the IDENTICAL deck (daily challenge). Without a seed the
 *  behaviour is unchanged (Math.random). mulberry32 is tiny and plenty
 *  for card shuffling - this is fairness, not cryptography. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(deck, seed) {
  const rnd = typeof seed === 'number' ? mulberry32(seed) : Math.random;
  const arr = deck.slice();
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * Teilt das gemischte Deck regulär aus: jeder Spieler bekommt 15 Handkarten,
 * der Rest bildet den verdeckten Nachziehstapel. Der Ablagestapel beginnt
 * mit einer offen aufgedeckten Karte vom Nachziehstapel.
 *
 * @param {Array} deck gemischtes, volles Deck (110 Karten)
 * @param {Array} playerIds Reihenfolge der Spieler (Sitzordnung)
 * @returns {{ hands: Object<string,Array>, drawPile: Array, discardPile: Array }}
 */
/**
 * Glücksgriff beim Abheben: Der Spieler rechts vom Geber hebt an einer
 * zufälligen Stelle ab. Liegt dort eine Pik Dame oder ein Joker, nimmt er
 * die Karte sofort auf die Hand - ebenso alle DIREKT folgenden Karten,
 * sofern auch sie Pik Dame oder Joker sind.
 *
 * Pure Funktion (cutIndex wird injiziert) - dadurch deterministisch testbar.
 * @returns {{ luckyCards: Array, remaining: Array }}
 */
function performLuckyCut(deck, cutIndex) {
  const remaining = deck.slice();
  const luckyCards = [];
  const isLucky = (card) => card && (card.isJoker || isPikDame(card));
  let idx = Math.max(0, Math.min(cutIndex, remaining.length - 1));
  while (idx < remaining.length && isLucky(remaining[idx])) {
    luckyCards.push(remaining.splice(idx, 1)[0]);
  }
  return { luckyCards, remaining };
}

function dealCards(deck, playerIds, options = {}) {
  let remaining = deck.slice();
  const hands = {};
  for (const pid of playerIds) hands[pid] = [];

  // Ausgleich für den Glücksgriff: Wer beim Abheben Karten ergattert hat,
  // wird in den ersten Verteilrunden entsprechend oft übersprungen, damit
  // am Ende ALLE exakt 15 Handkarten haben (ergatterte Karten mitgezählt).
  const skips = { ...(options.skips || {}) };
  const target = {};
  for (const pid of playerIds) {
    target[pid] = HAND_SIZE - (skips[pid] || 0);
  }

  let safety = 0;
  while (playerIds.some((pid) => hands[pid].length < target[pid])) {
    for (const pid of playerIds) {
      if (skips[pid] > 0) {
        skips[pid] -= 1; // in dieser Verteilrunde übersprungen
        continue;
      }
      if (hands[pid].length >= target[pid]) continue;
      if (remaining.length === 0) break;
      hands[pid].push(remaining.shift());
    }
    safety++;
    if (safety > 1000) break; // Sicherheitsnetz gegen Endlosschleifen
  }

  // Restliche Karten = verdeckter Nachziehstapel
  const drawPile = remaining;

  // Ablagestapel beginnt mit einer offen aufgedeckten Karte vom Nachziehstapel
  const discardPile = [];
  if (drawPile.length > 0) {
    discardPile.push(drawPile.shift());
  }

  return { hands, drawPile, discardPile };
}

module.exports = {
  createDeck,
  shuffle,
  dealCards,
  performLuckyCut,
  HAND_SIZE,
};

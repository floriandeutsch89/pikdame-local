// game/Deck.js
const { SUITS, RANKS, makeStandardCard, makeJoker } = require('./Card');

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

function shuffle(deck) {
  const arr = deck.slice();
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
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
function dealCards(deck, playerIds) {
  let remaining = deck.slice();
  const hands = {};
  for (const pid of playerIds) hands[pid] = [];

  let safety = 0;
  while (playerIds.some((pid) => hands[pid].length < HAND_SIZE)) {
    for (const pid of playerIds) {
      if (hands[pid].length >= HAND_SIZE) continue;
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
  HAND_SIZE,
};

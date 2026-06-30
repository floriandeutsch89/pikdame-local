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

function shuffle(deck) {
  const arr = deck.slice();
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * Simuliert das "Abheben" (Cut) vor dem Austeilen, inkl. Feature "Glücksgriff":
 * Es wird eine Karte vom (gemischten) Stapel "aufgedeckt" simuliert (die oberste
 * Karte nach dem fiktiven Abheben). Ist diese Karte eine Pik-Dame oder ein
 * Joker, bekommt der entsprechende Spieler sie SOFORT auf die Hand und wird
 * beim regulären Austeilen übersprungen, bis alle Spieler 15 Karten haben.
 *
 * @param {Array} deck gemischtes, volles Deck (110 Karten)
 * @param {Array} playerIds Reihenfolge der Spieler (Sitzordnung)
 * @returns {{ hands: Object<string,Array>, drawPile: Array, discardPile: Array, luckyHits: Array }}
 */
function dealWithGlucksgriff(deck, playerIds) {
  let remaining = deck.slice();
  const hands = {};
  for (const pid of playerIds) hands[pid] = [];

  const luckyHits = []; // Protokoll für UI/Log: { playerId, card }

  // "Glücksgriff": Wir gehen reihum durch die Spieler und simulieren je einen
  // Abhebe-Schnitt. Trifft ein Spieler auf Pik-Dame/Joker, bekommt er die Karte
  // sofort und zählt beim normalen Austeilen als "übersprungen" für genau
  // eine Karte (er bekommt am Ende trotzdem exakt 15 Karten).
  for (const pid of playerIds) {
    if (remaining.length === 0) break;
    const cutIndex = Math.floor(Math.random() * remaining.length);
    const cutCard = remaining[cutIndex];
    const isLucky = cutCard.isJoker || isPikDame(cutCard);
    if (isLucky) {
      remaining.splice(cutIndex, 1);
      hands[pid].push(cutCard);
      luckyHits.push({ playerId: pid, card: cutCard });
    }
  }

  // Reguläres Austeilen: jeder Spieler bekommt Karten, bis er 15 hat
  // (Spieler mit Glücksgriff-Karte bekommen entsprechend eine weniger vom Stapel).
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

  return { hands, drawPile, discardPile, luckyHits };
}

module.exports = {
  createDeck,
  shuffle,
  dealWithGlucksgriff,
  HAND_SIZE,
};

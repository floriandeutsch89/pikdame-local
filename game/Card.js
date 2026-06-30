// game/Card.js
// Repräsentiert eine einzelne Spielkarte. Bei 2 Decks gibt es jede reguläre
// Karte zweimal (deckIndex 0/1) + 6 Joker insgesamt -> 2*52 + 6 = 110 Karten.

const SUITS = ['H', 'D', 'C', 'S']; // Herz, Karo, Kreuz, Pik
const SUIT_NAMES = { H: 'Herz', D: 'Karo', C: 'Kreuz', S: 'Pik' };
const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];

// Reihenfolge für Folgen (Sequenzen). Annahme: Ass zählt NUR hoch (nach König),
// nicht als "1" vor der 2. Das ist nicht explizit in den Regeln spezifiziert
// und kann in dieser Datei leicht angepasst werden (RANK_ORDER).
const RANK_ORDER = RANKS; // Index = Rangfolge, 0 = '2' ... 12 = 'A'

function rankIndex(rank) {
  return RANK_ORDER.indexOf(rank);
}

/**
 * Punktwert einer Karte für die Abrechnung.
 * - 2 bis 9: 5 Punkte
 * - 10: 10 Punkte
 * - Bube, Dame, König: 10 Punkte
 * - Ass, Joker: 20 Punkte
 * - Pik Dame (einzeln): 100 Punkte (Sonderfall, ersetzt den normalen Damen-Wert)
 *
 * Der Wert "100" für die Pik Dame ist die EINZIGE Strafe dafür – es gibt
 * keine zusätzliche Sonderstrafe obendrauf. Liegt sie am Rundenende auf der
 * Hand, fließt sie ganz normal mit 100 Punkten in die Minuspunkte (handValue)
 * ein. 2 Pik Damen auf der Hand ergeben entsprechend -200 Punkte insgesamt.
 */
function cardValue(card) {
  if (card.isJoker) return 20;
  if (card.rank === 'Q' && card.suit === 'S') return 100; // Pik Dame Sonderfall
  if (card.rank === 'A') return 20;
  if (card.rank === '10') return 10;
  if (['J', 'Q', 'K'].includes(card.rank)) return 10;
  return 5; // '2'..'9'
}

function isPikDame(card) {
  return !card.isJoker && card.rank === 'Q' && card.suit === 'S';
}

function cardLabel(card) {
  if (card.isJoker) return 'Joker';
  return `${SUIT_NAMES[card.suit]}-${card.rank}`;
}

function makeStandardCard(suit, rank, deckIndex) {
  return {
    id: `${suit}${rank}-${deckIndex}`,
    suit,
    rank,
    isJoker: false,
  };
}

function makeJoker(index) {
  return {
    id: `JOKER-${index}`,
    isJoker: true,
  };
}

module.exports = {
  SUITS,
  SUIT_NAMES,
  RANKS,
  RANK_ORDER,
  rankIndex,
  cardValue,
  isPikDame,
  cardLabel,
  makeStandardCard,
  makeJoker,
};

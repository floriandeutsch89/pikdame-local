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

/**
 * Mischt das Deck FAIR und UNVERZERRT mit dem Fisher-Yates-Algorithmus (auch
 * "Knuth Shuffle"). Fisher-Yates ist der Standard für faires Mischen: Jede der
 * n! möglichen Kartenreihenfolgen ist exakt gleich wahrscheinlich, sofern die
 * Zufallsquelle gleichverteilt ist. Damit hat jede Karte für jede Position die
 * gleiche Wahrscheinlichkeit.
 *
 * FAIRNESS / "Wie verhindert man, dass einer alle guten Karten bekommt?"
 * - Gar nicht durch Eingriff - und das ist Absicht. Die Verteilung ist REIN
 *   ZUFÄLLIG; es gibt bewusst KEIN "Ausbalancieren" der Hände (kein Nachbessern,
 *   kein Bevorzugen/Benachteiligen). Ein manipuliertes "Fairmachen" wäre in
 *   Wahrheit unfair und in keinem seriösen Kartenspiel üblich.
 * - Die Fairness liegt in der GLEICHVERTEILUNG: Weil jede Kartenanordnung gleich
 *   wahrscheinlich ist, hat jeder Spieler in JEDER Runde exakt die gleiche
 *   Chance auf die Pik Dame, Joker & Co. Kein Sitz und kein Spieler ist im Vorteil.
 * - In einer EINZELNEN Runde kann jemand Glück haben (das gehört zum Spiel);
 *   über viele Runden gleicht sich das statistisch aus.
 * - Vor jeder Runde wird ein KOMPLETT NEUES, volles 110-Karten-Deck erzeugt und
 *   frisch gemischt (siehe GameManager.startNewRound) - es gibt keine
 *   Übernahme/Fortschreibung aus der Vorrunde.
 *
 * Zufallsquelle:
 * - Standard: Math.random (der eingebaute PRNG der Laufzeit) - für ein
 *   Kartenspiel völlig ausreichend (es geht um Fairness, nicht um Kryptografie).
 * - Mit numerischem `seed`: deterministischer mulberry32-PRNG. So bekommt bei
 *   der Tages-Challenge JEDER Spieler weltweit das IDENTISCHE Deck - Fairness
 *   hier durch exakt gleiche Bedingungen für alle.
 *
 * @param {Array} deck zu mischendes Deck (wird nicht mutiert; es wird kopiert)
 * @param {number} [seed] optionaler Seed für ein reproduzierbares Deck
 * @returns {Array} eine neu gemischte Kopie
 */
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
  // FAMILY RULE (v1.71): cutting SETS A PACKET ASIDE. Everything BEFORE the
  // cut spot plus the cut card itself (the 'stopper') is put aside for the
  // round - not dealt, not in the draw pile. Only the part AFTER the stopper
  // is played with. Lucky cards (Queen of Spades / jokers AT the spot) still
  // go straight into the cutter's hand as before; the next ordinary card then
  // counts as the cut card and leaves with the packet.
  const idx0 = Math.max(0, Math.min(cutIndex, deck.length - 1));
  const isLucky = (card) => card && (card.isJoker || isPikDame(card));
  const luckyCards = [];
  let i = idx0;
  while (i < deck.length && isLucky(deck[i])) {
    luckyCards.push(deck[i]);
    i += 1;
  }
  const stopper = i < deck.length ? deck[i] : null;
  const setAside = deck.slice(0, idx0).concat(stopper ? [stopper] : []);
  const remaining = deck.slice(stopper ? i + 1 : i);
  return { luckyCards, remaining, stopper, setAside };
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

/** Exported for callers that need MORE seeded randomness than the shuffle
 *  itself (e.g. the lucky cut in a daily-challenge deal). */
function seededRandom(seed) {
  return mulberry32(seed >>> 0);
}

module.exports = {
  seededRandom,
  createDeck,
  shuffle,
  dealCards,
  performLuckyCut,
  HAND_SIZE,
};

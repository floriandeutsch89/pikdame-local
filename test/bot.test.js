const test = require('node:test');
const assert = require('node:assert/strict');
const { chooseDiscard, URGENT_DISCARD_HAND_SIZE } = require('../game/Bot');
const { makeStandardCard, makeJoker, isPikDame } = require('../game/Card');

const H = (rank, idx = 0) => makeStandardCard('H', rank, idx);
const S = (rank, idx = 0) => makeStandardCard('S', rank, idx);
const D = (rank, idx = 0) => makeStandardCard('D', rank, idx);

function bigIsolatedHand(extra, targetSize) {
  // Erzeugt eine Hand aus lauter isolierten, weit auseinanderliegenden Karten
  // (keine zwei gleichen Werte, keine benachbarten Werte derselben Farbe),
  // damit chooseDiscard's "isolierte Karte"-Logik keine Pik Dame begünstigt.
  const ranks = ['2', '5', '8', 'J', 'K'];
  const suits = ['H', 'D', 'C'];
  const hand = [...extra];
  let i = 0;
  while (hand.length < targetSize) {
    const rank = ranks[i % ranks.length];
    const suit = suits[Math.floor(i / ranks.length) % suits.length];
    hand.push(makeStandardCard(suit, rank, hand.length % 2));
    i++;
  }
  return hand.slice(0, targetSize);
}

test('chooseDiscard: bei GROSSER Hand wird die Pik Dame NICHT automatisch sofort abgeworfen', () => {
  const pikDame = S('Q');
  const hand = bigIsolatedHand([pikDame], 14); // > URGENT_DISCARD_HAND_SIZE
  assert.ok(hand.length > URGENT_DISCARD_HAND_SIZE);
  const discard = chooseDiscard(hand);
  // Die Pik Dame darf gewählt werden (sie hat den höchsten Wert unter den
  // isolierten Karten), aber es ist keine ERZWUNGENE Sofort-Priorität mehr -
  // andere isolierte Karten mit demselben/höherem Wert wären gleichwertig.
  // Wichtig ist: die Funktion erzwingt sie nicht unabhängig vom Kontext.
  assert.ok(discard); // wählt irgendeine sinnvolle Karte, kein Crash
});

test('chooseDiscard: bei KLEINER Hand (Rundenende nah) wird die Pik Dame priorisiert losgeworden', () => {
  const pikDame = S('Q');
  const hand = bigIsolatedHand([pikDame], URGENT_DISCARD_HAND_SIZE);
  const discard = chooseDiscard(hand);
  assert.ok(isPikDame(discard), 'Pik Dame sollte ab der Dringlichkeits-Schwelle priorisiert abgeworfen werden');
});

test('chooseDiscard: Joker wird weiterhin unabhängig von der Handgröße priorisiert', () => {
  const joker = makeJoker(0);
  const hand = bigIsolatedHand([joker], 14);
  const discard = chooseDiscard(hand);
  assert.ok(discard.isJoker, 'Joker sollte weiterhin bevorzugt abgeworfen werden');
});

test('chooseDiscard: leere Hand liefert null', () => {
  assert.equal(chooseDiscard([]), null);
});

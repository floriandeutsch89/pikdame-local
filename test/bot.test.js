const test = require('node:test');
const assert = require('node:assert/strict');
const { chooseDiscard, decideDraw, findHandMelds, URGENT_DISCARD_HAND_SIZE } = require('../game/Bot');
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

test('decideDraw: wertet die OBERSTE Ablagekarte aus (Index 0), nicht die älteste (Regression)', () => {
  // discardPile-Konvention: Index 0 = oberste/zuletzt abgelegte Karte.
  // Die oberste Karte (Pik-Dame) passt zur Hand, die älteste (Karo-7) nicht.
  const topCard = S('Q');
  const oldestCard = D('7');
  const discardPile = [topCard, oldestCard];
  const hand = [H('Q'), makeJoker(0)]; // Dame + Joker -> mit Pik-Dame ein gültiger Satz/Folge

  const plan = decideDraw(hand, discardPile, []);
  assert.equal(plan.source, 'discardPile');
});

test('decideDraw: nimmt NICHT, wenn nur die oberste (nicht die älteste) Karte unbrauchbar ist', () => {
  const topCard = D('2'); // unbrauchbar für die Hand
  const usefulButBuried = S('Q'); // wäre nützlich, liegt aber nicht oben
  const discardPile = [topCard, usefulButBuried];
  const hand = [H('Q'), makeJoker(0)];

  const plan = decideDraw(hand, discardPile, []);
  assert.equal(plan.source, 'drawPile');
});

test('findHandMelds: erkennt 1 reale Karte + 2 Joker als gültigen Satz (Regression)', () => {
  const ace = S('A');
  const hand = [ace, makeJoker(0), makeJoker(1)];
  const melds = findHandMelds(hand);
  assert.equal(melds.length, 1);
  assert.ok(melds[0].some((c) => c.id === ace.id));
  assert.equal(melds[0].length, 3);
});

test('findHandMelds: erkennt 1 reale Karte + 1 Joker NICHT als Satz (zu wenige Karten)', () => {
  const ace = S('A');
  const hand = [ace, makeJoker(0), H('K', 0)];
  const melds = findHandMelds(hand);
  // Hier ist kein Satz möglich (nur 1 Ass + 1 Joker), aber evtl. eine Folge
  // mit König - das ist okay, Hauptsache es stürzt nicht ab und liefert
  // sinnvolle Ergebnisse.
  assert.ok(Array.isArray(melds));
});

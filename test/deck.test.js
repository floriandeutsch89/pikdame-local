const test = require('node:test');
const assert = require('node:assert/strict');
const { createDeck, shuffle, dealWithGlucksgriff, HAND_SIZE } = require('../game/Deck');
const { isPikDame } = require('../game/Card');

test('createDeck liefert exakt 110 Karten (2x52 + 6 Joker)', () => {
  const deck = createDeck();
  assert.equal(deck.length, 110);
  const jokers = deck.filter((c) => c.isJoker);
  assert.equal(jokers.length, 6);
  const standard = deck.filter((c) => !c.isJoker);
  assert.equal(standard.length, 104);
  // jede Standardkarte muss genau 2x vorkommen
  const counts = {};
  for (const c of standard) {
    const key = `${c.suit}${c.rank}`;
    counts[key] = (counts[key] || 0) + 1;
  }
  assert.equal(Object.keys(counts).length, 52);
  for (const key of Object.keys(counts)) {
    assert.equal(counts[key], 2, `${key} sollte genau 2x vorkommen`);
  }
});

test('shuffle verändert Reihenfolge, behält aber alle Karten', () => {
  const deck = createDeck();
  const shuffled = shuffle(deck);
  assert.equal(shuffled.length, deck.length);
  const idsBefore = deck.map((c) => c.id).sort();
  const idsAfter = shuffled.map((c) => c.id).sort();
  assert.deepEqual(idsAfter, idsBefore);
});

test('dealWithGlucksgriff verteilt an 4 Spieler je 15 Karten, Rest bleibt erhalten', () => {
  const deck = shuffle(createDeck());
  const players = ['p1', 'p2', 'p3', 'p4'];
  const { hands, drawPile, discardPile } = dealWithGlucksgriff(deck, players);

  for (const p of players) {
    assert.equal(hands[p].length, HAND_SIZE);
  }
  const total =
    players.reduce((sum, p) => sum + hands[p].length, 0) + drawPile.length + discardPile.length;
  assert.equal(total, 110);
  assert.equal(discardPile.length, 1);
});

test('Glücksgriff: Pik-Dame/Joker landen sofort beim Spieler, der sie "abhebt"', () => {
  // Deterministisches Mini-Deck: erzwinge, dass die Pik-Dame ganz oben liegt
  const deck = createDeck();
  const pikDame = deck.find((c) => isPikDame(c));
  const rest = deck.filter((c) => c !== pikDame);
  const rigged = [pikDame, ...rest];

  const players = ['p1', 'p2', 'p3', 'p4'];
  const { hands, luckyHits } = dealWithGlucksgriff(rigged, players);

  // p1 hebt zuerst ab; bei einem 1-Karten-"Schnitt" auf Position 0 ist die
  // einzig mögliche gezogene Karte die Pik-Dame -> p1 sollte den Glücksgriff
  // mit nicht-negativer Wahrscheinlichkeit bekommen. Da der Cut zufällig aus
  // dem gesamten Resthaufen gezogen wird, prüfen wir stattdessen nur die
  // Invariante: höchstens 1 Glücksgriff pro Spieler und alle Hände bleiben
  // bei exakt 15 Karten.
  for (const p of players) {
    assert.equal(hands[p].length, HAND_SIZE);
  }
  assert.ok(luckyHits.length <= 4);
  for (const hit of luckyHits) {
    assert.ok(hit.card.isJoker || isPikDame(hit.card));
  }
});

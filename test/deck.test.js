const test = require('node:test');
const assert = require('node:assert/strict');
const { createDeck, shuffle, dealCards, HAND_SIZE } = require('../game/Deck');

test('createDeck liefert exakt 110 Karten (2x52 + 6 Joker)', () => {
  const deck = createDeck();
  assert.equal(deck.length, 110);
  const jokers = deck.filter((c) => c.isJoker);
  assert.equal(jokers.length, 6);
  const standard = deck.filter((c) => !c.isJoker);
  assert.equal(standard.length, 104);
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

test('dealCards verteilt an 4 Spieler je 15 Karten, Rest bleibt erhalten', () => {
  const deck = shuffle(createDeck());
  const players = ['p1', 'p2', 'p3', 'p4'];
  const { hands, drawPile, discardPile } = dealCards(deck, players);

  for (const p of players) {
    assert.equal(hands[p].length, HAND_SIZE);
  }
  const total =
    players.reduce((sum, p) => sum + hands[p].length, 0) + drawPile.length + discardPile.length;
  assert.equal(total, 110);
  assert.equal(discardPile.length, 1);
});

test('dealCards funktioniert auch mit 2 oder 3 Spielern', () => {
  for (const playerCount of [2, 3]) {
    const deck = shuffle(createDeck());
    const players = Array.from({ length: playerCount }, (_, i) => `p${i + 1}`);
    const { hands, drawPile, discardPile } = dealCards(deck, players);
    for (const p of players) {
      assert.equal(hands[p].length, HAND_SIZE);
    }
    const total =
      players.reduce((sum, p) => sum + hands[p].length, 0) + drawPile.length + discardPile.length;
    assert.equal(total, 110);
  }
});

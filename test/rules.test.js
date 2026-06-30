const test = require('node:test');
const assert = require('node:assert/strict');
const { validateSet, validateRun, validateMeld, tryLayOff, tryJokerSwap } = require('../game/Rules');
const { makeStandardCard, makeJoker } = require('../game/Card');

const H = (rank, idx = 0) => makeStandardCard('H', rank, idx);
const D = (rank, idx = 0) => makeStandardCard('D', rank, idx);
const C = (rank, idx = 0) => makeStandardCard('C', rank, idx);
const S = (rank, idx = 0) => makeStandardCard('S', rank, idx);
const J = (i) => makeJoker(i);

test('validateSet: 3 gleiche Werte, verschiedene Farben ist gültig', () => {
  const r = validateSet([H('D'), D('D'), C('D')]);
  assert.equal(r.valid, true);
  assert.equal(r.type, 'set');
});

test('validateSet: gleiche Farbe bis zu 2x ist gültig (2 Decks im Spiel)', () => {
  const r = validateSet([H('D'), H('D', 1), C('D')]);
  assert.equal(r.valid, true);
  assert.equal(r.type, 'set');
});

test('validateSet: dieselbe Farbe 3x (mehr als 2 Kopien) ist ungültig', () => {
  // Es gibt nur 2 Kopien jeder Karte (2 Decks) - 3x dieselbe Farbe ist also unmöglich
  const r = validateSet([H('D', 0), H('D', 1), H('D', 2)]);
  assert.equal(r.valid, false);
});

test('validateSet: 2x Kreuz-Ass + 1x Herz-Ass ist ein gültiger Satz', () => {
  const r = validateSet([C('A', 0), C('A', 1), H('A')]);
  assert.equal(r.valid, true);
  assert.equal(r.rank, 'A');
});

test('validateSet: unterschiedliche Werte sind ungültig', () => {
  const r = validateSet([H('D'), D('K'), C('D')]);
  assert.equal(r.valid, false);
});

test('validateSet: Joker füllt fehlende Farbe im Satz', () => {
  const r = validateSet([H('D'), D('D'), J(0)]);
  assert.equal(r.valid, true);
  const jokerSlot = r.slots.find((s) => s.joker);
  assert.equal(jokerSlot.representsRank, 'D');
});

test('validateRun: 3 aufeinanderfolgende Werte gleicher Farbe ist gültig', () => {
  const r = validateRun([H('7'), H('8'), H('9')]);
  assert.equal(r.valid, true);
  assert.equal(r.type, 'run');
});

test('validateRun: gemischte Farben sind ungültig', () => {
  const r = validateRun([H('7'), D('8'), H('9')]);
  assert.equal(r.valid, false);
});

test('validateRun: Joker schließt eine Lücke in der Folge', () => {
  const r = validateRun([H('7'), J(0), H('9')]);
  assert.equal(r.valid, true);
  const jokerSlot = r.slots.find((s) => s.joker);
  assert.equal(jokerSlot.representsRank, '8');
  assert.equal(jokerSlot.representsSuit, 'H');
});

test('validateMeld: erkennt automatisch Satz vs. Folge', () => {
  assert.equal(validateMeld([H('D'), D('D'), C('D')]).type, 'set');
  assert.equal(validateMeld([H('7'), H('8'), H('9')]).type, 'run');
});

test('tryLayOff: Karte kann an passende Folge angelegt werden (oben)', () => {
  const meld = validateRun([H('7'), H('8'), H('9')]);
  const result = tryLayOff(meld, H('10'));
  assert.ok(result);
  assert.equal(result.slots.length, 4);
});

test('tryLayOff: falsche Farbe kann nicht angelegt werden', () => {
  const meld = validateRun([H('7'), H('8'), H('9')]);
  const result = tryLayOff(meld, D('10'));
  assert.equal(result, null);
});

test('tryLayOff: vierte passende Farbe kann an Satz angelegt werden', () => {
  const meld = validateSet([H('D'), D('D'), C('D')]);
  const result = tryLayOff(meld, S('D'));
  assert.ok(result);
  assert.equal(result.slots.length, 4);
});

test('tryLayOff: zweite Kopie einer bereits genutzten Farbe kann angelegt werden (2 Decks)', () => {
  const meld = validateSet([H('D', 0), D('D', 0), C('D', 0)]);
  const result = tryLayOff(meld, H('D', 1)); // zweite Kopie Herz-Dame aus Deck 2
  assert.ok(result);
  assert.equal(result.slots.length, 4);
});

test('tryLayOff: dritte Kopie derselben Farbe (über die 2 Decks hinaus) ist nicht möglich', () => {
  const meld = validateSet([H('D', 0), H('D', 1), C('D', 0)]);
  const result = tryLayOff(meld, H('D', 2)); // es gibt aber gar keine dritte Kopie
  assert.equal(result, null);
});

test('tryJokerSwap: echte Karte tauscht passenden Joker aus der Auslage', () => {
  const meld = validateSet([H('D'), D('D'), J(0)]);
  const jokerSlot = meld.slots.find((s) => s.joker);
  const handCard = makeStandardCard(jokerSlot.representsSuit, jokerSlot.representsRank, 1);
  const result = tryJokerSwap(meld, handCard);
  assert.ok(result);
  assert.ok(result.freedJoker.isJoker);
  assert.ok(result.meld.slots.every((s) => !s.joker || s !== jokerSlot));
});

test('tryJokerSwap: nicht passende Karte tauscht nichts', () => {
  const meld = validateSet([H('D'), D('D'), J(0)]);
  const result = tryJokerSwap(meld, H('K'));
  assert.equal(result, null);
});

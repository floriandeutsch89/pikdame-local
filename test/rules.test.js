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

test('validateSet: gleiche Farbe doppelt ist ungültig', () => {
  const r = validateSet([H('D'), H('D', 1), C('D')]);
  assert.equal(r.valid, false);
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

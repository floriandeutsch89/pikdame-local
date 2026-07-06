const test = require('node:test');
const assert = require('node:assert');
const GameManager = require('../game/GameManager');
const SE = require('../game/StateEncoder');
const { makeStandardCard: mk, makeJoker } = require('../game/Card');

function game2() {
  const g = new GameManager(() => {});
  g.addOrReconnectPlayer('p1', 'A');
  g.addOrReconnectPlayer('p2', 'B');
  g.startNewRound();
  return g;
}

test('encode produces a fixed-length vector matching OBS_SIZE', () => {
  const g = game2();
  const obs = SE.encode(g, 'p1');
  assert.equal(obs.length, SE.OBS_SIZE);
  assert.ok(obs instanceof Float32Array);
  // all features are finite and within a sane range
  for (const x of obs) assert.ok(Number.isFinite(x) && x >= -1.01 && x <= 2.01);
  g.destroy();
});

test('encode is deterministic for the same state', () => {
  const g = game2();
  const a = SE.encode(g, 'p1');
  const b = SE.encode(g, 'p1');
  assert.deepEqual(Array.from(a), Array.from(b));
  g.destroy();
});

test('discard mask marks exactly the non-joker hand card types', () => {
  const g = game2();
  const p1 = g.players.find((p) => p.id === 'p1');
  p1.hand = [mk('H', '7', 0), mk('S', '9', 0), makeJoker(0), mk('H', '7', 1)];
  const mask = SE.actionMask(g, 'p1', { phase: 'discard' });
  assert.equal(mask.length, SE.ACTION_SIZE);
  assert.equal(mask.filter(Boolean).length, 2);
  assert.equal(mask[SE.typeIndex(mk('H', '7', 0))], true);
  assert.equal(mask[SE.typeIndex(mk('S', '9', 0))], true);
  g.destroy();
});

test('draw mask offers draw-pile always and take-pile only when legal', () => {
  const g = game2();
  const legalOn = SE.actionMask(g, 'p1', { phase: 'draw', pileTakeLegal: true });
  assert.equal(legalOn[SE.ACTION_DRAW_PILE], true);
  assert.equal(legalOn[SE.ACTION_TAKE_PILE], true);
  assert.equal(legalOn.filter(Boolean).length, 2);
  const legalOff = SE.actionMask(g, 'p1', { phase: 'draw', pileTakeLegal: false });
  assert.equal(legalOff[SE.ACTION_DRAW_PILE], true);
  assert.equal(legalOff[SE.ACTION_TAKE_PILE], false);
  assert.equal(legalOff.filter(Boolean).length, 1);
  g.destroy();
});

test('encode carries the decision-phase flag', () => {
  const g = game2();
  const draw = SE.encode(g, 'p1', { phase: 'draw' });
  const disc = SE.encode(g, 'p1', { phase: 'discard' });
  assert.equal(draw.length, SE.OBS_SIZE);
  assert.notDeepEqual(Array.from(draw), Array.from(disc), 'phase flag differs');
  assert.equal(draw[SE.OBS_SIZE - 1], 1);
  assert.equal(disc[SE.OBS_SIZE - 1], 0);
  g.destroy();
});

test('cardForAction returns a real hand card of the chosen type, never a joker', () => {
  const g = game2();
  const p1 = g.players.find((p) => p.id === 'p1');
  p1.hand = [mk('H', '7', 0), makeJoker(0)];
  const idx = SE.typeIndex(mk('H', '7', 0));
  const card = SE.cardForAction(g, 'p1', idx);
  assert.ok(card && card.rank === '7' && card.suit === 'H' && !card.isJoker);
  g.destroy();
});

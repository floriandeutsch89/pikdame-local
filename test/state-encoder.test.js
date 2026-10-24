const test = require('node:test');
const assert = require('node:assert');
const GameManager = require('../game/GameManager');
const SE = require('../game/StateEncoder');
const { makeStandardCard: mk, makeJoker } = require('../game/Card');

// v1.67 interactive cutting: unit tests exercise the game AFTER the deal, so
// every locally constructed game auto-cuts. Dedicated cutting tests live in
// test/cutting.test.js and do NOT use this hook.
function __autoCutHook(g) {
  const orig = g.startNewRound.bind(g);
  g.startNewRound = (...a) => {
    orig(...a);
    if (g.phase === 'cutting') g.performCut(g.cutterId, 0.5);
  };
  return g;
}


function game2() {
  const g = __autoCutHook(new GameManager(() => {}));
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

// --- contract: models/pikdame-zen.onnx reads v1, a v2 net v1 + the team block ---

test('contract: v1 = 377, v2 = 385 (v1 + 8 team features), 54 actions; the default stays v1', () => {
  assert.equal(SE.OBS_SIZE_V1, 377);
  assert.equal(SE.OBS_SIZE_V2, 385);
  assert.equal(SE.TEAM_FEATURES, 8);
  assert.equal(SE.ACTION_SIZE, 54);
  assert.equal(SE.OBS_SIZE, SE.OBS_SIZE_V1);
  assert.equal(SE.obsSize(1), 377);
  assert.equal(SE.obsSize(2), 385);
  assert.equal(SE.versionForSize(377), 1);
  assert.equal(SE.versionForSize(385), 2);
  assert.equal(SE.versionForSize(400), null);
  assert.throws(() => SE.obsSize(3), /unknown observation version/);
  const g = game2();
  assert.equal(SE.encode(g, 'p1').length, 377);
  assert.throws(() => SE.encode(g, 'p1', { version: 3 }), /unknown observation version/);
  g.destroy();
});

// A fixed state, encoded by the v1 encoder as shipped with models/pikdame-zen.onnx:
// any change to the v1 layout or scaling breaks that model and fails here.
function goldenState() {
  return {
    players: [
      { id: 'me', hand: [mk('H', '7', 0), mk('H', '8', 0), mk('S', 'Q', 0), mk('H', '7', 1), makeJoker(0)], laidOutCards: [mk('C', 'K', 0), mk('C', 'K', 1), mk('D', 'K', 0)] },
      { id: 'o1', hand: Array.from({ length: 9 }, (_, i) => mk('D', String(2 + (i % 8)), 0)), laidOutCards: [] },
      { id: 'o2', hand: [mk('C', 'A', 0), mk('C', '2', 1)], laidOutCards: [] },
    ],
    tableMelds: [{ slots: [{ real: mk('C', 'K', 0) }, { real: mk('C', 'K', 1) }, { real: mk('D', 'K', 0) }, { joker: makeJoker(1) }] }],
    discardPile: [mk('D', '5', 1), { ...mk('S', '2', 0), faceDown: true }, mk('H', 'A', 0)],
    publicKnownHands: { o1: [mk('H', '9', 1)], o2: [mk('C', 'A', 0)] },
    totals: { me: 120, o1: 300, o2: -40 },
    drawPile: new Array(40).fill(null),
  };
}
// Non-zero [index, value] pairs at the discard decision; 158..209 (unseen copies) run-length coded.
const GOLDEN_V1 = [
  [5, 1], [6, 0.5], [49, 0.5], [52, 0.166667], [65, 0.5], [69, 0.5], [77, 0.5], [90, 1], [121, 1],
  [163, 0], [164, 0.5], [165, 0.5], [170, 0.5], [174, 0.5], [182, 0.5], [195, 0], [196, 0.5], [207, 0.5],
  [210, 0.6], [218, 0.5], [263, 0.133333], [302, 0.5],
  [369, 0.363636], [370, 0.027273], [371, 0.1], [372, 0.45], [373, 0.25], [374, 0.133333], [375, -0.9],
];

test('contract: the v1 layout is frozen (golden encoding of a fixed state)', () => {
  const expected = new Array(377).fill(0);
  for (let i = 158; i <= 209; i++) expected[i] = 1; // unseen copies: most types fully unseen
  for (const [i, x] of GOLDEN_V1) expected[i] = x;
  const disc = Array.from(SE.encode(goldenState(), 'me', { phase: 'discard' }));
  const draw = Array.from(SE.encode(goldenState(), 'me', { phase: 'draw' }));
  for (let i = 0; i < 377; i++) {
    assert.ok(Math.abs(disc[i] - expected[i]) < 1e-6, `v1[${i}] = ${disc[i]}, expected ${expected[i]}`);
    assert.ok(Math.abs(draw[i] - (i === 376 ? 1 : expected[i])) < 1e-6, `draw v1[${i}]`);
  }
});

function botGame(n, options = {}) {
  const g = __autoCutHook(new GameManager(() => {}, options));
  g.maybeRunBotTurn = () => {};
  g.players = Array.from({ length: n }, (_, i) => ({
    id: `b${i}`, name: `B${i}`, isBot: true, hand: [], connected: true, laidOutCards: [], botDifficulty: 'hard',
  }));
  for (const p of g.players) g.totals[p.id] = 0;
  g.maxSeats = n;
  g.startNewRound();
  return g;
}

function playTurns(g, turns) {
  for (let t = 0; t < turns && g.phase === 'playing'; t++) g.runBotTurn(g.currentPlayer().id);
}

test('v2 starts with v1 unchanged; the team block is all 0 in normal games of 2-4 players', () => {
  for (const n of [2, 3, 4]) {
    const g = botGame(n);
    playTurns(g, 7);
    for (const p of g.players) {
      for (const phase of ['draw', 'discard']) {
        const v1 = SE.encode(g, p.id, { phase });
        const v2 = SE.encode(g, p.id, { phase, version: 2 });
        assert.equal(v2.length, SE.OBS_SIZE_V2);
        assert.deepEqual(Array.from(v2.slice(0, SE.OBS_SIZE_V1)), Array.from(v1), `${n} players: prefix`);
        assert.deepEqual(Array.from(v2.slice(SE.OBS_SIZE_V1)), new Array(SE.TEAM_FEATURES).fill(0), `${n} players: team block`);
      }
    }
    g.destroy();
  }
});

test('v2 team block: team flag and the partner flag in the right opponent slot for every seat', () => {
  const g = botGame(4, { teamMode: true });
  playTurns(g, 9);
  g.players.forEach((p, seat) => {
    const v1 = SE.encode(g, p.id, { phase: 'discard' });
    const v2 = SE.encode(g, p.id, { phase: 'discard', version: 2 });
    assert.deepEqual(Array.from(v2.slice(0, SE.OBS_SIZE_V1)), Array.from(v1), `seat ${seat}: v1 prefix`);
    const block = Array.from(v2.slice(SE.OBS_SIZE_V1));
    assert.deepEqual(block, SE.teamFeatures(g, p.id).map((x) => Math.fround(x)));
    assert.equal(block[0], 1, 'team mode');
    // Opponent slots list the other seats in seat order; the partner sits opposite.
    const others = [0, 1, 2, 3].filter((s) => s !== seat);
    assert.deepEqual(block.slice(1, 4), others.map((s) => (s === (seat + 2) % 4 ? 1 : 0)), `seat ${seat}: partner slot`);
    assert.equal(g.partnerOf(p.id).id, g.players[others[block.slice(1, 4).indexOf(1)]].id);
  });
  g.destroy();
});

test('v2 team block: shared totals over the 2000 target (clipped), partner hand, smallest rival hand', () => {
  const g = botGame(4, { teamMode: true });
  g.totals = { b0: 900, b1: -100, b2: 700, b3: -300 };
  g.players[0].hand = g.players[0].hand.slice(0, 15);
  g.players[2].hand = g.players[2].hand.slice(0, 6);
  g.players[1].hand = g.players[1].hand.slice(0, 4);
  g.players[3].hand = g.players[3].hand.slice(0, 11);
  const a = SE.teamFeatures(g, 'b0');
  assert.ok(Math.abs(a[4] - 1600 / 2000) < 1e-9, 'own team');
  assert.ok(Math.abs(a[5] - -400 / 2000) < 1e-9, 'other team');
  assert.ok(Math.abs(a[6] - 6 / 15) < 1e-9, 'partner hand');
  assert.ok(Math.abs(a[7] - 4 / 15) < 1e-9, 'smallest rival hand');
  const b = SE.teamFeatures(g, 'b3');
  assert.ok(Math.abs(b[4] - -400 / 2000) < 1e-9 && Math.abs(b[5] - 1600 / 2000) < 1e-9, 'the other side sees it mirrored');
  assert.ok(Math.abs(b[6] - 4 / 15) < 1e-9 && Math.abs(b[7] - 6 / 15) < 1e-9);
  g.totals = { b0: 2500, b1: -2400, b2: 600, b3: 0 };
  const c = SE.teamFeatures(g, 'b1');
  assert.equal(c[4], -1, 'clipped below');
  assert.equal(c[5], 1, 'clipped above');
  g.destroy();
});

test('the action mask does not depend on the observation version', () => {
  const g = botGame(4, { teamMode: true });
  const p = g.players[0].id;
  assert.deepEqual(SE.actionMask(g, p, { phase: 'discard', version: 2 }), SE.actionMask(g, p, { phase: 'discard' }));
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

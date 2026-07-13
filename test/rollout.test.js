const test = require('node:test');
const assert = require('node:assert');
const GameManager = require('../game/GameManager');
const Rollout = require('../game/Rollout');
const { makeStandardCard: mk } = require('../game/Card');

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


function midRound(difficulties) {
  const g = __autoCutHook(new GameManager(() => {}));
  g.addOrReconnectPlayer('h', 'H');
  g.fillWithBots();
  g.players = difficulties.map((d, i) => ({
    id: `b${i}`, name: `B${i}`, isBot: true, hand: [], connected: true,
    laidOutCards: [], botDifficulty: d, _everLaidThisRound: false, _laidAtTurnStart: false,
  }));
  g.maxSeats = difficulties.length;
  g.startNewRound();
  return g;
}

test('cloneHeadless is independent and marked no-mcts (prevents rollout recursion)', () => {
  const g = midRound(['zen', 'hard']);
  const clone = Rollout.cloneHeadless(GameManager, g, 'zen');
  assert.equal(clone._noMcts, true);
  clone.players[0].hand.push(mk('H', '7', 0));
  assert.notEqual(clone.players[0].hand.length, g.players[0].hand.length, 'deep-copied, not shared');
  clone.destroy(); g.destroy();
});

test('determinize keeps my hand, respects opponent sizes, stays counting-consistent', () => {
  const g = midRound(['zen', 'hard', 'hard']);
  g.turnPhase = 'meld'; g.currentPlayerIndex = 0;
  const myHand = g.players[0].hand.map((c) => c.id);
  const clone = Rollout.cloneHeadless(GameManager, g, 'zen');
  Rollout.determinize(clone, 'b0', Math.random);
  // my hand untouched
  assert.deepEqual(clone.players[0].hand.map((c) => c.id), myHand);
  // opponents keep their sizes
  assert.equal(clone.players[1].hand.length, g.players[1].hand.length);
  // no card value appears more than its 2-deck copies across hidden zones
  const all = [
    ...clone.players.flatMap((p) => p.hand),
    ...clone.drawPile,
    ...clone.discardPile,
    ...clone.tableMelds.flatMap((m) => m.slots.map((s) => s.real).filter(Boolean)),
  ];
  const counts = {};
  for (const c of all) {
    if (c.isJoker) continue;
    const k = `${c.suit}${c.rank}`;
    counts[k] = (counts[k] || 0) + 1;
  }
  assert.ok(Object.values(counts).every((n) => n <= 2), 'no rank/suit exceeds two deck copies');
  clone.destroy(); g.destroy();
});

test('chooseDiscardByRollout returns one of the candidates and terminates within budget', () => {
  const g = midRound(['zen', 'hard', 'hard']);
  g.turnPhase = 'meld'; g.currentPlayerIndex = 0;
  const b0 = g.players[0];
  b0.hand = [mk('H', '7', 0), mk('S', '9', 0), mk('C', 'K', 0), mk('D', '4', 0)];
  const t0 = Date.now();
  const pick = Rollout.chooseDiscardByRollout(GameManager, g, 'b0', b0.hand, {
    determinizations: 6, difficulty: 'zen', budgetMs: 500,
  });
  assert.ok(Date.now() - t0 < 4000, 'terminates promptly');
  assert.ok(b0.hand.some((c) => c.id === pick.id), 'returns a real candidate');
  g.destroy();
});

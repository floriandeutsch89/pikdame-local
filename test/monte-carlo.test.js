const test = require('node:test');
const assert = require('node:assert');
const MC = require('../game/MonteCarlo');
const Bot = require('../game/Bot');
const { makeStandardCard: mk, makeJoker } = require('../game/Card');

test('buildUnseenPool: full 110-card deck minus known, duplicates consumed one at a time', () => {
  assert.equal(MC.buildUnseenPool([]).length, 110);
  // Remove ONE red king -> 109 left, and its twin is still in the pool
  const pool = MC.buildUnseenPool([mk('H', 'K', 0)]);
  assert.equal(pool.length, 109);
  const kingsLeft = pool.filter((c) => c.suit === 'H' && c.rank === 'K').length;
  assert.equal(kingsLeft, 1, 'second heart king still unseen');
  // Jokers: 6 total, remove 2
  assert.equal(MC.buildUnseenPool([makeJoker(0), makeJoker(1)]).filter((c) => c.isJoker).length, 4);
});

test('discardMeldRisk: a card completing a known opponent set scores far higher than a lone card', () => {
  const cands = [mk('C', '9', 0), mk('D', '2', 0)];
  const risk = MC.discardMeldRisk({
    ownHand: [mk('C', '9', 0), mk('D', '2', 0)],
    visibleCards: [],
    nextHandSize: 6,
    nextKnownCards: [mk('S', '9', 0), mk('H', '9', 0)], // two nines already known in their hand
    candidates: cands,
    samples: 200,
    seed: 7,
  });
  assert.equal(risk.get(cands[0].id), 1, 'nine completes their known set -> certain');
  assert.ok(risk.get(cands[1].id) < 0.6, 'lone two is much safer');
});

test('discardMeldRisk: deterministic under a fixed seed', () => {
  const cand = [mk('C', '7', 0)];
  const args = {
    ownHand: [mk('C', '7', 0)], visibleCards: [], nextHandSize: 8,
    nextKnownCards: [], candidates: cand, samples: 120, seed: 123,
  };
  const a = MC.discardMeldRisk(args).get(cand[0].id);
  const b = MC.discardMeldRisk(args).get(cand[0].id);
  assert.equal(a, b, 'same seed -> same estimate');
});

test('chooseDiscard is unchanged when no mcRisk map is supplied (production default)', () => {
  const hand = [mk('H', '7', 0), mk('S', '9', 0), mk('C', 'K', 0), mk('D', '4', 0)];
  const a = Bot.chooseDiscard(hand, [], { difficulty: 'zen', lowestOpponentHand: 3 });
  const b = Bot.chooseDiscard(hand, [], { difficulty: 'zen', lowestOpponentHand: 3 });
  assert.equal(a.id, b.id, 'stable');
  // Supplying an empty map with weight 0 must not change the pick either
  const c = Bot.chooseDiscard(hand, [], {
    difficulty: 'zen', lowestOpponentHand: 3, mcRisk: new Map(), mcWeight: 0,
  });
  assert.equal(c.id, a.id, 'empty MC map is a no-op');
});

test('chooseDiscard endgame: a heavy mcRisk on the top-value card pushes it out of the dump', () => {
  // Endgame path (lowestOpponentHand <= 4) dumps the highest-value card. The
  // king is the natural dump; flag it via MC as certain to help the opponent
  // and expect the bot to keep it and dump something else instead.
  const hand = [mk('H', '7', 0), mk('D', '4', 0), mk('C', 'K', 0), mk('S', '8', 0)];
  const king = hand[2];
  const plain = Bot.chooseDiscard(hand, [], { difficulty: 'zen', lowestOpponentHand: 3 });
  assert.equal(plain.id, king.id, 'without MC the king (top value) is dumped');
  const mcRisk = new Map([[king.id, 1]]);
  const pick = Bot.chooseDiscard(hand, [], {
    difficulty: 'zen', lowestOpponentHand: 3, mcRisk, mcWeight: 50,
  });
  assert.notEqual(pick.id, king.id, 'MC-flagged king is spared');
});

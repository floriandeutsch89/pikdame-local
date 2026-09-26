// Daily puzzle: seeded hand, exhaustive optimum, engine-graded answers and
// the per-player attempt bookkeeping in PlayerStore.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { puzzleForDate, publicPuzzle, checkAnswer, searchMelds, HAND_SIZE, MIN_BEST_POINTS } = require('../game/DailyPuzzle');
const { validateMeld } = require('../game/Rules');
const { cardValue, makeStandardCard } = require('../game/Card');
const { createPlayerStore } = require('../game/PlayerStore');

test('puzzleForDate: deterministic, joker-free, and the optimum is a valid meld with the claimed points', () => {
  const a = puzzleForDate('2026-09-26');
  const b = puzzleForDate('2026-09-26');
  assert.deepStrictEqual(a.hand.map((c) => c.id), b.hand.map((c) => c.id), 'same date, same hand');
  assert.notDeepStrictEqual(a.hand.map((c) => c.id), puzzleForDate('2026-09-27').hand.map((c) => c.id));
  assert.strictEqual(a.hand.length, HAND_SIZE);
  assert.ok(a.hand.every((c) => !c.isJoker), 'no jokers');
  const bestCards = a.best.cardIds.map((id) => a.hand.find((c) => c.id === id));
  assert.ok(validateMeld(bestCards).valid, 'optimum is a valid meld');
  assert.strictEqual(bestCards.reduce((n, c) => n + cardValue(c), 0), a.best.points);
  assert.ok(a.best.points >= MIN_BEST_POINTS);
  // No valid subset beats the optimum (brute force, independently).
  const { best } = searchMelds(a.hand);
  assert.strictEqual(best.points, a.best.points);
});

test('publicPuzzle hides the solution', () => {
  const pub = publicPuzzle(puzzleForDate('2026-09-26'));
  assert.deepStrictEqual(Object.keys(pub).sort(), ['date', 'hand', 'targetPoints']);
});

test('checkAnswer: grades the optimum as solved, a weaker meld as valid, junk as invalid', () => {
  const p = puzzleForDate('2026-09-26');
  const ok = checkAnswer(p, p.best.cardIds);
  assert.strictEqual(ok.solved, true);
  assert.ok(!('type' in ok), 'result must not carry a `type` key - it is spread into a WebSocket message');
  // A hand-built puzzle with a known weaker answer.
  const hand = [
    makeStandardCard('H', '2', 0), makeStandardCard('H', '3', 0), makeStandardCard('H', '4', 0), // 15
    makeStandardCard('S', 'K', 0), makeStandardCard('C', 'K', 0), makeStandardCard('D', 'K', 0), // 30
  ];
  const fixed = { hand, best: { cardIds: hand.slice(3).map((c) => c.id), points: 30 } };
  const weak = checkAnswer(fixed, hand.slice(0, 3).map((c) => c.id));
  assert.deepStrictEqual({ valid: weak.valid, points: weak.points, solved: weak.solved }, { valid: true, points: 15, solved: false });
  const wrong = checkAnswer(fixed, [hand[0].id, hand[3].id, hand[4].id]);
  assert.strictEqual(wrong.valid, false);
  assert.ok(wrong.reason, 'invalid answers carry the rules reason');
  assert.strictEqual(checkAnswer(fixed, ['nope', 'nope']).valid, false);
  assert.strictEqual(checkAnswer(fixed, [hand[3].id, hand[3].id, hand[4].id]).valid, false, 'duplicate ids never pass');
});

test('PlayerStore puzzle bookkeeping: tries, one solve, no XP after reveal', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pikpuzzle-'));
  const store = createPlayerStore(path.join(dir, 'players.json'));
  assert.deepStrictEqual(store.puzzleStatus('Anna', '2026-09-26'), { tries: 0, solved: false, revealed: false });
  let r = store.recordPuzzleAttempt('Anna', '2026-09-26', false);
  assert.deepStrictEqual(r, { tries: 1, solved: false, revealed: false, justSolved: false });
  r = store.recordPuzzleAttempt('Anna', '2026-09-26', true);
  assert.strictEqual(r.justSolved, true);
  r = store.recordPuzzleAttempt('Anna', '2026-09-26', true);
  assert.strictEqual(r.justSolved, false, 'a second solve on the same day earns nothing');
  assert.strictEqual(r.tries, 2, 'tries stop counting once solved');
  const rev = store.revealPuzzle('Ben', '2026-09-26');
  assert.strictEqual(rev.revealed, true);
  const after = store.recordPuzzleAttempt('Ben', '2026-09-26', true);
  assert.strictEqual(after.justSolved, false, 'revealed first = no XP');
  assert.strictEqual(after.solved, true);
});

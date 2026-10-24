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
const { testPlayerStore } = require('./helpers/player-store');

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
  assert.deepStrictEqual(Object.keys(pub).sort(), ['date', 'hand', 'kind', 'targetPoints']);
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

test('PlayerStore puzzle bookkeeping: tries, one solve, no XP after reveal', async (t) => {
  const { store } = testPlayerStore(t);
  assert.deepStrictEqual(await store.puzzleStatus('Anna', '2026-09-26'), { tries: 0, solved: false, revealed: false });
  let r = await store.recordPuzzleAttempt('Anna', '2026-09-26', false);
  assert.deepStrictEqual(r, { tries: 1, solved: false, revealed: false, justSolved: false });
  r = await store.recordPuzzleAttempt('Anna', '2026-09-26', true);
  assert.strictEqual(r.justSolved, true);
  r = await store.recordPuzzleAttempt('Anna', '2026-09-26', true);
  assert.strictEqual(r.justSolved, false, 'a second solve on the same day earns nothing');
  assert.strictEqual(r.tries, 2, 'tries stop counting once solved');
  const rev = await store.revealPuzzle('Ben', '2026-09-26');
  assert.strictEqual(rev.revealed, true);
  const after = await store.recordPuzzleAttempt('Ben', '2026-09-26', true);
  assert.strictEqual(after.justSolved, false, 'revealed first = no XP');
  assert.strictEqual(after.solved, true);
});

test('check button locks once solved or revealed, unlocks on the next game day (#304)', async (t) => {
  const vm = require('node:vm');
  const { addDays } = require('../game/GameDay');
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'client.js'), 'utf8');
  const m = src.match(/\n  function puzzleLocked\(status, solutionIds\) \{[\s\S]*?\n  \}\n/);
  assert.ok(m, 'puzzleLocked is defined in client.js');
  assert.match(src, /el\('puzzleCheckBtn'\)\.disabled = done \|\|/, 'the check button follows puzzleLocked');
  const ctx = {};
  vm.runInNewContext(`${m[0]}\nthis.locked = puzzleLocked;`, ctx);

  // The lock is derived from the server status, so a reload keeps it.
  const { store } = testPlayerStore(t);
  const day = '2026-10-05';
  assert.equal(ctx.locked(await store.puzzleStatus('Ben', day), null), false);
  await store.recordPuzzleAttempt('Ben', day, true);
  assert.equal(ctx.locked(await store.puzzleStatus('Ben', day), null), true, 'solved -> locked');
  assert.equal(ctx.locked(await store.puzzleStatus('Ben', addDays(day, 1)), null), false, 'new day -> unlocked');

  await store.revealPuzzle('Cleo', day);
  assert.equal(ctx.locked(await store.puzzleStatus('Cleo', day), null), true, 'revealed -> locked after reload');
  assert.equal(ctx.locked({ tries: 0, solved: false, revealed: false }, ['a']), true, 'solution on screen -> locked');
});

// --- Puzzle kinds rotate by weekday; the archive replays any past day ---------
const DP = require('../game/DailyPuzzle');
const { addDays: addDay } = require('../game/GameDay');

test('kinds: days before the rotation stay the single-meld puzzle they were served as', () => {
  assert.deepStrictEqual(DP.kindForDate('2026-10-18'), { kind: 'meld', size: 11 });
  // Pinned: an old day must never change, people compare it in the archive.
  assert.deepStrictEqual(DP.puzzleForDate('2026-09-26').hand.map((c) => c.id),
    ['CK-0', 'CK-1', 'DA-0', 'SK-1', 'C2-1', 'DJ-1', 'S5-0', 'D7-1', 'S6-0', 'DK-0', 'DA-1']);
  const week = [0, 1, 2, 3, 4, 5, 6].map((i) => DP.kindForDate(addDay(DP.ROTATION_START, i)).kind);
  assert.deepStrictEqual(week, ['meld', 'out', 'turn', 'meld', 'out', 'turn', 'out'], 'Monday first');
});

test('turn puzzles: the best is several disjoint melds, keeps a card, and nothing beats it', () => {
  for (let i = 0; i < 40; i++) {
    const date = addDay(DP.ROTATION_START, 7 * i + (i % 2 ? 2 : 5)); // Wednesdays and Saturdays
    const p = DP.puzzleForDate(date);
    assert.strictEqual(p.kind, 'turn', date);
    assert.ok(p.best.melds.length >= 2, `${date}: several melds`);
    const r = DP.checkAnswer(p, p.best.melds);
    assert.strictEqual(r.solved, true, `${date}: the stored best solves it`);
    assert.ok(r.left >= 1, `${date}: one card stays for the discard`);
    // Independent brute force: every combination of up to 4 disjoint melds.
    const melds = DP.enumerateMelds(p.hand);
    let max = 0;
    const walk = (start, used, pts, depth) => {
      if (pts > max && p.hand.length - used.toString(2).replace(/0/g, '').length >= 1) max = pts;
      if (depth === 4) return;
      for (let k = start; k < melds.length; k++) if (!(melds[k].mask & used)) walk(k + 1, used | melds[k].mask, pts + melds[k].points, depth + 1);
    };
    walk(0, 0, 0, 0);
    assert.strictEqual(p.best.points, max, `${date}: optimum`);
    assert.strictEqual(DP.publicPuzzle(p).targetPoints, p.best.points);
  }
});

test('out puzzles: solvable, graded by the engine, one card must stay', () => {
  for (let i = 0; i < 40; i++) {
    const date = addDay(DP.ROTATION_START, 7 * i + [1, 4, 6][i % 3]); // Tue, Fri, Sun
    const p = DP.puzzleForDate(date);
    assert.strictEqual(p.kind, 'out', date);
    assert.ok(p.hand.every((c) => !c.isJoker));
    const ok = DP.checkAnswer(p, p.best.melds);
    assert.deepStrictEqual({ solved: ok.solved, left: ok.left }, { solved: true, left: 1 }, date);
    assert.ok(!('type' in ok), 'never a `type` key (spread into a WebSocket message)');
    const partial = DP.checkAnswer(p, p.best.melds.slice(1));
    assert.deepStrictEqual({ valid: partial.valid, solved: partial.solved }, { valid: true, solved: false });
    assert.ok(partial.left > 1);
    assert.ok(DP.countCovers(DP.enumerateMelds(p.hand), p.hand.length).count >= 1);
  }
});

test('checkAnswer with several melds: overlaps, bad melds and laying every card', () => {
  const hand = [
    makeStandardCard('H', '5', 0), makeStandardCard('H', '6', 0), makeStandardCard('H', '7', 0),
    makeStandardCard('S', '7', 0), makeStandardCard('C', '7', 0), makeStandardCard('D', '2', 0),
  ];
  const ids = hand.map((c) => c.id);
  const out = { kind: 'out', hand, best: { points: 0 } };
  assert.strictEqual(DP.checkAnswer(out, [ids.slice(0, 3), [ids[2], ids[3], ids[4]]]).reason, 'Jede Karte darf nur in einer Auslage liegen.');
  const bad = DP.checkAnswer(out, [ids.slice(0, 3), [ids[3], ids[4], ids[5]]]);
  assert.deepStrictEqual({ valid: bad.valid, badMeld: bad.badMeld }, { valid: false, badMeld: 2 }, 'the wrong meld is named');
  // H7 can only serve one meld: the run 5-6-7 leaves the sevens short.
  assert.strictEqual(DP.checkAnswer(out, [ids.slice(0, 3)]).left, 3);
  // Laying every card leaves nothing to discard - going out needs the discard.
  const d7 = makeStandardCard('D', '7', 0);
  const full = { kind: 'out', hand: hand.slice(0, 5).concat(d7), best: { points: 0 } };
  assert.strictEqual(DP.checkAnswer(full, [ids.slice(0, 3), [ids[3], ids[4], d7.id]]).reason, 'Mindestens eine Karte muss zum Abwerfen übrig bleiben.');
  const meld = { kind: 'meld', hand, best: { points: 15 } };
  assert.strictEqual(DP.checkAnswer(meld, [ids.slice(0, 3), ids.slice(3, 5)]).reason, 'Hier ist genau eine Auslage gefragt.');
  assert.strictEqual(DP.checkAnswer(meld, [ids.slice(0, 3)]).solved, true, 'one meld as a list still works');
});

test('generation stays fast enough to build archive days on demand', () => {
  const t0 = Date.now();
  let date = DP.ROTATION_START;
  for (let i = 0; i < 70; i++) { DP.puzzleForDate(date); date = addDay(date, 1); }
  assert.ok(Date.now() - t0 < 3000, `70 days took ${Date.now() - t0} ms`);
});

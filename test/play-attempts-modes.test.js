// Play attempts of the daily puzzle and the tutorial (game/PuzzleAttempts.js,
// game/PlayEvents.js, game/TutorialSteps.js): the rows, their causes, the abuse
// guards, the reports per mode, the admin views and the server wiring.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const WebSocket = require('ws');
const GameManager = require('../game/GameManager');
const AdminPage = require('../game/AdminPage');
const DP = require('../game/DailyPuzzle');
const PlayEvents = require('../game/PlayEvents');
const { createPuzzleAttempts, meldFault, answerFault } = require('../game/PuzzleAttempts');
const { TUTORIAL_VERSION, TUTORIAL_STEPS, isTutorialStep, tutorialStepIndex } = require('../game/TutorialSteps');
const { gameDay, addDays, dayEnd } = require('../game/GameDay');
const { makeStandardCard } = require('../game/Card');
const { freePort } = require('./helpers/free-port');
const { testDatabaseUrl, testPool } = require('./helpers/test-db');

const { createPlayEvents, tutorialAttemptEvent, attemptEvent, tutorialCause, puzzleCause, attemptOpen, shapeFunnel } = PlayEvents;
const ROOT = path.join(__dirname, '..');
const DAY_MS = 24 * 60 * 60 * 1000;

// --- Tutorial in the engine -----------------------------------------------------

/** A started tutorial table for 'me'; the bot timer is off (the test plays). */
function tutorialGame({ name = 'Lena', onAttemptEnd = null } = {}) {
  const calls = [];
  const g = new GameManager(() => {}, {
    deckSeed: GameManager.TUTORIAL_SEED, tutorialMode: true,
    onAttemptEnd: (info) => { calls.push(info); if (onAttemptEnd) onAttemptEnd(info); },
  });
  g.maybeRunBotTurn = () => {};
  g.addOrReconnectPlayer('me', name);
  g.startTutorialRound();
  return { g, calls, me: g.players.find((p) => p.id === 'me') };
}

/** The learner melds all but one card (scoring only) and discards the last: round 1 is scored. */
function finishRound1(g, me) {
  me.laidOutCards = me.hand.slice(1);
  me.hand = me.hand.slice(0, 1);
  g.currentPlayerIndex = g.players.indexOf(me);
  g.turnPhase = 'meld';
  assert.ok(!g.discard(me.id, me.hand[0].id).error);
  assert.strictEqual(g.phase, 'roundEnd');
}

test('tutorial engine: reported lessons on the server clock; the scoring of round 1 is one won row', () => {
  const { g, calls, me } = tutorialGame();
  assert.match(g.attemptId, /^[0-9a-f-]{36}$/);
  assert.strictEqual(g.tutorialTrack.version, TUTORIAL_VERSION);
  assert.deepStrictEqual(g.tutorialStep('me', 'welcome', 'shown', 1000), { ok: true });
  g.tutorialStep('me', 'welcome', 'done', 4000);
  g.tutorialStep('me', 'draw', 'shown', 4500);
  g.tutorialStep('me', 'draw', 'shown', 9000); // shown again (after a bot turn): the first time counts
  g.noteTutorialRefusal('me');
  g.noteTutorialRefusal('me');
  g.tutorialStep('me', 'draw', 'done', 20500);
  g.noteTutorialRefusal('me'); // no lesson open: only the total
  g.tutorialStep('me', 'firstSet', 'done', 30000); // done without being shown: reached too
  assert.deepStrictEqual(calls, []);
  finishRound1(g, me);
  assert.deepStrictEqual(calls, [{ outcome: 'finished', reason: null }]);
  const ev = attemptEvent(g, calls[0], 40000);
  assert.deepStrictEqual(ev, tutorialAttemptEvent(g, calls[0], 40000), 'attemptEvent picks the tutorial');
  assert.deepStrictEqual([ev.mode, ev.period, ev.outcome, ev.name, ev.attemptId], ['tutorial', 'v1', 'won', 'Lena', g.attemptId]);
  assert.strictEqual(ev.stage, tutorialStepIndex('roundend'));
  assert.deepStrictEqual(ev.facts, {
    step: 'roundend',
    reached: ['welcome', 'draw', 'firstSet', 'roundend'],
    done: ['welcome', 'draw', 'firstSet', 'roundend'],
    sec: { welcome: 3, draw: 16 },
    errors: { draw: 2 },
    refusals: 3,
  });
  // Playing on afterwards (round 2, leaving, the cleanup) is no second attempt.
  assert.deepStrictEqual(g.tutorialStep('me', 'layOff', 'shown'), { ignored: true });
  g.noteTutorialRefusal('me');
  g._abandonSolo('timeout');
  g.abandonAttempt('expired');
  assert.strictEqual(calls.length, 1);
  g.destroy();
});

test('tutorial engine: junk, foreign seats, a flood and late reports are ignored; hints off ends it as skipped', () => {
  const { g, calls } = tutorialGame();
  const bot = g.players.find((p) => p.isBot);
  for (const [step, status] of [['nope', 'shown'], ['__proto__', 'shown'], ['constructor', 'done'], [{ a: 1 }, 'shown'],
    ['x'.repeat(5000), 'shown'], ['draw', 'finished'], ['draw', 'won'], [null, 'shown'], ['welcome', undefined]]) {
    assert.deepStrictEqual(g.tutorialStep('me', step, status), { ignored: true }, `${String(step).slice(0, 20)}/${status}`);
  }
  assert.deepStrictEqual(g.tutorialStep(bot.id, 'welcome', 'shown'), { ignored: true }, 'a bot seat never reports');
  assert.deepStrictEqual(g.tutorialStep('stranger', 'welcome', 'shown'), { ignored: true });
  assert.deepStrictEqual(g.tutorialTrack.shown, {}, 'nothing stored by junk');
  assert.ok(!Object.prototype.hasOwnProperty.call(g.tutorialTrack.shown, '__proto__'));
  // A flood: only the first reports (all of them within the cap) are looked at.
  for (let i = 0; i < 400; i++) g.tutorialStep('me', 'welcome', 'shown', 1000 + i);
  assert.ok(g.tutorialTrack.msgs > 200 && g.tutorialTrack.shown.welcome === 1000);
  assert.deepStrictEqual(g.tutorialStep('me', 'draw', 'shown'), { ignored: true }, 'over the cap');
  assert.strictEqual(g.tutorialTrack.shown.draw, undefined);
  g.destroy();

  // Hints off: abandoned as skipped, once; the round's end later writes nothing.
  const skip = tutorialGame();
  skip.g.tutorialStep('me', 'welcome', 'shown', 1000);
  skip.g.noteTutorialRefusal('me');
  assert.deepStrictEqual(skip.g.tutorialStep('me', null, 'off', 5000), { ok: true });
  assert.deepStrictEqual(skip.calls, [{ outcome: 'abandoned', reason: 'skipped' }]);
  const ev = tutorialAttemptEvent(skip.g, skip.calls[0], 8000);
  assert.deepStrictEqual([ev.outcome, ev.stage, ev.facts.step, ev.facts.reason, ev.facts.cause], ['abandoned', 1, 'welcome', 'skipped', 'skipped']);
  assert.deepStrictEqual(ev.facts.sec, { welcome: 7 }, 'the open lesson runs until the end');
  assert.deepStrictEqual(skip.g.tutorialStep('me', 'draw', 'shown'), { ignored: true });
  finishRound1(skip.g, skip.me);
  skip.g.tutorialStep('me', null, 'off');
  assert.strictEqual(skip.calls.length, 1);
  skip.g.destroy();

  // Normal tables never track.
  const plain = new GameManager(() => {}, {});
  plain.maybeRunBotTurn = () => {};
  plain.addOrReconnectPlayer('p1', 'Ada');
  plain.fillWithBots();
  plain.startNewRound();
  assert.deepStrictEqual(plain.tutorialStep('p1', 'welcome', 'shown'), { ignored: true });
  plain.noteTutorialRefusal('p1');
  assert.strictEqual(plain.tutorialTrack, null);
  assert.strictEqual(tutorialAttemptEvent(plain, { outcome: 'abandoned' }), null);
  plain.destroy();
});

test('tutorial engine: causes, leaving and the snapshot roundtrip (a restart writes it once)', () => {
  assert.strictEqual(tutorialCause({ step: 'joker', errors: { joker: 3 }, reason: 'skipped' }), 'stuck', '3 refusals at the last lesson');
  assert.strictEqual(tutorialCause({ step: 'joker', errors: { draw: 5 }, reason: 'skipped' }), 'skipped');
  assert.strictEqual(tutorialCause({ step: 'joker', reason: 'left' }), 'left');
  assert.strictEqual(tutorialCause({ step: 'joker', reason: 'forfeit' }), 'left');
  assert.strictEqual(tutorialCause({ step: null, reason: 'timeout' }), 'away');

  const { g, calls } = tutorialGame({ name: 'Rudi' });
  g.tutorialStep('me', 'welcome', 'shown', 1000);
  g.tutorialStep('me', 'welcome', 'done', 2000);
  g.tutorialStep('me', 'draw', 'shown', 2500);
  const state = JSON.parse(JSON.stringify(g.serialize()));
  assert.strictEqual(attemptOpen(state), true);
  const lost = attemptEvent(state, { outcome: 'abandoned', reason: 'restart' }, 9000);
  assert.deepStrictEqual(lost, tutorialAttemptEvent(g, { outcome: 'abandoned', reason: 'restart' }, 9000), 'state and game agree');
  assert.deepStrictEqual([lost.attemptId, lost.facts.step, lost.facts.reason, lost.facts.cause], [g.attemptId, 'draw', 'restart', 'away']);
  g.destroy();

  const back = new GameManager(() => {}, { onAttemptEnd: (i) => calls.push(i) });
  back.maybeRunBotTurn = () => {};
  back.deserialize(state);
  back.addOrReconnectPlayer('me', 'Rudi');
  back.tutorialStep('me', 'draw', 'done', 3000);
  assert.deepStrictEqual(back.abandonSeat('me'), { outcome: 'ended' });
  assert.deepStrictEqual(calls, [{ outcome: 'abandoned', reason: 'left' }]);
  const left = tutorialAttemptEvent(back, calls[0], 9000);
  assert.deepStrictEqual([left.attemptId, left.facts.done, left.facts.reason, left.stage], [state.attemptId, ['welcome', 'draw'], 'left', 2]);
  const done = JSON.parse(JSON.stringify(back.serialize()));
  assert.strictEqual(attemptOpen(done), false, 'a written attempt is never written again after a restart');
  back.destroy();

  // A snapshot from before the tracking: no row rather than a guessed one.
  const old = { ...state, tutorialTrack: undefined };
  assert.strictEqual(tutorialAttemptEvent(old, { outcome: 'abandoned', reason: 'restart' }), null);
});

test('tutorial steps: the client\'s lessons are the server\'s (keys, bonus flags), v1 pinned, every one labelled', () => {
  const src = fs.readFileSync(path.join(ROOT, 'public', 'client.js'), 'utf8');
  const block = src.slice(src.indexOf('const TUTORIAL_STEPS = ['), src.indexOf('const TUTORIAL_MANDATORY'));
  const client = [...block.matchAll(/key: '(\w+)'([^\n]*)/g)].map((m) => ({ key: m[1], optional: /optional: true/.test(m[2]) }));
  const byKey = (list) => Object.fromEntries(list.map((s) => [s.key, !!s.optional]));
  assert.ok(client.length >= 10, 'lessons found in client.js');
  assert.deepStrictEqual(byKey(TUTORIAL_STEPS), byKey(client), 'same lessons and bonus flags (order may differ: the funnel reads pileDuty after draw)');
  // Changing the lessons needs a new version: a pinned list per version.
  const PINNED = {
    v1: ['welcome', 'draw', 'pileDuty', 'firstSet', 'pikdame', 'queenSet', 'joker', 'moreMelds', 'discard', 'pile', 'layOff', 'jokerSwap', 'endgame', 'roundend'],
  };
  assert.deepStrictEqual(TUTORIAL_STEPS.map((s) => s.key), PINNED[TUTORIAL_VERSION], `lessons changed: bump TUTORIAL_VERSION and pin it here`);
  assert.ok(TUTORIAL_STEPS.every((s) => AdminPage.STEP_DE[s.key]), 'an admin label per lesson');
  assert.deepStrictEqual(Object.keys(AdminPage.TUTORIAL_CAUSE_DE), PlayEvents.TUTORIAL_CAUSES);
  assert.ok(PlayEvents.PUZZLE_CAUSES.every((c) => AdminPage.FAULT_DE[c]), 'a German text per puzzle cause');
  assert.ok(Object.keys(DP.STAR_TRIES).every((k) => AdminPage.KIND_DE[k]), 'a German name per puzzle kind');
  assert.strictEqual(isTutorialStep('toString'), false);
  assert.strictEqual(tutorialStepIndex('welcome'), 1);
  assert.strictEqual(tutorialStepIndex('nope'), null);
  assert.ok(/reportTutorial\(null, 'off'\)/.test(src) && /reportTutorial\(step\.key, 'shown'\)/.test(src), 'the client reports');
});

// --- Daily puzzle tracker ---------------------------------------------------------

/** The latest day (up to `from`) of a kind, and answers: right, a wrong meld, a valid near-miss. */
function puzzleDay(kind, from = gameDay()) {
  for (let i = 0; i < 30; i++) {
    const day = addDays(from, -i);
    const p = DP.puzzleForDate(day);
    if (p.kind !== kind) continue;
    const ids = p.hand.map((c) => c.id);
    let bad = null;
    for (let a = 0; a < ids.length && !bad; a++) {
      for (let b = a + 1; b < ids.length && !bad; b++) {
        for (let c = b + 1; c < ids.length && !bad; c++) if (!DP.checkMeld(p, [ids[a], ids[b], ids[c]]).valid) bad = [ids[a], ids[b], ids[c]];
      }
    }
    const shape = (melds) => (kind === 'meld' ? { cardIds: melds[0] } : { melds });
    const weaker = kind === 'meld'
      ? DP.enumerateMelds(p.hand).find((m) => m.points < p.best.points)
      : null;
    const near = kind === 'meld' ? [p.hand.filter((_, idx) => weaker.mask & (1 << idx)).map((c) => c.id)] : [p.best.melds[0]];
    return { day, p, right: shape(p.best.melds || [p.best.cardIds]), bad: shape([bad]), near: shape(near) };
  }
  throw new Error(`no ${kind} day`);
}

test('puzzle faults: the graded answer tells the mistake (invalid meld, no discard, short, not out)', () => {
  const out = puzzleDay('out');
  const answer = (x) => DP.checkAnswer(out.p, x.melds || x.cardIds);
  assert.strictEqual(answerFault('out', answer(out.bad)), 'meld');
  assert.strictEqual(answerFault('out', answer(out.near)), 'notOut');
  assert.strictEqual(answerFault('out', answer(out.right)), null);
  // Every card laid in valid melds: nothing left to discard.
  const fives = ['S', 'H', 'D'].map((s) => makeStandardCard(s, '5', 0));
  const allIn = DP.checkAnswer({ kind: 'turn', hand: fives, best: { points: 15 } }, [fives.map((c) => c.id)]);
  assert.deepStrictEqual([allIn.valid, allIn.fault, answerFault('turn', allIn)], [false, 'discard', 'discard']);
  const turn = puzzleDay('turn');
  assert.strictEqual(answerFault('turn', DP.checkAnswer(turn.p, turn.near.melds)), 'points');
  const meld = puzzleDay('meld');
  assert.strictEqual(answerFault('meld', DP.checkAnswer(meld.p, meld.near.cardIds)), 'points');
  assert.strictEqual(answerFault('meld', DP.checkAnswer(meld.p, [meld.p.best.cardIds, meld.p.best.cardIds])), 'other', 'two melds where one is asked');
  assert.strictEqual(answerFault('meld', DP.checkAnswer(meld.p, ['zz-1', 'zz-2', 'zz-3'])), 'other');
  assert.strictEqual(meldFault(DP.checkMeld(out.p, out.bad.melds[0])), 'meld');
  assert.strictEqual(meldFault(DP.checkMeld(out.p, ['zz'])), 'other');
  assert.strictEqual(meldFault(DP.checkMeld(out.p, out.right.melds[0])), null);
  assert.strictEqual(puzzleCause({ wrong: { points: 2, meld: 2, notOut: 1 } }), 'meld', 'ties: the earlier mistake');
  assert.strictEqual(puzzleCause({ wrong: {} }), 'noTry');
});

function tracker(opts = {}) {
  const events = [];
  let clock = Date.UTC(2026, 9, 21, 9);
  const t = createPuzzleAttempts({ record: (ev) => events.push(ev), now: () => clock, log: () => {}, ...opts });
  return { t, events, tick: (ms) => { clock += ms; return clock; }, now: () => clock };
}

test('puzzle tracker: won, given up, left open - one row each, with the first look as start', () => {
  const { t, events, tick, now } = tracker();
  const day = '2026-10-21';
  const opened = now();
  t.opened('Pia', day, 'out', { tries: 0 });
  t.opened('PIA ', day, 'out', { tries: 0 }); // the same name, another spelling
  tick(20000);
  t.meldChecked('Pia', day, 'out', { valid: false, fault: 'meld', reason: 'x' }, { tries: 0 });
  t.meldChecked('Pia', day, 'out', { valid: true }, { tries: 0 });
  tick(20000);
  t.tried('Pia', day, 'out', { valid: true, solved: false, left: 3 }, { tries: 1 });
  tick(20000);
  t.tried('Pia', day, 'out', { valid: true, solved: true, left: 1 }, { tries: 2, solved: true, justSolved: true, stars: 2 });
  assert.strictEqual(events.length, 1);
  assert.deepStrictEqual(events[0], {
    attemptId: `puzzle:${day}:pia`, startedAt: opened, endedAt: now(), name: 'Pia', mode: 'puzzle', period: day, stage: null,
    outcome: 'won', turns: 2, facts: { kind: 'out', mistakes: 2, wrong: { meld: 1, notOut: 1 }, stars: 2, firstWrong: 'meld' },
  });
  // A solved day stays over: a later look, check, reveal or try writes nothing.
  t.opened('Pia', day, 'out', { tries: 2, solved: true });
  t.revealed('Pia', day, 'out', { tries: 2, solved: true, revealed: true });
  t.tried('Pia', day, 'out', { valid: true, solved: true }, { tries: 2, solved: true, justSolved: false });
  assert.strictEqual(events.length, 1);

  // Given up after three short answers: lost, stuck, its most common mistake.
  t.opened('Gabi', day, 'turn', { tries: 0 });
  for (let i = 1; i <= 3; i++) t.tried('Gabi', day, 'turn', { valid: true, solved: false }, { tries: i });
  t.revealed('Gabi', day, 'turn', { tries: 3, revealed: true });
  t.revealed('Gabi', day, 'turn', { tries: 3, revealed: true }); // twice: one row
  t.tried('Gabi', day, 'turn', { valid: true, solved: true }, { tries: 4, solved: true, revealed: true, justSolved: false });
  assert.strictEqual(events.length, 2);
  assert.deepStrictEqual([events[1].outcome, events[1].turns, events[1].facts],
    ['lost', 3, { kind: 'turn', mistakes: 3, wrong: { points: 3 }, gaveUp: true, firstWrong: 'points', cause: 'points' }]);

  // Revealed without a try: given up, cause noTry.
  t.revealed('Nina', day, 'meld', { tries: 0, revealed: true });
  assert.deepStrictEqual([events[2].outcome, events[2].facts.cause, events[2].turns], ['lost', 'noTry', 0]);

  // Tried and left: abandoned when the day is over (at the last action); a mere look is dropped.
  t.opened('Otto', day, 'meld', { tries: 0 });
  tick(5000);
  const lastAt = now();
  t.tried('Otto', day, 'meld', { valid: false, fault: 'meld' }, { tries: 1 });
  t.opened('Lookie', day, 'meld', { tries: 0 });
  t.sweep(day);
  assert.strictEqual(events.length, 3, 'the day is not over yet');
  tick(DAY_MS);
  t.sweep('2026-10-22');
  assert.strictEqual(events.length, 4);
  assert.deepStrictEqual([events[3].name, events[3].outcome, events[3].endedAt, events[3].facts.reason, events[3].facts.cause],
    ['Otto', 'abandoned', lastAt, 'dayEnd', 'meld']);
  assert.strictEqual(t.size(), 0);
  assert.ok(events.every((e) => e.attemptId.startsWith(`puzzle:${day}:`) && e.stage === null));
});

test('puzzle tracker: snapshot roundtrip, junk entries, the daily cap and a failing write', () => {
  const a = tracker();
  const day = '2026-10-21';
  a.t.opened('Tina', day, 'meld', { tries: 0 });
  a.t.meldChecked('Tina', day, 'meld', { valid: false, fault: 'meld' }, { tries: 0 });
  a.t.opened('Yvo', '2026-10-20', 'out', { tries: 0 });
  a.t.tried('Yvo', '2026-10-20', 'out', { valid: true, solved: false }, { tries: 2 });
  const snap = JSON.parse(JSON.stringify(a.t.serialize()));
  assert.strictEqual(snap.length, 2);

  const b = tracker();
  b.t.restore([...snap, null, { name: '', day }, { name: 'x', day: 'evil' }, { name: 'Max', day, kind: 'weird', wrong: { meld: -3, hack: 9 }, firstWrong: 'hack', tries: 'x' }], day);
  assert.strictEqual(b.events.length, 1, 'yesterday ends at once');
  assert.deepStrictEqual([b.events[0].name, b.events[0].outcome, b.events[0].period, b.events[0].facts.reason], ['Yvo', 'abandoned', '2026-10-20', 'dayEnd']);
  const max = b.t.serialize().find((x) => x.name === 'Max');
  assert.deepStrictEqual([max.kind, max.wrong, max.firstWrong, max.tries], ['meld', {}, null, 0], 'restored fields are checked');
  b.t.tried('Tina', day, 'meld', { valid: true, solved: true }, { tries: 1, solved: true, justSolved: true, stars: 3 });
  const won = b.events[1];
  assert.deepStrictEqual([won.outcome, won.startedAt, won.facts.mistakes, won.facts.firstWrong], ['won', snap[0].openedAt, 1, 'meld'], 'the restored attempt goes on');

  const c = tracker({ maxPerDay: 2 });
  for (const n of ['A', 'B', 'C', 'D']) c.t.revealed(n, day, 'meld', { tries: 0, revealed: true });
  assert.deepStrictEqual(c.events.map((e) => e.name), ['A', 'B'], 'beyond the daily cap nothing is tracked');

  const d = createPuzzleAttempts({ record: () => { throw new Error('db down'); }, log: () => {} });
  assert.doesNotThrow(() => d.revealed('Ada', day, 'meld', { tries: 0, revealed: true }));
  assert.doesNotThrow(() => d.restore('nonsense', day));
});

// --- Store and reports against PostgreSQL -------------------------------------------

async function seedPuzzle(store, rows, base = Date.UTC(2026, 9, 10, 10)) {
  let i = 0;
  for (const [name, day, kind, outcome, turns, facts] of rows) {
    const endedAt = base + (i += 1) * 60000;
    await store.record({ startedAt: endedAt - 90000, endedAt, name, mode: 'puzzle', period: day, stage: null, outcome, turns,
      attemptId: `puzzle:${day}:${name.toLowerCase()}`, facts: { kind, ...facts } });
  }
}

const won = (mistakes = 0, wrong = {}) => ({ stars: mistakes ? 2 : 3, mistakes, wrong });
const lostP = (mistakes, wrong, cause) => ({ mistakes, wrong, gaveUp: true, cause });
const openP = (mistakes, wrong, cause) => ({ mistakes, wrong, reason: 'dayEnd', cause });

test('report: puzzle days and kinds, the hard days, players stuck with their cause', async (t) => {
  const store = createPlayEvents(testPool(t, 'pa_puzzle'));
  const rows = [];
  // 2026-10-05 (Mon, meld): easy. 2026-10-07 (Wed, turn): hard. 2026-10-06 (Tue, out): medium.
  for (let i = 0; i < 6; i++) rows.push([`M${i}`, '2026-10-05', 'meld', 'won', 1, won()]);
  rows.push(['Gabi', '2026-10-05', 'meld', 'lost', 1, lostP(1, { points: 1 }, 'points')]);
  for (let i = 0; i < 2; i++) rows.push([`T${i}`, '2026-10-07', 'turn', 'won', 3, won(2, { points: 2 })]);
  for (let i = 0; i < 3; i++) rows.push([`X${i}`, '2026-10-07', 'turn', 'abandoned', 1, openP(1, { points: 1 }, 'points')]);
  rows.push(['Gabi', '2026-10-07', 'turn', 'abandoned', 4, openP(4, { points: 3, meld: 1 }, 'points')]);
  rows.push(['Otto', '2026-10-07', 'turn', 'lost', 2, lostP(2, { meld: 2 }, 'meld')]);
  for (let i = 0; i < 4; i++) rows.push([`O${i}`, '2026-10-06', 'out', 'won', 2, won(1, { notOut: 1 })]);
  rows.push(['gabi ', '2026-10-06', 'out', 'lost', 0, lostP(0, {}, 'noTry')]);
  // 2026-10-08 (Thu, meld): everybody solves it; 2026-10-09 has too few attempts to rank.
  for (let i = 0; i < 6; i++) rows.push([`Z${i}`, '2026-10-08', 'meld', 'won', 1, won()]);
  rows.push(['Solo', '2026-10-09', 'out', 'lost', 1, lostP(1, { meld: 1 }, 'meld')]);
  rows.push(['Old', '2026-09-01', 'meld', 'won', 1, won()]);
  await seedPuzzle(store, rows);

  const r = await store.puzzleReport({ from: '2026-10-01', to: '2026-10-14' });
  assert.ok(!r.error, r.error);
  assert.deepStrictEqual(r.totals, { attempts: 26, players: 24, solveRate: 18 / 26, giveUpRate: 4 / 26, avgTries: (6 + 6 + 8 + 6) / 18, stuck: 3 });
  assert.deepStrictEqual(r.days.map((d) => [d.day, d.kind, d.attempts, d.solved, d.gaveUp, d.leftOpen, d.stuck, d.hard]), [
    ['2026-10-09', 'out', 1, 0, 1, 0, 1, false],
    ['2026-10-08', 'meld', 6, 6, 0, 0, 0, false],
    ['2026-10-07', 'turn', 7, 2, 1, 4, 2, true],
    ['2026-10-06', 'out', 5, 4, 1, 0, 1, true],
    ['2026-10-05', 'meld', 7, 6, 1, 0, 1, true],
  ], 'newest first; "schwer": the three lowest solve rates with 5+ attempts');
  assert.deepStrictEqual(r.days[2].topFault, { cause: 'points', n: 4 + 3 + 3 });
  assert.strictEqual(r.days[2].avgTries, 3);
  assert.deepStrictEqual(r.kinds.map((k) => [k.kind, k.days, k.attempts, k.solveRate, k.topFault && k.topFault.cause]),
    [['meld', 2, 13, 12 / 13, 'points'], ['turn', 1, 7, 2 / 7, 'points'], ['out', 2, 6, 4 / 6, 'notOut']]);
  assert.strictEqual(r.kinds[0].solveSec, 90, 'median time from the first look to the solve');
  assert.deepStrictEqual(r.stuck.map((s) => [s.name, s.days, s.lastDay, s.lastKind, s.lastOutcome, s.mistakes, s.top]), [
    ['gabi', 3, '2026-10-07', 'turn', 'abandoned', 5, { cause: 'points', n: 2 }],
    ['Solo', 1, '2026-10-09', 'out', 'lost', 1, { cause: 'meld', n: 1 }],
    ['Otto', 1, '2026-10-07', 'turn', 'lost', 2, { cause: 'meld', n: 1 }],
  ], 'given up or 3+ mistakes without a solve, most days first; the latest spelling; X* had one mistake');
  const narrow = await store.puzzleReport({ from: '2026-10-06', to: '2026-10-06' });
  assert.deepStrictEqual([narrow.totals.attempts, narrow.days.length, narrow.days[0].hard], [5, 1, true]);
  const empty = await store.puzzleReport({ from: '2027-01-01', to: '2027-01-14' });
  assert.deepStrictEqual([empty.totals.attempts, empty.days, empty.kinds, empty.stuck, empty.totals.solveRate], [0, [], [], [], null]);
  const tries = await store.playerAttempts('Gabi', { mode: 'puzzle' });
  assert.deepStrictEqual(tries.attempts.map((a) => a.period), ['2026-10-06', '2026-10-07', '2026-10-05'], 'newest written first');
  assert.strictEqual((await store.playerAttempts('Gabi')).attempts.length, 0, 'the tower view sees no puzzles');

  // One row per player and day: the attempt id.
  assert.strictEqual(await store.record({ name: 'Gabi', mode: 'puzzle', period: '2026-10-05', outcome: 'won', attemptId: 'puzzle:2026-10-05:gabi', facts: {} }), false);
  const errors = [];
  const strict = createPlayEvents(testPool(t, 'pa_mode'), { logError: (l) => errors.push(l) });
  assert.strictEqual(await strict.record({ name: 'X', mode: 'challenge', period: '2026-10-05', outcome: 'won' }), false);
  assert.match(errors[0], /not stored: name, a known mode and period are required/);
});

async function seedTutorial(store, rows, version = 'v1', base = Date.UTC(2026, 9, 12, 10)) {
  let i = 0;
  for (const [name, outcome, facts] of rows) {
    const endedAt = base + (i += 1) * 60000;
    await store.record({ startedAt: endedAt - 300000, endedAt, name, mode: 'tutorial', period: version,
      stage: tutorialStepIndex(facts.step), outcome, turns: 10, facts });
  }
}

const path3 = ['welcome', 'draw', 'firstSet'];
const tut = (reached, done, extra = {}) => ({ step: reached[reached.length - 1] || null, reached, done, sec: Object.fromEntries(done.map((k) => [k, 10])), errors: {}, refusals: 0, ...extra });

test('report: the tutorial funnel - reached, done, where they stop and why, the "Knick"', async (t) => {
  const store = createPlayEvents(testPool(t, 'pa_tutorial'));
  const finished = ['welcome', 'draw', 'firstSet', 'pikdame', 'queenSet', 'joker', 'discard', 'layOff', 'endgame', 'roundend'];
  const rows = [];
  for (let i = 0; i < 10; i++) rows.push([`W${i}`, 'won', tut(finished, finished)]);
  // 8 stop at firstSet (the Knick), 1 at draw, 1 skips at welcome, 1 never saw a lesson.
  for (let i = 0; i < 5; i++) rows.push([`S${i}`, 'abandoned', tut(path3, ['welcome', 'draw'], { reason: 'left', cause: 'left' })]);
  for (let i = 0; i < 3; i++) rows.push([`R${i}`, 'abandoned', tut(path3, ['welcome', 'draw'], { reason: 'timeout', errors: { firstSet: 4 }, refusals: 4, cause: 'stuck' })]);
  rows.push(['D', 'abandoned', tut(['welcome', 'draw'], ['welcome'], { reason: 'timeout', cause: 'away' })]);
  rows.push(['K', 'abandoned', tut(['welcome'], [], { reason: 'skipped', cause: 'skipped' })]);
  rows.push(['N', 'abandoned', { step: null, reached: [], done: [], sec: {}, errors: {}, refusals: 0, reason: 'left', cause: 'left' }]);
  await seedTutorial(store, rows);
  await seedTutorial(store, [['Old', 'won', tut(['welcome'], ['welcome'])]], 'v0');

  const r = await store.tutorialReport('v1');
  assert.ok(!r.error, r.error);
  assert.deepStrictEqual(r.versions, ['v1', 'v0']);
  assert.deepStrictEqual(r.totals, { attempts: 21, players: 21, completeRate: 10 / 21, skipRate: 1 / 21, leaveRate: 10 / 21, medianSec: 300 });
  const step = (key) => r.steps.find((s) => s.key === key);
  assert.deepStrictEqual(r.steps.map((s) => s.key), TUTORIAL_STEPS.map((s) => s.key), 'every lesson, in order');
  assert.deepStrictEqual([step('welcome').reached, step('welcome').done, step('welcome').dropped], [20, 19, 1]);
  assert.deepStrictEqual([step('firstSet').reached, step('firstSet').done, step('firstSet').dropped, step('firstSet').refusals], [18, 10, 8, 12]);
  assert.deepStrictEqual([step('draw').dropped, step('roundend').reached, step('pile').reached], [1, 10, 0]);
  assert.strictEqual(step('welcome').medianSec, 10);
  assert.deepStrictEqual(r.steps.filter((s) => s.wall).map((s) => s.key), ['firstSet'], 'the lesson losing 8 of 18');
  assert.strictEqual(r.beforeFirst, 1);
  assert.deepStrictEqual(r.causes, { left: 6, stuck: 3, away: 1, skipped: 1 });
  assert.deepStrictEqual(r.reasons, { left: 6, timeout: 4, skipped: 1 });
  const none = await store.tutorialReport('v9');
  assert.deepStrictEqual([none.totals.attempts, none.steps.every((s) => s.reached === 0 && !s.wall)], [0, true]);
  const shaped = shapeFunnel([{ fact: 'reached', key: 'welcome', n: 4 }, { fact: 'done', key: 'welcome', n: 1 },
    { fact: 'sec', key: 'welcome', sec: 30, n: 1 }, { fact: 'reached', key: 'nope', n: 9 }], [{ step: 'welcome', n: 3 }]);
  assert.deepStrictEqual([shaped.steps[0].reached, shaped.steps[0].medianSec, shaped.steps[0].wall], [4, 30, false], 'too few players for a Knick');
  // Medians from histograms (lower middle, like percentile_disc).
  assert.strictEqual(PlayEvents.histogramMedian([[30, 1], [10, 2], [20, 1]]), 10);
  assert.strictEqual(PlayEvents.histogramMedian([[30, 1], [10, 1], [20, 1], [40, 1]]), 20);
  assert.strictEqual(PlayEvents.histogramMedian([[5, 0]]), null);
  assert.strictEqual(PlayEvents.histogramMedian([]), null);
});

test('store: retention and deleting a name cover every mode', async (t) => {
  const pool = testPool(t, 'pa_keep');
  const now = Date.UTC(2026, 9, 23, 12);
  const store = createPlayEvents(pool, { now: () => now });
  const ev = (name, mode, ageDays) => store.record({ endedAt: now - ageDays * DAY_MS, name, mode, outcome: 'abandoned',
    period: mode === 'tower' ? '2026-10' : mode === 'puzzle' ? gameDay(now - ageDays * DAY_MS) : 'v1', facts: {} });
  await Promise.all(['tower', 'puzzle', 'tutorial'].flatMap((mode) => [ev('Ada', mode, 91), ev('Ada', mode, 3), ev('Ben', mode, 95), ev('Ben', mode, 1)]));
  assert.strictEqual(await store.prune(), 6, 'older than 90 days, whatever the mode');
  assert.strictEqual(await store.deleteByName('ADA'), 3, 'an account deletion takes every mode');
  const left = (await pool.query('SELECT player_key, mode FROM play_attempts ORDER BY mode')).rows;
  assert.deepStrictEqual(left.map((r) => `${r.player_key}/${r.mode}`), ['ben/puzzle', 'ben/tower', 'ben/tutorial']);
});

// --- Admin views ---------------------------------------------------------------------

test('admin page: the mode switch, the puzzle and the tutorial views; escaped, no script', () => {
  const page = (stuck) => AdminPage.renderAdminPage({ tab: 'stuck', stuck });
  const tower = page({ mode: 'tower', current: '2026-10', month: '2026-10', report: { months: [], totals: { attempts: 0 } } });
  assert.match(tower, /<nav class="modes" aria-label="Bereich"><a href="\/admin\/stuck" class="active" aria-current="page">Kartenhaus<\/a><a href="\/admin\/stuck\?mode=puzzle">Rätsel<\/a><a href="\/admin\/stuck\?mode=tutorial">Tutorial<\/a><\/nav>/);
  assert.match(tower, /<h2 class="sr">Kartenhaus<\/h2>/);

  const day = (d, kind, attempts, solved, extra = {}) => ({ day: d, kind, attempts, solved, gaveUp: 1, leftOpen: 0, solveRate: solved / attempts,
    giveUpRate: 1 / attempts, avgTries: 1.5, stuck: 1, faults: { points: 2 }, topFault: { cause: 'points', n: 2 }, hard: false, ...extra });
  const report = {
    from: '2026-10-08', to: '2026-10-21', stuckMistakes: 3,
    totals: { attempts: 12, players: 9, solveRate: 0.5, giveUpRate: 0.25, avgTries: 1.5, stuck: 2 },
    kinds: [{ kind: 'out', days: 1, attempts: 7, solved: 2, gaveUp: 1, stuck: 1, solveRate: 2 / 7, giveUpRate: 1 / 7, avgTries: 2, solveSec: 185, topFault: { cause: 'notOut', n: 4 } }],
    days: [day('2026-10-20', 'out', 7, 2, { hard: true }), day('2026-10-19', 'meld', 5, 4)],
    stuck: [{ name: 'Oma <i>', days: 2, lastDay: '2026-10-20', lastKind: 'out', lastOutcome: 'lost', mistakes: 7, top: { cause: 'notOut', n: 2 } }],
  };
  const puzzle = page({ mode: 'puzzle', days: 14, report });
  assert.match(puzzle, /class="active" aria-current="page">Rätsel</);
  assert.match(puzzle, /href="\/admin\/stuck\?mode=puzzle&amp;days=14" class="active" aria-current="page">14 Tage</);
  assert.match(puzzle, /<tr class="wall">\n<td class="floor"><b>Di 20\.10\.<\/b> <span class="badge warn" title="[^"]+">schwer<\/span><small>Ausmachen<\/small><\/td>/);
  assert.match(puzzle, /Tage <span class="sub">schwer: Di 20\.10\.<\/span>/);
  assert.match(puzzle, /data-label="gelöst in">3 min</);
  assert.match(puzzle, /href="\/admin\/stuck\?mode=puzzle&amp;days=14&amp;player=Oma\+%3Ci%3E">Oma &lt;i&gt;<\/a>/);
  assert.match(puzzle, /nicht ausgemacht, Karten übrig <span class="sub">2 von 2<\/span>/);
  assert.match(puzzle, /Di 20\.10\. Ausmachen, aufgegeben/);
  assert.match(puzzle, /<input type="hidden" name="mode" value="puzzle">/);
  assert.ok(!puzzle.includes('<i>') && !/<script/.test(puzzle));
  assert.match(page({ mode: 'puzzle', days: 7, report: { ...report, totals: { attempts: 0 } } }), /Noch keine Rätsel-Versuche in diesen 7 Tagen/);
  assert.match(page({ mode: 'puzzle', days: 7, report: { error: 'weg' } }), /Spielversuche nicht lesbar: weg/);

  const attempts = { name: 'Oma <i>', attempts: [
    { period: '2026-10-20', stage: null, outcome: 'lost', startedAt: 0, endedAt: 240000, turns: 3, facts: { kind: 'out', mistakes: 4, firstWrong: 'meld', cause: 'notOut', gaveUp: true } },
    { period: '2026-10-19', stage: null, outcome: 'won', startedAt: 0, endedAt: 45000, turns: 1, facts: { kind: 'meld', mistakes: 0, stars: 3 } },
  ] };
  const player = page({ mode: 'puzzle', days: 30, player: 'Oma <i>', attempts });
  assert.match(player, /Rätsel von Oma &lt;i&gt;/);
  assert.match(player, /aufgegeben nach 4 min · zuerst ungültige Auslage · meist nicht ausgemacht, Karten übrig/);
  assert.match(player, /<span class="badge ok">★★★ gelöst<\/span>/);
  assert.match(player, /data-unit="Versuch">1</, 'one check, singular');
  assert.match(player, /href="\/admin\/stuck\?mode=puzzle&amp;days=30">← Zur Übersicht 30 Tage</);

  const steps = TUTORIAL_STEPS.map((s, i) => ({ key: s.key, index: i + 1, optional: s.optional, reached: 10 - Math.min(i, 9), done: 9 - Math.min(i, 9), doneRate: 0.9,
    dropped: s.key === 'joker' ? 4 : 0, dropRate: s.key === 'joker' ? 0.5 : 0, medianSec: 12, refusals: s.key === 'joker' ? 5 : 0, wall: s.key === 'joker' }));
  const tutorial = page({ mode: 'tutorial', version: 'v1', current: 'v1', report: {
    version: 'v1', versions: ['v1', 'v0'], totals: { attempts: 10, players: 9, completeRate: 0.6, skipRate: 0.1, leaveRate: 0.3, medianSec: 420 },
    steps, beforeFirst: 1, avgDropRate: 0.05, reasons: { left: 3 }, causes: { stuck: 2, left: 1 },
  } });
  assert.match(tutorial, /class="active" aria-current="page">Tutorial</);
  assert.match(tutorial, /href="\/admin\/stuck\?mode=tutorial&amp;version=v0">Version v0</);
  assert.match(tutorial, /Schritte <span class="sub">Knick bei „Joker einsetzen“<\/span>/);
  assert.match(tutorial, /<tr class="wall">\n<td class="floor step"><b>7\. Joker einsetzen<\/b><span class="badge warn"/);
  assert.match(tutorial, /<b>3\. Ablage nehmen und auslegen<\/b><span class="badge plain">Bonus<\/span>/);
  assert.match(tutorial, /<span>Median-Dauer<\/span><b>7 min<\/b>/);
  assert.match(tutorial, /<span>gescheitert<\/span><b>2<\/b>/);
  assert.match(tutorial, /1 Start endete vor dem ersten Schritt/);
  assert.match(tutorial, /@media \(max-width:600px\)\{.*table\.bars tr\{display:flex/s, 'phone: every row a card');
  assert.match(page({ mode: 'tutorial', version: 'v1', current: 'v1', report: { versions: [], totals: { attempts: 0 } } }), /Noch keine Tutorial-Versuche\./);
});

// --- Real server ---------------------------------------------------------------------

function request(port, method, urlPath, { auth } = {}) {
  return new Promise((resolve, reject) => {
    const headers = auth ? { Authorization: `Basic ${Buffer.from(auth).toString('base64')}` } : {};
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, method, headers }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function waitFor(fn, what, timeoutMs = 8000) {
  for (const end = Date.now() + timeoutMs; Date.now() < end;) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error(`timed out: ${what}`);
}

async function startServer(t, databaseUrl, snapshot) {
  const port = await freePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pikdame-attempt-modes-'));
  if (snapshot) fs.writeFileSync(path.join(dataDir, 'sessions-snapshot.json'), JSON.stringify({ savedAt: Date.now(), sessions: [], ...snapshot }));
  const server = spawn('node', ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), PIKDAME_DATA_DIR: dataDir, PIKDAME_DATABASE_URL: databaseUrl, PIKDAME_ADMIN_TOKEN: 'am-token', PIKDAME_SMTP_HOST: '', PIKDAME_ONNX: '0', PIKDAME_PUBLIC_MODE: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const out = { log: '' };
  server.stdout.on('data', (c) => { out.log += c; });
  server.stderr.on('data', (c) => { out.log += c; });
  const sockets = [];
  t.after(async () => {
    for (const s of sockets) { try { s.close(); } catch (e) { /* closing */ } }
    const gone = server.exitCode !== null ? null : new Promise((r) => server.once('exit', r));
    server.kill();
    await gone;
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  for (let i = 0; ; i++) {
    try { if ((await request(port, 'GET', '/healthz')).status === 200) break; } catch (e) { /* booting */ }
    if (i > 150) throw new Error(`server on port ${port} did not come up`);
    await new Promise((r) => setTimeout(r, 100));
  }
  const socket = () => new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}`);
    const box = [];
    ws.on('message', (raw) => { try { box.push(JSON.parse(raw)); } catch (e) { /* binary */ } });
    ws.once('open', () => {
      sockets.push(ws);
      const send = (m) => ws.send(typeof m === 'string' ? m : JSON.stringify(m));
      // Sends and waits for the next message of `type` after it.
      const ask = async (m, type) => {
        const before = box.length;
        send(m);
        return waitFor(() => box.slice(before).find((x) => x.type === type), type);
      };
      resolve({ ws, box, send, ask });
    });
    ws.once('error', reject);
  });
  return { port, out, socket };
}

const dbRows = async (db, where = 'TRUE') => {
  try { return (await db.query(`SELECT * FROM play_attempts WHERE ${where} ORDER BY id`)).rows; } catch (e) { return []; }
};

test('server: puzzle attempts - won, given up, left open (restart), archive days and extra names never count', async (t) => {
  const databaseUrl = testDatabaseUrl('pa_srv_puzzle');
  const { Pool } = require('pg');
  const db = new Pool({ connectionString: databaseUrl, max: 2 });
  t.after(() => db.end());
  const today = gameDay();
  const yesterday = addDays(today, -1);
  const p = DP.puzzleForDate(today);
  const kind = p.kind;
  const ans = puzzleDay(kind, today);
  assert.strictEqual(ans.day, today);
  const openedBefore = Date.now() - 10 * 60 * 1000;
  const yvLast = dayEnd(yesterday) - 2 * 60 * 60 * 1000; // 22:00 yesterday, German time
  const srv = await startServer(t, databaseUrl, { puzzleAttempts: [
    { name: 'Yvonne', day: yesterday, kind: 'out', openedAt: yvLast - 60000, lastAt: yvLast, tries: 2, wrong: { notOut: 2 }, firstWrong: 'notOut' },
    { name: 'Tina', day: today, kind, openedAt: openedBefore, lastAt: openedBefore + 1000, tries: 0, wrong: { meld: 1 }, firstWrong: 'meld' },
  ] });

  // The restart: yesterday's open attempt ends at once, as abandoned at its last action.
  const [yv] = await waitFor(async () => { const r = await dbRows(db, "player_key = 'yvonne'"); return r.length && r; }, 'restored day end');
  assert.deepStrictEqual([yv.mode, yv.period, yv.stage, yv.outcome, yv.turns, yv.facts.reason, yv.facts.cause, yv.game_day, yv.attempt_id],
    ['puzzle', yesterday, null, 'abandoned', 2, 'dayEnd', 'notOut', yesterday, `puzzle:${yesterday}:yvonne`]);
  assert.strictEqual(yv.ended_at.getTime(), yvLast);

  const s = await srv.socket();
  const solve = (name, x) => s.ask({ type: 'solvePuzzle', name, ...x }, 'puzzleResult');
  // Pia: a refused meld, a wrong answer, a near miss, the solve.
  await s.ask({ type: 'getPuzzle', name: 'Pia' }, 'puzzle');
  assert.strictEqual((await s.ask({ type: 'checkPuzzleMeld', name: 'Pia', cardIds: (ans.bad.melds || [ans.bad.cardIds])[0] }, 'puzzleMeldCheck')).valid, false);
  assert.strictEqual((await solve('Pia', ans.bad)).valid, false);
  assert.strictEqual((await solve('Pia', ans.near)).solved, false);
  const solved = await solve('Pia', ans.right);
  assert.strictEqual(solved.solved, true);
  const [pia] = await waitFor(async () => { const r = await dbRows(db, "player_key = 'pia'"); return r.length && r; }, 'won row');
  const near = kind === 'out' ? 'notOut' : 'points';
  assert.deepStrictEqual([pia.period, pia.outcome, pia.turns, pia.attempt_id], [today, 'won', 3, `puzzle:${today}:pia`]);
  assert.deepStrictEqual(pia.facts, { kind, mistakes: 3, wrong: { meld: 2, [near]: 1 }, stars: DP.starsFor(kind, 3), firstWrong: 'meld' });
  assert.ok(pia.started_at < pia.ended_at && pia.game_day === today);

  // Gabi: three wrong answers, then the solution: given up, stuck.
  await s.ask({ type: 'getPuzzle', name: 'Gabi' }, 'puzzle');
  for (let i = 0; i < 3; i++) await solve('Gabi', ans.bad);
  await s.ask({ type: 'revealPuzzle', name: 'Gabi' }, 'puzzleSolution');
  const [gabi] = await waitFor(async () => { const r = await dbRows(db, "player_key = 'gabi'"); return r.length && r; }, 'lost row');
  assert.deepStrictEqual([gabi.outcome, gabi.turns, gabi.facts.gaveUp, gabi.facts.cause, gabi.facts.mistakes], ['lost', 3, true, 'meld', 3]);

  // Tina was open before the restart: her solve keeps the first look and the earlier mistake.
  await solve('Tina', ans.right);
  const [tina] = await waitFor(async () => { const r = await dbRows(db, "player_key = 'tina'"); return r.length && r; }, 'restored won');
  assert.deepStrictEqual([tina.outcome, tina.started_at.getTime(), tina.facts.mistakes, tina.facts.firstWrong], ['won', openedBefore, 1, 'meld']);

  // An archive day is graded but never an attempt; a solved day never twice.
  await s.ask({ type: 'getPuzzle', name: 'Arne', date: yesterday }, 'puzzle');
  await s.ask({ type: 'revealPuzzle', name: 'Arne', date: yesterday }, 'puzzleSolution');
  await solve('Pia', ans.right);
  await s.ask({ type: 'revealPuzzle', name: 'Pia' }, 'puzzleSolution');

  // A connection tracks a few names, not a list of invented ones.
  const spam = await srv.socket();
  for (let i = 0; i < 8; i++) await spam.ask({ type: 'revealPuzzle', name: `Spam${i}` }, 'puzzleSolution');
  await new Promise((r) => setTimeout(r, 400));
  const names = (await dbRows(db)).map((r) => r.player_key);
  assert.deepStrictEqual(names.filter((n) => !n.startsWith('spam')).sort(), ['gabi', 'pia', 'tina', 'yvonne']);
  assert.strictEqual(names.filter((n) => n.startsWith('spam')).length, 5);

  // Admin: the puzzle view and a player's tries.
  const auth = 'admin:am-token';
  const view = await request(srv.port, 'GET', '/admin/stuck?mode=puzzle&days=7', { auth });
  assert.strictEqual(view.status, 200);
  assert.match(view.body, /class="active" aria-current="page">7 Tage</);
  assert.match(view.body, /href="\/admin\/stuck\?mode=puzzle&amp;days=7&amp;player=Gabi">Gabi<\/a>/);
  const odd = await request(srv.port, 'GET', '/admin/stuck?mode=puzzle&days=999', { auth });
  assert.match(odd.body, /class="active" aria-current="page">14 Tage</, 'an unknown range falls back to 14 days');
  const gabiView = await request(srv.port, 'GET', '/admin/stuck?mode=puzzle&days=7&player=gabi', { auth });
  assert.match(gabiView.body, /Rätsel von Gabi/);
  assert.match(gabiView.body, /aufgegeben/);
  assert.doesNotMatch(srv.out.log, /not stored/);
});

/** A tutorial table as a snapshot session, the learner one card from the end of round 1. */
function tutorialSnap(code, playerId, name) {
  const g = new GameManager(() => {}, { deckSeed: GameManager.TUTORIAL_SEED, tutorialMode: true });
  g.maybeRunBotTurn = () => {};
  g.addOrReconnectPlayer(playerId, name);
  g.startTutorialRound();
  const me = g.players.find((p) => p.id === playerId);
  g.tutorialStep(playerId, 'welcome', 'shown', Date.now() - 60000);
  g.tutorialStep(playerId, 'welcome', 'done', Date.now() - 50000);
  g.tutorialStep(playerId, 'endgame', 'shown', Date.now() - 1000);
  me.laidOutCards = me.hand.slice(1);
  me.hand = me.hand.slice(0, 1);
  g.turnPhase = 'meld';
  const state = JSON.parse(JSON.stringify(g.serialize()));
  g.destroy();
  const now = Date.now();
  return { session: { code, createdAt: now, lastActivity: now, playerTokens: { [playerId]: `tok-${playerId}` }, stammtisch: null, state }, lastCardId: me.hand[0].id };
}

test('server: tutorial lessons over the wire; junk ignored; left, skipped and finished are one row each', async (t) => {
  const databaseUrl = testDatabaseUrl('pa_srv_tutorial');
  const { Pool } = require('pg');
  const db = new Pool({ connectionString: databaseUrl, max: 2 });
  t.after(() => db.end());
  const snap = tutorialSnap('TUTFIN', 'p-fin', 'Fina');
  const srv = await startServer(t, databaseUrl, { sessions: [snap.session] });

  // Lena: two lessons, junk, three refused moves at "draw", then she leaves from the start screen.
  const a = await srv.socket();
  const joined = await a.ask({ type: 'startTutorial', name: 'Lena' }, 'joined');
  await waitFor(() => a.box.find((m) => m.type === 'state' && m.state.phase === 'playing'), 'tutorial dealt');
  for (const m of [
    { type: 'tutorialStep', step: 'welcome', status: 'shown' }, { type: 'tutorialStep', step: 'welcome', status: 'done' },
    { type: 'tutorialStep', step: 'draw', status: 'shown' },
    { type: 'tutorialStep', step: 'nope', status: 'shown' }, { type: 'tutorialStep', step: '__proto__', status: 'done' },
    { type: 'tutorialStep', step: { $gt: 1 }, status: 'shown' }, { type: 'tutorialStep', step: 'x'.repeat(4000), status: 'shown' },
    { type: 'tutorialStep', step: 'draw', status: 'finished' }, { type: 'tutorialStep', status: 42 }, { type: 'tutorialStep' },
  ]) a.send(m);
  await new Promise((r) => setTimeout(r, 300));
  for (let i = 0; i < 3; i++) await a.ask({ type: 'discard', cardId: 'nope' }, 'error');
  assert.ok(!a.box.some((m) => m.type === 'error' && /tutorialStep|Unbekannter/.test(m.error)), 'reports are never answered');
  const home = await srv.socket();
  await home.ask({ type: 'abandonSession', code: joined.sessionCode, playerId: joined.playerId, playerToken: joined.playerToken }, 'sessionAbandoned');
  const [lena] = await waitFor(async () => { const r = await dbRows(db, "player_key = 'lena'"); return r.length && r; }, 'left row');
  assert.deepStrictEqual([lena.mode, lena.period, lena.stage, lena.outcome], ['tutorial', TUTORIAL_VERSION, 2, 'abandoned']);
  assert.deepStrictEqual([lena.facts.step, lena.facts.reached, lena.facts.done, lena.facts.errors, lena.facts.reason, lena.facts.cause],
    ['draw', ['welcome', 'draw'], ['welcome'], { draw: 3 }, 'left', 'stuck']);

  // Kai switches the hints off: abandoned as skipped; the table plays on without a second row.
  const b = await srv.socket();
  await b.ask({ type: 'startTutorial', name: 'Kai' }, 'joined');
  await waitFor(() => b.box.find((m) => m.type === 'state' && m.state.phase === 'playing'), 'dealt');
  b.send({ type: 'tutorialStep', step: 'welcome', status: 'shown' });
  b.send({ type: 'tutorialStep', status: 'off' });
  b.send({ type: 'tutorialStep', step: 'draw', status: 'shown' });
  const [kai] = await waitFor(async () => { const r = await dbRows(db, "player_key = 'kai'"); return r.length && r; }, 'skipped row');
  assert.deepStrictEqual([kai.outcome, kai.stage, kai.facts.reason, kai.facts.cause, kai.facts.reached], ['abandoned', 1, 'skipped', 'skipped', ['welcome']]);

  // Not a tutorial table: reports are dropped, the connection lives on.
  const c = await srv.socket();
  await c.ask({ type: 'createSession', name: 'Nora' }, 'joined');
  c.send({ type: 'tutorialStep', step: 'welcome', status: 'shown' });
  assert.ok(await c.ask({ type: 'ping' }, 'pong'));

  // Fina comes back to her restored table and goes out: round 1 scored, won, once.
  const f = await srv.socket();
  await f.ask({ type: 'joinSession', code: 'TUTFIN', playerId: 'p-fin', playerToken: 'tok-p-fin', name: 'Fina' }, 'joined');
  f.send({ type: 'discard', cardId: snap.lastCardId });
  await waitFor(() => f.box.find((m) => m.type === 'state' && m.state.phase === 'roundEnd'), 'round 1 scored');
  const [fina] = await waitFor(async () => { const r = await dbRows(db, "player_key = 'fina'"); return r.length && r; }, 'won row');
  assert.deepStrictEqual([fina.outcome, fina.stage, fina.facts.step, fina.facts.reached, fina.facts.done, fina.attempt_id],
    ['won', tutorialStepIndex('roundend'), 'roundend', ['welcome', 'endgame', 'roundend'], ['welcome', 'roundend'], snap.session.state.attemptId]);
  f.send({ type: 'nextRound' });
  await new Promise((r) => setTimeout(r, 300));
  assert.strictEqual((await dbRows(db, "player_key = 'fina'")).length, 1);

  const view = await request(srv.port, 'GET', '/admin/stuck?mode=tutorial', { auth: 'admin:am-token' });
  assert.match(view.body, /<span>Starts<\/span><b>3<\/b>/);
  assert.match(view.body, /<b>2\. Karte aufnehmen<\/b>/);
  assert.match(view.body, /<span>Über&shy;sprungen<\/span><b>1<\/b>/, 'a soft hyphen breaks the long label on a phone tile');
  assert.strictEqual((await request(srv.port, 'GET', '/admin/stuck?mode=tutorial&version=v<script>', { auth: 'admin:am-token' })).body.includes('<script>'), false);
  assert.doesNotMatch(srv.out.log, /not stored/);
});

// Daily challenge store on PostgreSQL: one attempt per player and day (begun =
// used, atomic), the board, the "Damen-Magnet des Tages", retention and the
// one-time import of the old challenges.json.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createChallengeStore, todayDate } = require('../game/ChallengeStore');
const { computeEarnedBadges } = require('../game/Badges');
const { gameDay, addDays } = require('../game/GameDay');
const { testPool } = require('./helpers/test-db');

const NOW = Date.parse('2026-10-16T10:00:00Z'); // game day 2026-10-16
const TODAY = '2026-10-16';
const freshStore = (t, opts = { legacyFile: null }) => createChallengeStore(testPool(t, 'challenge'), opts);
const tmpFile = (content) => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pikchal-')), 'challenges.json');
  if (content !== undefined) fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
  return file;
};

test('the first started game of a day is the attempt, a restart is refused', async (t) => {
  const cs = freshStore(t);
  assert.equal(await cs.hasAttempted(TODAY, 'Flo'), false);
  assert.deepEqual(await cs.beginAttempt(TODAY, 'Flo', 'AAAA01', NOW), { ranked: true });
  assert.equal(await cs.hasAttempted(TODAY, 'flo'), true, 'begun = used, case-insensitive');
  assert.deepEqual(await cs.beginAttempt(TODAY, 'FLO', 'AAAA02', NOW), { ranked: false }, 'a restart is refused');
  assert.deepEqual(await cs.beginAttempt('2026-10-17', 'Flo', 'AAAA03', NOW), { ranked: true }, 'a new day, a new attempt');
  assert.deepEqual(await cs.beginAttempt(TODAY, 'Anna', 'AAAA04', NOW), { ranked: true }, 'per player');
});

test('two racing starts for the same name: exactly one is ranked', async (t) => {
  const pool = testPool(t, 'challenge_race');
  const a = createChallengeStore(pool, { legacyFile: null });
  const b = createChallengeStore(pool, { legacyFile: null }); // a second replica
  await a.ready();
  const results = await Promise.all([
    a.beginAttempt(TODAY, 'Flo', 'RACE01', NOW), b.beginAttempt(TODAY, 'flo', 'RACE02', NOW),
    a.beginAttempt(TODAY, 'FLO', 'RACE03', NOW), b.beginAttempt(TODAY, ' Flo ', 'RACE04', NOW),
  ]);
  assert.equal(results.filter((r) => r.ranked).length, 1);
  const winner = ['RACE01', 'RACE02', 'RACE03', 'RACE04'][results.findIndex((r) => r.ranked)];
  assert.equal(await a.runningAttempt(TODAY, 'Flo'), winner, 'the ranked start owns the attempt');
  // A lost attempt is re-usable, but again only once.
  await a.markLostAttempts(new Set());
  const again = await Promise.all([a.beginAttempt(TODAY, 'Flo', 'AGAIN1', NOW), b.beginAttempt(TODAY, 'Flo', 'AGAIN2', NOW)]);
  assert.equal(again.filter((r) => r.ranked).length, 1);
});

test('a result from before attempts were tracked uses the day up', async (t) => {
  const cs = freshStore(t);
  await cs.submit(TODAY, 'Flo', 700, NOW);
  assert.deepEqual(await cs.beginAttempt(TODAY, 'Flo', 'BBBB01', NOW), { ranked: false });
});

test('a ranked game lost by the server frees the day, one that was given up does not', async (t) => {
  const cs = freshStore(t);
  await cs.beginAttempt(TODAY, 'Lost', 'GONE01', NOW);
  await cs.beginAttempt(TODAY, 'Alive', 'LIVE01', NOW);
  await cs.beginAttempt(TODAY, 'Quit', 'GONE02', NOW);
  await cs.closeAttempt(TODAY, 'quit'); // forfeit
  await cs.beginAttempt(TODAY, 'Done', 'GONE03', NOW);
  await cs.submit(TODAY, 'Done', 450, NOW);
  await cs.markLostAttempts(new Set(['LIVE01'])); // server start: only LIVE01 came back
  assert.equal(await cs.hasAttempted(TODAY, 'Lost'), false, 'lost by the server');
  assert.deepEqual(await cs.beginAttempt(TODAY, 'Lost', 'NEW001', NOW), { ranked: true }, 'gets a new ranked attempt');
  assert.deepEqual(await cs.beginAttempt(TODAY, 'Alive', 'LIVE02', NOW), { ranked: false }, 'still running elsewhere');
  assert.deepEqual(await cs.beginAttempt(TODAY, 'Quit', 'NEW002', NOW), { ranked: false }, 'giving up uses the day');
  assert.deepEqual(await cs.beginAttempt(TODAY, 'Done', 'NEW003', NOW), { ranked: false }, 'a result uses the day');
});

test('a new store on the same database keeps attempts and results (restart)', async (t) => {
  const pool = testPool(t, 'challenge_restart');
  const before = createChallengeStore(pool, { legacyFile: null });
  await before.beginAttempt(TODAY, 'Flo', 'KEEP01', NOW);
  await before.submit(TODAY, 'Anna', 900, NOW);
  const after = createChallengeStore(pool, { legacyFile: null });
  assert.equal(await after.runningAttempt(TODAY, 'Flo'), 'KEEP01');
  assert.deepEqual(await after.beginAttempt(TODAY, 'Flo', 'KEEP02', NOW), { ranked: false });
  assert.deepEqual(await after.getBoard(TODAY), [{ rank: 1, name: 'Anna', score: 900 }]);
});

test('attempts and results are pruned with the days (14-day window)', async (t) => {
  const cs = freshStore(t);
  await cs.beginAttempt('2026-09-01', 'Old', 'OLD001', NOW);
  await cs.submit('2026-09-01', 'Old', 100, NOW);
  await cs.submit(addDays(TODAY, -14), 'Edge', 100, NOW); // still kept
  await cs.beginAttempt(TODAY, 'New', 'NEW001', NOW); // the next write prunes
  assert.equal(await cs.hasAttempted('2026-09-01', 'Old'), false);
  assert.deepEqual(await cs.getBoard('2026-09-01'), []);
  assert.equal(await cs.playerCount(addDays(TODAY, -14)), 1);
  assert.equal(await cs.hasAttempted(TODAY, 'New'), true);
});

test('first result per name, ranked board (score desc, then the earlier finish)', async (t) => {
  const cs = freshStore(t);
  const today = gameDay();
  await cs.submit(today, 'Anna', 480);
  await cs.submit(today, 'anna', 350); // case-insensitive: the first result stays
  await cs.submit(today, 'ANNA', 900); // a better later game is practice, too
  await cs.submit(today, 'Ben', 620);
  await cs.submit(today, 'Cid', 480, Date.now() + 1000);
  const board = await cs.getBoard(today);
  assert.deepEqual(board.map((e) => [e.name, e.score]), [['Ben', 620], ['Anna', 480], ['Cid', 480]]);
  assert.equal(await cs.rankOf(today, 'ANNA'), 2);
  assert.equal(await cs.rankOf(today, 'Nobody'), null);
  assert.equal((await cs.getBoard(today, 1)).length, 1);
});

test('a day keeps the best 100 results', async (t) => {
  const cs = freshStore(t);
  for (let i = 0; i < 102; i++) await cs.submit(TODAY, `P${i}`, i, NOW + i);
  assert.equal(await cs.playerCount(TODAY), 100);
  assert.equal(await cs.resultOf(TODAY, 'P0'), null, 'the two lowest fell off');
  assert.equal((await cs.resultOf(TODAY, 'P101')).rank, 1);
});

test('Damen-Magnet des Tages: most queens caught, tie goes to the lower score, then the earlier finish', async (t) => {
  const cs = freshStore(t);
  assert.equal(await cs.queenMagnet(TODAY), null, 'nobody played');
  await cs.submit(TODAY, 'Clean', 900, NOW, { queens: 0 });
  assert.equal(await cs.queenMagnet(TODAY), null, 'nobody was caught');
  await cs.submit(TODAY, 'Ada', 500, NOW + 1, { queens: 2 });
  await cs.submit(TODAY, 'Ben', 300, NOW + 2, { queens: 2 });
  await cs.submit(TODAY, 'Cid', 300, NOW + 3, { queens: 2 });
  assert.deepEqual(await cs.queenMagnet(TODAY), { name: 'Ben', queens: 2 });
  await cs.submit(TODAY, 'Dora', 800, NOW + 4, { queens: 3 });
  assert.deepEqual(await cs.queenMagnet(TODAY), { name: 'Dora', queens: 3 });
  assert.equal((await cs.getHistory(null, 3, NOW))[0].magnet.name, 'Dora', 'history carries the magnet per day');
});

test('the magnet badge goes to the holder of a day that is over', async (t) => {
  const cs = freshStore(t);
  await cs.submit(TODAY, 'Ada', 500, NOW, { queens: 2 });
  assert.equal(await cs.wasQueenMagnet('ada', NOW), false, 'today is still open');
  await cs.submit('2026-10-15', 'Ada', 400, NOW, { queens: 1 });
  await cs.submit('2026-10-15', 'Ben', 100, NOW, { queens: 0 });
  assert.equal(await cs.wasQueenMagnet('ADA', NOW), true);
  assert.equal(await cs.wasQueenMagnet('Ben', NOW), false);
  const rec = { players: [{ id: 'p1', name: 'Ada' }], rounds: [], finalTotals: { p1: 0 }, winnerId: null };
  assert.ok(computeEarnedBadges(rec, 'p1', {}, { queenMagnet: true }).includes('queen_magnet_day'));
  assert.ok(!computeEarnedBadges(rec, 'p1', {}, {}).includes('queen_magnet_day'));
});

test('wasChampion: first place counts only once the day is over', async (t) => {
  const cs = freshStore(t);
  const now = Date.parse('2026-10-05T10:00:00Z');
  await cs.submit('2026-10-05', 'Ada', 900, now); // today: still open
  assert.equal(await cs.wasChampion('ada', now), false);
  await cs.submit('2026-10-04', 'Ben', 300, now);
  await cs.submit('2026-10-04', 'Ada', 500, now);
  assert.equal(await cs.wasChampion('Ada', now), true);
  assert.equal(await cs.wasChampion('Ben', now), false, 'second place is not first');
  assert.equal(await cs.wasChampion('', now), false);
});

test('resultOf: rank, score, caught queens and field size for sharing', async (t) => {
  const cs = freshStore(t);
  assert.equal(await cs.resultOf(TODAY, 'Flo'), null, 'no ranked game yet');
  await cs.submit(TODAY, 'Anna', 900, NOW);
  await cs.submit(TODAY, 'Flo', 1120, NOW, { queens: 2 });
  await cs.submit(TODAY, 'Ben', 400, NOW);
  assert.deepEqual(await cs.resultOf(TODAY, 'flo'), { rank: 1, score: 1120, queens: 2, players: 3 });
  assert.deepEqual(await cs.resultOf(TODAY, 'Ben'), { rank: 3, score: 400, queens: 0, players: 3 });
});

test('hasFinished: a result or a given-up game opens the day, a running or lost one does not', async (t) => {
  const cs = freshStore(t);
  assert.equal(await cs.hasFinished(TODAY, 'Flo'), false);
  await cs.beginAttempt(TODAY, 'Flo', 'AAAA01', NOW);
  assert.equal(await cs.hasFinished(TODAY, 'Flo'), false, 'still running');
  await cs.closeAttempt(TODAY, 'Flo');
  assert.equal(await cs.hasFinished(TODAY, 'flo'), true, 'given up');
  await cs.beginAttempt(TODAY, 'Ben', 'AAAA02', NOW);
  await cs.markLostAttempts(new Set());
  assert.equal(await cs.hasFinished(TODAY, 'Ben'), false, 'lost by the server');
  await cs.submit(TODAY, 'Anna', 900, NOW);
  assert.equal(await cs.hasFinished(TODAY, 'Anna'), true, 'played');
  assert.equal(await cs.playerCount(TODAY), 1);
});

test('exclude: weekly and trend leave out the hidden day', async (t) => {
  const cs = freshStore(t);
  await cs.submit(TODAY, 'Anna', 900, NOW);
  await cs.submit('2026-10-15', 'Ben', 500, NOW - 864e5);
  assert.deepEqual((await cs.getWeekly(null, 5, NOW, { exclude: TODAY })).top.map((e) => e.name), ['Ben']);
  const trend = await cs.getTrend(null, { exclude: TODAY }, NOW);
  assert.deepEqual(trend.top.map((p) => p.name), ['Ben']);
  assert.equal(trend.dates[trend.dates.length - 1], TODAY, 'the day stays on the axis, empty');
});

test('challenge history lists past days with winner and own rank; empty past days skipped', async (t) => {
  const store = freshStore(t);
  const now = Date.now();
  const d0 = todayDate(now), d1 = todayDate(now - 86400000), d3 = todayDate(now - 3 * 86400000);
  await store.submit(d3, 'Flo', 500, now - 3 * 86400000);
  await store.submit(d3, 'Anna', 800, now - 3 * 86400000);
  await store.submit(d1, 'Flo', 650, now - 86400000);
  await store.submit(d0, 'Flo', 700, now);
  const h = await store.getHistory('Flo', 3, now);
  assert.equal(h[0].date, d0, 'today first');
  const day1 = h.find((d) => d.date === d1);
  const day3 = h.find((d) => d.date === d3);
  assert.ok(day1 && day3, 'past days with entries are listed');
  assert.equal(day3.top[0].name, 'Anna', 'daily winner shown');
  assert.equal(day3.yourRank, 2, 'own rank per day');
  assert.equal(day1.yourScore, 650);
  assert.ok(!h.some((d) => d.players === 0 && d.date !== d0), 'empty past days skipped');
});

test('weekly challenge board sums the best 5 daily scores of the current week', async (t) => {
  const store = freshStore(t);
  const sunday = Date.UTC(2026, 6, 19, 12); // 2026-07-19 is a Sunday: the whole week counts
  for (let i = 0; i < 7; i++) {
    const at = sunday - i * 86400000;
    await store.submit(todayDate(at), 'Flo', 100 + i * 10, at); // 100..160 over Mon..Sun
  }
  await store.submit(todayDate(sunday), 'Anna', 500, sunday); // one day, high score
  const w = await store.getWeekly('Flo', 5, sunday);
  assert.equal(w.top[0].name, 'Flo');
  assert.equal(w.top[0].weekScore, 700, 'best 5 of 7 days count');
  assert.equal(w.top[0].days, 7);
  assert.equal(w.top[1].name, 'Anna');
  assert.equal(w.top[1].weekScore, 500, 'a single big day does not beat a steady week');
  assert.equal(w.yourRank, 1);
});

test('challenge history does not skip a day right after the spring DST switch', async (t) => {
  // 2026-03-31 00:30 CEST: stepping back in 24h blocks would jump from 03-31 straight to 03-29.
  const store = freshStore(t);
  const now = Date.parse('2026-03-30T22:30:00Z');
  assert.equal(gameDay(now), '2026-03-31');
  await store.submit('2026-03-30', 'Flo', 300, now);
  await store.submit('2026-03-31', 'Flo', 400, now);
  const dates = (await store.getHistory('Flo', 3, now)).map((d) => d.date);
  assert.deepEqual(dates.slice(0, 2), ['2026-03-31', '2026-03-30']);
});

test('the weekly board starts on Monday German time, not UTC', async (t) => {
  const store = freshStore(t);
  // Sunday 2026-07-19 23:30Z = Monday 01:30 in Germany: a new week.
  const now = Date.parse('2026-07-19T23:30:00Z');
  await store.submit('2026-07-19', 'Flo', 500, now);
  await store.submit('2026-07-20', 'Anna', 100, now);
  const w = await store.getWeekly(null, 5, now);
  assert.equal(w.week, '2026-07-20..2026-07-20');
  assert.deepEqual(w.top.map((e) => e.name), ['Anna'], 'last week does not count');
});

test('challenge trend: me vs. the top 5 others of 14 game days, gaps as null (#303)', async (t) => {
  const store = freshStore(t);
  const now = Date.parse('2026-10-05T10:00:00Z');
  const today = gameDay(now);
  const oldest = addDays(today, -13);
  await store.submit(oldest, 'Flo', 210, now); // oldest day still in the window
  await store.submit(addDays(today, -14), 'Zed', 9999, now); // outside: never counts
  await store.submit(today, 'Flo', 320, now);
  // Seven others: the top 5 by 14-day SUM, not by a single day.
  for (const [n, s1, s2] of [['Ada', 500, 500], ['Ben', 900, null], ['Cem', 300, 300], ['Dan', 200, 200], ['Eva', 250, 100], ['Fritz', 100, null], ['Gil', 50, null]]) {
    await store.submit(today, n, s1, now);
    if (s2 != null) await store.submit(oldest, n, s2, now);
  }
  const tr = await store.getTrend('flo', {}, now);
  assert.equal(tr.dates.length, 14);
  assert.deepEqual([tr.dates[0], tr.dates[13]], [oldest, today]);
  assert.deepEqual(tr.me.scores.filter((v) => v != null), [210, 320]);
  assert.equal(tr.me.total, 530);
  assert.ok(tr.me.scores.slice(1, 13).every((v) => v === null), 'days not played are gaps');
  assert.deepEqual(tr.top.map((p) => [p.name, p.total]), [['Ada', 1000], ['Ben', 900], ['Cem', 600], ['Dan', 400], ['Eva', 350]]);
  assert.ok(!tr.top.some((p) => p.name === 'Flo' || p.name === 'Zed'), 'me excluded, out-of-window ignored');
  assert.equal((await store.getTrend('', {}, now)).me, null, 'without a name: only the top 5');
  // The public board still shows 7 days, retention keeps 14 for the trend.
  assert.ok((await store.getHistory('Flo', 3, now)).every((d) => d.date > addDays(today, -7)));
});

// --- One-time import of the old challenges.json -----------------------------
const LEGACY = {
  days: {
    [TODAY]: [{ name: 'Anna', score: 900, at: NOW, queens: 2 }, { name: 'Ben', score: 400, at: NOW + 1 }, { bogus: true }],
  },
  attempts: {
    [TODAY]: {
      anna: { name: 'Anna', code: 'IMP001', at: NOW, state: 'done' },
      flo: { name: 'Flo', code: 'IMP002', at: NOW, state: 'running' },
      odd: { name: 'Odd', code: 'IMP003', at: NOW, state: 'weird' },
    },
  },
};

test('import: challenges.json moves into the tables once, then the file is renamed', async (t) => {
  const pool = testPool(t, 'challenge_import');
  const file = tmpFile(LEGACY);
  const cs = createChallengeStore(pool, { legacyFile: file });
  assert.deepEqual(await cs.resultOf(TODAY, 'anna'), { rank: 1, score: 900, queens: 2, players: 2 }, 'the first call waits for the import');
  assert.equal(await cs.runningAttempt(TODAY, 'Flo'), 'IMP002');
  assert.equal(await cs.hasAttempted(TODAY, 'Odd'), false, 'a malformed attempt is skipped');
  assert.ok(!fs.existsSync(file) && fs.existsSync(`${file}.migrated`), 'renamed after the commit');
  // A file showing up again (e.g. restored by hand) is never imported twice.
  fs.writeFileSync(file, JSON.stringify({ days: { [TODAY]: [{ name: 'Late', score: 5000, at: NOW }] } }));
  const again = createChallengeStore(pool, { legacyFile: file });
  assert.equal(await again.resultOf(TODAY, 'Late'), null);
  assert.ok(!fs.existsSync(file), 'moved aside without importing');
  assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM legacy_imports')).rows[0].n, 1);
});

test('import: an unreadable file blocks the import (no marker), the store keeps working', async (t) => {
  const pool = testPool(t, 'challenge_badfile');
  const file = tmpFile('{"days": {');
  const errors = [];
  t.mock.method(console, 'error', (...args) => errors.push(args.join(' ')));
  const cs = createChallengeStore(pool, { legacyFile: file });
  assert.deepEqual(await cs.beginAttempt(TODAY, 'Flo', 'BAD001', NOW), { ranked: true }, 'the challenge still works');
  assert.ok(fs.existsSync(file) && !fs.existsSync(`${file}.migrated`), 'the file stays for the next try');
  assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM legacy_imports')).rows[0].n, 0, 'never marked done');
  assert.ok(errors.some((e) => /challenges\.json import failed/.test(e)));
  // Fixed by hand: the next start imports it, a running attempt in the database wins.
  fs.writeFileSync(file, JSON.stringify({ attempts: { [TODAY]: { flo: { name: 'Flo', code: 'OLD999', at: NOW, state: 'done' } } }, days: { [TODAY]: [{ name: 'Anna', score: 1, at: NOW }] } }));
  const next = createChallengeStore(pool, { legacyFile: file });
  assert.equal(await next.playerCount(TODAY), 1);
  assert.equal(await next.runningAttempt(TODAY, 'Flo'), 'BAD001');
});

test('import: no file, nothing to do', async (t) => {
  const pool = testPool(t, 'challenge_nofile');
  const cs = createChallengeStore(pool, { legacyFile: tmpFile() });
  assert.equal(await cs.playerCount(TODAY), 0);
  assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM legacy_imports')).rows[0].n, 0);
});

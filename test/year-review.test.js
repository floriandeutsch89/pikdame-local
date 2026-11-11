/** "Dein Pik-Dame-Jahr": the per-year counters and the review built from them
 *  (game/YearReview.js), and their store, which must survive a restart. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const YR = require('../game/YearReview');
const { createYearStatsStore } = require('../game/YearStatsStore');
const { testPool } = require('./helpers/test-db');

const facts = (over = {}) => ({ bestRound: 0, pdLaid: 0, pdCaught: 0, jokersLaid: 0, handAusWins: 0, ...over });

test('the review season is December of the German game day, nothing else', () => {
  for (const d of ['2026-12-01', '2026-12-24', '2026-12-31']) assert.ok(YR.isReviewSeason(d), d);
  for (const d of ['2026-11-30', '2027-01-01', '2026-06-12', '', null, '2026-12']) assert.ok(!YR.isReviewSeason(d), String(d));
});

test('strongestBot: the highest level at the table, Zen without a level, null without bots', () => {
  assert.strictEqual(YR.strongestBot([{ isBot: true, botDifficulty: 'easy' }, { isBot: true, botDifficulty: 'hard' }, { isBot: false }]), 'hard');
  assert.strictEqual(YR.strongestBot([{ isBot: true }]), 'zen');
  assert.strictEqual(YR.strongestBot([{ isBot: false }, { isBot: false }]), null);
  assert.strictEqual(YR.strongestBot(undefined), null);
});

test('bumpYear counts games, wins, facts, distinct days, opponents, bots and tables', () => {
  let y = YR.bumpYear(undefined, { date: '2026-03-01', won: true, score: 1040, facts: facts({ bestRound: 270, pdLaid: 1, jokersLaid: 2 }), opponents: ['Gerda'], botLevel: 'zen', table: 'Familie' });
  y = YR.bumpYear(y, { date: '2026-03-01', won: false, score: 880, facts: facts({ pdCaught: 1, handAusWins: 1 }), opponents: ['gerda', 'Klaus'], botLevel: 'easy', table: 'familie' });
  y = YR.bumpYear(y, { date: '2026-03-02', won: false, score: 300, facts: facts(), opponents: [], botLevel: null, table: null });
  assert.strictEqual(y.games, 3);
  assert.strictEqual(y.wins, 1);
  assert.strictEqual(y.queensLaid, 1);
  assert.strictEqual(y.queensCaught, 1);
  assert.strictEqual(y.jokers, 2);
  assert.strictEqual(y.handAus, 1);
  assert.strictEqual(y.bestRound, 270);
  assert.strictEqual(y.bestGame, 1040);
  assert.strictEqual(y.days, 2, 'two games on one day count one day');
  assert.deepStrictEqual(y.opponents.gerda, { name: 'gerda', games: 2, wins: 1 }, 'one opponent, any spelling');
  assert.deepStrictEqual(y.opponents.klaus, { name: 'Klaus', games: 1, wins: 0 });
  assert.deepStrictEqual(y.bots, { zen: { games: 1, wins: 1 }, easy: { games: 1, wins: 0 } });
  assert.deepStrictEqual(y.tables.familie, { name: 'familie', games: 2, wins: 1 });
});

test('bumpYear keeps the opponent list small: the 30 most played survive', () => {
  let y;
  for (let i = 0; i < 40; i++) {
    const games = i < 5 ? 3 : 1;
    for (let g = 0; g < games; g++) y = YR.bumpYear(y, { date: '2026-05-01', won: false, score: 0, opponents: [`P${i}`] });
  }
  assert.strictEqual(Object.keys(y.opponents).length, 30);
  for (let i = 0; i < 5; i++) assert.ok(y.opponents[`p${i}`], `frequent opponent P${i} kept`);
});

test('noteStreak keeps the longest streak of the year', () => {
  let y = YR.noteStreak(undefined, 4);
  y = YR.noteStreak(y, 2);
  y = YR.noteStreak(y, 9);
  assert.strictEqual(y.bestStreak, 9);
  assert.strictEqual(y.games, 0, 'a streak alone is no game');
});

test('buildReview: a profile born this year reports its exact all-time counters', () => {
  const profile = {
    id: `profile-${Date.parse('2026-07-05T10:00:00Z')}-x`, name: 'Flo', gamesPlayed: 43, gamesWon: 17,
    totalQueensLaid: 12, totalQueensCaught: 3, bestRoundScore: 285, bestGameScore: 1385, totalHandAus: 1, totalJokersLaid: 40,
    dailyStreak: 2, daily: { best: 11 },
  };
  let bucket = YR.bumpYear(undefined, { date: '2026-10-20', won: true, score: 900, opponents: ['Gerda'], botLevel: 'medium', table: 'Familie' });
  bucket = YR.bumpYear(bucket, { date: '2026-10-21', won: false, score: 700, opponents: ['Gerda', 'Klaus'], botLevel: 'zen' });
  const r = YR.buildReview({ year: '2026', profile, bucket, trackingSince: '2026-10-17' });
  assert.deepStrictEqual(r.totals, { games: 43, wins: 17, queensLaid: 12, queensCaught: 3, bestRound: 285, bestGame: 1385, handAus: 1, jokers: 40, bestStreak: 11 });
  assert.strictEqual(r.totalsSince, null, 'totals are exact');
  assert.strictEqual(r.breakdownSince, '2026-10-17', 'the breakdown only exists since the counter started');
  assert.deepStrictEqual(r.favorite, { name: 'Gerda', games: 2, wins: 1 });
  assert.deepStrictEqual(r.bots, [{ level: 'medium', games: 1, wins: 1 }, { level: 'zen', games: 1, wins: 0 }], 'weakest level first');
  assert.deepStrictEqual(r.table, { name: 'Familie', games: 1, wins: 1 });
  assert.strictEqual(r.activeDays, 2);
});

test('buildReview: an older profile counts the year bucket, flagged when the counter began mid-year', () => {
  const profile = { id: `profile-${Date.parse('2025-03-01T10:00:00Z')}-x`, name: 'Gerda', gamesPlayed: 500, gamesWon: 200 };
  const bucket = YR.bumpYear(undefined, { date: '2026-11-02', won: true, score: 1200, facts: facts({ pdLaid: 2 }) });
  const partial = YR.buildReview({ year: '2026', profile, bucket, trackingSince: '2026-10-17' });
  assert.strictEqual(partial.totals.games, 1, 'never the all-time 500');
  assert.strictEqual(partial.totals.queensLaid, 2);
  assert.strictEqual(partial.totalsSince, '2026-10-17');
  const full = YR.buildReview({ year: '2027', profile, bucket: { ...bucket }, trackingSince: '2026-10-17' });
  assert.strictEqual(full.totalsSince, null, 'a year that began after the counter is complete');
  assert.strictEqual(full.breakdownSince, null);
});

test('buildReview: no game that year means no review; missing parts stay missing', () => {
  assert.strictEqual(YR.buildReview({ year: '2026', profile: null, bucket: null }), null);
  assert.strictEqual(YR.buildReview({ year: '2026', profile: { id: 'profile-1-x', name: 'Neu' }, bucket: YR.noteStreak(undefined, 3) }), null);
  const lone = YR.buildReview({ year: '2026', profile: null, bucket: YR.bumpYear(undefined, { date: '2026-12-01', won: false, score: 0 }) });
  assert.strictEqual(lone.favorite, null, 'played only against bots: no favourite is made up');
  assert.strictEqual(lone.table, null);
  assert.deepStrictEqual(lone.bots, []);
});

test('YearStatsStore: counts per name and year, and survives a restart', async (t) => {
  const pool = testPool(t, 'years');
  const store = createYearStatsStore(pool, { legacyFile: null });
  assert.strictEqual(await store.trackingSince(), null);
  await store.recordGame('Flo', '2026-12-03', { won: true, score: 1000, facts: facts({ pdLaid: 1 }), opponents: ['Gerda'], botLevel: 'hard', table: null });
  await store.recordGame('flo', '2026-12-04', { won: false, score: 600, opponents: ['Gerda'] });
  await store.recordStreak('FLO', '2026-12-04', 5);

  const again = createYearStatsStore(pool, { legacyFile: null });
  const y = await again.yearFor('Flo', '2026');
  assert.strictEqual(y.games, 2, 'one name in any spelling');
  assert.strictEqual(y.queensLaid, 1);
  assert.strictEqual(y.bestStreak, 5);
  assert.strictEqual(y.days, 2);
  assert.strictEqual(y.opponents.gerda.games, 2);
  assert.strictEqual(await again.trackingSince(), '2026-12-03', 'the first counted day');
  assert.strictEqual(await again.yearFor('Flo', '2025'), null);
  assert.strictEqual(await again.yearFor('Niemand', '2026'), null);
  await again.recordGame('', '2026-12-05', { won: true, score: 1 });
  await again.recordGame('Flo', 'gestern', { won: true, score: 1 });
  assert.strictEqual((await again.yearFor('Flo', '2026')).games, 2, 'no name or no day: nothing counted');
});

test('YearStatsStore: two games of one name at the same moment are both counted', async (t) => {
  const store = createYearStatsStore(testPool(t, 'years'), { legacyFile: null });
  await Promise.all(Array.from({ length: 8 }, (_, i) => store.recordGame('Flo', '2026-12-03', { won: i % 2 === 0, score: 100 + i })));
  const y = await store.yearFor('Flo', '2026');
  assert.deepStrictEqual([y.games, y.wins, y.bestGame], [8, 4, 107]);
});

test('recordFinishedGame books every human result: the other humans are opponents, the strongest bot the level', async (t) => {
  const store = createYearStatsStore(testPool(t, 'years'), { legacyFile: null });
  // Shapes as GameManager hands them to onGameOver; a seat given up mid-game
  // is a bot in the record (no result of its own).
  const players = [
    { id: 'p1', name: 'Flo', isBot: false }, { id: 'p2', name: 'Gerda', isBot: false },
    { id: 'p3', name: 'Uli', isBot: true, leftGame: true, botDifficulty: 'hard' }, { id: 'b1', name: 'Horst', isBot: true, botDifficulty: 'medium' },
  ];
  const results = [
    { id: 'p1', name: 'Flo', score: 1040, won: true, facts: facts({ pdLaid: 1, bestRound: 200 }) },
    { id: 'p2', name: 'Gerda', score: 760, won: false, facts: facts({ pdCaught: 1 }) },
  ];
  await store.recordFinishedGame(results, players, '2026-12-05', { table: 'Familie', streaks: { p1: { streak: 3 } } });
  const flo = await store.yearFor('Flo', '2026');
  assert.deepStrictEqual(Object.values(flo.opponents), [{ name: 'Gerda', games: 1, wins: 1 }], 'the leaver is no opponent');
  assert.deepStrictEqual(flo.bots, { hard: { games: 1, wins: 1 } }, 'the strongest bot seat, the leaver included');
  assert.deepStrictEqual(flo.tables, { familie: { name: 'Familie', games: 1, wins: 1 } });
  assert.strictEqual(flo.bestStreak, 3);
  assert.strictEqual(flo.queensLaid, 1);
  const gerda = await store.yearFor('Gerda', '2026');
  assert.deepStrictEqual(Object.values(gerda.opponents), [{ name: 'Flo', games: 1, wins: 0 }]);
  assert.strictEqual(gerda.queensCaught, 1);
  assert.strictEqual(gerda.bestStreak, 0, 'no streak handed over, none booked');
  assert.strictEqual(await store.yearFor('Uli', '2026'), null, 'nothing for the seat that left');
});

test('YearStatsStore keeps the current and the previous year only', async (t) => {
  const store = createYearStatsStore(testPool(t, 'years'), { legacyFile: null });
  await store.recordGame('Flo', '2024-12-30', { won: true, score: 1 });
  await store.recordGame('Flo', '2025-12-30', { won: true, score: 1 });
  await store.recordGame('Flo', '2026-01-02', { won: false, score: 1 });
  assert.strictEqual(await store.yearFor('Flo', '2024'), null, 'two years back is dropped');
  assert.strictEqual((await store.yearFor('Flo', '2025')).games, 1, 'last December stays for the review in January');
  assert.strictEqual((await store.yearFor('Flo', '2026')).games, 1);
  assert.strictEqual(await store.trackingSince(), '2024-12-30');
});

test('years.json is imported once: the review built from it equals the one from the file', async (t) => {
  const pool = testPool(t, 'years');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pikdame-years-')), 'years.json');
  // The file as the old store wrote it.
  let flo = YR.bumpYear(undefined, { date: '2026-03-01', won: true, score: 1040, facts: facts({ pdLaid: 2, bestRound: 310 }), opponents: ['Gerda'], botLevel: 'zen', table: 'Familie' });
  flo = YR.bumpYear(flo, { date: '2026-03-02', won: false, score: 420, opponents: ['Gerda', 'Uwe'] });
  flo = YR.noteStreak(flo, 4);
  const old = { since: '2026-02-11', players: { flo: { name: 'Flo', years: { 2026: flo, 2025: YR.bumpYear(undefined, { date: '2025-12-30', won: true, score: 900 }) } }, kaputt: null, leer: { name: ' ', years: {} } } };
  fs.writeFileSync(file, JSON.stringify(old));

  const store = createYearStatsStore(pool, { legacyFile: file });
  assert.deepStrictEqual(await store.yearFor('FLO', 2026), flo, 'the bucket as it was');
  assert.strictEqual((await store.yearFor('Flo', 2025)).games, 1);
  assert.strictEqual(await store.trackingSince(), '2026-02-11');
  assert.deepStrictEqual(
    YR.buildReview({ year: '2026', profile: null, bucket: await store.yearFor('Flo', 2026), trackingSince: await store.trackingSince() }),
    YR.buildReview({ year: '2026', profile: null, bucket: flo, trackingSince: old.since }),
  );
  assert.ok(fs.existsSync(`${file}.migrated`) && !fs.existsSync(file));
  const { rows } = await pool.query("SELECT created_at FROM players WHERE player_key = 'flo'");
  assert.strictEqual(rows[0].created_at, null, 'a name first seen in the import claims no age');

  // Counting goes on from the imported bucket; a restored old file is not imported twice.
  await store.recordGame('Flo', '2026-11-11', { won: true, score: 1100 });
  fs.writeFileSync(file, JSON.stringify(old));
  const again = createYearStatsStore(pool, { legacyFile: file });
  const y = await again.yearFor('Flo', 2026);
  assert.deepStrictEqual([y.games, y.wins, y.days, y.bestGame, y.bestStreak], [3, 2, 3, 1100, 4]);
  assert.strictEqual(await again.trackingSince(), '2026-02-11', 'a later day never moves the start');
});

test('a broken years.json is not marked imported: counting works, the import retries', async (t) => {
  const pool = testPool(t, 'years');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pikdame-years-')), 'years.json');
  fs.writeFileSync(file, '{not json');
  const store = createYearStatsStore(pool, { legacyFile: file });
  await store.recordGame('Flo', '2026-12-03', { won: true, score: 1 });
  assert.strictEqual((await store.yearFor('Flo', 2026)).games, 1);
  assert.strictEqual((await pool.query("SELECT 1 FROM legacy_imports WHERE source = 'years.json'")).rows.length, 0);
  assert.ok(fs.existsSync(file));
});

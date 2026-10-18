// Stammtisch goals: group points and level, the weekly target (Mon-Sun,
// Europe/Berlin) and the streak of reached weeks; old tables migrate once.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const G = require('../game/StammtischGoals');
const { createStammtischStore } = require('../game/StammtischStore');
const { loadedStore, testDatabaseUrl } = require('./helpers/test-db');

// Week of Monday 2026-10-12 (CEST, UTC+2). Noon keeps every instant inside its game day.
const MON = Date.parse('2026-10-12T10:00:00Z');
const DAY = 86400000;
const at = (days) => MON + days * DAY;

async function tempStore() {
  return { st: await loadedStore(createStammtischStore, 'goals') };
}
function rec(humans = 2) {
  const players = [{ id: 'a', name: 'Flo' }, { id: 'b', name: 'Anna' }, { id: 'c', name: 'Ben' }, { id: 'd', name: 'Oma' }]
    .slice(0, humans)
    .concat([{ id: 'x', name: 'Uwe', isBot: true }]);
  return { winnerId: 'a', finalTotals: { a: 1000 }, players, finishedAt: Date.now() };
}
function play(st, code, n, when, humans = 2) {
  const events = [];
  for (let i = 0; i < n; i++) events.push(...st.recordGame(code, rec(humans), when).goalEvents);
  return events;
}

test('points, curve and week keys', () => {
  assert.strictEqual(G.gameXp(1), 10);
  assert.strictEqual(G.gameXp(3), 20, 'every further human adds 5');
  assert.strictEqual(G.gameXp(0), 0, 'a match without humans earns nothing');
  assert.deepStrictEqual(G.levelFromXp(0), { level: 1, into: 0, need: 50 });
  assert.deepStrictEqual(G.levelFromXp(124), { level: 2, into: 74, need: 75 });
  assert.deepStrictEqual(G.levelFromXp(125), { level: 3, into: 0, need: 100 });
  assert.strictEqual(G.levelFromXp(1e12).level, 200, 'bounded');
  assert.strictEqual(G.weekOf('2026-10-18'), '2026-10-12', 'Sunday belongs to the week that began Monday');
  assert.strictEqual(G.weekOf('2026-10-19'), '2026-10-19');
});

test('the weekly goal: reached once with the goal-th match, with an event', async () => {
  const { st } = await tempStore();
  const { table } = st.create('Runde', 'Flo');
  const GOAL = G.WEEKLY_GOAL;
  assert.strictEqual(GOAL, 5, 'a family plays about five matches a week');
  assert.deepStrictEqual(play(st, table.code, GOAL - 1, at(1)).filter((e) => e.type === 'week'), []);
  const last = play(st, table.code, 1, at(2));
  assert.deepStrictEqual(last.filter((e) => e.type === 'week'), [{ type: 'week', streak: 1, goal: GOAL }]);
  assert.deepStrictEqual(play(st, table.code, 1, at(3)).filter((e) => e.type === 'week'), [], 'one more says nothing');
  const g = st.chipInfo(table.code, at(4)).goals;
  assert.deepStrictEqual(g.week, { start: '2026-10-12', games: GOAL + 1, goal: GOAL, reached: true });
  assert.strictEqual(g.streak, 1);
  assert.strictEqual(g.weeksReached, 1);
});

test('the week turns at midnight German time, not UTC', async () => {
  const { st } = await tempStore();
  const { table } = st.create('Runde', 'Flo');
  // Sunday 23:30 in Berlin is still Sunday 21:30 UTC - and Monday 00:30 in Berlin
  // is Sunday 22:30 UTC: a UTC week would put both into the same week.
  st.recordGame(table.code, rec(), Date.parse('2026-10-18T21:30:00Z'));
  st.recordGame(table.code, rec(), Date.parse('2026-10-18T22:30:00Z'));
  const g = st.chipInfo(table.code, Date.parse('2026-10-19T10:00:00Z')).goals;
  assert.deepStrictEqual([g.week.start, g.week.games], ['2026-10-19', 1]);
});

test('streak: weeks in a row, alive through the running week, gone after a missed one', async () => {
  const { st } = await tempStore();
  const { table } = st.create('Runde', 'Flo');
  play(st, table.code, G.WEEKLY_GOAL, at(0));
  const second = play(st, table.code, G.WEEKLY_GOAL, at(7)).filter((e) => e.type === 'week');
  assert.deepStrictEqual(second, [{ type: 'week', streak: 2, goal: G.WEEKLY_GOAL }]);
  const running = st.chipInfo(table.code, at(14)).goals;
  assert.deepStrictEqual([running.week.games, running.streak], [0, 2], 'not lost before the week is over');
  assert.strictEqual(st.chipInfo(table.code, at(21)).goals.streak, 0, 'a missed week ends it');
  assert.strictEqual(st.chipInfo(table.code, at(21)).goals.weeksReached, 2, 'reached weeks stay counted');
});

test('level: points from every match, an event when a level is crossed', async () => {
  const { st } = await tempStore();
  const { table } = st.create('Runde', 'Flo');
  // Two humans: 15 points a match; level 2 needs 50 -> the 4th match.
  const levels = [];
  for (let i = 1; i <= 4; i++) {
    for (const e of st.recordGame(table.code, rec(2), at(0)).goalEvents) if (e.type === 'level') levels.push([i, e.level]);
  }
  assert.deepStrictEqual(levels, [[4, 2]]);
  const g = st.summary(table.code, at(0)).goals;
  assert.deepStrictEqual([g.level, g.into, g.need, g.xp], [2, 10, 75, 60]);
});

test('migration: an old table gets its goals from the kept matches, the next match counts once', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pikst-goals-')), 'stammtisch.json');
  const game = (when) => ({ at: when, seriesNo: 1, players: [
    { name: 'Flo', isBot: false, score: 900, won: true },
    { name: 'Anna', isBot: false, score: 300, won: false },
    { name: 'Uwe', isBot: true, score: 100, won: false },
  ] });
  // A table as stored before this feature: no goals field at all.
  fs.writeFileSync(file, JSON.stringify({ tables: { STALTX: {
    code: 'STALTX', name: 'Alt', createdAt: at(-30), lastActivity: at(2),
    members: {}, series: { no: 1, bestOf: 3, wins: {}, games: 3, winner: null, finishedAt: null },
    games: [game(at(-7)), game(at(1)), game(at(2))],
  } } }));
  const url = testDatabaseUrl('goals');
  const st = createStammtischStore(url, { legacyFile: file });
  await st.load();
  const before = st.chipInfo('STALTX', at(3)).goals;
  assert.deepStrictEqual([before.xp, before.week.games, before.weeksReached], [45, 2, 0]);
  st.recordGame('STALTX', rec(2), at(3));
  const after = st.chipInfo('STALTX', at(3)).goals;
  assert.deepStrictEqual([after.xp, after.week.games], [60, 3], 'history once plus the new match');
  await st.flush();
  const reopened = createStammtischStore(url);
  await reopened.load();
  assert.ok(reopened.get('STALTX').goals, 'stored from now on');
});

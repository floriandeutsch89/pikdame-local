// Stammtisch: persistent group tables - codes, standings, pairwise record
// and the best-of-3 rematch series - in PostgreSQL, with the one-time import
// of stammtisch.json.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Pool } = require('pg');
const { createStammtischStore, normalizeCode, legacyRows } = require('../game/StammtischStore');
const { testPool } = require('./helpers/test-db');

function tempStore(t, opts = {}) {
  const pool = testPool(t, 'stammtisch');
  return { st: createStammtischStore(pool, { legacyFile: null, ...opts }), pool };
}
function rec(winnerId, totals, players) {
  return {
    winnerId,
    finalTotals: totals,
    players: players || [{ id: 'a', name: 'Flo' }, { id: 'b', name: 'Anna' }, { id: 'x', name: 'Uwe', isBot: true }],
    finishedAt: Date.now(),
  };
}
const memberNames = async (st, code) => (await st.summary(code)).members.map((m) => m.name.toLowerCase()).sort();

test('create: a ST-prefixed code, the founder as first member, sanitized name', async (t) => {
  const { st } = tempStore(t);
  const { table } = await st.create('  Familie <Müller>  ', 'Flo');
  assert.match(table.code, /^ST[A-Z2-9]{4}$/);
  assert.strictEqual(table.name, 'Familie Müller');
  assert.deepStrictEqual(await memberNames(st, table.code), ['flo']);
  assert.deepStrictEqual(await st.get(table.code.toLowerCase()), { code: table.code, name: 'Familie Müller' }, 'lookup normalizes the code');
  assert.strictEqual(await st.get('NOPE12'), null);
  assert.strictEqual(await st.get(''), null);
  assert.strictEqual(normalizeCode(' st-9e wh '), 'ST9EWH');
});

test('recordGame: standings, pairwise record and a best-of-3 series that only humans can win', async (t) => {
  const { st } = tempStore(t);
  const { table } = await st.create('Runde', 'Flo');
  assert.strictEqual((await st.recordGame(table.code, rec('a', { a: 1010, b: 400, x: 200 }))).seriesEvent, null);
  assert.strictEqual((await st.recordGame(table.code, rec('b', { a: 300, b: 1005, x: 200 }))).seriesEvent, null);
  // A bot win is a played game but nobody's series point.
  const botWin = await st.recordGame(table.code, rec('x', { a: 300, b: 200, x: 1100 }));
  assert.strictEqual(botWin.seriesEvent, null);
  assert.deepStrictEqual(botWin.summary.series.wins, { flo: 1, anna: 1 });
  assert.strictEqual(botWin.summary.series.games, 3);
  const decider = await st.recordGame(table.code, rec('a', { a: 1200, b: 100, x: 0 }));
  assert.deepStrictEqual(decider.seriesEvent, { type: 'won', winner: 'Flo', no: 1 });
  const sum = await st.summary(table.code);
  assert.strictEqual(sum.series.winner, 'Flo');
  assert.deepStrictEqual(sum.members.map((m) => [m.name, m.wins, m.games]), [['Flo', 2, 4], ['Anna', 1, 4]]);
  assert.deepStrictEqual(sum.pairwise.flo.anna, { ahead: 3, behind: 1 });
  assert.strictEqual(sum.gamesPlayed, 4);
  assert.deepStrictEqual(sum.recent[0].players.map((p) => [p.name, p.isBot, p.score, p.won]),
    [['Flo', false, 1200, true], ['Anna', false, 100, false], ['Uwe', true, 0, false]], 'newest first, seats in order');
  // The next game opens series 2 with fresh counters.
  const next = await st.recordGame(table.code, rec('b', { a: 0, b: 1000, x: 0 }));
  assert.strictEqual(next.summary.series.no, 2);
  assert.deepStrictEqual(next.summary.series.wins, { anna: 1 });
  assert.strictEqual(next.summary.series.winner, null);
});

test('recordGame: a forfeited match (no winner) counts as played but scores nobody', async (t) => {
  const { st } = tempStore(t);
  const { table } = await st.create('Runde', 'Flo');
  const r = await st.recordGame(table.code, rec(null, { a: 10, b: 20, x: 0 }));
  assert.deepStrictEqual(r.summary.series.wins, {});
  assert.strictEqual(r.summary.series.games, 1);
});

// "2 gegen 2": Flo + Anna (team A, seats 0 and 2) against Ben + a bot (team B, seats 1 and 3).
function teamRec(winnerTeam, totals, teamNames = [null, null]) {
  const teams = [['a', 'b'], ['c', 'x']];
  return {
    winnerId: null, teamMode: true, teams, winnerTeam, winnerIds: teams[winnerTeam], teamNames, finalTotals: totals,
    players: [{ id: 'a', name: 'Flo' }, { id: 'c', name: 'Ben' }, { id: 'b', name: 'Anna' }, { id: 'x', name: 'Uwe', isBot: true }],
    finishedAt: Date.now(),
  };
}

test('recordGame: a team match counts as played (list, goals, games, points), never as a win, head-to-head or series step', async (t) => {
  const { st } = tempStore(t);
  const { table } = await st.create('Runde', 'Flo');
  await st.recordGame(table.code, rec('a', { a: 1010, b: 400, x: 200 }));
  const before = await st.recordGame(table.code, rec('b', { a: 300, b: 1005, x: 200 }));
  const booked = await st.recordGame(table.code, teamRec(0, { a: 1100, b: 950, c: 990, x: 880 }, ['Die Löwen', null]));
  assert.strictEqual(booked.seriesEvent, null);
  const sum = booked.summary;
  assert.deepStrictEqual([sum.gamesPlayed, sum.teamGames], [3, 1]);
  assert.deepStrictEqual(sum.series, before.summary.series, 'the series neither advances nor restarts');
  assert.deepStrictEqual(sum.pairwise, before.summary.pairwise, 'no head-to-head from a team match');
  assert.ok(!sum.pairwise.ben, 'Ben met the others only in the team match');
  assert.deepStrictEqual(sum.members.map((m) => [m.name, m.wins, m.games, m.points]),
    [['Flo', 1, 3, 2410], ['Anna', 1, 3, 2355], ['Ben', 0, 1, 990]], 'games and own points count, a team win does not');
  // Group goals: 15 + 15 for two humans, 20 for three.
  assert.deepStrictEqual([sum.goals.xp, sum.goals.week.games], [50, 3]);
  const [team] = sum.recent;
  assert.deepStrictEqual([team.teamMode, team.teamNames, team.day], [true, ['Die Löwen', null], sum.today]);
  assert.deepStrictEqual(team.players.map((p) => [p.name, p.isBot, p.score, p.won, p.team]),
    [['Flo', false, 1100, true, 0], ['Ben', false, 990, false, 1], ['Anna', false, 950, true, 0], ['Uwe', true, 880, false, 1]]);
  assert.ok(!('teamMode' in sum.recent[1]) && !('team' in sum.recent[1].players[0]), 'a solo match keeps its shape');
  assert.strictEqual(await st.lastWinner(table.code), 'Flo', 'the winning team\'s top scorer deals next time');
});

test('recordGame: the series runs on across a team match; a finished one stays until the next solo match', async (t) => {
  const { st } = tempStore(t);
  const { table } = await st.create('Runde', 'Flo');
  await st.recordGame(table.code, rec('a', { a: 1010, b: 400, x: 200 }));
  const mid = await st.recordGame(table.code, teamRec(1, { a: 500, b: 400, c: 1200, x: 900 }));
  assert.deepStrictEqual([mid.summary.series.no, mid.summary.series.games, mid.summary.series.wins], [1, 1, { flo: 1 }]);
  const decided = await st.recordGame(table.code, rec('a', { a: 1020, b: 500, x: 100 }));
  assert.deepStrictEqual(decided.seriesEvent, { type: 'won', winner: 'Flo', no: 1 }, 'the team match was no game of the series');
  assert.strictEqual(decided.summary.series.games, 2);
  const after = await st.recordGame(table.code, teamRec(0, { a: 1100, b: 950, c: 990, x: 880 }));
  assert.deepStrictEqual([after.summary.series.no, after.summary.series.winner, after.summary.series.wins], [1, 'Flo', { flo: 2 }],
    'the finished series stays visible through a team match');
  const next = await st.recordGame(table.code, rec('b', { a: 300, b: 1005, x: 200 }));
  assert.deepStrictEqual([next.summary.series.no, next.summary.series.games, next.summary.series.wins, next.summary.series.winner],
    [2, 1, { anna: 1 }, null], 'the next solo match starts series 2');
  assert.deepStrictEqual(next.summary.pairwise.flo.anna, { ahead: 2, behind: 1 }, 'only the three solo matches');
  // Kept games: the series number the team matches were played under, never a step in it.
  assert.deepStrictEqual(next.summary.recent.map((g) => [g.seriesNo, !!g.teamMode]), [[2, false], [1, true], [1, false], [1, true], [1, false]]);
});

test('touch: registers a member on join and survives a restart (a new store on a new pool)', async (t) => {
  const { st, pool } = tempStore(t);
  const { table } = await st.create('Runde', 'Flo');
  assert.deepStrictEqual(await st.touch(table.code, 'Anna'), { code: table.code, name: 'Runde' });
  const pool2 = new Pool({ connectionString: pool.options.connectionString, max: 2 });
  t.after(() => pool2.end());
  const fresh = createStammtischStore(pool2, { legacyFile: null });
  assert.deepStrictEqual(await memberNames(fresh, table.code), ['anna', 'flo']);
  assert.strictEqual(await fresh.touch('NOPE12', 'x'), null);
});

test('recordGame: unknown code is a no-op, game list is capped', async (t) => {
  const { st, pool } = tempStore(t);
  assert.strictEqual(await st.recordGame('NOPE12', rec('a', {})), null);
  const { table } = await st.create('Runde', 'Flo');
  for (let i = 0; i < 105; i++) await st.recordGame(table.code, rec('a', { a: 1000, b: 0, x: 0 }));
  assert.strictEqual((await st.summary(table.code)).gamesPlayed, 100);
  const nos = (await pool.query('SELECT min(game_no) AS lo, max(game_no) AS hi FROM stammtisch_games')).rows[0];
  assert.deepStrictEqual([nos.lo, nos.hi], [6, 105], 'the oldest go, numbering goes on');
  assert.strictEqual((await pool.query('SELECT count(*)::int AS n FROM stammtisch_game_seats')).rows[0].n, 300, 'their seats go too');
});

test('my Stammtische: list by account, only the owner deletes, members leave (#307)', async (t) => {
  const { st } = tempStore(t);
  const { table } = await st.create('Familie', 'Flo', Date.now() - 1000, 'Flo');
  const other = (await st.create('Skatrunde', 'Anna', Date.now(), 'Anna')).table;
  await st.touch(table.code, 'Anna');
  await st.touch(table.code, 'Ben');

  const flo = await st.listFor('flo');
  assert.deepStrictEqual(flo.map((x) => [x.code, x.isOwner]), [[table.code, true]]);
  assert.deepStrictEqual(flo[0].members.sort(), ['Anna', 'Ben', 'Flo']);
  // Anna: own table first (newer activity), then the one she plays at.
  assert.deepStrictEqual((await st.listFor('Anna')).map((x) => [x.code, x.isOwner]), [[table.code, false], [other.code, true]]);
  assert.deepStrictEqual(await st.listFor(''), []);
  assert.deepStrictEqual(await st.listFor('Nobody'), []);

  assert.match((await st.remove(table.code, 'Anna')).error, /Nur wer den Stammtisch gegründet hat/, 'a member cannot delete');
  assert.match((await st.remove(table.code, 'Mallory')).error, /Nur wer/, 'a stranger cannot delete');
  assert.ok(await st.get(table.code), 'still there');

  assert.match((await st.leave(table.code, 'Flo')).error, /nur löschen/, 'the owner deletes, never leaves');
  assert.deepStrictEqual(await st.leave(table.code, 'ben'), { ok: true, code: table.code });
  assert.ok(!(await st.listFor('Ben')).length, 'Ben no longer lists it');
  assert.match((await st.leave(table.code, 'Ben')).error, /nicht eingetragen/);

  assert.deepStrictEqual(await st.remove(table.code.toLowerCase(), 'FLO'), { ok: true, code: table.code });
  assert.strictEqual(await st.get(table.code), null);
  assert.match((await st.remove(table.code, 'Flo')).error, /gibt es nicht/);
});

test('without an account the founder owns the table; without a founder the first member', async (t) => {
  const { st } = tempStore(t);
  const { table } = await st.create('Alt', 'Flo'); // accounts off: no owner account
  await st.touch(table.code, 'Anna');
  assert.deepStrictEqual((await st.listFor('Flo')).map((x) => x.isOwner), [true]);
  assert.match((await st.remove(table.code, 'Anna')).error, /Nur wer/);
  assert.ok((await st.remove(table.code, 'Flo')).ok);
  const nobody = (await st.create('Leer', '')).table;
  await st.touch(nobody.code, 'Cleo');
  await st.touch(nobody.code, 'Dan');
  assert.match((await st.leave(nobody.code, 'Cleo')).error, /nur löschen/, 'the first member owns it');
  assert.ok((await st.leave(nobody.code, 'Dan')).ok);
});

test('lastWinner: the human who won the latest match (bots never count)', async (t) => {
  const { st } = tempStore(t);
  const { table } = await st.create('Runde', 'Flo');
  assert.strictEqual(await st.lastWinner(table.code), null);
  await st.recordGame(table.code, rec('b', { a: 300, b: 1005, x: 200 }));
  assert.strictEqual(await st.lastWinner(table.code), 'Anna');
  await st.recordGame(table.code, rec('x', { a: 300, b: 200, x: 1100 }));
  assert.strictEqual(await st.lastWinner(table.code), null);
  assert.strictEqual(await st.lastWinner('NOPE12'), null);
});

test('chipInfo: the record for the start-screen chip and sheet, without activity data', async (t) => {
  const { st } = tempStore(t);
  const { table } = await st.create('Runde', 'Flo');
  await st.recordGame(table.code, rec('a', { a: 1010, b: 400, x: 200 }));
  await st.recordGame(table.code, rec('b', { a: 300, b: 1005, x: 200 }));
  await st.recordGame(table.code, rec('a', { a: 1020, b: 500, x: 100 }));
  const info = await st.chipInfo(table.code.toLowerCase());
  assert.strictEqual(info.code, table.code);
  assert.strictEqual(info.name, 'Runde');
  assert.strictEqual(info.gamesPlayed, 3);
  assert.deepStrictEqual(info.members.map((m) => [m.name, m.wins, m.games]), [['Flo', 2, 3], ['Anna', 1, 3]]);
  for (const m of info.members) assert.deepStrictEqual(Object.keys(m).sort(), ['avg', 'games', 'name', 'wins'], 'no lastSeen/points');
  assert.deepStrictEqual(info.pairwise.flo.anna, { ahead: 2, behind: 1 });
  assert.strictEqual(info.series.winner, 'Flo');
  assert.deepStrictEqual(Object.keys(info).sort(),
    ['code', 'gamesPlayed', 'goals', 'members', 'name', 'pairwise', 'recent', 'series', 'teamGames', 'today'], 'the record and the newest matches');
  assert.deepStrictEqual([info.goals.xp, info.goals.week.games, info.goals.week.goal], [45, 3, require('../game/StammtischGoals').WEEKLY_GOAL], 'the group goals ride along');
  // The sheet's matches: the newest three by game day, no time of day.
  await st.recordGame(table.code, teamRec(1, { a: 500, b: 400, c: 1200, x: 900 }));
  const sheet = await st.chipInfo(table.code);
  assert.deepStrictEqual([sheet.gamesPlayed, sheet.teamGames, sheet.recent.length], [4, 1, 3]);
  for (const g of sheet.recent) assert.deepStrictEqual(Object.keys(g).filter((k) => k === 'at' || k === 'seriesNo'), [], 'no time, no series number');
  assert.deepStrictEqual(sheet.recent.map((g) => [g.day, !!g.teamMode]), [[sheet.today, true], [sheet.today, false], [sheet.today, false]]);
  assert.match(sheet.today, /^\d{4}-\d{2}-\d{2}$/);
  assert.strictEqual(await st.chipInfo('NOPE12'), null);
});

test('at once: joins and matches on one table all land; deleting a player keeps the group\'s record', async (t) => {
  const { st, pool } = tempStore(t);
  const { table } = await st.create('Runde', 'Flo');
  const names = ['Anna', 'Ben', 'Cleo', 'Dan', 'Eva', 'Fritz'];
  await Promise.all([
    ...names.map((n) => st.touch(table.code, n)),
    ...Array.from({ length: 6 }, (_, i) => st.recordGame(table.code, rec(i % 2 ? 'a' : 'b', { a: 100 + i, b: 50, x: 0 }))),
  ]);
  const sum = await st.summary(table.code);
  assert.strictEqual(sum.gamesPlayed, 6, 'every match booked once');
  assert.deepStrictEqual(sum.members.map((m) => m.name).sort(), ['Anna', 'Ben', 'Cleo', 'Dan', 'Eva', 'Fritz', 'Flo'].sort());
  assert.deepStrictEqual([sum.members.find((m) => m.name === 'Flo').games, sum.goals.xp], [6, 90]);

  await pool.query("DELETE FROM players WHERE player_key = 'anna'");
  const after = await st.summary(table.code);
  assert.ok(!after.members.some((m) => m.name === 'Anna'), 'no longer a member');
  assert.strictEqual(after.gamesPlayed, 6, 'the matches stay');
  assert.ok(after.recent.every((g) => g.players.some((p) => p.name === 'Anna')), 'with her name as played');
  assert.strictEqual((await pool.query("SELECT count(*)::int AS n FROM stammtisch_game_seats WHERE player_name = 'Anna' AND player_id IS NULL")).rows[0].n, 6);

  await st.remove(table.code, 'Flo');
  const left = (await pool.query(`SELECT (SELECT count(*) FROM stammtisch_members) + (SELECT count(*) FROM stammtisch_games)
    + (SELECT count(*) FROM stammtisch_game_seats) + (SELECT count(*) FROM stammtisch_series_wins) + (SELECT count(*) FROM stammtisch_weeks) AS n`)).rows[0].n;
  assert.strictEqual(Number(left), 0, 'deleting the table takes everything in it');
});

test('inactive tables go after 180 days, the newest 300 stay', async (t) => {
  const { st, pool } = tempStore(t);
  const now = Date.now();
  const old = (await st.create('Alt', 'Flo', now - 200 * 86400000)).table;
  const recent = (await st.create('Neu', 'Flo', now - 10 * 86400000)).table;
  await pool.query(`INSERT INTO stammtische (stammtisch_code, stammtisch_name, last_used_at)
    SELECT 'ZZ' || lpad(i::text, 4, '0'), 'Viele', now() - interval '1 day' FROM generate_series(1, 300) AS i`);
  await st.create('Heute', 'Flo', now);
  assert.strictEqual(await st.get(old.code), null, 'unused for 200 days');
  assert.strictEqual(await st.get(recent.code), null, 'the least recently used beyond 300');
  assert.strictEqual((await pool.query('SELECT count(*)::int AS n FROM stammtische')).rows[0].n, 301);
});

// --- One-time import of stammtisch.json -------------------------------------------

function legacyFile(t, content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pikdame-st-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'stammtisch.json');
  fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
  return file;
}
const AT = Date.parse('2026-10-14T10:00:00Z');
const OLD_FILE = { tables: {
  ST2345: {
    code: 'ST2345', name: 'Familie', createdAt: AT - 86400000, lastActivity: AT, owner: null,
    members: { flo: { name: 'Flo', games: 2, wins: 1, points: 1400, lastSeen: AT }, anna: { name: 'Anna', games: 2, wins: 1, points: 1500, lastSeen: AT } },
    series: { no: 1, bestOf: 3, wins: { anna: 1, ben: 1 }, games: 2, winner: null, finishedAt: null },
    games: [
      { at: AT - 3600000, seriesNo: 1, players: [{ name: 'Flo', isBot: false, score: 1000, won: true }, { name: 'Anna', isBot: false, score: 500, won: false }, { name: 'Uwe', isBot: true, score: 10, won: false }] },
      { at: AT, seriesNo: 1, players: [{ name: 'Flo', isBot: false, score: 400, won: false }, { name: 'Anna', isBot: false, score: 1000, won: true }] },
    ],
  },
  STOWN2: { code: 'STOWN2', name: 'Skat', createdAt: AT, lastActivity: AT, owner: 'cleo', members: { dan: { name: 'Dan', games: 0, wins: 0, points: 0 } },
    series: { no: 3, bestOf: 3, wins: {}, games: 2, winner: 'Dan', finishedAt: AT }, games: [], goals: { xp: 120, weeks: { '2026-10-12': 5 }, weeksReached: 1 } },
  'bad code!': { code: 'NO-WAY-TOO-LONG', name: 'x' },
} };

test('legacyRows: tables, members in order, series wins (also of non-members), games, seats and goals', () => {
  const rows = legacyRows(OLD_FILE, AT);
  assert.deepStrictEqual(rows.tables.map((x) => [x.code, x.owner_key, x.series_no, x.series_winner_name, x.goal_xp, x.goal_weeks_reached]),
    [['ST2345', 'flo', 1, null, 30, 0], ['STOWN2', 'cleo', 3, 'Dan', 120, 1]], 'no owner: the first member; goals rebuilt from the matches');
  assert.deepStrictEqual(rows.members.map((m) => [m.code, m.player_key, m.points]), [['ST2345', 'flo', 1400], ['ST2345', 'anna', 1500], ['STOWN2', 'dan', 0]]);
  assert.ok(rows.members[0].joined_at < rows.members[1].joined_at, 'the order of the file stays');
  assert.deepStrictEqual(rows.seriesWins.map((w) => [w.player_key, w.wins]), [['anna', 1], ['ben', 1]]);
  assert.deepStrictEqual(rows.seats.map((x) => [x.game_no, x.seat_no, x.player_key, x.is_bot]),
    [[1, 0, 'flo', false], [1, 1, 'anna', false], [1, 2, null, true], [2, 0, 'flo', false], [2, 1, 'anna', false]]);
  assert.deepStrictEqual(rows.weeks.map((w) => [w.code, w.week_start_day, w.games_played]), [['ST2345', '2026-10-12', 2], ['STOWN2', '2026-10-12', 5]]);
  assert.deepStrictEqual(rows.players.map((p) => p.player_key).sort(), ['anna', 'ben', 'cleo', 'dan', 'flo']);
});

test('import: stammtisch.json moves in once, the file is renamed, the tables play on', async (t) => {
  const pool = testPool(t, 'st_import');
  const file = legacyFile(t, OLD_FILE);
  const st = createStammtischStore(pool, { legacyFile: file });
  const sum = await st.summary('st2345', AT);
  assert.deepStrictEqual([sum.name, sum.gamesPlayed, sum.series.wins, sum.goals.xp], ['Familie', 2, { anna: 1, ben: 1 }, 30]);
  assert.deepStrictEqual(sum.members.map((m) => [m.name, m.games, m.wins, m.points]), [['Anna', 2, 1, 1500], ['Flo', 2, 1, 1400]]);
  assert.deepStrictEqual(sum.pairwise.flo.anna, { ahead: 1, behind: 1 });
  assert.strictEqual(await st.lastWinner('ST2345'), 'Anna');
  assert.deepStrictEqual((await st.listFor('Flo')).map((x) => [x.code, x.isOwner]), [['ST2345', true]], 'the first member owns it');
  assert.deepStrictEqual((await st.listFor('Cleo')).map((x) => [x.code, x.isOwner]), [['STOWN2', true]], 'the owner account, not a member');
  assert.strictEqual((await st.summary('STOWN2', AT)).series.winner, 'Dan');
  assert.strictEqual(await st.get('NOWAYT'), null, 'a code no lookup can reach is skipped');
  // The next match: series 1 decided by Anna, numbering goes on after the imported games.
  const r = await st.recordGame('ST2345', rec('b', { a: 10, b: 1000, x: 0 }), AT + 1000);
  assert.deepStrictEqual(r.seriesEvent, { type: 'won', winner: 'Anna', no: 1 });
  assert.strictEqual(r.summary.gamesPlayed, 3);
  assert.ok(!fs.existsSync(file) && fs.existsSync(`${file}.migrated`));

  fs.renameSync(`${file}.migrated`, file);
  const again = createStammtischStore(pool, { legacyFile: file });
  assert.strictEqual((await again.summary('ST2345')).gamesPlayed, 3, 'never imported twice');
  assert.ok(!fs.existsSync(file));
});

test('import: an unreadable file is not marked and stays; fixed, it imports, a code taken meanwhile keeps the live table', async (t) => {
  const pool = testPool(t, 'st_broken');
  const file = legacyFile(t, '{"tables": {"ST2345": ');
  const orig = console.error;
  const errors = [];
  console.error = (...a) => errors.push(a.join(' '));
  let live;
  try {
    const st = createStammtischStore(pool, { legacyFile: file });
    live = (await st.create('Live', 'Zoe')).table;
  } finally {
    console.error = orig;
  }
  assert.match(errors.join('\n'), /stammtisch\.json import failed, retrying in 10 min/);
  assert.ok(fs.existsSync(file));
  assert.strictEqual((await pool.query('SELECT count(*)::int AS n FROM legacy_imports')).rows[0].n, 0);

  fs.writeFileSync(file, JSON.stringify({ tables: { ...OLD_FILE.tables, [live.code]: { code: live.code, name: 'Alt', members: {}, games: [] } } }));
  const restarted = createStammtischStore(pool, { legacyFile: file });
  assert.strictEqual((await restarted.get(live.code)).name, 'Live', 'the live table keeps its code');
  assert.strictEqual((await restarted.summary('ST2345')).gamesPlayed, 2);
});

// Stammtisch: persistent group tables - codes, standings, pairwise record
// and the best-of-3 rematch series.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createStammtischStore, normalizeCode } = require('../game/StammtischStore');

function tempStore() {
  return createStammtischStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pikst-')), 'stammtisch.json'));
}
function rec(winnerId, totals, players) {
  return {
    winnerId,
    finalTotals: totals,
    players: players || [{ id: 'a', name: 'Flo' }, { id: 'b', name: 'Anna' }, { id: 'x', name: 'Uwe', isBot: true }],
    finishedAt: Date.now(),
  };
}

test('create: a ST-prefixed code, the founder as first member, sanitized name', () => {
  const st = tempStore();
  const { table } = st.create('  Familie <Müller>  ', 'Flo');
  assert.match(table.code, /^ST[A-Z2-9]{4}$/);
  assert.strictEqual(table.name, 'Familie Müller');
  assert.deepStrictEqual(Object.keys(table.members), ['flo']);
  assert.strictEqual(st.get(table.code.toLowerCase()).code, table.code, 'lookup normalizes the code');
  assert.strictEqual(st.get('NOPE12'), null);
  assert.strictEqual(normalizeCode(' st-9e wh '), 'ST9EWH');
});

test('recordGame: standings, pairwise record and a best-of-3 series that only humans can win', () => {
  const st = tempStore();
  const { table } = st.create('Runde', 'Flo');
  assert.strictEqual(st.recordGame(table.code, rec('a', { a: 1010, b: 400, x: 200 })).seriesEvent, null);
  assert.strictEqual(st.recordGame(table.code, rec('b', { a: 300, b: 1005, x: 200 })).seriesEvent, null);
  // A bot win is a played game but nobody's series point.
  const botWin = st.recordGame(table.code, rec('x', { a: 300, b: 200, x: 1100 }));
  assert.strictEqual(botWin.seriesEvent, null);
  assert.deepStrictEqual(botWin.summary.series.wins, { flo: 1, anna: 1 });
  assert.strictEqual(botWin.summary.series.games, 3);
  const decider = st.recordGame(table.code, rec('a', { a: 1200, b: 100, x: 0 }));
  assert.deepStrictEqual(decider.seriesEvent, { type: 'won', winner: 'Flo', no: 1 });
  const sum = st.summary(table.code);
  assert.strictEqual(sum.series.winner, 'Flo');
  assert.deepStrictEqual(sum.members.map((m) => [m.name, m.wins, m.games]), [['Flo', 2, 4], ['Anna', 1, 4]]);
  assert.deepStrictEqual(sum.pairwise.flo.anna, { ahead: 3, behind: 1 });
  assert.strictEqual(sum.gamesPlayed, 4);
  // The next game opens series 2 with fresh counters.
  const next = st.recordGame(table.code, rec('b', { a: 0, b: 1000, x: 0 }));
  assert.strictEqual(next.summary.series.no, 2);
  assert.deepStrictEqual(next.summary.series.wins, { anna: 1 });
  assert.strictEqual(next.summary.series.winner, null);
});

test('recordGame: a forfeited match (no winner) counts as played but scores nobody', () => {
  const st = tempStore();
  const { table } = st.create('Runde', 'Flo');
  const r = st.recordGame(table.code, rec(null, { a: 10, b: 20, x: 0 }));
  assert.deepStrictEqual(r.summary.series.wins, {});
  assert.strictEqual(r.summary.series.games, 1);
});

test('touch: registers a member on join and survives a reload', () => {
  const st = tempStore();
  const { table } = st.create('Runde', 'Flo');
  st.touch(table.code, 'Anna');
  st.flushSync();
  const fresh = createStammtischStore(st.filePath);
  assert.deepStrictEqual(Object.keys(fresh.get(table.code).members).sort(), ['anna', 'flo']);
  assert.strictEqual(fresh.touch('NOPE12', 'x'), null);
});

test('recordGame: unknown code is a no-op, game list is capped', () => {
  const st = tempStore();
  assert.strictEqual(st.recordGame('NOPE12', rec('a', {})), null);
  const { table } = st.create('Runde', 'Flo');
  for (let i = 0; i < 120; i++) st.recordGame(table.code, rec('a', { a: 1000, b: 0, x: 0 }));
  assert.strictEqual(st.get(table.code).games.length, 100);
});

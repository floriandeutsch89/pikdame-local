const test = require('node:test');
const assert = require('node:assert/strict');
const { gameDay, addDays, weekdayIndex, dayEnd } = require('../game/GameDay');
const { createChallengeStore } = require('../game/ChallengeStore');

test('the game day flips at midnight German time, summer and winter', () => {
  // Summer (CEST, UTC+2): 22:00Z is already the next day in Germany.
  assert.equal(gameDay(Date.parse('2026-09-27T21:59:59Z')), '2026-09-27');
  assert.equal(gameDay(Date.parse('2026-09-27T22:00:00Z')), '2026-09-28');
  // Winter (CET, UTC+1): 23:00Z is the next day.
  assert.equal(gameDay(Date.parse('2026-12-31T22:59:59Z')), '2026-12-31');
  assert.equal(gameDay(Date.parse('2026-12-31T23:00:00Z')), '2027-01-01');
});

test('dayEnd is the next German midnight, including DST switch days', () => {
  assert.equal(new Date(dayEnd('2026-09-28')).toISOString(), '2026-09-28T22:00:00.000Z');
  assert.equal(new Date(dayEnd('2026-12-31')).toISOString(), '2026-12-31T23:00:00.000Z');
  // 2026-03-29: clocks go forward (23h day), 2026-10-25: back (25h day).
  assert.equal(new Date(dayEnd('2026-03-28')).toISOString(), '2026-03-28T23:00:00.000Z');
  assert.equal(new Date(dayEnd('2026-03-29')).toISOString(), '2026-03-29T22:00:00.000Z');
  assert.equal(new Date(dayEnd('2026-10-25')).toISOString(), '2026-10-25T23:00:00.000Z');
  for (const d of ['2026-03-29', '2026-10-25', '2026-07-01']) {
    assert.equal(gameDay(dayEnd(d) - 1), d, `${d}: last ms still belongs to the day`);
    assert.equal(gameDay(dayEnd(d)), addDays(d, 1), `${d}: dayEnd starts the next day`);
  }
});

test('calendar helpers work on date strings', () => {
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(weekdayIndex('2026-07-20'), 0, 'Monday');
  assert.equal(weekdayIndex('2026-07-19'), 6, 'Sunday');
});

test('challenge history does not skip a day right after the spring DST switch', () => {
  // 2026-03-31 00:30 CEST: stepping back in 24h blocks would jump from
  // 03-31 straight to 03-29 (03-30 has only 23 hours).
  const os = require('node:os');
  const path = require('node:path');
  const store = createChallengeStore(path.join(os.tmpdir(), `gd-${process.pid}-${Date.now()}.json`));
  const now = Date.parse('2026-03-30T22:30:00Z');
  assert.equal(gameDay(now), '2026-03-31');
  store.submit('2026-03-30', 'Flo', 300, now);
  store.submit('2026-03-31', 'Flo', 400, now);
  const dates = store.getHistory('Flo', 3, now).map((d) => d.date);
  assert.deepEqual(dates.slice(0, 2), ['2026-03-31', '2026-03-30']);
});

test('the weekly board starts on Monday German time, not UTC', () => {
  const os = require('node:os');
  const path = require('node:path');
  const store = createChallengeStore(path.join(os.tmpdir(), `gw-${process.pid}-${Date.now()}.json`));
  // Sunday 2026-07-19 23:30Z = Monday 01:30 in Germany: a new week.
  const now = Date.parse('2026-07-19T23:30:00Z');
  store.submit('2026-07-19', 'Flo', 500, now);
  store.submit('2026-07-20', 'Anna', 100, now);
  const w = store.getWeekly(null, 5, now);
  assert.equal(w.week, '2026-07-20..2026-07-20');
  assert.deepEqual(w.top.map((e) => e.name), ['Anna'], 'last week does not count');
});

test('challenge trend: me vs. the top 5 others of 14 game days, gaps as null (#303)', () => {
  const os = require('node:os');
  const path = require('node:path');
  const { addDays } = require('../game/GameDay');
  const file = path.join(os.tmpdir(), `gt-${process.pid}-${Date.now()}.json`);
  const store = createChallengeStore(file);
  const now = Date.parse('2026-10-05T10:00:00Z');
  const today = gameDay(now);
  const oldest = addDays(today, -13);
  store.submit(oldest, 'Flo', 210, now); // oldest day still in the window
  store.submit(addDays(today, -14), 'Zed', 9999, now); // outside: never counts
  store.submit(today, 'Flo', 320, now);
  // Seven others: the top 5 by 14-day SUM, not by a single day.
  for (const [n, s1, s2] of [['Ada', 500, 500], ['Ben', 900, null], ['Cem', 300, 300], ['Dan', 200, 200], ['Eva', 250, 100], ['Fritz', 100, null], ['Gil', 50, null]]) {
    store.submit(today, n, s1, now);
    if (s2 != null) store.submit(oldest, n, s2, now);
  }
  const t = store.getTrend('flo', {}, now);
  assert.equal(t.dates.length, 14);
  assert.deepEqual([t.dates[0], t.dates[13]], [oldest, today]);
  assert.deepEqual(t.me.scores.filter((v) => v != null), [210, 320]);
  assert.equal(t.me.total, 530);
  assert.ok(t.me.scores.slice(1, 13).every((v) => v === null), 'days not played are gaps');
  assert.deepEqual(t.top.map((p) => [p.name, p.total]), [['Ada', 1000], ['Ben', 900], ['Cem', 600], ['Dan', 400], ['Eva', 350]]);
  assert.ok(!t.top.some((p) => p.name === 'Flo' || p.name === 'Zed'), 'me excluded, out-of-window ignored');
  assert.equal(store.getTrend('', {}, now).me, null, 'without a name: only the top 5');
  // The public board still shows 7 days, retention keeps 14 for the trend.
  assert.ok(store.getHistory('Flo', 3, now).every((d) => d.date > addDays(today, -7)));
  require('node:fs').rmSync(file, { force: true });
});

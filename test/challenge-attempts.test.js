// Daily challenge: one attempt per player and day (begun = used); plus the
// "Damen-Magnet des Tages" title.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createChallengeStore } = require('../game/ChallengeStore');
const { computeEarnedBadges } = require('../game/Badges');

const NOW = Date.parse('2026-10-16T10:00:00Z'); // game day 2026-10-16
const TODAY = '2026-10-16';
const freshStore = () => createChallengeStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pikatt-')), 'challenges.json'));

test('the first started game of a day is the attempt, a restart is refused', () => {
  const cs = freshStore();
  assert.equal(cs.hasAttempted(TODAY, 'Flo'), false);
  assert.deepEqual(cs.beginAttempt(TODAY, 'Flo', 'AAAA01', NOW), { ranked: true });
  assert.equal(cs.hasAttempted(TODAY, 'flo'), true, 'begun = used, case-insensitive');
  assert.deepEqual(cs.beginAttempt(TODAY, 'FLO', 'AAAA02', NOW), { ranked: false }, 'a restart is refused');
  assert.deepEqual(cs.beginAttempt('2026-10-17', 'Flo', 'AAAA03', NOW), { ranked: true }, 'a new day, a new attempt');
  assert.deepEqual(cs.beginAttempt(TODAY, 'Anna', 'AAAA04', NOW), { ranked: true }, 'per player');
});

test('a result from before attempts were tracked uses the day up', () => {
  const cs = freshStore();
  cs.submit(TODAY, 'Flo', 700, NOW);
  assert.deepEqual(cs.beginAttempt(TODAY, 'Flo', 'BBBB01', NOW), { ranked: false });
});

test('a ranked game lost by the server frees the day, one that was given up does not', () => {
  const cs = freshStore();
  cs.beginAttempt(TODAY, 'Lost', 'GONE01', NOW);
  cs.beginAttempt(TODAY, 'Alive', 'LIVE01', NOW);
  cs.beginAttempt(TODAY, 'Quit', 'GONE02', NOW);
  cs.closeAttempt(TODAY, 'quit'); // forfeit
  cs.beginAttempt(TODAY, 'Done', 'GONE03', NOW);
  cs.submit(TODAY, 'Done', 450, NOW);
  cs.markLostAttempts(new Set(['LIVE01'])); // server start: only LIVE01 came back
  assert.equal(cs.hasAttempted(TODAY, 'Lost'), false, 'lost by the server');
  assert.deepEqual(cs.beginAttempt(TODAY, 'Lost', 'NEW001', NOW), { ranked: true }, 'gets a new ranked attempt');
  assert.deepEqual(cs.beginAttempt(TODAY, 'Alive', 'LIVE02', NOW), { ranked: false }, 'still running elsewhere');
  assert.deepEqual(cs.beginAttempt(TODAY, 'Quit', 'NEW002', NOW), { ranked: false }, 'giving up uses the day');
  assert.deepEqual(cs.beginAttempt(TODAY, 'Done', 'NEW003', NOW), { ranked: false }, 'a result uses the day');
});

test('attempts are pruned with the days (14-day window)', () => {
  const cs = freshStore();
  cs.beginAttempt('2026-09-01', 'Old', 'OLD001', NOW);
  cs.beginAttempt(TODAY, 'New', 'NEW001', NOW); // the next write prunes
  assert.equal(cs.hasAttempted('2026-09-01', 'Old'), false);
  assert.equal(cs.hasAttempted(TODAY, 'New'), true);
});

test('Damen-Magnet des Tages: most queens caught, tie goes to the lower score, then the earlier finish', () => {
  const cs = freshStore();
  assert.equal(cs.queenMagnet(TODAY), null, 'nobody played');
  cs.submit(TODAY, 'Clean', 900, NOW, { queens: 0 });
  assert.equal(cs.queenMagnet(TODAY), null, 'nobody was caught');
  cs.submit(TODAY, 'Ada', 500, NOW + 1, { queens: 2 });
  cs.submit(TODAY, 'Ben', 300, NOW + 2, { queens: 2 });
  cs.submit(TODAY, 'Cid', 300, NOW + 3, { queens: 2 });
  assert.deepEqual(cs.queenMagnet(TODAY), { name: 'Ben', queens: 2 });
  cs.submit(TODAY, 'Dora', 800, NOW + 4, { queens: 3 });
  assert.deepEqual(cs.queenMagnet(TODAY), { name: 'Dora', queens: 3 });
  assert.equal(cs.getHistory(null, 3, NOW)[0].magnet.name, 'Dora', 'history carries the magnet per day');
});

test('the magnet badge goes to the holder of a day that is over', () => {
  const cs = freshStore();
  cs.submit(TODAY, 'Ada', 500, NOW, { queens: 2 });
  assert.equal(cs.wasQueenMagnet('ada', NOW), false, 'today is still open');
  cs.submit('2026-10-15', 'Ada', 400, NOW, { queens: 1 });
  cs.submit('2026-10-15', 'Ben', 100, NOW, { queens: 0 });
  assert.equal(cs.wasQueenMagnet('ADA', NOW), true);
  assert.equal(cs.wasQueenMagnet('Ben', NOW), false);
  const rec = { players: [{ id: 'p1', name: 'Ada' }], rounds: [], finalTotals: { p1: 0 }, winnerId: null };
  assert.ok(computeEarnedBadges(rec, 'p1', {}, { queenMagnet: true }).includes('queen_magnet_day'));
  assert.ok(!computeEarnedBadges(rec, 'p1', {}, {}).includes('queen_magnet_day'));
});

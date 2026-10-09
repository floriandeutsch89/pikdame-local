const test = require('node:test');
const assert = require('node:assert');
const { hasPg, freshSchema } = require('./helpers/pg');
const { ensureStatsSchema } = require('../game/StatsSchema');
const { createPgDocument, createMemoryDocument } = require('../game/PgDocument');
const { createPlayerStore, playerCodec } = require('../game/PlayerStore');

const PG = !hasPg && 'needs PIKDAME_TEST_PG_URL';
const quiet = { log() {}, error() {} };
const rowsOf = (codec, doc) => [...codec.rows(doc)];

/** write -> flush -> a fresh document loads it again. */
async function roundTrip(codec, doc, loadOpts) {
  const s = await freshSchema();
  try {
    await ensureStatsSchema(s.pool);
    const d = createPgDocument({ pool: s.pool, codec, log: quiet });
    await d.load();
    d.write(doc);
    await d.flush();
    const again = await codec.load(s.pool, loadOpts);
    const d2 = createPgDocument({ pool: s.pool, codec, log: quiet });
    await d2.load();
    d2.write(d2.read());
    return { again, rewritten: d2.pendingStatements() };
  } finally { await s.drop(); }
}

const FULL_PROFILE = {
  id: 'profile-1', name: 'Oma Inge', gamesPlayed: 7, gamesWon: 3, totalScore: 900, gamesLost: 4,
  winStreak: 0, bestGameScore: 400, bestRoundScore: 120, totalQueensLaid: 2, totalQueensCaught: 1,
  totalJokersLaid: 5, totalHandAus: 1, lastPlaceStreak: 0, totalChallenges: 2, totalStammtischGames: 1,
  totalPuzzlesSolved: 3, xp: 420, dailyStreak: 2,
  badges: { first_win: 1700000000000 }, favoriteBadges: ['first_win'], seasonalBacks: { winter: '2026-01-02' },
  quests: { '2026-10-09': { play3: 2 } }, daily: { streak: 2, best: 5, last: '2026-10-09' },
  puzzles: { '2026-10-09': { tries: 1, solved: true, revealed: false } },
  teams: ['legacy'], // unknown field from an old file - must survive
};

test('playerCodec: one row per lower-case name, first one wins', () => {
  const rows = rowsOf(playerCodec, { players: [{ name: 'Anna' }, { name: 'anna', gamesPlayed: 9 }, { name: 'Bo' }] });
  assert.deepEqual(rows.map(([k]) => k), ['anna', 'bo']);
});

test('playerCodec: a counter that is not an integer goes to extra, not lost', () => {
  const [[, stmt]] = rowsOf(playerCodec, { players: [{ name: 'X', gamesPlayed: 2.5, xp: '7' }] });
  const extra = JSON.parse(stmt.values.at(-1));
  assert.deepEqual(extra, { gamesPlayed: 2.5, xp: '7' });
});

test('PlayerStore: no profile cap any more', () => {
  const store = createPlayerStore(createMemoryDocument());
  for (let i = 0; i < 520; i++) store.recordGameResult([{ name: `P${i}`, score: 1, won: false }]);
  assert.equal(store.listPlayers().length, 520);
});

test('PlayerStore on Postgres: every field round-trips, a load rewrites nothing', { skip: PG }, async () => {
  const { again, rewritten } = await roundTrip(playerCodec, { players: [FULL_PROFILE, { id: 'profile-2', name: 'Neu', gamesPlayed: 0, gamesWon: 0, totalScore: 0 }] });
  assert.deepEqual(again.players[0], FULL_PROFILE);
  assert.equal(again.players[1].name, 'Neu');
  assert.equal(again.players[1].bestGameScore, undefined, 'never-set stays undefined');
  assert.deepEqual(rewritten, [], 'JSONB key order must not look like a change');
});

test('playerCodec: non-integer counters round-trip through extra', { skip: PG }, async () => {
  const { again } = await roundTrip(playerCodec, { players: [{ name: 'X', gamesPlayed: 2.5, xp: '7' }] });
  assert.equal(again.players[0].gamesPlayed, 2.5);
  assert.equal(again.players[0].xp, '7');
});

const { createGlobalStatsStore, globalStatsCodec } = require('../game/GlobalStatsStore');

test('GlobalStats on Postgres: counters round-trip; empty table = undefined', { skip: PG }, async () => {
  const doc = { games: 12, rounds: 80, pikDamesLaidOut: 9, pikDamesCaught: 4, handAusRounds: 3 };
  const { again, rewritten } = await roundTrip(globalStatsCodec, doc);
  assert.deepEqual(again, doc);
  assert.deepEqual(rewritten, []);
  const s = await freshSchema();
  try { await ensureStatsSchema(s.pool); assert.equal(await globalStatsCodec.load(s.pool), undefined); } finally { await s.drop(); }
});

test('GlobalStats: works on a memory document', () => {
  const g = createGlobalStatsStore(createMemoryDocument());
  g.recordGame({ rounds: [{ isHandAus: true, results: {} }] });
  assert.equal(g.getStats().games, 1);
  assert.equal(g.getStats().handAusRounds, 1);
});

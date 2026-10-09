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

const { createChallengeStore, challengeCodec } = require('../game/ChallengeStore');
const { gameDay, addDays } = require('../game/GameDay');

test('ChallengeStore: keeps every entry of a day (no 100 cap) and can be flushed', () => {
  const c = createChallengeStore(createMemoryDocument());
  const day = gameDay(Date.now());
  for (let i = 0; i < 130; i++) c.submit(day, `P${i}`, i);
  assert.equal(c.rankOf(day, 'P0'), 130);
  assert.equal(typeof c.flushSync, 'function');
});

test('ChallengeStore on Postgres: window load vs full load; pruned days stay in the DB', { skip: PG }, async () => {
  const today = gameDay(Date.now());
  const old = addDays(today, -30);
  const doc = { days: { [today]: [{ name: 'Anna', score: 50, at: 2 }, { name: 'Bo', score: 40, at: 1 }], [old]: [{ name: 'Cy', score: 9, at: 1 }] } };
  const { again, rewritten } = await roundTrip(challengeCodec, doc, { all: true });
  assert.deepEqual(again, doc);
  assert.deepEqual(rewritten, []);
  const s = await freshSchema();
  try {
    await ensureStatsSchema(s.pool);
    const d = createPgDocument({ pool: s.pool, codec: challengeCodec, log: quiet });
    await d.load();
    d.write(doc);
    await d.flush();
    assert.deepEqual(Object.keys((await challengeCodec.load(s.pool)).days), [today], 'RAM window = KEEP_DAYS');
    const d2 = createPgDocument({ pool: s.pool, codec: challengeCodec, log: quiet });
    await d2.load();
    d2.write(d2.read());
    await d2.flush();
    const all = await challengeCodec.load(s.pool, { all: true });
    assert.ok(all.days[old], 'a day outside the window is never deleted');
  } finally { await s.drop(); }
});

const { createStammtischStore, stammtischCodec } = require('../game/StammtischStore');

const TABLE = {
  code: 'STAB12', name: 'Donnerstag', createdAt: 1, lastActivity: 5, owner: null, // legacy: no owner
  members: { anna: { name: 'Anna', games: 2, wins: 1, points: 300, lastSeen: 5 } },
  games: [
    { at: 3, seriesNo: 1, players: [{ name: 'Anna', isBot: false, score: 200, won: true }] },
    { at: 5, seriesNo: 1, players: [{ name: 'Anna', isBot: false, score: 100, won: false }] },
  ],
  series: { no: 1, bestOf: 3, wins: { anna: 1 }, games: 2, winner: null, finishedAt: null },
};

test('Stammtisch: no pruning of old tables, no cap on games', () => {
  const st = createStammtischStore(createMemoryDocument());
  const { table } = st.create('Alt', 'Anna', 0);
  st.create('Neu', 'Bo', Date.now()); // used to prune tables inactive for 180 days
  assert.ok(st.get(table.code), 'old table survives');
  for (let i = 0; i < 120; i++) st.recordGame(table.code, { players: [{ id: 'a', name: 'Anna' }], finalTotals: { a: 1 }, winnerId: 'a', finishedAt: i });
  assert.equal(st.summary(table.code).gamesPlayed, 120);
});

test('Stammtisch on Postgres: tables and games round-trip; remove deletes', { skip: PG }, async () => {
  const doc = { tables: { STAB12: TABLE } };
  const { again, rewritten } = await roundTrip(stammtischCodec, doc);
  assert.deepEqual(again, doc);
  assert.deepEqual(rewritten, []);
  const s = await freshSchema();
  try {
    await ensureStatsSchema(s.pool);
    const d = createPgDocument({ pool: s.pool, codec: stammtischCodec, log: quiet });
    await d.load();
    d.write(structuredClone(doc));
    await d.flush();
    d.write({ tables: {} });
    await d.flush();
    assert.equal((await s.pool.query('SELECT count(*)::int AS n FROM stammtisch_games')).rows[0].n, 0, 'games go with the table');
  } finally { await s.drop(); }
});

const { createGameHistoryStore, createPgGameHistoryStore, gameHistoryCodec } = require('../game/GameHistoryStore');
const { createFakePool } = require('./helpers/fake-pool');

const gameRec = (finishedAt, names) => ({
  finishedAt, startedAt: finishedAt - 10, winnerId: 'p0', finalTotals: { p0: 100 },
  players: names.map((n, i) => ({ id: `p${i}`, name: n, isBot: n.startsWith('Bot') })),
  rounds: [{ totalsAfter: { p0: 100 } }],
});

test('GameHistory (memory): historyFor is async and filters by human name', async () => {
  const h = createGameHistoryStore(createMemoryDocument());
  h.saveGame(gameRec(1, ['Anna', 'Bot Bert']));
  assert.equal((await h.historyFor('anna')).length, 1);
  assert.equal((await h.historyFor('Bot Bert')).length, 0);
});

test('GameHistory (Postgres): unsaved games stay pending while the DB is down', async () => {
  const pool = createFakePool();
  const h = createPgGameHistoryStore(pool, { flushDelayMs: 60000, log: { log() {}, error() {} } });
  pool.failNext(Object.assign(new Error('down'), { code: 'ECONNREFUSED' }));
  h.saveGame(gameRec(1, ['Anna']));
  await assert.rejects(h.flush());
  assert.equal(h.status(), 'degraded');
  assert.equal(h.pendingStatements().length, 2, 'record + one seat');
  await h.flush();
  assert.deepEqual(h.pendingStatements(), []);
});

test('GameHistory on Postgres: newest first, bots ignored, unflushed games included', { skip: PG }, async () => {
  const s = await freshSchema();
  try {
    await ensureStatsSchema(s.pool);
    const h = createPgGameHistoryStore(s.pool, { flushDelayMs: 60000, log: quiet });
    const a = h.saveGame(gameRec(100, ['Anna', 'Bot Bert']));
    await h.flush();
    const b = h.saveGame(gameRec(200, ['anna', 'Bo'])); // not flushed yet
    const mine = await h.historyFor('ANNA', 20);
    assert.deepEqual(mine.map((g) => g.id), [b.id, a.id]);
    assert.equal(mine[1].won, true);
    assert.deepEqual(await h.historyFor('Bot Bert'), []);
    const all = await gameHistoryCodec.load(s.pool, { all: true });
    assert.deepEqual(all.games.map((g) => g.id), [a.id, b.id], 'flushed by historyFor');
  } finally { await s.drop(); }
});

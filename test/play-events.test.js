// Play attempts (game/PlayEvents.js, migrations/004 + 005): the engine hook, the
// Kartenhaus rows, the store against PostgreSQL, the admin tab "Festhänger"
// and the server wiring (finish, give up, leave, restart, account delete).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const WebSocket = require('ws');
const GameManager = require('../game/GameManager');
const BotTower = require('../game/BotTower');
const AdminPage = require('../game/AdminPage');
const { SessionRegistry } = require('../game/SessionRegistry');
const { migrate } = require('../game/Migrations');
const { gameDay } = require('../game/GameDay');
const { createPgAccountStore } = require('../game/PgAccountStore');
const PlayEvents = require('../game/PlayEvents');
const { freePort } = require('./helpers/free-port');
const { testDatabaseUrl, testPool } = require('./helpers/test-db');
const { createAdminAccount, adminLogin, ADMIN } = require('./helpers/admin-session');

const { createPlayEvents, towerAttemptEvent, towerCause, attemptOpen, topCause, shapeFloors } = PlayEvents;
const MONTH = BotTower.LEGACY_MONTH; // a fixed month: the tests never depend on today's deals
const DAY_MS = 24 * 60 * 60 * 1000;

/** A started Kartenhaus floor for one human ('me'); the bot timer is off (the test plays). */
function towerGame(stage = 1, { onAttemptEnd = null, name = 'Ada', id = 'me' } = {}) {
  const calls = [];
  const g = new GameManager(() => {}, {
    deckSeed: BotTower.stageConfig(stage, MONTH).seed, towerStage: stage, towerMonth: MONTH,
    onAttemptEnd: (info) => { calls.push(info); if (onAttemptEnd) onAttemptEnd(info); },
  });
  g.maybeRunBotTurn = () => {};
  g.addOrReconnectPlayer(id, name);
  g.syncLobbyBots();
  assert.deepStrictEqual(g.startTowerRound(), { ok: true });
  return { g, calls, me: g.players.find((p) => p.id === id) };
}

/** The human melds all but one card (scoring only) and discards the last: out, a star. */
function goOut(g, me) {
  me.laidOutCards = me.hand.slice(1);
  me.hand = me.hand.slice(0, 1);
  g.turnPhase = 'meld';
  assert.ok(!g.discard(me.id, me.hand[0].id).error);
}

/** The first bot melds all but one plain card and discards it: the round ends, the human holds 15. */
function botGoesOut(g) {
  const bot = g.players.find((p) => p.isBot);
  const last = bot.hand.findIndex((c) => !c.isJoker);
  bot.laidOutCards = bot.hand.filter((_, i) => i !== last);
  bot.hand = [bot.hand[last]];
  g.currentPlayerIndex = g.players.indexOf(bot);
  g.turnPhase = 'meld';
  assert.ok(!g.discard(bot.id, bot.hand[0].id).error);
}

// --- Engine: one report per attempt -----------------------------------------------

test('engine: a floor played out reports "finished" once - a star is a won row', () => {
  const { g, calls, me } = towerGame(1);
  assert.match(g.attemptId, /^[0-9a-f-]{36}$/, 'every try has its own id');
  goOut(g, me);
  assert.strictEqual(g.phase, 'gameOver');
  assert.deepStrictEqual(calls, [{ outcome: 'finished', reason: null }]);
  const ev = towerAttemptEvent(g, calls[0], 1000);
  assert.strictEqual(ev.outcome, 'won');
  assert.deepStrictEqual([ev.name, ev.mode, ev.period, ev.stage, ev.attemptId], ['Ada', 'tower', MONTH, 1, g.attemptId]);
  assert.ok(ev.startedAt > 0 && ev.startedAt <= ev.endedAt, 'start and end of the played round');
  assert.ok(ev.facts.stars >= 1 && ev.facts.margin > 0);
  assert.strictEqual(ev.facts.end, 'me');
  assert.strictEqual(ev.facts.cause, undefined, 'a won try has no cause');
  assert.strictEqual(ev.facts.handCards, 0);
  // Leaving the result screen later (the solo grace runs out) is no second attempt.
  g._abandonSolo('timeout');
  g.abandonAttempt('expired');
  assert.strictEqual(calls.length, 1);
  g.destroy();
});

test('engine: a bot going out leaves the human without a star - lost, with the reason', () => {
  const { g, calls, me } = towerGame(2);
  botGoesOut(g);
  assert.strictEqual(g.phase, 'gameOver');
  const ev = towerAttemptEvent(g, calls[0]);
  assert.strictEqual(ev.outcome, 'lost');
  assert.strictEqual(ev.facts.stars, 0);
  assert.strictEqual(ev.facts.end, 'bot');
  assert.strictEqual(ev.facts.handCards, 15);
  assert.strictEqual(ev.facts.queenInHand, me.hand.filter((c) => c.rank === 'Q' && c.suit === 'S').length);
  assert.strictEqual(ev.facts.cause, towerCause(ev.facts));
  assert.strictEqual(ev.facts.score, ev.facts.margin + ev.facts.handicap + ev.facts.bestBot, 'margin = score - head start - best bot');
  assert.strictEqual(ev.turns, g.gameOverInfo.totalTurns);
  g.destroy();
});

test('engine: giving up, leaving and the grace timeout each end the attempt once, with their reason', () => {
  const forfeit = towerGame(3);
  for (let i = 0; i < 4; i++) forfeit.g.runBotTurn(forfeit.g.currentPlayer().id, { forced: true });
  forfeit.g.forfeitRound('me');
  assert.strictEqual(forfeit.g.gameOverInfo.forfeited, true);
  assert.deepStrictEqual(forfeit.calls, [{ outcome: 'abandoned', reason: 'forfeit' }]);
  const ev = towerAttemptEvent(forfeit.g, forfeit.calls[0]);
  assert.strictEqual(ev.outcome, 'abandoned');
  assert.deepStrictEqual([ev.facts.reason, ev.facts.cause, ev.turns], ['forfeit', 'abandoned', forfeit.g.gameTurnCount]);
  assert.ok(ev.turns > 0, 'the turn it was given up in');
  assert.strictEqual(ev.facts.margin, ev.facts.score - ev.facts.handicap - ev.facts.bestBot);
  forfeit.g.abandonAttempt('expired');
  assert.strictEqual(forfeit.calls.length, 1);
  forfeit.g.destroy();

  const left = towerGame(1);
  assert.deepStrictEqual(left.g.abandonSeat('me'), { outcome: 'ended' });
  assert.deepStrictEqual(left.calls, [{ outcome: 'abandoned', reason: 'left' }]);
  left.g.destroy();

  const away = towerGame(1);
  away.g._abandonSolo('timeout');
  assert.deepStrictEqual(away.calls, [{ outcome: 'abandoned', reason: 'timeout' }]);
  away.g.destroy();
});

test('engine: a failing hook never breaks the game; normal tables and lobbies report nothing', () => {
  let cleaned = false;
  const g = new GameManager(() => {}, {
    towerStage: 1, towerMonth: MONTH, onAbandon: () => { cleaned = true; },
    onAttemptEnd: () => { throw new Error('database down'); },
  });
  g.maybeRunBotTurn = () => {};
  g.addOrReconnectPlayer('me', 'Ada');
  g.syncLobbyBots();
  g.abandonAttempt('expired');
  assert.strictEqual(g.attemptOver, false, 'nothing dealt yet: no attempt');
  g.startTowerRound();
  assert.deepStrictEqual(g.abandonSeat('me'), { outcome: 'ended' });
  assert.strictEqual(g.phase, 'abandoned');
  assert.ok(cleaned, 'the session cleanup still ran');
  g.destroy();

  const calls = [];
  const plain = new GameManager(() => {}, { onAttemptEnd: (i) => calls.push(i) });
  plain.maybeRunBotTurn = () => {};
  plain.addOrReconnectPlayer('p1', 'Ada');
  plain.fillWithBots();
  plain.startNewRound();
  plain.toggleForfeitVote('p1');
  plain.abandonAttempt('expired');
  assert.deepStrictEqual(calls, [], 'only solo attempts are reported');
  plain.destroy();
});

test('engine: snapshot roundtrip keeps the attempt id and whether it ended', () => {
  const { g, me } = towerGame(1);
  const state = JSON.parse(JSON.stringify(g.serialize()));
  assert.ok(!('onAttemptEnd' in state), 'the hook is never persisted');
  assert.strictEqual(attemptOpen(state), true);
  const open = towerAttemptEvent(state, { outcome: 'abandoned', reason: 'restart' }, 5000);
  assert.strictEqual(open.attemptId, g.attemptId);
  assert.deepStrictEqual(open, towerAttemptEvent(g, { outcome: 'abandoned', reason: 'restart' }, 5000), 'state and game agree');
  g.destroy();

  const calls = [];
  const back = new GameManager(() => {}, { onAttemptEnd: (i) => calls.push(i) });
  back.maybeRunBotTurn = () => {};
  back.deserialize(state);
  back.addOrReconnectPlayer('me', 'Ada');
  assert.strictEqual(back.attemptId, open.attemptId);
  goOut(back, back.players.find((p) => p.id === me.id));
  assert.deepStrictEqual(calls, [{ outcome: 'finished', reason: null }]);
  const done = JSON.parse(JSON.stringify(back.serialize()));
  assert.strictEqual(done.attemptOver, true);
  assert.strictEqual(attemptOpen(done), false, 'a written attempt is never written again after a restart');
  back.destroy();
});

test('registry: every removed session passes the hook once, a throwing hook never blocks', () => {
  let clock = 0;
  const seen = [];
  const reg = new SessionRegistry(() => ({ destroy() {} }), { now: () => clock, onRemove: (s) => { seen.push(s.code); throw new Error('x'); } });
  const a = reg.create().session;
  const b = reg.create().session;
  reg.delete(a.code);
  clock = 2 * 24 * 60 * 60 * 1000;
  assert.strictEqual(reg.cleanup(), 1);
  assert.deepStrictEqual(seen, [a.code, b.code]);
  assert.strictEqual(reg.size, 0);
});

test('causes: the queen or jokers only when they cost the star, goOut, empty pile, else the margin', () => {
  const base = { margin: -30, end: 'bot', queenInHand: 0, jokersInHand: 0 };
  assert.strictEqual(towerCause({ ...base, queenInHand: 1 }), 'queen', '-30 with -100 in hand: the queen cost it');
  assert.strictEqual(towerCause({ ...base, margin: -130, queenInHand: 1 }), 'margin', 'short even without her');
  assert.strictEqual(towerCause({ ...base, margin: -15, jokersInHand: 1 }), 'jokers');
  assert.strictEqual(towerCause({ ...base, margin: 40, mods: ['goOut'] }), 'goOut');
  assert.strictEqual(towerCause({ ...base, end: 'emptyDraw' }), 'emptyDraw');
  assert.strictEqual(towerCause({ ...base, end: 'stalemate' }), 'stalemate');
  assert.strictEqual(towerCause(base), 'margin');
  assert.deepStrictEqual(topCause({ margin: 2, queen: 2, abandoned: 1 }), { cause: 'queen', n: 2 }, 'ties: the more telling cause');
  assert.strictEqual(topCause({}), null);
  assert.strictEqual(AdminPage.causeText('margin', { miss: 40 }), 'Schwelle um 40 Pkt verfehlt');
  assert.strictEqual(AdminPage.causeText('abandoned', { turn: 12 }), 'abgebrochen in Zug 12');
  assert.strictEqual(AdminPage.causeText('queen'), 'Pik Dame kassiert');
  assert.strictEqual(AdminPage.causeText('emptyDraw'), 'Ziehstapel leer');
});

test('floors: the "Knick" is a win rate at most half the floor below, both with enough tries', () => {
  const row = (stage, attempts, won) => ({ stage, attempts, players: 3, cleared: 1, won, abandoned: 0, median_turns: 40.5 });
  const floors = shapeFloors([row(1, 10, 8), row(2, 10, 5), row(3, 10, 2), row(4, 4, 0), row(6, 10, 1)], { 3: 2 });
  assert.deepStrictEqual(floors.map((f) => f.wall), [false, false, true, false, false]);
  assert.deepStrictEqual([floors[2].winRate, floors[2].stuck, floors[2].medianTurns], [0.2, 2, 41]);
});

// --- Store against PostgreSQL ------------------------------------------------------

test('migration 005: play_attempts with its checks, one row per attempt id', async (t) => {
  const pool = testPool(t, 'pe_mig');
  assert.ok((await migrate(pool)).includes(5));
  const cols = (await pool.query(`SELECT column_name FROM information_schema.columns
    WHERE table_name = 'play_attempts' AND table_schema = current_schema() ORDER BY ordinal_position`)).rows.map((r) => r.column_name);
  assert.deepStrictEqual(cols, ['id', 'attempt_id', 'player_key', 'player_name', 'mode', 'period', 'stage', 'outcome',
    'game_day', 'started_at', 'ended_at', 'turns', 'facts', 'player_id']);
  const ada = (await pool.query("INSERT INTO players (player_key, player_name) VALUES ('ada', 'Ada') RETURNING id")).rows[0].id;
  const insert = (outcome, attemptId) => pool.query(`INSERT INTO play_attempts
    (attempt_id, player_key, player_name, mode, period, stage, outcome, game_day, started_at, ended_at, player_id)
    VALUES ($2, 'ada', 'Ada', 'tower', '2026-10', 1, $1, '2026-10-23', now(), now(), $3)`, [outcome, attemptId, ada]);
  await insert('won', 'x');
  await assert.rejects(insert('maybe', 'y'), /play_attempts_outcome_check/);
  await assert.rejects(insert('lost', 'x'), /play_attempts_attempt_id_key/);
  await insert('lost', null);
  await insert('abandoned', null);
  assert.strictEqual((await pool.query('SELECT count(*)::int AS n FROM play_attempts')).rows[0].n, 3);
});

test('store: one row per attempt, never throws - a duplicate, a bad event and a dead database resolve false', async (t) => {
  const pool = testPool(t, 'pe_store');
  const errors = [];
  const store = createPlayEvents(pool, { logError: (line) => errors.push(line) });
  const { g, calls, me } = towerGame(1, { name: '  Oma Inge ' });
  goOut(g, me);
  const ev = towerAttemptEvent(g, calls[0], Date.UTC(2026, 9, 23, 22, 30)); // 00:30 in Berlin: the next game day
  g.destroy();
  assert.strictEqual(await store.record(ev), true);
  assert.strictEqual(await store.record(ev), false, 'the same attempt twice (replayed snapshot)');
  const rows = (await pool.query('SELECT * FROM play_attempts')).rows;
  assert.strictEqual(rows.length, 1);
  const r = rows[0];
  assert.deepStrictEqual([r.player_name, r.player_key, r.game_day, r.mode, r.period, r.stage, r.outcome, r.attempt_id],
    ['Oma Inge', 'oma inge', '2026-10-24', 'tower', MONTH, 1, 'won', ev.attemptId], 'the game day comes back as a string');
  assert.deepStrictEqual([r.started_at.getTime(), r.ended_at.getTime()], [ev.startedAt, ev.endedAt]);
  assert.deepStrictEqual(r.facts, JSON.parse(JSON.stringify(ev.facts)));
  assert.strictEqual(r.turns, ev.turns);
  assert.deepStrictEqual(errors, []);

  assert.strictEqual(await store.record({ ...ev, attemptId: null, outcome: 'maybe' }), false);
  assert.match(errors[0], /\[play-events\] tower .* not stored: unknown outcome/);

  const dead = createPlayEvents({ query: async () => { throw new Error('connection refused'); } }, { logError: (line) => errors.push(line) });
  let job;
  assert.doesNotThrow(() => { job = dead.record({ ...ev, attemptId: 'other' }); });
  assert.strictEqual(await job, false);
  assert.match(errors[1], /not stored: connection refused/);
  await dead.flush();
});

test('store: 90 days retention and deleting a name', async (t) => {
  const pool = testPool(t, 'pe_keep');
  const now = Date.UTC(2026, 9, 23, 12);
  const store = createPlayEvents(pool, { now: () => now });
  const ev = (name, ageDays) => store.record({ endedAt: now - ageDays * DAY_MS, name, mode: 'tower', period: '2026-10', stage: 1, outcome: 'lost', turns: 9, facts: {} });
  await Promise.all([ev('Ada', 91), ev('Ada', 89), ev('ADA ', 1), ev('Ben', 120), ev('Ben', 2)]);
  assert.strictEqual(await store.prune(), 2);
  const names = async () => (await pool.query('SELECT player_key FROM play_attempts ORDER BY ended_at')).rows.map((r) => r.player_key);
  assert.deepStrictEqual(await names(), ['ada', 'ben', 'ada']);
  assert.strictEqual(await store.deleteByName(' ada'), 2);
  assert.deepStrictEqual(await names(), ['ben']);
  assert.strictEqual(await store.deleteByName(''), 0);
  await ev('Cleo', 95);
  store.startRetention({ firstMs: 10, everyMs: 60000 });
  await waitFor(async () => (await names()).length === 1, 'the timer prunes');
  store.stopRetention();
  assert.deepStrictEqual(await names(), ['ben']);
});

/** Rows for the report: [name, floor, outcome, turns, facts]. */
async function seed(store, month, rows, now = Date.UTC(2026, 9, 20, 12)) {
  let i = 0;
  for (const [name, stage, outcome, turns, facts = {}] of rows) {
    const endedAt = now + (i += 1) * 60000;
    await store.record({ startedAt: endedAt - 30000, endedAt, name, mode: 'tower', period: month, stage, outcome, turns, facts });
  }
}

test('report: the floors of a month, the players stuck on one and their most common reason', async (t) => {
  const store = createPlayEvents(testPool(t, 'pe_report'));
  const lost = (margin, cause = 'margin') => ({ stars: 0, margin, cause });
  const quit = { cause: 'abandoned', reason: 'left', margin: -50 };
  await seed(store, '2026-10', [
    ...[1, 2, 3, 4, 5].map((n) => [`P${n}`, 1, 'won', 30, { stars: 1, margin: 20 }]),
    ['P1', 2, 'won', 40, { stars: 2 }], ['P2', 2, 'won', 44, { stars: 1 }], ['P3', 2, 'won', 36, { stars: 1 }],
    ['P4', 2, 'lost', 50, lost(-10)], ['P5', 2, 'lost', 20, lost(-20)],
    ['P1', 3, 'lost', 38, lost(-40)], ['P1', 3, 'lost', 42, lost(-60)], ['P1', 3, 'abandoned', 12, quit], ['P1', 3, 'lost', 40, lost(-20, 'queen')],
    ['P2', 3, 'lost', 31, lost(-5, 'queen')], ['P2', 3, 'lost', 33, lost(-15, 'queen')], ['P2', 3, 'won', 35, { stars: 1 }],
    ['P3', 3, 'abandoned', 7, quit], ['P3', 3, 'abandoned', 9, quit], ['p3 ', 3, 'lost', 30, lost(-80)],
  ]);
  await seed(store, '2026-09', [['Old', 1, 'won', 30]]);
  const r = await store.towerReport('2026-10');
  assert.ok(!r.error, r.error);
  assert.deepStrictEqual(r.months, ['2026-10', '2026-09']);
  assert.deepStrictEqual(r.totals, { attempts: 20, players: 5, winRate: 9 / 20, abandonRate: 3 / 20, stuck: 2 });
  assert.deepStrictEqual(r.floors.map((f) => [f.stage, f.attempts, f.players, f.cleared, f.won, f.abandoned, f.stuck, f.wall]),
    [[1, 5, 5, 5, 5, 0, 0, false], [2, 5, 5, 3, 3, 0, 0, false], [3, 10, 3, 1, 1, 3, 2, true]]);
  assert.strictEqual(r.floors[1].medianTurns, 40);
  assert.strictEqual(r.floors[2].medianTurns, 35, 'median of the played-out tries only');
  assert.deepStrictEqual(r.stuck.map((s) => [s.name, s.stage, s.attempts, s.top]), [
    ['P1', 3, 4, { cause: 'margin', n: 2 }],
    ['p3', 3, 3, { cause: 'abandoned', n: 2 }],
  ], 'most tries first; P2 cleared floor 3 in the end; the latest spelling of a name');
  assert.deepStrictEqual([r.stuck[0].miss, r.stuck[0].quitTurn, r.stuck[1].quitTurn], [40, 12, 7]);
  const limited = await store.towerReport('2026-10', { limit: 1 });
  assert.strictEqual(limited.stuck.length, 1);
  assert.strictEqual(limited.totals.stuck, 2);

  const empty = await store.towerReport('2026-11');
  assert.deepStrictEqual([empty.totals.attempts, empty.floors, empty.stuck], [0, [], []]);
  const tries = await store.playerAttempts('P1');
  assert.strictEqual(tries.name, 'P1');
  assert.deepStrictEqual(tries.attempts.map((a) => [a.period, a.stage, a.outcome]).slice(0, 2), [['2026-10', 3, 'lost'], ['2026-10', 3, 'abandoned']], 'newest first');
  assert.strictEqual(tries.attempts[0].endedAt - tries.attempts[0].startedAt, 30000);
  assert.strictEqual(r.stuck[0].lastAt, Date.UTC(2026, 9, 20, 12) + 14 * 60000, 'the latest try, in ms');
  assert.strictEqual(tries.attempts.length, 6);
  assert.strictEqual((await store.playerAttempts('P1', { limit: 2 })).attempts.length, 2);
});

// --- Admin tab ---------------------------------------------------------------------

test('admin page: the "Festhänger" tab, mobile cards, escaped names, no script', async (t) => {
  const store = createPlayEvents(testPool(t, 'pe_admin'));
  await seed(store, '2026-10', [
    ['A<b>', 1, 'won', 30, { stars: 1, margin: 10 }], ['Bo', 1, 'won', 30, { stars: 1 }], ['Cy', 1, 'won', 30, { stars: 1 }],
    ['Di', 1, 'won', 30, { stars: 1 }], ['Ed', 1, 'won', 30, { stars: 1 }],
    ...[1, 2, 3, 4].map(() => ['A<b>', 2, 'lost', 41, { cause: 'margin', margin: -40, end: 'bot' }]),
    ['A<b>', 2, 'abandoned', 12, { cause: 'abandoned', reason: 'forfeit' }],
  ]);
  const report = await store.towerReport('2026-10');
  const html = AdminPage.renderAdminPage({ tab: 'stuck', csrf: 'c', stuck: { current: '2026-11', month: '2026-10', player: '', report } });
  assert.match(html, /href="\/admin\/stuck" class="active" aria-current="page">Festhänger</);
  assert.match(html, /href="\/admin\/stuck\?month=2026-11">November 2026</, 'the current month is always offered');
  assert.match(html, /class="active" aria-current="page">Oktober 2026</);
  assert.match(html, /<tr class="wall">\n<td class="floor"><b>Etage 2<\/b> <span class="badge warn" title="[^"]+">Knick<\/span><small>Leicht, Mittel<\/small>/);
  assert.match(html, /<a class="kpi warn" href="#festhaenger"><span>Festhänger<\/span><b>1<\/b><\/a>/, 'the count jumps to the list');
  assert.match(html, /Schwelle um 40 Pkt verfehlt <span class="sub">4 von 5<\/span>/);
  assert.match(html, /href="\/admin\/stuck\?month=2026-10&amp;player=A%3Cb%3E">A&lt;b&gt;<\/a>/);
  assert.ok(!html.includes('A<b>'), 'names are escaped');
  assert.doesNotMatch(html, /<script/);
  assert.match(html, /@media \(max-width:600px\)\{\.kpis/, 'phone: cards instead of a wide table');

  const tries = await store.playerAttempts('a<b>');
  const player = AdminPage.renderAdminPage({ tab: 'stuck', stuck: { current: '2026-10', month: '2026-10', player: 'A<b>', report, attempts: tries } });
  assert.match(player, /Versuche von A&lt;b&gt;/);
  assert.match(player, /abgebrochen in Zug 12 · aufgegeben/);
  assert.match(player, /Schwelle um 40 Pkt verfehlt · ein Bot ging raus/);
  assert.match(player, /<span class="badge ok">★ Stern<\/span>/);

  const none = AdminPage.renderAdminPage({ tab: 'stuck', stuck: { current: '2026-10', month: '2026-10', report: await store.towerReport('2026-12') } });
  assert.match(none, /Noch keine Kartenhaus-Versuche in diesem Monat/);
  const broken = AdminPage.renderAdminPage({ tab: 'stuck', stuck: { current: '2026-10', month: '2026-10', report: { error: 'kaputt' } } });
  assert.match(broken, /Spielversuche nicht lesbar: kaputt/);
});

// --- Real server ------------------------------------------------------------------

function request(port, method, urlPath, { auth, body } = {}) {
  return new Promise((resolve, reject) => {
    const headers = {};
    if (auth) headers.Cookie = auth; // the admin session cookie
    if (body) { headers['Content-Type'] = 'application/x-www-form-urlencoded'; headers['Content-Length'] = Buffer.byteLength(body); }
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, method, headers }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function startServer(t, databaseUrl, sessions, savedAt = Date.now()) {
  const port = await freePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pikdame-playevents-'));
  fs.writeFileSync(path.join(dataDir, 'sessions-snapshot.json'), JSON.stringify({ savedAt, sessions }));
  const server = spawn('node', ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(port), PIKDAME_DATA_DIR: dataDir, PIKDAME_DATABASE_URL: databaseUrl, PIKDAME_ADMINS: ADMIN.email, PIKDAME_SMTP_HOST: '', PIKDAME_ONNX: '0', PIKDAME_PUBLIC_MODE: '' },
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
    ws.once('open', () => { sockets.push(ws); resolve({ ws, box, send: (m) => ws.send(JSON.stringify(m)) }); });
    ws.once('error', reject);
  });
  return { port, out, socket };
}

async function waitFor(fn, what, timeoutMs = 6000) {
  for (const end = Date.now() + timeoutMs; Date.now() < end;) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error(`timed out: ${what}`);
}

/** A seated, started floor as a snapshot session (the server restores it). */
function snapTable(code, playerId, name, stage, setup = null) {
  const g = new GameManager(() => {}, { deckSeed: BotTower.stageConfig(stage, MONTH).seed, towerStage: stage, towerMonth: MONTH });
  g.maybeRunBotTurn = () => {};
  g.addOrReconnectPlayer(playerId, name);
  g.syncLobbyBots();
  g.startTowerRound();
  const extra = setup ? setup(g, g.players.find((p) => p.id === playerId)) : {};
  const state = JSON.parse(JSON.stringify(g.serialize()));
  g.destroy();
  const now = Date.now();
  return { session: { code, createdAt: now, lastActivity: now, playerTokens: { [playerId]: `tok-${playerId}` }, stammtisch: null, state }, playerId, name, ...extra };
}

test('server: finished, left and given-up floors land once each; admin tab; account delete; a dead table never stops a floor', async (t) => {
  const databaseUrl = testDatabaseUrl('pe_server');
  const accounts = createPgAccountStore(databaseUrl);
  await accounts.verifyEmail((await accounts.register('Gina', 'gina@example.com', 'geheim123')).verifyToken);
  await accounts.close();
  const { Pool } = require('pg');
  const db = new Pool({ connectionString: databaseUrl, max: 2 }); // the server's own schema
  t.after(() => db.end());
  const store = createPlayEvents(db);
  await seed(store, MONTH, [['Gina', 1, 'lost', 20, { cause: 'margin', margin: -30 }], ['Gina', 1, 'lost', 22, { cause: 'margin', margin: -10 }]]);

  const won = snapTable('PEWON1', 'p-ada', 'Ada', 1, (g, me) => {
    me.laidOutCards = me.hand.slice(1);
    me.hand = me.hand.slice(0, 1);
    g.turnPhase = 'meld';
    return { lastCardId: me.hand[0].id };
  });
  const left = snapTable('PELFT2', 'p-cleo', 'Cleo', 2);
  const forfeit = snapTable('PEFOR3', 'p-ada2', 'Ada', 1);
  const srv = await startServer(t, databaseUrl, [won.session, left.session, forfeit.session]);
  const rows = async () => (await db.query(`SELECT player_name AS name, period || '/' || stage AS target, outcome, turns, attempt_id, facts
    FROM play_attempts WHERE player_name <> 'Gina' ORDER BY id`)).rows;

  // Back at the table, the last card: a won row with the floor's attempt id.
  const a = await srv.socket();
  a.send({ type: 'joinSession', code: won.session.code, playerId: won.playerId, playerToken: `tok-${won.playerId}`, name: 'Ada' });
  await waitFor(() => a.box.find((m) => m.type === 'joined'), 'joined');
  a.send({ type: 'discard', cardId: won.lastCardId });
  const verdict = await waitFor(() => a.box.find((m) => m.type === 'towerResult'), 'towerResult');
  assert.ok(verdict.stars >= 1);
  let got = await waitFor(async () => { const r = await rows(); return r.length === 1 && r; }, 'won row');
  assert.deepStrictEqual([got[0].name, got[0].target, got[0].outcome, got[0].attempt_id], ['Ada', `${MONTH}/1`, 'won', won.session.state.attemptId]);
  assert.strictEqual(got[0].facts.stars, verdict.stars);
  assert.strictEqual(got[0].facts.margin, verdict.margin);

  // The start screen gives the other floor up for a new game.
  const home = await srv.socket();
  home.send({ type: 'abandonSession', code: left.session.code, playerId: left.playerId, playerToken: `tok-${left.playerId}`, name: 'Cleo' });
  assert.strictEqual((await waitFor(() => home.box.find((m) => m.type === 'sessionAbandoned'), 'abandoned')).outcome, 'ended');
  got = await waitFor(async () => { const r = await rows(); return r.length === 2 && r; }, 'left row');
  assert.deepStrictEqual([got[1].name, got[1].target, got[1].outcome, got[1].facts.reason, got[1].facts.cause], ['Cleo', `${MONTH}/2`, 'abandoned', 'left', 'abandoned']);

  // Admin: the month's floors and the player view.
  await createAdminAccount(databaseUrl);
  const { cookie: auth } = await adminLogin(srv.port);
  const page = await request(srv.port, 'GET', `/admin/stuck?month=${MONTH}`, { auth });
  assert.strictEqual(page.status, 200);
  assert.match(page.body, /<b>Etage 1<\/b>/);
  assert.match(page.body, /<b>Etage 2<\/b>/);
  assert.doesNotMatch((await request(srv.port, 'GET', '/admin/stuck')).body, /Etage 1/, 'nothing without the admin session');
  const ada = await request(srv.port, 'GET', `/admin/stuck?month=${MONTH}&player=ada`, { auth });
  assert.match(ada.body, /Versuche von Ada/);
  assert.match(ada.body, /<span class="badge ok">★/);
  assert.ok((await request(srv.port, 'GET', '/admin/stuck?month=evil', { auth })).body
    .includes(`href="/admin/stuck?month=${BotTower.monthOf(gameDay())}" class="active"`), 'a bad month falls back to the current one');

  // Deleting an account deletes its attempts (and nobody else's).
  const users = await request(srv.port, 'GET', '/admin/users', { auth });
  const csrf = (users.body.match(/name="csrf" value="([a-f0-9]+)"/) || [])[1];
  const del = await request(srv.port, 'POST', '/admin/users', { auth, body: `csrf=${csrf}&username=Gina&action=delete` });
  assert.match(del.body, /Benutzer „Gina“ wurde gelöscht \(mit 2 Spielversuchen\)/);
  assert.strictEqual((await db.query("SELECT count(*)::int AS n FROM play_attempts WHERE player_key = 'gina'")).rows[0].n, 0);
  assert.strictEqual((await rows()).length, 2);

  // The table is gone: the floor still ends normally, the failed write is logged.
  await db.query('DROP TABLE play_attempts');
  const b = await srv.socket();
  b.send({ type: 'joinSession', code: forfeit.session.code, playerId: forfeit.playerId, playerToken: `tok-${forfeit.playerId}`, name: 'Ada' });
  await waitFor(() => b.box.find((m) => m.type === 'joined'), 'joined');
  b.send({ type: 'forfeitRound' });
  const over = await waitFor(() => b.box.find((m) => m.type === 'state' && m.state.phase === 'gameOver'), 'forfeited state');
  assert.strictEqual(over.state.gameOverInfo.forfeited, true);
  await waitFor(() => /\[play-events\] tower .* abandoned not stored/.test(srv.out.log), 'logged failure');
  assert.strictEqual((await request(srv.port, 'GET', '/healthz')).status, 200);
});

test('server: a floor lost in a restart (stale snapshot) is written once as abandoned', async (t) => {
  const databaseUrl = testDatabaseUrl('pe_restart');
  const savedAt = Date.now() - 31 * 60 * 1000;
  const lost = snapTable('PERST1', 'p-dora', 'Dora', 3, (g) => {
    for (let i = 0; i < 5; i++) g.runBotTurn(g.currentPlayer().id, { forced: true });
  });
  const srv = await startServer(t, databaseUrl, [lost.session], savedAt);
  const { Pool } = require('pg');
  const db = new Pool({ connectionString: databaseUrl, max: 1 });
  t.after(() => db.end());
  const got = await waitFor(async () => {
    try { return (await db.query('SELECT * FROM play_attempts')).rows.find(Boolean); } catch (e) { return null; }
  }, 'restart row');
  assert.match(srv.out.log, /Session-Restore übersprungen/);
  assert.deepStrictEqual([got.player_name, got.period, got.stage, got.outcome, got.facts.reason, got.attempt_id],
    ['Dora', MONTH, 3, 'abandoned', 'restart', lost.session.state.attemptId]);
  assert.strictEqual(got.ended_at.getTime(), savedAt, 'when the table was last seen');
  assert.ok(got.started_at <= got.ended_at, 'never a start after the end');
  assert.strictEqual(got.game_day, gameDay(savedAt));
  assert.strictEqual(got.turns, lost.session.state.gameTurnCount);
  await new Promise((r) => setTimeout(r, 300));
  assert.strictEqual((await db.query('SELECT count(*)::int AS n FROM play_attempts')).rows[0].n, 1);
});

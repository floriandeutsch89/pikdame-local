/** Badge unlock cards, server side: each badge is shown to its owner exactly once
 *  (claimed in the database, so a second device or a reconnect never repeats it),
 *  round badges arrive at their round's end, the ones decided after a day ended at
 *  the next visit, and an account's name is claimed only with its login token. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { Pool } = require('pg');
const WebSocket = require('ws');
const GameManager = require('../game/GameManager');
const { BADGE_IDS, ROUND_BADGES, computeEarnedBadges, computeRoundBadges } = require('../game/Badges');
const { createPlayerStore } = require('../game/PlayerStore');
const { createChallengeStore } = require('../game/ChallengeStore');
const { gameDay, addDays } = require('../game/GameDay');
const { puzzleForDate } = require('../game/DailyPuzzle');
const { testPlayerStore } = require('./helpers/player-store');
const { testDatabaseUrl } = require('./helpers/test-db');
const { freePort } = require('./helpers/free-port');

const ROOT = path.join(__dirname, '..');
const DAY = 24 * 60 * 60 * 1000;

// --- PlayerStore -----------------------------------------------------------------

test('claimBadgeNotices: every new badge once, oldest first; a badge from the catalogue only', async (t) => {
  let clock = Date.UTC(2026, 9, 20, 18);
  const { store, pool } = testPlayerStore(t, { now: () => clock });
  await store.upsertPlayerProfile('Anna');
  await store.awardBadges('Anna', ['score_500', 'first_win']);
  clock += 60000;
  await store.awardBadges('Anna', ['pd_caught']);
  await pool.query("INSERT INTO player_badges (player_id, badge_id) SELECT id, 'retired_badge' FROM players WHERE player_key = 'anna'");
  assert.deepStrictEqual(await store.claimBadgeNotices('anna'), [
    { id: 'first_win', earnedAt: Date.UTC(2026, 9, 20, 18) },
    { id: 'score_500', earnedAt: Date.UTC(2026, 9, 20, 18) },
    { id: 'pd_caught', earnedAt: Date.UTC(2026, 9, 20, 18) + 60000 },
  ], 'one instant: catalogue order; an id the client cannot show is claimed silently');
  assert.deepStrictEqual(await store.claimBadgeNotices('Anna'), [], 'claimed: never again');
  assert.deepStrictEqual(await store.awardBadges('Anna', ['pd_caught', 'run_13']), ['run_13']);
  assert.deepStrictEqual((await store.claimBadgeNotices('Anna')).map((b) => b.id), ['run_13'], 'only what is new since');
  assert.deepStrictEqual(await store.claimBadgeNotices('Nobody'), []);
  assert.deepStrictEqual(await store.claimBadgeNotices(''), []);
  const { rows } = await pool.query('SELECT count(*)::int AS n FROM player_badges WHERE notified_at IS NULL');
  assert.strictEqual(rows[0].n, 0);
});

test('claimBadgeNotices: two devices asking at once split the badges, never both show one', async (t) => {
  const { store, pool } = testPlayerStore(t);
  const other = createPlayerStore(pool, { legacyFile: null }); // a second server process on the same database
  await store.upsertPlayerProfile('Ben');
  const ids = BADGE_IDS.slice(0, 24);
  for (let round = 0; round < 5; round++) {
    await pool.query('UPDATE player_badges SET notified_at = NULL');
    if (round === 0) await store.awardBadges('Ben', ids);
    const [a, b] = await Promise.all([store.claimBadgeNotices('Ben'), other.claimBadgeNotices('ben')]);
    const got = [...a, ...b].map((x) => x.id);
    assert.strictEqual(got.length, ids.length, 'no badge twice');
    assert.deepStrictEqual(got.sort(), [...ids].sort(), 'and none lost');
  }
});

test('awardBadges create: a round badge before the first booked match makes the guest a player', async (t) => {
  const at = Date.UTC(2026, 9, 21, 20);
  const { store, pool } = testPlayerStore(t, { now: () => at });
  assert.deepStrictEqual(await store.awardBadges('Neu', ['pd_caught']), [], 'without create: no profile, no badge');
  assert.deepStrictEqual(await store.awardBadges('Neu', ['pd_caught'], { create: true }), ['pd_caught']);
  assert.deepStrictEqual(await store.awardBadges('neu', ['pd_caught', 'pd_laid'], { create: true }), ['pd_laid'], 'the same row');
  const { rows } = await pool.query("SELECT player_name, games_played, created_at FROM players WHERE player_key = 'neu'");
  assert.deepStrictEqual(rows.map((r) => [r.player_name, r.games_played, r.created_at.getTime()]), [['Neu', 0, at]]);
  assert.deepStrictEqual((await store.claimBadgeNotices('Neu')).map((b) => b.id), ['pd_laid', 'pd_caught']);
});

test('badgesEarnedSince: the badges of a match\'s earlier rounds, in the order asked', async (t) => {
  let clock = Date.UTC(2026, 9, 22, 10);
  const { store } = testPlayerStore(t, { now: () => clock });
  await store.upsertPlayerProfile('Cleo');
  await store.awardBadges('Cleo', ['pd_laid']); // an earlier match
  const started = clock += 1000;
  clock += 5 * 60000;
  await store.awardBadges('Cleo', ['pd_caught', 'round_300']); // a round of this one
  assert.deepStrictEqual(await store.badgesEarnedSince('Cleo', ['round_300', 'pd_laid', 'pd_caught'], started), ['round_300', 'pd_caught']);
  assert.deepStrictEqual(await store.badgesEarnedSince('Cleo', [], started), []);
  assert.deepStrictEqual(await store.badgesEarnedSince('Cleo', ['pd_caught'], null), [], 'no start known: nothing extra');
});

// --- Badges.js: what a round decides ------------------------------------------

test('computeRoundBadges: what the rounds decide, never match, counter or day badges', () => {
  const round = (pid, breakdown, extra = {}) => ({ winnerId: 'p2', isHandAus: false, results: { [pid]: { roundScore: 40, breakdown } }, ...extra });
  const record = {
    winnerId: 'p1',
    finalTotals: { p1: 900, p2: 100 },
    finishedAt: Date.UTC(2026, 9, 22, 23, 30), // 01:30 in Berlin: a night owl at the match's end
    rounds: [
      round('p1', { pikDameLaidOut: 2, pikDameCount: 0, ringRuns: 1, longestRun: 5, jokersLaidOut: 0 },
        { winnerId: 'p1', isHandAus: true, totalsAfter: { p1: -50, p2: 40 } }),
      round('p1', { pikDameLaidOut: 1, pikDameCount: 1, jokersLaidOut: 4 }),
    ],
  };
  const all = computeEarnedBadges(record, 'p1', { gamesWon: 10, gamesPlayed: 10, winStreak: 3 });
  const roundOnly = computeRoundBadges(record, 'p1');
  assert.deepStrictEqual(roundOnly.sort(), ['double_queen_round', 'hand_aus_win', 'joker_king', 'pd_caught', 'pd_laid', 'pd_triple', 'quick_start', 'ring_run'].sort());
  assert.ok(roundOnly.every((id) => all.includes(id)), 'the match end awards them too (already held: not new again)');
  for (const id of ['first_win', 'score_500', 'night_owl', 'streak_3', 'marathon_10', 'comeback']) {
    assert.ok(all.includes(id) && !roundOnly.includes(id), `${id} waits for the match`);
  }
  assert.ok(ROUND_BADGES.every((id) => BADGE_IDS.includes(id)));
  assert.deepStrictEqual(computeRoundBadges({ rounds: [] }, 'p1'), []);
  assert.deepStrictEqual(computeRoundBadges(null, 'p1'), []);
});

// --- GameManager: the round-end hook -------------------------------------------

/** Plays the running round with the bot logic for every seat (the human's too). */
function playRound(g) {
  for (let i = 0; i < 4000 && g.phase === 'playing'; i++) {
    const cp = g.currentPlayer();
    g.runBotTurn(cp.id, { forced: !cp.isBot });
  }
}
function table(opts = {}, totals = null, guests = []) {
  const calls = [];
  const g = new GameManager(() => {}, { ...opts, onRoundEnd: (rec) => calls.push(JSON.parse(JSON.stringify(rec))) });
  g.maybeRunBotTurn = () => {};
  g.addOrReconnectPlayer('p1', 'Flo');
  guests.forEach((name, i) => g.addOrReconnectPlayer(`g${i + 1}`, name));
  g.fillWithBots();
  if (totals) for (const p of g.players) g.totals[p.id] = totals(p);
  g.startNewRound();
  if (g.phase === 'cutting') g.performCut(g.cutterId, 0.5);
  return { g, calls };
}

test('GameManager: onRoundEnd after a round the match goes on after, never at its end, in the tutorial or the Kartenhaus', () => {
  const { g, calls } = table({ deckSeed: 11 });
  playRound(g);
  assert.strictEqual(g.phase, 'roundEnd');
  assert.strictEqual(calls.length, 1);
  assert.deepStrictEqual(calls[0].players, [{ id: 'p1', name: 'Flo' }], 'humans only');
  assert.strictEqual(calls[0].rounds.length, 1);
  assert.ok(calls[0].rounds[0].results.p1.breakdown, 'the round facts the badges read');
  assert.ok(!('onRoundEnd' in JSON.parse(JSON.stringify(g.serialize()))), 'a hook never goes into the snapshot');
  g.destroy();

  // Two humans; one gives up: a bot plays that seat, and it earns nothing more.
  const two = table({ deckSeed: 12 }, null, ['Gerd']);
  assert.strictEqual(two.g.abandonSeat('g1').outcome, 'left');
  playRound(two.g);
  assert.strictEqual(two.g.phase, 'roundEnd');
  assert.deepStrictEqual(two.calls.map((c) => c.players.map((p) => p.id)), [['p1']]);
  two.g.destroy();

  const over = table({ deckSeed: 13 }, (p) => (p.id === 'p1' ? 1600 : 0));
  playRound(over.g);
  assert.strictEqual(over.g.phase, 'gameOver');
  assert.deepStrictEqual(over.calls, [], 'the last round belongs to the match end (onGameOver)');
  over.g.destroy();

  const tutorial = table({ deckSeed: GameManager.TUTORIAL_SEED, tutorialMode: true });
  playRound(tutorial.g);
  assert.strictEqual(tutorial.g.phase, 'roundEnd');
  assert.deepStrictEqual(tutorial.calls, [], 'the tutorial awards no badges');
  tutorial.g.destroy();
});

// --- The real server -------------------------------------------------------------

async function waitForServer(port, timeoutMs = 15000) {
  for (const deadline = Date.now() + timeoutMs; Date.now() < deadline;) {
    const up = await new Promise((resolve) => {
      const req = http.get({ host: '127.0.0.1', port, path: '/healthz', timeout: 500 }, (res) => { res.resume(); resolve(true); });
      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
    });
    if (up) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`server on port ${port} did not come up within ${timeoutMs}ms`);
}
function openSocket(port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}`);
    ws.inbox = [];
    ws.on('message', (raw) => { try { ws.inbox.push(JSON.parse(raw)); } catch (e) { /* not ours */ } });
    const timer = setTimeout(() => reject(new Error('socket did not open')), 5000);
    ws.once('open', () => { clearTimeout(timer); resolve(ws); });
    ws.once('error', (e) => { clearTimeout(timer); reject(e); });
  });
}
/** The first message since `from` (inbox index) that passes `pred`. */
async function waitFor(ws, pred, { from = 0, ms = 8000 } = {}) {
  for (const deadline = Date.now() + ms; Date.now() < deadline;) {
    const m = ws.inbox.slice(from).find(pred);
    if (m) return m;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('message did not arrive');
}
async function claim(ws, name, accountToken) {
  const from = ws.inbox.length;
  ws.send(JSON.stringify({ type: 'claimBadges', name, accountToken }));
  return (await waitFor(ws, (m) => m.type === 'badgeUnlocks', { from })).badges.map((b) => b.id);
}

/** A server on its own schema and data dir; `table` (a GameManager snapshot with
 *  Flo as p1, token tok-flo) is restored at the start. Stopped with test `t`. */
async function bootServer(t, tag, table = null) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `pikdame-${tag}-`));
  if (table) {
    const now = Date.now();
    fs.writeFileSync(path.join(dataDir, 'sessions-snapshot.json'), JSON.stringify({
      savedAt: now,
      sessions: [{ code: 'UNLOCK', createdAt: now, lastActivity: now, playerTokens: { p1: 'tok-flo' }, stammtisch: null, state: table }],
      puzzleAttempts: [],
    }));
  }
  const dbUrl = testDatabaseUrl(tag);
  const port = await freePort();
  const server = spawn('node', ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PIKDAME_DATABASE_URL: dbUrl, PORT: String(port), PIKDAME_DATA_DIR: dataDir, PIKDAME_PUBLIC_MODE: '0', PIKDAME_ONNX: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.resume();
  server.stderr.resume();
  const sockets = [];
  const pool = new Pool({ connectionString: dbUrl, max: 2 });
  const exited = new Promise((r) => server.once('exit', r));
  t.after(async () => {
    for (const s of sockets) { try { s.close(); } catch (e) { /* closing */ } }
    await pool.end();
    server.kill();
    await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  await waitForServer(port);
  const sock = async () => { const s = await openSocket(port); sockets.push(s); return s; };
  return { pool, sock };
}

/** Plays a deal with the bot logic for every seat until Flo (p1) is down to the free
 *  discard of her last card, i.e. about to go out; `want(cp, game)` filters. Returns
 *  that moment's snapshot (her seat waiting for her) and the card, or null. */
function untilFloGoesOut(g, want) {
  let found = null;
  // The engine's own discard seam: asked when Flo's turn is down to its free discard.
  g.players.find((p) => p.id === 'p1').externalDiscard = (game, cp) => {
    if (!found && cp.hand.length === 1 && !game.pendingDiscardRest && want(cp, game)) {
      found = { state: JSON.parse(JSON.stringify(game.serialize())), cardId: cp.hand[0].id };
      // She just dropped out: her seat waits for her, no stand-in plays her turn.
      found.state.players.find((p) => p.id === 'p1').disconnectedAt = Date.now();
    }
    return null; // the heuristic discards as usual
  };
  for (let i = 0; i < 4000 && g.phase === 'playing' && !found; i++) {
    const cp = g.currentPlayer();
    g.runBotTurn(cp.id, { forced: !cp.isBot });
  }
  return found;
}
function dealFor(seed) {
  const g = new GameManager(() => {}, { deckSeed: seed });
  g.maybeRunBotTurn = () => {};
  g.addOrReconnectPlayer('p1', 'Flo');
  g.fillWithBots();
  g.setAllBotsDifficulty('medium');
  g.startNewRound();
  if (g.phase === 'cutting') g.performCut(g.cutterId, 0.5);
  return g;
}
const laidTheQueen = (cp) => cp.laidOutCards.some((c) => c.rank === 'Q' && c.suit === 'S');

test('server: a round badge reaches its owner at the round end, once; the next device and a reconnect get nothing', async (t) => {
  // Round 1, Flo goes out with a Queen of Spades laid: pd_laid at the round end.
  let deal = null;
  for (let seed = 1; seed < 600 && !deal; seed++) {
    const g = dealFor(seed);
    deal = untilFloGoesOut(g, laidTheQueen);
    g.destroy();
  }
  assert.ok(deal, 'a deal where Flo goes out with a Queen of Spades laid');
  const { pool, sock } = await bootServer(t, 'badge_unlock', deal.state);

  const flo = await sock();
  flo.send(JSON.stringify({ type: 'joinSession', code: 'UNLOCK', playerId: 'p1', playerToken: 'tok-flo', name: 'Flo' }));
  await waitFor(flo, (m) => m.type === 'state' && m.state.phase === 'playing' && m.state.currentPlayerId === 'p1');
  const before = flo.inbox.length;
  flo.send(JSON.stringify({ type: 'discard', cardId: deal.cardId }));
  const roundEnd = await waitFor(flo, (m) => m.type === 'state' && m.state.phase === 'roundEnd', { from: before });
  assert.ok(roundEnd.state.totals.p1 < 1000, 'precondition: the match goes on');
  const unlock = await waitFor(flo, (m) => m.type === 'badgeUnlocks', { from: before });
  const ids = unlock.badges.map((b) => b.id);
  assert.ok(ids.includes('pd_laid'), `pd_laid at the round end (got ${ids.join(', ')})`);
  assert.ok(ids.every((id) => ROUND_BADGES.includes(id)), 'only what the round decided');
  assert.strictEqual(unlock.name, 'Flo');
  assert.ok(unlock.badges.every((b) => Number.isFinite(b.earnedAt)));
  assert.ok(!flo.inbox.slice(before).some((m) => m.type === 'badges'), 'no overlay list before the match ends');

  // Awarded at the round end: on the (new guest's) profile before any match is booked.
  const { rows } = await pool.query(`SELECT p.games_played, b.badge_id, b.notified_at IS NOT NULL AS shown FROM players p
    JOIN player_badges b ON b.player_id = p.id WHERE p.player_key = 'flo' ORDER BY b.badge_id`);
  assert.deepStrictEqual(rows.map((r) => r.badge_id), [...ids].sort());
  assert.ok(rows.every((r) => r.games_played === 0 && r.shown), 'held and shown, no match booked yet');

  // Device B on the start screen, and device A after a reconnect: nothing again.
  const phone = await sock();
  assert.deepStrictEqual(await claim(phone, 'Flo'), [], 'the other device does not repeat it');
  flo.close();
  const again = await sock();
  again.send(JSON.stringify({ type: 'joinSession', code: 'UNLOCK', playerId: 'p1', playerToken: 'tok-flo', name: 'Flo' }));
  await waitFor(again, (m) => m.type === 'joined');
  assert.deepStrictEqual(await claim(again, 'Flo'), [], 'nor does a reconnect');

  // Earned while away (no open socket then): waits for the next claim, then once.
  const store = createPlayerStore(pool, { legacyFile: null });
  assert.deepStrictEqual(await store.awardBadges('Flo', ['run_13']), ['run_13']);
  const [first, second] = await Promise.all([claim(phone, 'Flo'), claim(again, 'flo')]);
  assert.deepStrictEqual([...first, ...second], ['run_13'], 'two devices asking at once: one of them shows it');

  // Decided after the day ended: yesterday's challenge champion and Damen-Magnet.
  const challenges = createChallengeStore(pool, { legacyFile: null });
  const yesterday = addDays(gameDay(), -1);
  await challenges.submit(yesterday, 'Flo', 1180, Date.now() - DAY, { queens: 0 });
  await challenges.submit(yesterday, 'Oma Gerda', 640, Date.now() - DAY, { queens: 2 });
  assert.deepStrictEqual(await claim(phone, 'Flo'), ['challenge_champ'], 'the champion learns it on the next visit');
  assert.deepStrictEqual(await claim(phone, 'Flo'), [], 'once');
  assert.deepStrictEqual(await claim(phone, 'Oma Gerda'), ['queen_magnet_day'], 'a guest name claims its own');
});

test('server: at the match end the overlay lists the whole match, the unlock cards only what is new', async (t) => {
  // Round 1 brought Flo round badges; round 2 ends the match with her win.
  let deal = null;
  let earlier = [];
  for (let seed = 1; seed < 600 && !deal; seed++) {
    const g = dealFor(seed);
    for (let i = 0; i < 4000 && g.phase === 'playing'; i++) g.runBotTurn(g.currentPlayer().id, { forced: !g.currentPlayer().isBot });
    earlier = g.phase === 'roundEnd' ? computeRoundBadges({ rounds: g.roundHistory }, 'p1') : [];
    if (earlier.length) {
      for (const p of g.players) g.totals[p.id] = p.id === 'p1' ? 1500 : 0; // no round can stop her now
      g.startNewRound();
      if (g.phase === 'cutting') g.performCut(g.cutterId, 0.5);
      deal = untilFloGoesOut(g, () => true);
    }
    g.destroy();
  }
  assert.ok(deal, 'a deal with round badges in round 1 where Flo ends round 2');
  const { pool, sock } = await bootServer(t, 'badge_unlock_end', deal.state);
  // What round 1's end awarded and showed (this server never saw that round).
  const store = createPlayerStore(pool, { legacyFile: null, now: () => deal.state.gameStartedAt + 1000 });
  assert.deepStrictEqual(await store.awardBadges('Flo', earlier, { create: true }), earlier);
  assert.deepStrictEqual((await store.claimBadgeNotices('Flo')).map((b) => b.id).sort(), [...earlier].sort());

  const flo = await sock();
  flo.send(JSON.stringify({ type: 'joinSession', code: 'UNLOCK', playerId: 'p1', playerToken: 'tok-flo', name: 'Flo' }));
  await waitFor(flo, (m) => m.type === 'state' && m.state.phase === 'playing' && m.state.currentPlayerId === 'p1');
  const before = flo.inbox.length;
  flo.send(JSON.stringify({ type: 'discard', cardId: deal.cardId }));
  await waitFor(flo, (m) => m.type === 'state' && m.state.phase === 'gameOver', { from: before });
  const overlay = await waitFor(flo, (m) => m.type === 'badges', { from: before });
  const unlock = await waitFor(flo, (m) => m.type === 'badgeUnlocks', { from: before });
  const listed = overlay.earned.find((e) => e.name === 'Flo').badges;
  const shown = unlock.badges.map((b) => b.id);
  assert.ok(shown.includes('first_win'), `the win is new (got ${shown.join(', ')})`);
  for (const id of earlier) {
    assert.ok(listed.includes(id), `the overlay still lists ${id} from round 1`);
    assert.ok(!shown.includes(id), `but its card was shown at round 1's end: ${id}`);
  }
  assert.ok(shown.every((id) => listed.includes(id)), 'every new card is in the overlay too');
  assert.ok(!flo.inbox.slice(before).some((m) => m.type === 'badgeUnlocks' && m !== unlock), 'one batch of cards');
  assert.deepStrictEqual(await claim(flo, 'Flo'), [], 'and nothing left to claim');
});

test('server: an account\'s name is claimed only with its login token; a solved puzzle shows its badges at once', async (t) => {
  const { pool, sock } = await bootServer(t, 'badge_unlock_acc');
  const ws = await sock();
  await claim(ws, 'Nobody'); // answered: the schema is in place
  const { rows: [user] } = await pool.query(`INSERT INTO users (username, email, password_hash, password_salt, email_verified)
    VALUES ('Ada', 'ada@example.org', '\\x00', '', TRUE) RETURNING id`);
  await pool.query('INSERT INTO login_sessions (session_token, user_id, created_at) VALUES ($1, $2, now())', ['tok-ada', user.id]);
  const store = createPlayerStore(pool, { legacyFile: null });
  await store.awardBadges('Ada', ['first_win'], { create: true });

  assert.deepStrictEqual(await claim(ws, 'Ada'), [], 'no token: nothing, and nothing used up');
  assert.deepStrictEqual(await claim(ws, 'Ada', 'someone-else'), []);
  assert.deepStrictEqual(await claim(ws, 'ada', 'tok-ada'), ['first_win'], 'the owner gets it');
  assert.deepStrictEqual(await claim(ws, 'Ada', 'tok-ada'), []);

  // The seventh solved puzzle: "Rätselfuchs" as a card right after the result, for a guest.
  await pool.query("UPDATE players SET puzzles_solved = 6 WHERE player_key = 'ada'");
  await pool.query("INSERT INTO players (player_key, player_name, puzzles_solved) VALUES ('rita', 'Rita', 6)");
  const melds = puzzleForDate(gameDay()).best.melds;
  const solve = async (name, accountToken) => {
    const from = ws.inbox.length;
    ws.send(JSON.stringify({ type: 'solvePuzzle', name, melds, accountToken }));
    return { from, result: await waitFor(ws, (m) => m.type === 'puzzleResult', { from }) };
  };
  const rita = await solve('Rita');
  assert.ok(rita.result.badges.includes('puzzle_7'));
  const cards = await waitFor(ws, (m) => m.type === 'badgeUnlocks', { from: rita.from });
  assert.ok(cards.badges.map((b) => b.id).includes('puzzle_7'));
  assert.ok(ws.inbox.indexOf(cards) > ws.inbox.indexOf(rita.result), 'after the result');
  assert.deepStrictEqual(await claim(ws, 'Rita'), []);

  // Someone else solving under Ada's name: the badge is hers, the card waits for her.
  const spoof = await solve('Ada');
  assert.ok(spoof.result.badges.includes('puzzle_7'));
  await claim(ws, 'Nobody');
  assert.ok(!ws.inbox.slice(spoof.from).some((m) => m.type === 'badgeUnlocks' && m.name === 'Ada'), 'no card for a stranger');
  assert.ok((await claim(ws, 'Ada', 'tok-ada')).includes('puzzle_7'), 'Ada sees it on her next visit');
});

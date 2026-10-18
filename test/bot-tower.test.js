/** Bot tower: ten fixed one-round stages (game/BotTower.js is the only
 *  definition). Module rules, the engine path (one round, solo, frozen table,
 *  card conservation, snapshot), best-of storage with the badge families,
 *  and the real server's getTower/startTower messages. */
const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const WebSocket = require('ws');
const BotTower = require('../game/BotTower');
const GameManager = require('../game/GameManager');
const { createDeck } = require('../game/Deck');
const { createPlayerStore } = require('../game/PlayerStore');
const { familyBadges, BADGE_IDS } = require('../game/Badges');

const { TOWER_STAGES, starsFor, outcomeFromRecord, unlockedStage, summarize } = BotTower;

// --- Module ---------------------------------------------------------------------

test('ten stages: rising bots and handicap, unique seeds, 30 stars', () => {
  assert.strictEqual(BotTower.TOWER_SIZE, 10);
  assert.strictEqual(BotTower.MAX_STARS, 30);
  assert.deepStrictEqual(TOWER_STAGES.map((s) => s.stage), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.strictEqual(new Set(TOWER_STAGES.map((s) => s.seed)).size, 10, 'every stage its own deal');
  const levels = ['easy', 'medium', 'hard', 'zen'];
  for (const s of TOWER_STAGES) {
    assert.ok(Number.isInteger(s.seed) && s.seed >= 0, `stage ${s.stage}: integer seed`);
    assert.ok(s.bots.length >= 2 && s.bots.length <= 3, `stage ${s.stage}: 3-4 seats`);
    for (const b of s.bots) assert.ok(levels.includes(b), `stage ${s.stage}: level ${b}`);
  }
  for (let i = 1; i < TOWER_STAGES.length; i++) {
    assert.ok(TOWER_STAGES[i].handicap >= TOWER_STAGES[i - 1].handicap, `handicap never drops at stage ${i + 1}`);
  }
  const has = (s, level) => s.bots.includes(level);
  for (const s of TOWER_STAGES.slice(0, 3)) assert.ok(!has(s, 'hard') && !has(s, 'zen'), `stage ${s.stage}: easy/medium only`);
  for (const s of TOWER_STAGES.slice(3, 6)) assert.ok(has(s, 'hard') && !has(s, 'zen'), `stage ${s.stage}: hard, no Zen yet`);
  for (const s of TOWER_STAGES.slice(6, 9)) assert.ok(has(s, 'zen'), `stage ${s.stage}: Zen in the mix`);
  const top = TOWER_STAGES[9];
  assert.deepStrictEqual(top.bots, ['zen', 'zen', 'zen'], 'stage 10: three Zen');
  assert.ok(top.handicap > 0, 'stage 10: plus a handicap');
});

test('the client never learns the seeds', () => {
  const pub = BotTower.publicStages();
  assert.strictEqual(pub.length, 10);
  for (const s of pub) assert.deepStrictEqual(Object.keys(s).sort(), ['bots', 'handicap', 'stage']);
  pub[0].bots.push('zen');
  assert.strictEqual(TOWER_STAGES[0].bots.length, 2, 'a copy, not the definition');
  assert.strictEqual(BotTower.stageConfig('3').stage, 3, 'stage numbers from a message work too');
  assert.strictEqual(BotTower.stageConfig(11), null);
  assert.strictEqual(BotTower.stageConfig('x'), null);
});

test('stars: ahead after the handicap, 100 clear, out yourself', () => {
  const s = (myScore, botScores, wentOut, handicap = 0) => starsFor({ myScore, botScores, wentOut, handicap });
  assert.strictEqual(s(100, [100, 40], true), 0, 'a tie is no star');
  assert.strictEqual(s(105, [100, 40], false), 1);
  assert.strictEqual(s(199, [100], true), 1, '99 ahead: one star, going out does not skip a step');
  assert.strictEqual(s(200, [100], false), 2, '100 ahead');
  assert.strictEqual(s(200, [100], true), 3, '100 ahead and out');
  assert.strictEqual(s(120, [100], true, 20), 0, 'the handicap counts');
  assert.strictEqual(s(125, [100], true, 20), 1);
  assert.strictEqual(s(-20, [-40, -60], false), 1, 'negative rounds compare too');
  assert.strictEqual(s(50, [], false), 1, 'no bots: ahead of zero');
});

function stageRecord({ stage = 4, my = 230, bots = [145, 60], winnerId = 'me' } = {}) {
  const results = { me: { roundScore: my } };
  bots.forEach((v, i) => { results[`bot-${i + 1}`] = { roundScore: v }; });
  return {
    towerStage: stage,
    players: [{ id: 'me', name: 'Ada', isBot: false }, ...bots.map((_, i) => ({ id: `bot-${i + 1}`, name: `B${i}`, isBot: true }))],
    rounds: [{ winnerId, results }],
  };
}

test('XP: the first star of a stage pays once, more stars and retries nothing', () => {
  const { xpForTowerStage, XP_TOWER_FIRST_STAR } = require('../game/Progression');
  assert.strictEqual(XP_TOWER_FIRST_STAR, 25);
  assert.strictEqual(xpForTowerStage(0, 1), 25, 'first star');
  assert.strictEqual(xpForTowerStage(0, 3), 25, 'three at once are still one first star');
  assert.strictEqual(xpForTowerStage(1, 2), 0, 'a second star');
  assert.strictEqual(xpForTowerStage(3, 3), 0, 'a repeat');
  assert.strictEqual(xpForTowerStage(0, 0), 0, 'no star');
  assert.strictEqual(TOWER_STAGES.length * xpForTowerStage(0, 1), 250, 'the whole tower: at most 250');
});

test('stageWinner: the human wins exactly with a star, the handicap included', () => {
  const { stageWinner } = BotTower;
  assert.strictEqual(stageWinner({ me: 145, a: 140, b: 30 }, 'me', 'me', 20), 'a', 'ahead on points, behind after the handicap');
  assert.strictEqual(stageWinner({ me: 165, a: 140, b: 30 }, 'b', 'me', 20), 'me');
  assert.strictEqual(stageWinner({ me: 140, a: 140, b: 30 }, 'me', 'me', 0), 'a', 'a tie is no star, so no win');
  assert.strictEqual(stageWinner({ me: 10, a: 90, b: 90 }, 'b', 'me', 0), 'b', 'tied bots: whoever went out');
  assert.strictEqual(stageWinner({ me: 10, a: 90, b: 90 }, 'me', 'me', 0), 'a', 'else the first of them');
});

test('outcomeFromRecord: the verdict of the one round', () => {
  assert.deepStrictEqual(outcomeFromRecord(stageRecord(), 'me'),
    { stage: 4, stars: 1, myScore: 230, bestBot: 145, handicap: 0, margin: 85, wentOut: true });
  const h = outcomeFromRecord(stageRecord({ stage: 10, my: 305, bots: [190, 20, -10], winnerId: 'bot-2' }), 'me');
  assert.deepStrictEqual({ stars: h.stars, margin: h.margin, handicap: h.handicap, wentOut: h.wentOut }, { stars: 1, margin: 15, handicap: 100, wentOut: false });
  assert.strictEqual(outcomeFromRecord(stageRecord({ my: 300, bots: [100] }), 'me').stars, 3);
  assert.strictEqual(outcomeFromRecord({ ...stageRecord(), rounds: [] }, 'me'), null, 'no round, no verdict');
  assert.strictEqual(outcomeFromRecord({ ...stageRecord(), towerStage: undefined }, 'me'), null, 'not a tower game');
  assert.strictEqual(outcomeFromRecord(stageRecord(), 'nobody'), null);
});

test('unlocking: stage 1 first, then one above every cleared stage in a row', () => {
  assert.strictEqual(unlockedStage({}), 1);
  assert.strictEqual(unlockedStage({ 1: 1 }), 2);
  assert.strictEqual(unlockedStage({ 1: 3, 2: 0 }), 2);
  assert.strictEqual(unlockedStage({ 1: 1, 3: 3 }), 2, 'a gap stops the climb');
  const all = Object.fromEntries(TOWER_STAGES.map((s) => [s.stage, 1]));
  assert.strictEqual(unlockedStage(all), 10, 'never beyond the top');
  assert.deepStrictEqual(summarize({ 1: 3, 2: 2, 3: 9, 4: -1, 5: 'x' }), { stars: 8, cleared: 3, unlocked: 4 }, 'clamped per stage');
  assert.deepStrictEqual(summarize(Object.fromEntries(TOWER_STAGES.map((s) => [s.stage, 3]))), { stars: 30, cleared: 10, unlocked: 10 });
});

// --- Engine ---------------------------------------------------------------------

const REFERENCE = (() => {
  const counts = new Map();
  for (const card of createDeck()) counts.set(card.id, (counts.get(card.id) || 0) + 1);
  return counts;
})();
/** Every card exactly as often as in the 110-card deck (see card-conservation.test.js). */
function conserved(g) {
  const found = new Map();
  const add = (c) => { if (c && c.id) found.set(c.id, (found.get(c.id) || 0) + 1); };
  for (const p of g.players) (p.hand || []).forEach(add);
  for (const m of g.tableMelds || []) for (const s of m.slots || []) { add(s.real); add(s.joker); }
  for (const pile of [g.drawPile, g.discardPile, g.retiredJokers, g._pendingDeck]) (pile || []).forEach(add);
  if (found.size !== REFERENCE.size) return false;
  for (const [id, n] of REFERENCE) if (found.get(id) !== n) return false;
  return true;
}

function towerGame(stage, extra = {}) {
  const cfg = BotTower.stageConfig(stage);
  const g = new GameManager(() => {}, { deckSeed: cfg.seed, towerStage: cfg.stage, ...extra });
  g.addOrReconnectPlayer('me', 'Ada');
  g.syncLobbyBots(); // what joinSession does before the stage starts
  return g;
}

/** Plays the stage to its end, every seat by the heuristic (the human forced). */
function playOut(g) {
  let turns = 0;
  while (g.phase === 'playing' && turns++ < 3000) {
    const cp = g.currentPlayer();
    g.runBotTurn(cp.id, { forced: !cp.isBot });
    assert.ok(conserved(g), `card conservation after turn ${turns}`);
  }
}

test('startTowerRound: the stage bots after the human, who moves first, timer off', () => {
  const g = towerGame(8);
  assert.deepStrictEqual(g.startTowerRound(), { ok: true });
  assert.strictEqual(g.phase, 'playing');
  assert.deepStrictEqual(g.players.map((p) => (p.isBot ? p.botDifficulty : 'human')), ['human', 'zen', 'hard', 'hard']);
  assert.strictEqual(g.currentPlayer().id, 'me');
  assert.strictEqual(g.houseRules.turnTimerSeconds, 0);
  assert.ok(g.log.some((e) => e.text === 'Bot-Turm, Stufe 8: Hol in dieser Runde mehr Punkte als jeder Bot - die Bots bekommen 40 Punkte Vorgabe.'));
  assert.ok(conserved(g));
  assert.match(g.startTowerRound().error, /lässt sich nicht starten/, 'only from the lobby');
  assert.strictEqual(g.seatStatus('me').tower, 8);
  assert.strictEqual(g.publicState('me').towerStage, 8);
  g.destroy();
  const plain = new GameManager(() => {});
  assert.ok(plain.startTowerRound().error, 'not a tower table');
  plain.destroy();
});

test('every try deals the same cards (the seed fixes deck and cut)', () => {
  const hands = [1, 2].map(() => {
    const g = towerGame(5);
    g.startTowerRound();
    const ids = g.players.map((p) => p.hand.map((c) => c.id).join(','));
    g.destroy();
    return ids;
  });
  assert.deepStrictEqual(hands[0], hands[1]);
});

test('a stage is one round: game over after it, the record carries the stage', () => {
  for (const stage of [3, 6]) {
    let record = null;
    const g = towerGame(stage, { onGameOver: (r, rec) => { record = rec; } });
    g.startTowerRound();
    playOut(g);
    assert.strictEqual(g.phase, 'gameOver', `stage ${stage}: over after one round`);
    assert.strictEqual(g.roundNumber, 1);
    assert.ok(record, 'onGameOver ran');
    assert.strictEqual(record.towerStage, stage);
    assert.strictEqual(record.rounds.length, 1);
    const out = outcomeFromRecord(record, 'me');
    assert.ok(out, 'gradable');
    // The match winner says the same as the stars: the human wins exactly with a star.
    assert.strictEqual(g.gameOverInfo.winnerId === 'me', out.stars >= 1, `stage ${stage}: winner and stars agree`);
    g.destroy();
  }
});

test('solo and frozen: nobody joins, rules and bot levels stay, leaving ends it without stars', () => {
  let recorded = false;
  const g = towerGame(4, { onGameOver: () => { recorded = true; } });
  g.startTowerRound();
  assert.strictEqual(g.isSoloMode(), true);
  assert.strictEqual(g.addOrReconnectPlayer('p2', 'Ben'), null, 'no join by code');
  assert.match(g.setHouseRules({ handAusDoubles: true }).error, /Bot-Turm/);
  assert.strictEqual(g.houseRules.handAusDoubles, false, 'unchanged');
  const bot = g.players.find((p) => p.isBot);
  assert.match(g.setBotDifficulty('me', bot.id, 'easy').error, /Bot-Turm/);
  assert.match(g.setAllBotsDifficultyBy('me', 'easy').error, /Bot-Turm/);
  assert.strictEqual(bot.botDifficulty, 'hard');
  assert.strictEqual(g.isBotControlled(g.players[0]), false, 'no bot takes the human seat');
  assert.deepStrictEqual(g.abandonSeat('me'), { outcome: 'ended' });
  assert.strictEqual(g.phase, 'abandoned');
  assert.strictEqual(recorded, false, 'no verdict for a stage given up');
  g.destroy();
});

test('snapshot roundtrip: a running stage comes back as a tower stage and still ends after its round', () => {
  const g = towerGame(2);
  g.startTowerRound();
  for (let i = 0; i < 6 && g.phase === 'playing'; i++) {
    const cp = g.currentPlayer();
    g.runBotTurn(cp.id, { forced: !cp.isBot });
  }
  const state = JSON.parse(JSON.stringify(g.serialize()));
  g.destroy();
  assert.strictEqual(state.towerStage, 2);
  let record = null;
  const back = new GameManager(() => {}, { onGameOver: (r, rec) => { record = rec; } });
  back.deserialize(state);
  assert.strictEqual(back.towerStage, 2);
  assert.strictEqual(back.isSoloMode(), true);
  assert.ok(conserved(back));
  back.addOrReconnectPlayer('me', 'Ada'); // the player comes back after the restart
  playOut(back);
  assert.strictEqual(back.phase, 'gameOver');
  assert.strictEqual(record.towerStage, 2);
  back.destroy();
});

// --- Storage + badges -------------------------------------------------------------

test('best stars per stage, never worse; the counters feed the tower badges', () => {
  const store = createPlayerStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pikdame-tower-')), 'players.json'));
  assert.deepStrictEqual(store.towerBest('Ada'), {}, 'unknown name: nothing yet');
  let r = store.recordTowerResult('Ada', 1, 1);
  assert.deepStrictEqual({ best: r.best, improved: r.improved, stars: r.stars, cleared: r.cleared, unlocked: r.unlocked },
    { best: { 1: 1 }, improved: true, stars: 1, cleared: 1, unlocked: 2 });
  assert.deepStrictEqual([r.xp, r.totalXp, store.getPlayerByName('Ada').xp], [25, 25, 25], 'the first star pays into the profile');
  r = store.recordTowerResult('ada', 1, 3);
  assert.strictEqual(r.improved, true);
  assert.strictEqual(r.xp, 0, 'more stars on the same stage pay nothing');
  r = store.recordTowerResult('ADA', 1, 2);
  assert.strictEqual(r.improved, false, 'a worse try never overwrites');
  assert.strictEqual(r.xp, 0, 'nor does a repeat');
  assert.strictEqual(store.recordTowerResult('Ada', 2, 0).xp, 0, 'a missed stage pays nothing');
  assert.strictEqual(store.getPlayerByName('Ada').xp, 25);
  assert.strictEqual(store.getPlayerByName('Ada').gamesPlayed, 0, 'no game counted');
  assert.deepStrictEqual(store.towerBest('Ada'), { 1: 3 });
  store.recordTowerResult('Ada', 1, 0);
  assert.deepStrictEqual(store.towerBest('Ada'), { 1: 3 }, 'nor does a lost one');
  const copy = store.towerBest('Ada');
  copy[1] = 0;
  assert.deepStrictEqual(store.towerBest('Ada'), { 1: 3 }, 'a copy, not the profile');

  for (const s of [2, 3]) store.recordTowerResult('Ada', s, 1);
  const p = store.getPlayerByName('Ada');
  assert.strictEqual(p.towerCleared, 3);
  assert.strictEqual(p.towerStars, 5);
  assert.ok(familyBadges(p).includes('tower_3'));
  assert.ok(!familyBadges(p).includes('tower_6'));
  for (const s of TOWER_STAGES) store.recordTowerResult('Ada', s.stage, 3);
  const top = store.getPlayerByName('Ada');
  assert.deepStrictEqual([top.towerCleared, top.towerStars], [10, 30]);
  for (const id of ['tower_3', 'tower_6', 'tower_10', 'tower_stars_30']) {
    assert.ok(BADGE_IDS.includes(id), `${id} is a badge`);
    assert.ok(familyBadges(top).includes(id), `${id} at the top`);
  }
  assert.deepStrictEqual(store.awardBadges('Ada', familyBadges(top)).filter((id) => id.startsWith('tower')).sort(),
    ['tower_10', 'tower_3', 'tower_6', 'tower_stars_30']);
  assert.deepStrictEqual(store.awardBadges('Ada', familyBadges(top)), [], 'each badge once');
});

// --- Real server ------------------------------------------------------------------

async function waitForServer(port, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
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
    const timer = setTimeout(() => reject(new Error('socket did not open')), 5000);
    ws.once('open', () => { clearTimeout(timer); resolve(ws); });
    ws.once('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

function next(ws, type, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { ws.off('message', onMsg); reject(new Error(`no ${type}`)); }, timeoutMs);
    function onMsg(raw) {
      let m;
      try { m = JSON.parse(raw); } catch (e) { return; }
      if (m.type !== type) return;
      clearTimeout(timer);
      ws.off('message', onMsg);
      resolve(m);
    }
    ws.on('message', onMsg);
  });
}

async function ask(ws, msg, replyType) {
  const reply = next(ws, replyType);
  ws.send(JSON.stringify(msg));
  return reply;
}

async function startServer(t, port, env = {}, prepare = null) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pikdame-tower-srv-'));
  if (prepare) prepare(dataDir); // seed the data dir (accounts, a session snapshot) before the boot
  const server = spawn('node', ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(port), PIKDAME_DATA_DIR: dataDir, PIKDAME_ONNX: '0', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const sockets = [];
  t.after(async () => {
    for (const s of sockets) { try { s.close(); } catch (e) { /* closing */ } }
    // SIGTERM still writes the snapshot: removing the dir before exit raced (ENOTEMPTY).
    const gone = server.exitCode !== null ? null : new Promise((r) => server.once('exit', r));
    server.kill();
    await gone;
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  await waitForServer(port);
  return { dataDir, socket: async () => { const s = await openSocket(port); sockets.push(s); return s; } };
}

test('server: getTower lists the stages, startTower checks the lock and seats a solo stage', async (t) => {
  const srv = await startServer(t, 8137);
  const ws = await srv.socket();
  const info = await ask(ws, { type: 'getTower', name: 'Ada' }, 'towerInfo');
  assert.strictEqual(info.stages.length, 10);
  assert.ok(info.stages.every((s) => !('seed' in s)), 'no seeds over the wire');
  assert.deepStrictEqual({ best: info.best, stars: info.stars, cleared: info.cleared, unlocked: info.unlocked, clearMargin: info.clearMargin },
    { best: {}, stars: 0, cleared: 0, unlocked: 1, clearMargin: 100 });

  const locked = await ask(ws, { type: 'startTower', stage: 2, name: 'Ada' }, 'error');
  assert.match(locked.error, /noch gesperrt/);
  const unknown = await ask(ws, { type: 'startTower', stage: 99, name: 'Ada' }, 'error');
  assert.match(unknown.error, /gibt es nicht/);

  const joined = next(ws, 'joined');
  const state = new Promise((resolve) => {
    ws.on('message', function onMsg(raw) {
      const m = JSON.parse(raw);
      if (m.type === 'state' && m.state.phase === 'playing') { ws.off('message', onMsg); resolve(m.state); }
    });
  });
  ws.send(JSON.stringify({ type: 'startTower', stage: 1, name: 'Ada' }));
  const j = await joined;
  const s = await state;
  assert.strictEqual(s.towerStage, 1);
  assert.deepStrictEqual(s.players.map((p) => (p.isBot ? p.botDifficulty : 'human')), ['human', 'easy', 'easy']);
  assert.strictEqual(s.currentPlayerId, j.playerId, 'the human opens');

  // Nobody joins a tower stage by its code.
  const ben = await srv.socket();
  const refused = await ask(ben, { type: 'joinSession', code: j.sessionCode, name: 'Ben' }, 'error');
  assert.match(refused.error, /voll/);
});

test('server: public mode keeps no profiles, so the tower is off', async (t) => {
  const srv = await startServer(t, 8138, { PIKDAME_PUBLIC_MODE: '1' });
  const ws = await srv.socket();
  const info = await ask(ws, { type: 'getTower', name: 'Ada' }, 'towerInfo');
  assert.deepStrictEqual(info.best, {});
  const off = await ask(ws, { type: 'startTower', stage: 1, name: 'Ada' }, 'error');
  assert.match(off.error, /auf diesem Server ist er aus/);
});

// --- XP for a stage's first star, through the real server ---------------------------
const { createAccountStore } = require('../game/AccountStore');
const sqliteProbe = createAccountStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pikdame-tower-probe-')), 'probe.db'));
const HAS_SQLITE = sqliteProbe !== null;
if (sqliteProbe) sqliteProbe.close();

/** A stage-1 table one discard from its end: the human has melded all but one card. */
function stageAtTheEnd(playerId, name) {
  const g = new GameManager(() => {}, { deckSeed: BotTower.stageConfig(1).seed, towerStage: 1 });
  g.addOrReconnectPlayer(playerId, name);
  g.syncLobbyBots();
  g.startTowerRound();
  const me = g.players.find((p) => p.id === playerId);
  me.laidOutCards = me.hand.slice(1);
  me.hand = me.hand.slice(0, 1);
  g.turnPhase = 'meld'; // as if drawn: the last card is the discard that goes out
  const lastCardId = me.hand[0].id;
  const state = JSON.parse(JSON.stringify(g.serialize()));
  g.destroy();
  return { state, lastCardId };
}

function inbox(ws) {
  const box = [];
  ws.on('message', (raw) => { try { box.push(JSON.parse(raw)); } catch (e) { /* binary */ } });
  return box;
}

async function waitIn(box, type, timeoutMs = 4000) {
  for (const deadline = Date.now() + timeoutMs; Date.now() < deadline;) {
    const m = box.find((x) => x.type === type);
    if (m) return m;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`no ${type}`);
}

test('server: the first star pays 25 XP (account and season too), a repeat and a guest only what is theirs', { skip: !HAS_SQLITE }, async (t) => {
  const tables = {
    first: { code: 'TWRAA2', id: 'p-ada1', token: 'tok-ada1', name: 'Ada', ...stageAtTheEnd('p-ada1', 'Ada') },
    again: { code: 'TWRAA3', id: 'p-ada2', token: 'tok-ada2', name: 'Ada', ...stageAtTheEnd('p-ada2', 'Ada') },
    guest: { code: 'TWRBB4', id: 'p-ben', token: 'tok-ben', name: 'Ben', ...stageAtTheEnd('p-ben', 'Ben') },
  };
  let accountToken = null;
  const srv = await startServer(t, 8139, {}, (dataDir) => {
    const accounts = createAccountStore(path.join(dataDir, 'users.db'));
    accounts.verifyEmail(accounts.register('Ada', 'ada@example.com', 'geheim123').verifyToken);
    accountToken = accounts.login('Ada', 'geheim123').token;
    accounts.close();
    const now = Date.now();
    const sessions = Object.values(tables).map((x) => ({
      code: x.code, createdAt: now, lastActivity: now, playerTokens: { [x.id]: x.token }, stammtisch: null, state: x.state,
    }));
    fs.writeFileSync(path.join(dataDir, 'sessions-snapshot.json'), JSON.stringify({ savedAt: now, sessions }));
  });

  /** Back at the restored table, then the last card: the verdict and what followed it. */
  const finish = async (x, withAccount) => {
    const ws = await srv.socket();
    const box = inbox(ws);
    ws.send(JSON.stringify({ type: 'joinSession', code: x.code, playerId: x.id, playerToken: x.token, name: x.name, accountToken: withAccount ? accountToken : undefined }));
    await waitIn(box, 'joined');
    ws.send(JSON.stringify({ type: 'discard', cardId: x.lastCardId }));
    const verdict = await waitIn(box, 'towerResult');
    await new Promise((r) => setTimeout(r, 300)); // room for the account booking
    return { verdict, account: box.find((m) => m.type === 'accountProgress') || null };
  };

  const first = await finish(tables.first, true);
  assert.ok(first.verdict.stars >= 1, 'went out far ahead: a star');
  assert.strictEqual(first.verdict.xp, 25);
  assert.strictEqual(first.verdict.level.total, 25, 'level bookkeeping like the solved puzzle');
  assert.ok(first.account, 'the account is booked');
  assert.deepStrictEqual([first.account.progress.xp, first.account.progress.seasonXp, first.account.progress.games], [25, 25, 0],
    'lifetime and season XP, no game counted');

  const again = await finish(tables.again, true);
  assert.strictEqual(again.verdict.xp, 0, 'a repeat of a cleared stage pays nothing');
  assert.strictEqual(again.account, null, 'nor books the account');

  const guest = await finish(tables.guest, false);
  assert.strictEqual(guest.verdict.xp, 25, 'a guest earns the profile XP');
  assert.strictEqual(guest.account, null, 'but has no account to book');

  const ws = await srv.socket();
  const profiles = await ask(ws, { type: 'listProfiles' }, 'profiles');
  const p = (name) => profiles.players.find((x) => x.name === name);
  assert.deepStrictEqual([p('Ada').xp, p('Ada').gamesPlayed], [25, 0], 'profile: XP once, no game');
  assert.deepStrictEqual([p('Ben').xp, p('Ben').gamesPlayed], [25, 0]);
});

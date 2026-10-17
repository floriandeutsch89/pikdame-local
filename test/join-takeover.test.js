// Joining a started game: the newcomer takes over a bot seat AS IT IS.
// Before, the joiner got a fresh empty seat in place of the bot: a bot with
// 9 cards became a newcomer with 0, and those cards left the 110-card deck.
const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const WebSocket = require('ws');
const GameManager = require('../game/GameManager');
const { createDeck } = require('../game/Deck');

const REFERENCE = (() => {
  const counts = new Map();
  for (const card of createDeck()) counts.set(card.id, (counts.get(card.id) || 0) + 1);
  return counts;
})();

/** Every card in the game, by place (same census as card-conservation). While a
 *  human cuts, the new deck waits whole and the last round's cards are stale. */
function census(game) {
  const found = new Map();
  const add = (card, where) => {
    if (!card || !card.id) return;
    found.set(card.id, (found.get(card.id) || []).concat(where));
  };
  if (game.phase === 'cutting') {
    for (const c of game._pendingDeck || []) add(c, 'pendingDeck');
    return found;
  }
  for (const p of game.players) for (const c of p.hand || []) add(c, `hand:${p.id}`);
  for (const meld of game.tableMelds || []) {
    for (const slot of meld.slots || []) {
      if (slot.real) add(slot.real, `meld:${meld.id}`);
      if (slot.joker) add(slot.joker, `meldJoker:${meld.id}`);
    }
  }
  for (const c of game.drawPile || []) add(c, 'draw');
  for (const c of game.discardPile || []) add(c, 'discard');
  for (const c of game.retiredJokers || []) add(c, 'retired');
  return found;
}

function conservationErrors(game) {
  const found = census(game);
  const errors = [];
  for (const [id, expected] of REFERENCE) {
    const places = found.get(id) || [];
    if (places.length !== expected) errors.push(`${id}: ${places.length}x instead of ${expected}x (${places.join(' + ') || 'nowhere'})`);
  }
  for (const [id, places] of found) if (!REFERENCE.has(id)) errors.push(`unknown card ${id} @ ${places.join(' + ')}`);
  return errors;
}

function assertDeck(game, when) {
  const errors = conservationErrors(game);
  assert.deepEqual(errors, [], `card conservation broken ${when}:\n  ${errors.join('\n  ')}`);
}

function newGame(opts) {
  const game = new GameManager(() => {}, opts);
  game.addOrReconnectPlayer('p1', 'Anna');
  game.fillWithBots();
  return game;
}

/** One step of a game where every seat is driven by the bot logic (humans forced). */
function step(game) {
  if (game.phase === 'roundEnd') { game.startNewRound(); return; }
  if (game.phase === 'cutting') { game.performCut(game.cutterId, 0.5); return; }
  if (game.phase !== 'playing') return;
  const cp = game.currentPlayer();
  game.runBotTurn(cp.id, { forced: !game.isBotControlled(cp) });
}

/** Plays on until `ready(game)` holds (or fails the test after `limit` steps). */
function playUntil(game, ready, limit = 3000) {
  for (let i = 0; i < limit; i++) {
    if (ready(game)) return;
    if (game.phase === 'gameOver') break;
    step(game);
  }
  assert.fail('the wanted game situation never came up');
}

/** Plays the rest of the match with the deck checked after every step. */
function playOutChecked(game, newcomerId) {
  let newcomerTurns = 0;
  for (let i = 0; i < 20000 && game.phase !== 'gameOver'; i++) {
    if (game.phase === 'playing' && game.currentPlayer().id === newcomerId) newcomerTurns += 1;
    step(game);
    assertDeck(game, `after step ${i}`);
  }
  assert.equal(game.phase, 'gameOver', 'the match runs to its end');
  assert.ok(newcomerTurns > 0, 'the newcomer actually played');
}

const firstBot = (game) => game.players.find((p) => p.isBot);
const handIds = (p) => p.hand.map((c) => c.id).sort();
const meldIdsOf = (game, id) => game.tableMelds.filter((m) => m.ownerId === id).map((m) => m.id).sort();

test('join while playing: the newcomer takes the bot seat with its hand, melds, points and id', () => {
  const game = newGame();
  game.startNewRound();
  // A bot with lay-outs on the table, a few cards in hand, not on turn.
  playUntil(game, (g) => {
    const bot = firstBot(g);
    return g.phase === 'playing' && g.roundNumber >= 2 && meldIdsOf(g, bot.id).length > 0
      && bot.hand.length >= 2 && g.currentPlayer().id !== bot.id;
  });
  const bot = firstBot(game);
  const before = {
    id: bot.id, name: bot.name, index: game.players.indexOf(bot), hand: handIds(bot),
    melds: meldIdsOf(game, bot.id), total: game.totals[bot.id],
    history: game.roundHistory.map((r) => r.totalsAfter[bot.id]),
  };
  assert.ok(before.total !== undefined && before.history.length > 0, 'the bot has points from earlier rounds');
  assertDeck(game, 'before the join');

  const seat = game.addOrReconnectPlayer('p-new', 'Neu');
  assert.ok(seat, 'the join succeeds');
  assert.equal(seat.id, before.id, 'the seat keeps its id');
  assert.equal(game.players.indexOf(seat), before.index, 'same place at the table');
  assert.equal(seat.isBot, false);
  assert.equal(seat.connected, true);
  assert.equal(seat.name, 'Neu');
  assert.equal(seat.botDifficulty, undefined, 'no bot level left on a human seat');
  assert.deepEqual(handIds(seat), before.hand, 'the bot hand goes to the newcomer');
  assert.deepEqual(meldIdsOf(game, seat.id), before.melds, 'its lay-outs stay its own');
  assert.equal(game.totals[seat.id], before.total, 'its points stay');
  assert.deepEqual(game.roundHistory.map((r) => r.totalsAfter[seat.id]), before.history, 'and the score history');
  assert.ok(game.log.some((e) => e.text === `Neu übernimmt den Platz von ${before.name}.`), 'the table is told');
  assertDeck(game, 'right after the join');

  playOutChecked(game, seat.id);
  game.destroy();
});

test('join on the bot\'s own turn: the pending bot move is dropped and the human plays on', () => {
  const game = newGame();
  game.setHouseRules({ turnTimerSeconds: 30 });
  game.startNewRound();
  playUntil(game, (g) => g.phase === 'playing' && g.currentPlayer().id === firstBot(g).id && g.turnPhase === 'draw');
  const bot = firstBot(game);
  game.maybeRunBotTurn(); // the bot's think timer is now pending
  assert.ok(game._botTimer, 'a bot move is pending');
  const hand = handIds(bot);

  const seat = game.addOrReconnectPlayer('p-new', 'Neu');
  assert.equal(seat.id, bot.id);
  assert.equal(game._botTimer, null, 'the pending bot move is cancelled');
  assert.ok(game.turnDeadline, 'the human gets the turn timer');
  assert.equal(game.isBotControlled(seat), false);
  game.runBotTurn(seat.id); // a late bot timer firing anyway
  assert.equal(game.turnPhase, 'draw', 'nothing happened on the human\'s behalf');
  assert.deepEqual(handIds(seat), hand);

  const r = game.drawFromPile(seat.id);
  assert.ok(!r || !r.error, `the human can draw: ${r && r.error}`);
  assert.equal(seat.hand.length, hand.length + 1);
  assertDeck(game, 'after the human drew');
  playOutChecked(game, seat.id);
  game.destroy();
});

test('join at round end: the bot\'s rest cards and points carry over, the next round deals to the newcomer', () => {
  const game = newGame();
  game.startNewRound();
  playUntil(game, (g) => g.phase === 'roundEnd');
  const bot = firstBot(game);
  const total = game.totals[bot.id];
  const rest = handIds(bot);
  const seat = game.addOrReconnectPlayer('p-new', 'Neu');
  assert.equal(seat.id, bot.id);
  assert.equal(game.totals[seat.id], total);
  assert.deepEqual(handIds(seat), rest);
  assertDeck(game, 'after the join at round end');
  game.startNewRound();
  if (game.phase === 'cutting') game.performCut(game.cutterId, 0.5);
  assert.ok(seat.hand.length >= 15, 'the newcomer is dealt a full hand');
  assertDeck(game, 'after the next deal');
  playOutChecked(game, seat.id);
  game.destroy();
});

test('join while a human cuts: the seat is taken before the deal and dealt normally', () => {
  const game = newGame();
  game.setExplicitDealer(game.players[1].id); // Anna (seat 0) cuts
  game.startNewRound();
  assert.equal(game.phase, 'cutting');
  assert.equal(game.cutterId, 'p1');
  assertDeck(game, 'during the cut');
  const bot = firstBot(game);
  const seat = game.addOrReconnectPlayer('p-new', 'Neu');
  assert.equal(seat.id, bot.id);
  assert.equal(game.phase, 'cutting', 'the cut still waits for Anna');
  assertDeck(game, 'after the join during the cut');
  game.performCut('p1', 0.5);
  assert.ok(seat.hand.length >= 15);
  assertDeck(game, 'after the cut');
  playOutChecked(game, seat.id);
  game.destroy();
});

test('a taken-over seat survives a snapshot roundtrip', () => {
  const game = newGame();
  game.startNewRound();
  playUntil(game, (g) => g.phase === 'playing' && meldIdsOf(g, firstBot(g).id).length > 0);
  const seat = game.addOrReconnectPlayer('p-new', 'Neu');
  const snapshot = JSON.parse(JSON.stringify(game.serialize()));
  const restored = new GameManager(() => {});
  restored.deserialize(snapshot);
  const back = restored.players.find((p) => p.id === seat.id);
  assert.ok(back, 'the seat is there');
  assert.equal(back.isBot, false);
  assert.equal(back.name, 'Neu');
  assert.deepEqual(handIds(back), handIds(seat));
  assert.deepEqual(meldIdsOf(restored, seat.id), meldIdsOf(game, seat.id));
  assert.equal(restored.totals[seat.id], game.totals[seat.id]);
  assertDeck(restored, 'after the restore');
  game.destroy();
  restored.destroy();
});

test('lobby joins still replace a bot with a fresh seat; a full started table and solo games stay closed', () => {
  const lobby = newGame();
  const seat = lobby.addOrReconnectPlayer('p2', 'Ben');
  assert.equal(seat.id, 'p2', 'in the lobby the newcomer gets their own seat');
  assert.equal(lobby.players.length, 4);
  lobby.destroy();

  const full = new GameManager(() => {});
  for (let i = 1; i <= 4; i++) full.addOrReconnectPlayer(`p${i}`, `P${i}`);
  full.startNewRound();
  assert.equal(full.addOrReconnectPlayer('p5', 'Late'), null, 'no bot seat left - no join');
  full.destroy();

  for (const opts of [{ tutorialMode: true }, { challengeDate: '2026-03-09' }]) {
    const solo = newGame(opts);
    solo.startNewRound();
    assert.equal(solo.addOrReconnectPlayer('p2', 'Gast'), null, 'challenge and tutorial stay single-player');
    assert.ok(solo.players.filter((p) => !p.isBot).length === 1);
    solo.destroy();
  }
});

// --- Real server: join a running session by its code ------------------------
const PORT = 8094;

async function waitForServer(port, timeoutMs = 15000) {
  const http = require('node:http');
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

function openSocket() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${PORT}`);
    const timer = setTimeout(() => reject(new Error('socket did not open')), 5000);
    ws.once('open', () => { clearTimeout(timer); resolve(ws); });
    ws.once('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

function waitFor(ws, accept, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('expected message did not arrive')), timeoutMs);
    const onMsg = (raw) => {
      let m;
      try { m = JSON.parse(raw); } catch (e) { return; }
      if (!accept(m)) return;
      clearTimeout(timer);
      ws.off('message', onMsg);
      resolve(m);
    };
    ws.on('message', onMsg);
  });
}

/** Cards a viewer can account for in a playing state: all of the 110. */
function publicCardCount(state) {
  let n = state.drawPileCount + state.discardPileCount + (state.retiredJokers || []).length;
  for (const p of state.players) n += p.handCount;
  for (const m of state.tableMelds || []) n += (m.slots || []).length;
  return n;
}

test('server: joining a running session by code takes over a bot seat with its cards', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pikdame-join-'));
  const server = spawn('node', ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), PIKDAME_DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => {
    server.kill();
    await new Promise((r) => server.once('exit', r));
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  await waitForServer(PORT);

  const host = await openSocket();
  const hostJoined = waitFor(host, (m) => m.type === 'joined');
  host.send(JSON.stringify({ type: 'createSession', name: 'Anna' }));
  const { sessionCode } = await hostJoined;
  // Start; if Anna has to cut, she cuts - then wait for the round to run.
  host.on('message', (raw) => {
    const m = JSON.parse(raw);
    if (m.type === 'state' && m.state.phase === 'cutting' && m.state.cutterId === m.state.players[0].id) {
      host.send(JSON.stringify({ type: 'performCut', position: 0.5 }));
    }
  });
  const playing = waitFor(host, (m) => m.type === 'state' && m.state.phase === 'playing');
  host.send(JSON.stringify({ type: 'startGame', houseRules: {} }));
  await playing;

  const guest = await openSocket();
  const guestJoined = waitFor(guest, (m) => m.type === 'joined');
  const guestState = waitFor(guest, (m) => m.type === 'state');
  guest.send(JSON.stringify({ type: 'joinSession', code: sessionCode, name: 'Ben' }));
  const joined = await guestJoined;
  const { state } = await guestState;
  const me = state.players.find((p) => p.id === joined.playerId);
  assert.ok(me, 'the guest sits at the table under the id the server reported');
  assert.equal(me.name, 'Ben');
  assert.equal(me.isBot, false);
  assert.match(joined.playerId, /^bot-\d+$/, 'it is the former bot seat');
  assert.equal(state.players.length, 4, 'no extra seat');
  if (state.phase === 'playing') {
    assert.ok(me.hand.length > 0, 'the guest holds the bot\'s cards');
    assert.equal(me.hand.length, me.handCount);
    assert.equal(publicCardCount(state), 110, 'all 110 cards are still in the game');
  }

  // The seat token works for a reconnect, like any human seat.
  const again = await openSocket();
  const rejoined = waitFor(again, (m) => m.type === 'joined');
  again.send(JSON.stringify({ type: 'joinSession', code: sessionCode, name: 'Ben', playerId: joined.playerId, playerToken: joined.playerToken }));
  assert.equal((await rejoined).playerId, joined.playerId);

  host.close();
  guest.close();
  again.close();
});

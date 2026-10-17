/** One game at a time (v2.67): the start screen gives up the device's open
 *  game before another starts. Engine side: lobby frees the seat, alone with
 *  bots ends the match unscored, with other humans a bot plays the seat to the
 *  end and the leaver is neither able to return nor scored. */
const test = require('node:test');
const assert = require('node:assert');
const GameManager = require('../game/GameManager');
const { createDeck } = require('../game/Deck');

function autoCut(g) {
  const orig = g.startNewRound.bind(g);
  g.startNewRound = (...a) => {
    orig(...a);
    if (g.phase === 'cutting') g.performCut(g.cutterId, 0.5);
  };
  return g;
}

function table(humans, { onGameOver } = {}) {
  const g = autoCut(new GameManager(() => {}, { onGameOver }));
  humans.forEach((name, i) => g.addOrReconnectPlayer(`p${i + 1}`, name));
  return g;
}

function cardCount(g) {
  let n = g.drawPile.length + g.discardPile.length + (g.retiredJokers || []).length;
  for (const p of g.players) n += p.hand.length;
  for (const meld of g.tableMelds || []) for (const s of meld.slots || []) n += (s.real ? 1 : 0) + (s.joker ? 1 : 0);
  return n;
}

/** Plays every seat (humans forced) until the match is over. */
function playToEnd(g) {
  let guard = 0;
  while (g.phase !== 'gameOver' && guard++ < 20000) {
    if (g.phase === 'roundEnd') { g.startNewRound(); continue; }
    if (g.phase === 'cutting') { g.performCut(g.cutterId, 0.5); continue; }
    const cp = g.currentPlayer();
    g.runBotTurn(cp.id, { forced: true });
    assert.strictEqual(cardCount(g), createDeck().length, `card conservation after turn ${guard}`);
  }
  assert.strictEqual(g.phase, 'gameOver');
}

test('lobby: giving up frees the seat', () => {
  const g = table(['Anna', 'Ben']);
  g.syncLobbyBots();
  assert.deepStrictEqual(g.abandonSeat('p1'), { outcome: 'lobby' });
  assert.ok(!g.players.some((p) => p.id === 'p1'));
  assert.ok(g.players.some((p) => p.id === 'p2'));
  g.destroy();
});

test('alone with bots: the match ends at once and nobody is scored', () => {
  let recorded = null;
  const g = table(['Anna'], { onGameOver: (results) => { recorded = results; } });
  g.fillWithBots();
  g.startNewRound();
  assert.strictEqual(g.seatStatus('p1').alone, true);
  assert.deepStrictEqual(g.abandonSeat('p1'), { outcome: 'ended' });
  assert.strictEqual(g.phase, 'gameOver');
  assert.strictEqual(g.gameOverInfo.forfeited, true);
  assert.strictEqual(g.gameOverInfo.winnerId, null);
  assert.strictEqual(recorded, null, 'an abandoned match is not recorded');
  assert.ok(g.log.some((e) => /^Anna hat aufgegeben - die Partie endet ohne Wertung\.$/.test(e.text)));
  g.destroy();
});

test('with another human: a bot keeps the seat, the leaver cannot return and is not scored', () => {
  let results = null;
  let record = null;
  const g = table(['Anna', 'Ben'], { onGameOver: (r, rec) => { results = r; record = rec; } });
  g.fillWithBots();
  g.setAllBotsDifficulty('hard');
  g.startNewRound();
  assert.strictEqual(g.seatStatus('p2').alone, false);
  assert.deepStrictEqual(g.abandonSeat('p2'), { outcome: 'left' });
  const ben = g.players.find((p) => p.id === 'p2');
  assert.strictEqual(ben.leftGame, true);
  assert.strictEqual(g.isBotControlled(ben), true, 'no grace window: the bot plays right away');
  assert.strictEqual(ben.botDifficulty, 'hard', 'the stand-in plays at the table level');
  assert.ok(g.log.some((e) => /^Ben hat das Spiel verlassen - ein Bot spielt weiter\.$/.test(e.text)));
  // Reclaim refused - by id and by the disconnect safety net.
  assert.strictEqual(g.addOrReconnectPlayer('p2', 'Ben'), null);
  assert.strictEqual(ben.connected, false);
  g.markDisconnected('p2');
  assert.strictEqual(g.isBotControlled(ben), true, 'a late close must not restart a grace window');
  assert.deepStrictEqual(g.abandonSeat('p2'), { outcome: 'none' }, 'idempotent');
  assert.strictEqual(g.seatStatus('p2').left, true);
  assert.strictEqual(g.publicState('p1').players.find((p) => p.id === 'p2').leftGame, true);

  playToEnd(g);
  assert.deepStrictEqual(results.map((r) => r.name), ['Anna'], 'only the remaining human is recorded');
  const benRecord = record.players.find((p) => p.id === 'p2');
  assert.strictEqual(benRecord.isBot, true, 'downstream stats treat the leaver like a bot');
  assert.strictEqual(benRecord.leftGame, true);
  assert.strictEqual(record.players.find((p) => p.id === 'p1').isBot, false);
  g.destroy();
});

test('a disconnected human still counts: leaving does not end their game', () => {
  const g = table(['Anna', 'Ben']);
  g.fillWithBots();
  g.startNewRound();
  g.markDisconnected('p1'); // Anna's app is closed, she may come back
  assert.deepStrictEqual(g.abandonSeat('p2'), { outcome: 'left' });
  assert.notStrictEqual(g.phase, 'gameOver');
  assert.ok(g.addOrReconnectPlayer('p1', 'Anna'), 'Anna can still come back');
  g.destroy();
});

test('forfeit votes: the leaver drops out, a vote of the rest decides', () => {
  const g = table(['Anna', 'Ben', 'Cleo']);
  g.fillWithBots();
  g.startNewRound();
  g.toggleForfeitVote('p1');
  g.toggleForfeitVote('p3');
  assert.notStrictEqual(g.phase, 'gameOver', 'Ben has not agreed yet');
  g.abandonSeat('p2');
  assert.strictEqual(g.phase, 'gameOver', 'everyone still seated had agreed');
  assert.strictEqual(g.gameOverInfo.forfeited, true);
  g.destroy();
});

test('the tutorial ends quietly instead of being scored as a forfeit', () => {
  let gone = false;
  const g = autoCut(new GameManager(() => {}, { tutorialMode: true, onAbandon: () => { gone = true; } }));
  g.addOrReconnectPlayer('p1', 'Neuling');
  g.fillWithBots();
  g.startNewRound();
  assert.strictEqual(g.seatStatus('p1').tutorial, true);
  assert.deepStrictEqual(g.abandonSeat('p1'), { outcome: 'ended' });
  assert.strictEqual(g.phase, 'abandoned');
  assert.strictEqual(gone, true, 'the registry drops the session');
  g.destroy();
});

test('the daily challenge is never given up this way', () => {
  const g = autoCut(new GameManager(() => {}, { challengeDate: '2026-03-09' }));
  g.addOrReconnectPlayer('p1', 'Anna');
  g.fillWithBots();
  g.startNewRound();
  assert.deepStrictEqual(g.abandonSeat('p1'), { outcome: 'none' });
  assert.notStrictEqual(g.phase, 'gameOver');
  g.destroy();
});

test('rematch: the leaver is gone and a lobby bot takes the seat', () => {
  const g = table(['Anna', 'Ben']);
  g.fillWithBots();
  g.startNewRound();
  g.abandonSeat('p2');
  playToEnd(g);
  g.prepareRematch();
  assert.strictEqual(g.phase, 'lobby');
  assert.ok(!g.players.some((p) => p.id === 'p2'));
  assert.strictEqual(g.players.length, 4, 'the table is topped up with bots again');
  assert.ok(!Object.prototype.hasOwnProperty.call(g.totals, 'p2'));
  g.destroy();
});

test('snapshot: a given-up seat stays given up after a restart', () => {
  const g = table(['Anna', 'Ben']);
  g.fillWithBots();
  g.startNewRound();
  g.abandonSeat('p2');
  const snap = JSON.parse(JSON.stringify(g.serialize()));
  g.destroy();
  const restored = new GameManager(() => {});
  restored.deserialize(snap);
  const ben = restored.players.find((p) => p.id === 'p2');
  assert.strictEqual(ben.leftGame, true);
  assert.strictEqual(restored.isBotControlled(ben), true);
  assert.strictEqual(restored.addOrReconnectPlayer('p2', 'Ben'), null);
  assert.strictEqual(cardCount(restored), createDeck().length);
  restored.destroy();
});

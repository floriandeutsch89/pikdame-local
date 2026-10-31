// Ready, pause and forfeit gates: a human who minimised the app (socket gone)
// is no consent - their seat blocks until the takeover grace runs out.
const test = require('node:test');
const assert = require('node:assert/strict');
const GameManager = require('../game/GameManager');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function table(withCleo = false) {
  const g = new GameManager(() => {});
  g.addOrReconnectPlayer('p1', 'Anna');
  g.addOrReconnectPlayer('p2', 'Ben');
  if (withCleo) g.addOrReconnectPlayer('p3', 'Cleo');
  g.fillWithBots();
  g.startNewRound();
  if (g.phase === 'cutting') g.performCut(g.cutterId, 0.5);
  g.maybeRunBotTurn = () => {}; // we drive the table, no bot timer
  assert.equal(g.phase, 'playing');
  return g;
}

function atRoundEnd() {
  const g = table();
  g.finishRound(g.players[0].id);
  assert.equal(g.phase, 'roundEnd');
  return g;
}

async function withShortGrace(fn) {
  const old = GameManager.TAKEOVER_GRACE_MS;
  GameManager.TAKEOVER_GRACE_MS = 30;
  try { await fn(); } finally { GameManager.TAKEOVER_GRACE_MS = old; }
}

test('ready gate: a minimised player blocks the next round', () => {
  const g = atRoundEnd();
  g.markNextRoundReady('p1');
  g.markDisconnected('p2');
  assert.equal(g.phase, 'roundEnd', 'disconnect is no consent');
  g.markNextRoundReady('p1');
  assert.equal(g.phase, 'roundEnd');
  g.destroy();
});

test('ready gate: the returning player still sees the prompt and starts the round', () => {
  const g = atRoundEnd();
  g.markNextRoundReady('p1');
  g.markDisconnected('p2');
  g.addOrReconnectPlayer('p2', 'Ben');
  assert.equal(g.phase, 'roundEnd');
  const st = g.publicState('p2');
  assert.deepEqual(st.nextRoundReady, ['p1'], 'Ben has not confirmed yet');
  assert.equal(st.players.find((p) => p.id === 'p2').controlledByBot, false);
  g.markNextRoundReady('p2');
  assert.notEqual(g.phase, 'roundEnd');
  g.destroy();
});

test('ready gate: a confirmation given before minimising still counts', () => {
  const g = atRoundEnd();
  g.markNextRoundReady('p2');
  g.markDisconnected('p2');
  g.markNextRoundReady('p1');
  assert.notEqual(g.phase, 'roundEnd');
  g.destroy();
});

test('ready gate: grace expiry releases the table', async () => {
  await withShortGrace(async () => {
    const g = atRoundEnd();
    g.markNextRoundReady('p1');
    g.markDisconnected('p2');
    assert.equal(g.phase, 'roundEnd');
    await wait(80);
    assert.notEqual(g.phase, 'roundEnd', 'takeover timer re-evaluates the gate');
    g.destroy();
  });
});

test('ready gate: a takeover timer firing before Date.now() catches up still releases the table', async () => {
  await withShortGrace(async () => {
    const g = atRoundEnd();
    g.markNextRoundReady('p1');
    g.markDisconnected('p2');
    const frozen = g.players.find((p) => p.id === 'p2').disconnectedAt + 29; // 1 ms short of the grace
    const realNow = Date.now;
    Date.now = () => frozen;
    try {
      await wait(80);
      assert.notEqual(g.phase, 'roundEnd', 'the expired timer itself ends the grace');
    } finally { Date.now = realNow; }
    g.destroy();
  });
});

test('ready gate: nobody left at the table -> no round starts on its own', async () => {
  await withShortGrace(async () => {
    const g = atRoundEnd();
    g.markDisconnected('p1');
    g.markDisconnected('p2');
    await wait(80);
    assert.equal(g.phase, 'roundEnd');
    g.addOrReconnectPlayer('p1', 'Anna');
    g.markNextRoundReady('p1');
    assert.notEqual(g.phase, 'roundEnd', 'Ben is past his grace');
    g.destroy();
  });
});

test('ready gate: a player who left the game never blocks', () => {
  const g = atRoundEnd();
  g.markNextRoundReady('p1');
  assert.equal(g.abandonSeat('p2').outcome, 'left');
  assert.notEqual(g.phase, 'roundEnd');
  g.destroy();
});

test('ready gate: snapshot restore mid-wait keeps everyone blocking for the grace', () => {
  const g = atRoundEnd();
  g.markNextRoundReady('p1');
  g.markDisconnected('p2');
  const snap = JSON.parse(JSON.stringify(g.serialize()));
  g.destroy();
  const back = new GameManager(() => {});
  back.deserialize(snap);
  back.maybeRunBotTurn = () => {};
  assert.equal(back.phase, 'roundEnd');
  assert.ok(back._takeoverTimers instanceof Map);
  back.addOrReconnectPlayer('p1', 'Anna');
  back.markNextRoundReady('p1');
  assert.equal(back.phase, 'roundEnd', 'Ben (gone at restart) still blocks');
  back.addOrReconnectPlayer('p2', 'Ben');
  back.markNextRoundReady('p2');
  assert.notEqual(back.phase, 'roundEnd');
  back.destroy();
});

test('restore: a seat live at SIGTERM blocks the gates while its clock runs, the bot plays as before', () => {
  const g = atRoundEnd();
  const snap = JSON.parse(JSON.stringify(g.serialize()));
  g.destroy();
  const back = new GameManager(() => {});
  back.deserialize(snap);
  back.maybeRunBotTurn = () => {};
  const p2 = back.players.find((p) => p.id === 'p2');
  assert.equal(back.isBotControlled(p2), true, 'stand-in behaviour after a restart is unchanged');
  assert.deepEqual(back.publicState('p1').consentIds, ['p1', 'p2']);
  back.addOrReconnectPlayer('p1', 'Anna');
  back.markNextRoundReady('p1');
  assert.equal(back.phase, 'roundEnd', 'Ben has not confirmed yet');
  back.destroy();
});

test('pause vote: a minimised player is no consent until the grace runs out', async () => {
  await withShortGrace(async () => {
    const g = table();
    g.togglePauseVote('p1');
    g.markDisconnected('p2');
    assert.equal(!!g.paused, false, 'disconnect is no consent');
    g.addOrReconnectPlayer('p2', 'Ben');
    assert.equal(!!g.paused, false);
    g.togglePauseVote('p2');
    assert.equal(g.paused, true, 'both agreed');
    g.togglePauseVote('p1');
    g.markDisconnected('p2');
    assert.equal(g.paused, true, 'resume waits for Ben too');
    await wait(80);
    assert.equal(!!g.paused, false, 'grace over -> Anna alone decides');
    g.destroy();
  });
});

test('pause vote: a player who left the game never blocks', () => {
  const g = table(true);
  g.togglePauseVote('p1');
  g.togglePauseVote('p3');
  assert.equal(!!g.paused, false);
  g.abandonSeat('p2');
  assert.equal(g.paused, true);
  g.destroy();
});

test('forfeit vote: a minimised player is no consent until the grace runs out', async () => {
  await withShortGrace(async () => {
    const g = table();
    g.toggleForfeitVote('p1');
    g.markDisconnected('p2');
    assert.equal(g.phase, 'playing', 'disconnect is no consent');
    g.addOrReconnectPlayer('p2', 'Ben');
    assert.equal(g.phase, 'playing');
    g.markDisconnected('p2');
    await wait(80);
    assert.equal(g.phase, 'gameOver', 'grace over -> the vote completes');
    g.destroy();
  });
});

test('forfeit vote: a player who left the game never blocks', () => {
  const g = table(true);
  g.toggleForfeitVote('p1');
  g.toggleForfeitVote('p3');
  assert.equal(g.phase, 'playing');
  g.abandonSeat('p2');
  assert.equal(g.phase, 'gameOver');
  g.destroy();
});

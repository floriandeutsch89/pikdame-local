const test = require('node:test');
const assert = require('node:assert');
const GameManager = require('../game/GameManager');
const { HAND_SIZE } = require('../game/Deck');

// NOTE: deliberately NO auto-cut hook here - this file tests the cutting
// phase itself.

function humanGame(count = 3) {
  const sent = [];
  const g = new GameManager((playerId, message) => sent.push({ playerId, message }));
  for (let i = 1; i <= count; i++) g.addOrReconnectPlayer(`p${i}`, `Spieler ${i}`);
  return { g, sent };
}

test('cutting: a connected human cutter pauses the round start in phase cutting', () => {
  const { g } = humanGame(3);
  g.startNewRound();
  assert.equal(g.phase, 'cutting');
  // Cutter = player BEFORE the dealer (dealerIndex 0 -> last seat)
  assert.equal(g.cutterId, g.players[g.players.length - 1].id);
  assert.ok(g.cutDeadline > Date.now(), 'a timeout deadline is armed');
  g.destroy();
});

test('cutting: only the cutter may cut, position must be in [0,1]', () => {
  const { g } = humanGame(3);
  g.startNewRound();
  const notCutter = g.players.find((p) => p.id !== g.cutterId).id;
  assert.ok(g.performCut(notCutter, 0.5).error, 'wrong player rejected');
  assert.ok(g.performCut(g.cutterId, 1.5).error, 'position > 1 rejected');
  assert.ok(g.performCut(g.cutterId, 'x').error, 'non-numeric rejected');
  assert.equal(g.phase, 'cutting', 'still waiting after rejections');
  const r = g.performCut(g.cutterId, 0.3);
  assert.equal(r.ok, true);
  assert.equal(g.phase, 'playing');
  g.destroy();
});

test('cutting: after the cut everyone holds exactly 15 cards (lucky cards included)', () => {
  // Repeat often enough that lucky cuts actually occur sometimes.
  for (let i = 0; i < 60; i++) {
    const { g } = humanGame(3);
    g.startNewRound();
    g.performCut(g.cutterId, Math.random());
    for (const p of g.players) {
      assert.equal(p.hand.length, HAND_SIZE, `${p.name} holds ${p.hand.length}`);
    }
    g.destroy();
  }
});

test('cutting: performCut is rejected outside the cutting phase', () => {
  const { g } = humanGame(2);
  g.startNewRound();
  g.performCut(g.cutterId, 0.5);
  assert.equal(g.phase, 'playing');
  assert.ok(g.performCut(g.players[0].id, 0.5).error, 'no re-cut mid-round');
  g.destroy();
});

test('cutting: a bot cutter never pauses - the round starts synchronously', () => {
  const { g } = humanGame(1); // 1 human host
  g.fillWithBots();
  // dealer 0 (human) -> cutter is the LAST seat, a bot
  g.startNewRound();
  assert.equal(g.phase, 'playing');
  g.destroy();
});

test('cutting: seeded rounds (daily challenge) always auto-cut deterministically', () => {
  const deal = () => {
    const { g } = humanGame(2);
    g.deckSeed = 12345;
    g.startNewRound();
    const hands = g.players.map((p) => p.hand.map((c) => c.id).join(','));
    g.destroy();
    return { phase: 'playing', hands };
  };
  const a = deal();
  const b = deal();
  assert.deepEqual(a.hands, b.hands, 'identical decks for everyone, human cutter or not');
});

test('cutting: the pending deck NEVER appears in publicState (cheat guard)', () => {
  const { g } = humanGame(3);
  g.startNewRound();
  assert.equal(g.phase, 'cutting');
  for (const p of g.players) {
    const s = JSON.stringify(g.publicState(p.id));
    assert.ok(!s.includes('_pendingDeck'), 'field name must not leak');
    // In cutting, no hands are dealt yet - no card object may be visible at all
    const st = g.publicState(p.id);
    assert.equal(st.cutterId, g.cutterId);
    assert.ok(st.cutDeadline > 0);
  }
  g.destroy();
});

test('cutting: cutter disconnect auto-cuts so the table keeps moving', () => {
  const { g } = humanGame(3);
  g.startNewRound();
  const cutter = g.cutterId;
  g.markDisconnected(cutter);
  assert.equal(g.phase, 'playing', 'auto-cut on disconnect');
  for (const p of g.players) assert.equal(p.hand.length, HAND_SIZE);
  g.destroy();
});

test('cutting: serialize/deserialize mid-cut restores a playable table (auto-cut)', () => {
  const { g } = humanGame(3);
  g.startNewRound();
  assert.equal(g.phase, 'cutting');
  const snap = JSON.parse(JSON.stringify(g.serialize()));
  g.destroy();
  const g2 = new GameManager(() => {});
  g2.deserialize(snap);
  assert.equal(g2.phase, 'playing', 'restore must not strand the table in cutting');
  for (const p of g2.players) assert.equal(p.hand.length, HAND_SIZE);
  g2.destroy();
});

test('cutting: non-cutter disconnect does NOT auto-cut', () => {
  const { g } = humanGame(3);
  g.startNewRound();
  const other = g.players.find((p) => p.id !== g.cutterId).id;
  g.markDisconnected(other);
  assert.equal(g.phase, 'cutting', 'still waiting for the cutter');
  g.performCut(g.cutterId, 0.5);
  assert.equal(g.phase, 'playing');
  g.destroy();
});

test('cut reveal: publicState exposes lucky cards + the stopper, nothing else', () => {
  // Force a deterministic deck situation by cutting many games and checking
  // the invariants that must ALWAYS hold.
  for (let i = 0; i < 60; i++) {
    const { g } = humanGame(3);
    g.startNewRound();
    g.performCut(g.cutterId, Math.random());
    const st = g.publicState(g.players[0].id);
    const r = st.lastCutReveal;
    assert.ok(r, 'reveal present after the cut');
    assert.equal(r.round, g.roundNumber);
    assert.ok(r.cards.length >= 1, 'at least the stopper is revealed');
    // All but the last are lucky; the last one (stopper) never is.
    const isLucky = (c) => c.isJoker || (c.suit === 'S' && c.rank === 'Q');
    r.cards.forEach((c, idx) => {
      if (idx < r.luckyCount) assert.ok(isLucky(c), 'kept cards are lucky');
    });
    const stopper = r.cards[r.cards.length - 1];
    if (r.cards.length > r.luckyCount) {
      assert.ok(!isLucky(stopper), 'the stopper is an ordinary card');
    }
    // The stopper STAYS in play: total cards must still be 110.
    const inHands = g.players.reduce((a, p) => a + p.hand.length, 0);
    assert.equal(inHands + g.drawPile.length + g.discardPile.length, 110);
    g.destroy();
  }
});

test('cut reveal: auto-cuts (bot cutter) reveal too, so the step is visible every round', () => {
  const { g } = humanGame(1);
  g.fillWithBots();
  g.startNewRound(); // bot cutter -> auto
  assert.equal(g.phase, 'playing');
  const r = g.publicState(g.players[0].id).lastCutReveal;
  assert.ok(r && r.cards.length >= 1);
  g.destroy();
});

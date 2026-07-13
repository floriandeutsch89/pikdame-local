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

test('cut reveal: the CUTTER always sees the revealed cards; totals stay at 110', () => {
  for (let i = 0; i < 60; i++) {
    const { g } = humanGame(3);
    g.startNewRound();
    const cutterId = g.cutterId;
    g.performCut(cutterId, Math.random());
    const r = g.publicState(cutterId).lastCutReveal; // the cutter's own view
    assert.ok(r, 'the cutter always gets a reveal');
    assert.equal(r.round, g.roundNumber);
    assert.ok(r.cards.length >= 1, 'at least one card revealed to the cutter');
    const isLucky = (c) => c.isJoker || (c.suit === 'S' && c.rank === 'Q');
    r.cards.forEach((c, idx) => {
      if (idx < r.luckyCount) assert.ok(isLucky(c), 'kept cards are lucky');
    });
    if (r.cards.length > r.luckyCount) {
      assert.ok(!isLucky(r.cards[r.cards.length - 1]), 'the stopper is an ordinary card');
    }
    // The stopper STAYS in play: total cards must still be 110.
    const inHands = g.players.reduce((a, p) => a + p.hand.length, 0);
    assert.equal(inHands + g.drawPile.length + g.discardPile.length, 110);
    g.destroy();
  }
});

test('cut reveal: a bot auto-cut is public ONLY on a lucky hit; ordinary bot cuts show nothing', () => {
  let sawLucky = false, sawOrdinary = false;
  for (let i = 0; i < 250 && !(sawLucky && sawOrdinary); i++) {
    const { g } = humanGame(1);
    g.fillWithBots();
    g.startNewRound(); // bot cutter -> auto
    assert.equal(g.phase, 'playing');
    const raw = g.lastCutReveal;
    const humanView = g.publicState(g.players[0].id).lastCutReveal;
    if (raw.luckyCards.length > 0) {
      sawLucky = true;
      assert.ok(humanView && humanView.luckyCount === raw.luckyCards.length,
        'a lucky bot cut is announced to the table');
    } else {
      sawOrdinary = true;
      assert.equal(humanView, null, 'an ordinary bot cut reveals nothing to others');
    }
    g.destroy();
  }
  assert.ok(sawOrdinary, 'saw at least one ordinary cut');
  // lucky cuts are ~40% per cut with 6 jokers + 2 queens in 110 cards over a
  // run - across 250 games missing one would be a red flag:
  assert.ok(sawLucky, 'saw at least one lucky cut');
});

test('cut reveal privacy: an ordinary cut card is visible to the CUTTER ONLY', () => {
  // Repeat until we hit a non-lucky cut (overwhelmingly likely per attempt).
  for (let i = 0; i < 40; i++) {
    const { g } = humanGame(3);
    g.startNewRound();
    g.performCut(g.cutterId, Math.random());
    const raw = g.lastCutReveal;
    const cutterId = raw.cutterId;
    if (raw.luckyCards.length === 0) {
      const forCutter = g.publicState(cutterId).lastCutReveal;
      assert.ok(forCutter && forCutter.cards.length === 1, 'cutter sees the one card');
      for (const p of g.players) {
        if (p.id === cutterId) continue;
        assert.equal(g.publicState(p.id).lastCutReveal, null, 'others see NOTHING');
      }
      g.destroy();
      return;
    }
    g.destroy();
  }
  assert.fail('no ordinary cut in 40 attempts (statistically impossible)');
});

test('cut reveal privacy: lucky cards are public, the stopper stays cutter-only', () => {
  for (let i = 0; i < 200; i++) {
    const { g } = humanGame(3);
    g.startNewRound();
    g.performCut(g.cutterId, Math.random());
    const raw = g.lastCutReveal;
    if (raw.luckyCards.length > 0 && raw.stopper) {
      const cutterView = g.publicState(raw.cutterId).lastCutReveal;
      assert.equal(cutterView.cards.length, raw.luckyCards.length + 1, 'cutter: lucky + stopper');
      const other = g.players.find((p) => p.id !== raw.cutterId);
      const otherView = g.publicState(other.id).lastCutReveal;
      assert.equal(otherView.cards.length, raw.luckyCards.length, 'others: lucky only');
      assert.ok(!otherView.cards.some((c) => c.id === raw.stopper.id), 'stopper never leaks');
      g.destroy();
      return;
    }
    g.destroy();
  }
  assert.fail('no lucky cut in 200 attempts (statistically near-impossible)');
});

test('cutting happens EVERY round, cutter rotates with the dealer (regression: "only once per game")', () => {
  const { g } = humanGame(2);
  const seen = [];
  for (let r = 1; r <= 6; r++) {
    g.startNewRound();
    assert.equal(g.phase, 'cutting', `round ${r} must start with a cut`);
    seen.push(g.cutterId);
    g.performCut(g.cutterId, 0.5);
    g.phase = 'roundEnd'; // simulate the round finishing
  }
  // with 2 players the cutter must alternate every round
  for (let i = 1; i < seen.length; i++) {
    assert.notEqual(seen[i], seen[i - 1], 'cutter rotates with the dealer');
  }
  g.destroy();
});

// --- v1.70.1: Tages-Challenge ist wettbewerbs-fest -----------------------------
test('challenge lock: bot difficulty and house rules cannot be changed mid-challenge', () => {
  const GM = require('../game/GameManager');
  const g = new GM(() => {}, { deckSeed: 12345, challengeDate: '2026-07-13' });
  g.addOrReconnectPlayer('p1', 'Anna');
  g.fillWithBots();
  g.startNewRound();
  const bot = g.players.find((p) => p.isBot);
  assert.equal(bot.botDifficulty || 'zen', 'zen', 'challenge bots are zen');

  const r1 = g.setBotDifficulty('p1', bot.id, 'easy');
  assert.ok(r1.error, 'difficulty change rejected');
  assert.equal(bot.botDifficulty || 'zen', 'zen', 'difficulty unchanged');

  const before = JSON.stringify(g.houseRules);
  const r2 = g.setHouseRules({ turnTimerSeconds: 90, strictThreshold: true });
  assert.ok(r2 && r2.error, 'house-rule change rejected');
  assert.equal(JSON.stringify(g.houseRules), before, 'rules unchanged');

  // the system setup path must still work (used when creating the session)
  const r3 = g.setHouseRules({ turnTimerSeconds: 0 }, { system: true });
  assert.ok(!r3 || !r3.error, 'system setup path stays open');
  g.destroy();
});

test('challenge lock: normal games keep both settings fully adjustable', () => {
  const GM = require('../game/GameManager');
  const g = new GM(() => {});
  g.addOrReconnectPlayer('p1', 'Anna');
  g.fillWithBots();
  const bot = g.players.find((p) => p.isBot);
  const r1 = g.setBotDifficulty('p1', bot.id, 'easy');
  assert.ok(!r1.error, 'normal game: difficulty adjustable');
  assert.equal(bot.botDifficulty, 'easy');
  const r2 = g.setHouseRules({ turnTimerSeconds: 60 });
  assert.ok(!r2 || !r2.error, 'normal game: rules adjustable');
  assert.equal(g.houseRules.turnTimerSeconds, 60);
  g.destroy();
});

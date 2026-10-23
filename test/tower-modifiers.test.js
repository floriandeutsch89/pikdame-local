/** Kartenhaus floors 11-20: the rules against the human seat (game/BotTower.js
 *  MODS) as the engine enforces them - queen dealt into the hand, no discard
 *  pickup, stars only when going out - with card conservation on every floor. */
const test = require('node:test');
const assert = require('node:assert');
const BotTower = require('../game/BotTower');
const GameManager = require('../game/GameManager');
const { createDeck } = require('../game/Deck');
const { isPikDame } = require('../game/Card');

const REFERENCE = (() => {
  const counts = new Map();
  for (const card of createDeck()) counts.set(card.id, (counts.get(card.id) || 0) + 1);
  return counts;
})();
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

function floor(stage, month = '2026-11') {
  const cfg = BotTower.stageConfig(stage, month);
  const g = new GameManager(() => {}, { deckSeed: cfg.seed, towerStage: stage, towerMonth: month });
  g.addOrReconnectPlayer('me', 'Ada');
  g.syncLobbyBots();
  assert.deepStrictEqual(g.startTowerRound(), { ok: true });
  return g;
}
const stageWith = (mods) => BotTower.TOWER_STAGES.find((s) => s.mods && mods.every((m) => s.mods.includes(m)) && s.mods.length === mods.length).stage;

test('queen: the human starts with a Queen of Spades, the deck stays complete', () => {
  for (const month of ['2026-10', '2026-11', '2027-03']) {
    const g = floor(stageWith(['queen']), month);
    const me = g.players.find((p) => p.id === 'me');
    assert.ok(me.hand.some((c) => isPikDame(c)), `${month}: a Queen of Spades in hand`);
    assert.strictEqual(me.hand.length, 15);
    assert.ok(conserved(g), `${month}: card conservation`);
    assert.ok(g.log.some((e) => e.text === 'Risiko: Du startest mit der Pik Dame auf der Hand – ausgelegt +100, auf der Hand −100.'));
    g.destroy();
  }
  const ids = [1, 2].map(() => { const g = floor(stageWith(['queen'])); const h = g.players[0].hand.map((c) => c.id).join(); g.destroy(); return h; });
  assert.strictEqual(ids[0], ids[1], 'every try deals the same');
});

test('noDiscard: the human never takes the discard pile, the bots still may', () => {
  const g = floor(stageWith(['noDiscard']));
  const me = g.players.find((p) => p.id === 'me');
  assert.match(g.drawFromDiscard('me').error, /Auf dieser Etage darfst du die Ablage nicht aufnehmen/);
  assert.strictEqual(g.canTakeDiscardTop(me, g.discardPile[0]), false);
  const bot = g.players.find((p) => p.isBot);
  assert.strictEqual(g._discardBlockedFor(bot), false, 'bots play by the normal rules');
  assert.ok(g.log.some((e) => e.text === 'Erschwernis: Du darfst die Ablage nicht aufnehmen.'));
  // A heuristic turn for the human seat falls back to the stock instead of hanging.
  g.runBotTurn('me', { forced: true });
  assert.notStrictEqual(g.currentPlayer().id, 'me', 'the turn passed on');
  // Stock empty and the top not takeable for the human: the round ends (family rule).
  g.destroy();
  const h = floor(stageWith(['noDiscard']));
  h.drawPile.length = 0;
  assert.deepStrictEqual(h.drawFromPile('me'), { ok: true, roundEnded: true });
  h.destroy();
});

test('goOut: ahead without going out is no star and no win', () => {
  const { starsFor, stageWinner } = BotTower;
  assert.strictEqual(starsFor({ myScore: 400, botScores: [100], wentOut: false, handicap: 100, goOut: true }), 0);
  assert.strictEqual(starsFor({ myScore: 400, botScores: [100], wentOut: true, handicap: 100, goOut: true }), 3);
  assert.strictEqual(stageWinner({ me: 400, a: 100 }, 'a', 'me', 100, true), 'a');
  assert.strictEqual(stageWinner({ me: 400, a: 100 }, 'me', 'me', 100, true), 'me');
});

test('E2E: every floor 11-20 plays to its end, cards conserved after every turn', () => {
  for (const s of BotTower.TOWER_STAGES.filter((x) => x.stage > 10)) {
    let record = null;
    const cfg = BotTower.stageConfig(s.stage, '2026-10');
    const g = new GameManager(() => {}, { deckSeed: cfg.seed, towerStage: s.stage, towerMonth: '2026-10', onGameOver: (r, rec) => { record = rec; } });
    g.addOrReconnectPlayer('me', 'Ada');
    g.syncLobbyBots();
    g.startTowerRound();
    let turns = 0;
    while (g.phase === 'playing' && turns++ < 3000) {
      const cp = g.currentPlayer();
      g.runBotTurn(cp.id, { forced: !cp.isBot });
      assert.ok(conserved(g), `floor ${s.stage}: conservation after turn ${turns}`);
    }
    assert.strictEqual(g.phase, 'gameOver', `floor ${s.stage}: over after one round`);
    const out = BotTower.outcomeFromRecord(record, 'me');
    assert.deepStrictEqual(out.mods, s.mods);
    assert.strictEqual(g.gameOverInfo.winnerId === 'me', out.stars >= 1, `floor ${s.stage}: winner and stars agree`);
    g.destroy();
  }
});

test('publicState: the floor card gets head start, two-star margin and handicaps - never the seed', () => {
  const keysDeep = (obj, out = []) => {
    if (obj && typeof obj === 'object') for (const [k, v] of Object.entries(obj)) { out.push(k); keysDeep(v, out); }
    return out;
  };
  for (const s of BotTower.TOWER_STAGES) {
    const month = '2026-11';
    const cfg = BotTower.stageConfig(s.stage, month);
    const g = new GameManager(() => {}, { deckSeed: cfg.seed, towerStage: s.stage, towerMonth: month });
    g.addOrReconnectPlayer('me', 'Ada');
    g.syncLobbyBots();
    g.startTowerRound();
    const st = g.publicState('me');
    assert.strictEqual(st.towerStage, s.stage);
    assert.strictEqual(st.towerMonth, month);
    assert.strictEqual(st.towerHandicap, cfg.handicap, `floor ${s.stage}: head start`);
    assert.strictEqual(st.towerClearMargin, BotTower.CLEAR_MARGIN);
    assert.deepStrictEqual(st.towerMods, cfg.mods || null);
    assert.ok(!keysDeep(st).some((k) => /seed/i.test(k)), `floor ${s.stage}: no seed in the client state`);
    g.destroy();
  }
  const plain = new GameManager(() => {});
  plain.addOrReconnectPlayer('me', 'Ada');
  const st = plain.publicState('me');
  assert.strictEqual(st.towerHandicap, null);
  assert.strictEqual(st.towerClearMargin, null);
  plain.destroy();
});

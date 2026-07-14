const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const SE = require('../game/StateEncoder');
const { makeStandardCard: mk } = require('../game/Card');

// Isolate the log file per run and enable logging BEFORE requiring the modules
// that read the env at call time (record/flush read process.env each call).
const tmp = path.join(os.tmpdir(), `pikdame-moves-${process.pid}.jsonl`);
process.env.PIKDAME_LOG_GAMES = '1';
process.env.PIKDAME_LOG_PATH = tmp;

const GameManager = require('../game/GameManager');
const MoveLogger = require('../game/MoveLogger');

// v1.67 interactive cutting: unit tests exercise the game AFTER the deal, so
// every locally constructed game auto-cuts. Dedicated cutting tests live in
// test/cutting.test.js and do NOT use this hook.
function __autoCutHook(g) {
  const orig = g.startNewRound.bind(g);
  g.startNewRound = (...a) => {
    orig(...a);
    if (g.phase === 'cutting') g.performCut(g.cutterId, 0.5);
  };
  return g;
}


function freshLog() {
  try { fs.unlinkSync(tmp); } catch (e) { /* ignore */ }
}

test('records only human decisions and flushes with a won flag', () => {
  freshLog();
  const g = __autoCutHook(new GameManager(() => {}));
  g.addOrReconnectPlayer('human', 'Mensch'); // NOT a bot
  g.fillWithBots();
  const bot = g.players.find((p) => p.isBot);

  // A bot decision must NOT be recorded...
  MoveLogger.record(g, bot.id, 'discard', 5);
  assert.ok(!g._moveLog || g._moveLog.length === 0, 'bot moves are ignored');

  // ...a human decision must be.
  const human = g.players.find((p) => p.id === 'human');
  human.hand = [mk('H', '7', 0), mk('S', '9', 0)];
  MoveLogger.record(g, 'human', 'discard', SE.typeIndex(mk('H', '7', 0)), mk('H', '7', 0));
  MoveLogger.record(g, 'human', 'draw', SE.ACTION_DRAW_PILE);
  assert.equal(g._moveLog.length, 2);
  assert.equal(g._moveLog[0].obs.length, SE.OBS_SIZE);
  assert.equal(g._moveLog[0].mask.length, SE.ACTION_SIZE);

  // Flush tags rows with won based on the top total.
  g.totals = { human: 1000, [bot.id]: 200 };
  MoveLogger.flush(g);
  assert.ok(!g._moveLog || g._moveLog.length === 0, 'buffer cleared after flush');

  const lines = fs.readFileSync(tmp, 'utf8').trim().split('\n');
  assert.equal(lines.length, 2);
  const row = JSON.parse(lines[0]);
  assert.equal(row.won, true, 'human had the top total');
  assert.equal(row.obs.length, SE.OBS_SIZE);
  assert.ok(row.phase === 'discard' || row.phase === 'draw');
  assert.equal('playerId' in row, false, 'no identity leaked to disk');
  // deserialized action + raw state
  assert.equal(row.move.type, 'discard');
  assert.equal(row.move.card, '7H', 'the actual discarded card is recorded');
  assert.ok(Array.isArray(row.state.hand) && row.state.hand.includes('7H'), 'own hand is in state');
  assert.ok('discardTop' in row.state && 'drawCount' in row.state && Array.isArray(row.state.opponents));
  // outcome enrichment
  assert.equal(row.rank, 1, 'winner is rank 1');
  assert.equal(row.finalTotal, 1000);
  assert.equal(row.winnerTotal, 1000);
  assert.ok('players' in row && 'rounds' in row && 'turns' in row && 'seat' in row);
  // draw row: deserialized draw source
  const drawRow = JSON.parse(lines[1]);
  assert.equal(drawRow.move.type, 'drawPile');
  // minified: mask is 0/1 ints, obs rounded to <= 4 decimals
  assert.ok(row.mask.every((v) => v === 0 || v === 1), 'mask is 0/1');
  assert.ok(row.obs.every((v) => Math.abs(v * 1e4 - Math.round(v * 1e4)) < 1e-6), 'obs rounded to 4dp');
  freshLog();
});

test('serialize does not persist the transient move buffer', () => {
  const g = __autoCutHook(new GameManager(() => {}));
  g.addOrReconnectPlayer('human', 'M');
  g.fillWithBots();
  g._moveLog = [{ phase: 'draw', obs: [], action: 52, mask: [] }];
  const snap = g.serialize();
  assert.equal('_moveLog' in snap, false);
});

// --- v1.75: Trainingsdaten-Qualität ---------------------------------------------
test('flush tags every row with outcome and rules version; forfeit is marked', () => {
  const os = require('node:os');
  const tmp = path.join(os.tmpdir(), `ml-test-${Date.now()}.jsonl`);
  process.env.PIKDAME_LOG_PATH_IGNORED = ''; // LOG_PATH ist beim Laden fixiert - wir testen über den Buffer+flush-Weg mit eigenem Pfad nicht; stattdessen: Buffer inspizieren via flush in Datei? LOG_PATH konstant -> wir prüfen die geschriebenen Zeilen über die echte Datei mit Backup.
  const ML = require('../game/MoveLogger');
  const GM = require('../game/GameManager');
  const fs = require('node:fs');
  const before = fs.existsSync(ML.LOG_PATH) ? fs.readFileSync(ML.LOG_PATH, 'utf8') : null;
  try {
    const g = new GM(() => {});
    g.addOrReconnectPlayer('p1', 'Anna');
    g.addOrReconnectPlayer('p2', 'Ben');
    g.startNewRound();
    if (g.phase === 'cutting') g.performCut(g.cutterId, 0.5);
    // einen echten menschlichen Zug aufzeichnen
    const me = g.currentPlayer();
    g.turnPhase = 'draw';
    g.drawFromPile(me.id);
    assert.ok(g._moveLog && g._moveLog.length >= 1, 'move buffered');
    g.totals = { p1: 100, p2: 50 };
    ML.flush(g, 'forfeit');
    const lines = fs.readFileSync(ML.LOG_PATH, 'utf8').trim().split('\n');
    const row = JSON.parse(lines[lines.length - 1]);
    assert.equal(row.outcome, 'forfeit');
    assert.equal(row.rv, ML.RULES_VERSION);
    assert.ok(row.rv >= 2);
    g.destroy();
  } finally {
    const fs2 = require('node:fs');
    if (before === null) { try { fs2.unlinkSync(ML.LOG_PATH); } catch (e) {} }
    else fs2.writeFileSync(ML.LOG_PATH, before);
  }
});

test('undoPileTake removes the buffered TAKE_PILE row - an undone take never happened', () => {
  const GM = require('../game/GameManager');
  const { makeStandardCard } = require('../game/Card');
  const g = new GM(() => {});
  g.addOrReconnectPlayer('p1', 'Anna');
  g.addOrReconnectPlayer('p2', 'Ben');
  g.startNewRound();
  if (g.phase === 'cutting') g.performCut(g.cutterId, 0.5);
  const me = g.currentPlayer();
  g.turnPhase = 'draw';
  const c1 = makeStandardCard('H', '9', 900);
  const c2 = makeStandardCard('S', '9', 901);
  const top = makeStandardCard('D', '9', 902);
  me.hand.push(c1, c2);
  g.discardPile.unshift(top);
  const lenBefore = (g._moveLog || []).length;
  g.drawFromDiscard(me.id);
  assert.equal(g._moveLog.length, lenBefore + 1, 'take recorded');
  g.undoPileTake(me.id);
  assert.equal(g._moveLog.length, lenBefore, 'take unrecorded after undo');
  g.destroy();
});

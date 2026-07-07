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

function freshLog() {
  try { fs.unlinkSync(tmp); } catch (e) { /* ignore */ }
}

test('records only human decisions and flushes with a won flag', () => {
  freshLog();
  const g = new GameManager(() => {});
  g.addOrReconnectPlayer('human', 'Mensch'); // NOT a bot
  g.fillWithBots();
  const bot = g.players.find((p) => p.isBot);

  // A bot decision must NOT be recorded...
  MoveLogger.record(g, bot.id, 'discard', 5);
  assert.ok(!g._moveLog || g._moveLog.length === 0, 'bot moves are ignored');

  // ...a human decision must be.
  const human = g.players.find((p) => p.id === 'human');
  human.hand = [mk('H', '7', 0), mk('S', '9', 0)];
  MoveLogger.record(g, 'human', 'discard', SE.typeIndex(mk('H', '7', 0)));
  MoveLogger.record(g, 'human', 'draw', SE.ACTION_TAKE_PILE);
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
  freshLog();
});

test('serialize does not persist the transient move buffer', () => {
  const g = new GameManager(() => {});
  g.addOrReconnectPlayer('human', 'M');
  g.fillWithBots();
  g._moveLog = [{ phase: 'draw', obs: [], action: 52, mask: [] }];
  const snap = g.serialize();
  assert.equal('_moveLog' in snap, false);
});

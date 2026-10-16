// Bot lines: the server sends a moment id (game/BotQuips.js), the client
// holds the bilingual lines; rare by design (chance + table-wide throttle).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');
const GameManager = require('../game/GameManager');
const { QUIP_MOMENTS } = require('../game/BotQuips');

function table(quips) {
  const g = new GameManager(() => {}, { onBotQuip: (botId, moment) => quips.push({ botId, moment }) });
  g.addOrReconnectPlayer('me', 'Flo');
  g.fillWithBots();
  g._emoteDelayForTest = 0;
  return g;
}
const tick = () => new Promise((r) => setTimeout(r, 5));

test('every quip moment has German and English lines in the client', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'client.js'), 'utf8');
  const block = src.match(/\n  const BOT_QUIPS = \{[\s\S]*?\n  \};\n/);
  assert.ok(block, 'BOT_QUIPS is defined in client.js');
  for (const lang of ['de', 'en']) {
    const ctx = { L: (de, en) => (lang === 'de' ? de : en) };
    vm.runInNewContext(`${block[0]}\nthis.quips = BOT_QUIPS;`, ctx);
    assert.deepEqual(Object.keys(ctx.quips).sort(), [...QUIP_MOMENTS].sort(), 'client and server know the same moments');
    for (const m of QUIP_MOMENTS) {
      const lines = ctx.quips[m]();
      assert.ok(lines.length >= 2 && lines.every((t) => typeof t === 'string' && t.length > 3), `${m}: ${lang} lines`);
    }
  }
});

test('a quip reaches the table, at most one per table within the gap, never from a human', async () => {
  const quips = [];
  const g = table(quips);
  const bots = g.players.filter((p) => p.isBot);
  g.maybeBotQuip('me', 'round_win', 1);
  g.maybeBotQuip(bots[0].id, 'no_such_moment', 1);
  g.maybeBotQuip(bots[0].id, 'round_win', 1);
  g.maybeBotQuip(bots[1].id, 'big_pile', 1); // inside the table-wide gap
  await tick();
  assert.deepEqual(quips, [{ botId: bots[0].id, moment: 'round_win' }]);
  g._lastQuipAt = Date.now() - GameManager.QUIP_GAP_MS - 1;
  g.maybeBotQuip(bots[1].id, 'big_pile', 1);
  await tick();
  assert.equal(quips.length, 2, 'after the gap the next line may come');
  g.destroy();
});

test('round end picks one line: match win, else round win ("Hand aus" first), else a caught queen', async () => {
  const realRandom = Math.random;
  Math.random = () => 0; // every chance hits
  try {
    const run = (setup) => {
      const quips = [];
      const g = table(quips);
      const bot = g.players.find((p) => p.isBot);
      setup(g, bot);
      return { g, quips, bot };
    };
    const cases = [
      [(g, bot) => g._roundEndQuip(null, {}, { gameOver: true, winnerId: bot.id }), 'game_win'],
      [(g, bot) => { g.lastRoundWasHandAus = true; g._roundEndQuip(bot.id, {}, {}); }, 'hand_aus'],
      [(g, bot) => { g.lastRoundWasHandAus = false; g._roundEndQuip(bot.id, {}, {}); }, 'round_win'],
      [(g, bot) => g._roundEndQuip('me', { [bot.id]: { breakdown: { pikDameCount: 1 } } }, {}), 'queen_caught'],
    ];
    for (const [setup, moment] of cases) {
      const { g, quips } = run(setup);
      await tick();
      assert.deepEqual(quips.map((q) => q.moment), [moment]);
      g.destroy();
    }
    const { g, quips } = run((game) => game._roundEndQuip('me', {}, {}));
    await tick();
    assert.deepEqual(quips, [], 'a human round win with nobody caught stays quiet');
    g.destroy();
  } finally {
    Math.random = realRandom;
  }
});

test('the throttle and the hook stay out of the snapshot', () => {
  const g = table([]);
  g._lastQuipAt = Date.now();
  const snap = JSON.parse(JSON.stringify(g.serialize()));
  assert.ok(!('_lastQuipAt' in snap) && !('onBotQuip' in snap));
  const quips = [];
  const copy = new GameManager(() => {}, { onBotQuip: (b, m) => quips.push(m) });
  copy.deserialize(snap);
  assert.equal(copy._lastQuipAt, 0, 'a restart starts a fresh throttle');
  assert.equal(typeof copy.onBotQuip, 'function', 'the hook comes from the new session, not the snapshot');
  for (const x of [g, copy]) x.destroy();
});

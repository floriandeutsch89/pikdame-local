// OnnxPolicy picks the StateEncoder version from the model's input size: a v1
// model (377) keeps team tables heuristic, a v2 model (385) plays them too.
// No onnxruntime in the repo: a fake runtime stands in at the module's seam.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const MODELS = fs.mkdtempSync(path.join(os.tmpdir(), 'pikdame-models-'));
fs.writeFileSync(path.join(MODELS, 'pikdame-zen.onnx'), 'fake'); // only existence is checked
process.env.PIKDAME_MODELS_DIR = MODELS;
process.env.PIKDAME_ONNX = '1';
process.on('exit', () => fs.rmSync(MODELS, { recursive: true, force: true }));

const OnnxPolicy = require('../game/OnnxPolicy');
const GameManager = require('../game/GameManager');
const SE = require('../game/StateEncoder');
const { createDeck } = require('../game/Deck');

/** A fake InferenceSession for a model with `size` inputs; records every run. */
function fakeModel(size, { metadata = true, fail = false, logits } = {}) {
  const runs = [];
  return {
    runs,
    inputNames: ['obs'],
    outputNames: ['logits'],
    inputMetadata: metadata ? [{ name: 'obs', isTensor: true, type: 'float32', shape: ['batch', size] }] : undefined,
    async run(feeds) {
      const t = feeds.obs;
      if (t.dims[1] !== size) throw new Error(`Got invalid dimensions for input: obs Got: ${t.dims[1]} Expected: ${size}`);
      if (fail) throw new Error('inference failed');
      runs.push(t);
      return { logits: { data: logits ? logits(t) : new Float32Array(SE.ACTION_SIZE) } };
    },
  };
}

let model = null;
const fakeOrt = {
  Tensor: class { constructor(type, data, dims) { Object.assign(this, { type, data, dims }); } },
  InferenceSession: { create: async () => model },
};

function useModel(m, t) {
  OnnxPolicy._test.reset();
  OnnxPolicy._test.setRuntime(fakeOrt);
  model = m;
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'error', () => {});
  return m;
}

function bots(g, levels) {
  g.maybeRunBotTurn = () => {};
  g.players = levels.map((d, i) => ({ id: `b${i}`, name: `B${i}`, isBot: true, hand: [], connected: true, laidOutCards: [], botDifficulty: d }));
  for (const p of g.players) g.totals[p.id] = 0;
  g.maxSeats = levels.length;
  g.startNewRound();
  return g;
}
const normalGame = () => bots(new GameManager(() => {}), ['zen', 'hard', 'medium']);
const teamGame = (level = 'zen') => bots(new GameManager(() => {}, { teamMode: true }), [level, level, level, level]);
const zenSeat = { id: 'x', isBot: true, botDifficulty: 'zen' };

test('a v1 model reads v1 observations and leaves team tables to the heuristic', async (t) => {
  const m = useModel(fakeModel(SE.OBS_SIZE_V1), t);
  const g = normalGame();
  const id = g.currentPlayer().id;
  await OnnxPolicy.chooseDiscardCard(g, id, 'zen');
  assert.equal(m.runs.length, 1);
  assert.deepEqual(m.runs[0].dims, [1, 377]);
  assert.deepEqual(Array.from(m.runs[0].data), Array.from(SE.encode(g, id, { phase: 'discard' })));
  assert.equal(OnnxPolicy.supportsTeams('zen'), false);
  assert.equal(g._botTurnUsesOnnx(zenSeat), true, 'normal table: Zen plays the net');

  const team = teamGame();
  assert.equal(team._botTurnUsesOnnx(zenSeat), false, 'team table: Zen keeps its heuristic');
  assert.equal(await OnnxPolicy.chooseDiscardCard(team, team.currentPlayer().id, 'zen'), null, 'never a v1 net at a team table');
  assert.equal(await OnnxPolicy.chooseDrawSource(team, team.currentPlayer().id, 'zen'), null);
  assert.equal(m.runs.length, 1, 'no inference for the team table');
  g.destroy();
  team.destroy();
});

test('a v2 model reads v2 observations everywhere and plays team tables', async (t) => {
  const m = useModel(fakeModel(SE.OBS_SIZE_V2), t);
  await OnnxPolicy.warmup(['zen']);
  assert.equal(OnnxPolicy.supportsTeams('zen'), true);
  const g = normalGame();
  const id = g.currentPlayer().id;
  await OnnxPolicy.chooseDiscardCard(g, id, 'zen');
  const normalObs = Array.from(m.runs[0].data);
  assert.deepEqual(m.runs[0].dims, [1, 385]);
  assert.deepEqual(normalObs, Array.from(SE.encode(g, id, { phase: 'discard', version: 2 })));
  assert.deepEqual(normalObs.slice(377), new Array(8).fill(0), 'normal game: the team block stays 0');

  const team = teamGame();
  const tid = team.currentPlayer().id;
  assert.equal(team._botTurnUsesOnnx(zenSeat), true);
  await OnnxPolicy.chooseDrawSource(team, tid, 'zen');
  assert.deepEqual(m.runs[1].dims, [1, 385]);
  assert.deepEqual(Array.from(m.runs[1].data), Array.from(SE.encode(team, tid, { phase: 'draw', version: 2 })));
  assert.equal(m.runs[1].data[377], 1, 'team mode flag');
  g.destroy();
  team.destroy();
});

test('team table: a human\'s stand-in plays the table level, so the net only at a Zen table', async (t) => {
  useModel(fakeModel(SE.OBS_SIZE_V2), t);
  await OnnxPolicy.warmup(['zen']);
  const human = { id: 'h', isBot: false, connected: false };
  const easy = teamGame('easy');
  assert.equal(easy._botTurnUsesOnnx(human), false, 'stand-in at an easy team table');
  const zen = teamGame('zen');
  assert.equal(zen._botTurnUsesOnnx(human), true, 'stand-in at a Zen team table');
  const normal = normalGame();
  assert.equal(normal._botTurnUsesOnnx(human), true, 'normal table: the stand-in plays Zen as before');
  for (const g of [easy, zen, normal]) g.destroy();
});

test('without input metadata (older runtimes) the version is probed', async (t) => {
  useModel(fakeModel(SE.OBS_SIZE_V2, { metadata: false }), t);
  await OnnxPolicy.warmup(['zen']);
  assert.equal(OnnxPolicy.supportsTeams('zen'), true);
  const m = useModel(fakeModel(SE.OBS_SIZE_V1, { metadata: false }), t);
  await OnnxPolicy.warmup(['zen']);
  assert.equal(OnnxPolicy.supportsTeams('zen'), false);
  const g = normalGame();
  m.runs.length = 0; // drop the probe
  await OnnxPolicy.chooseDiscardCard(g, g.currentPlayer().id, 'zen');
  assert.deepEqual(m.runs[0].dims, [1, 377]);
  g.destroy();
});

test('supportsTeams starts the load itself and turns true once the v2 model is there', async (t) => {
  useModel(fakeModel(SE.OBS_SIZE_V2), t);
  assert.equal(OnnxPolicy.supportsTeams('zen'), false, 'not loaded yet: heuristic');
  await OnnxPolicy.warmup(['zen']); // joins the load the first call started
  assert.equal(OnnxPolicy.supportsTeams('zen'), true);
});

test('an unknown input size or a failing model falls back to the heuristic', async (t) => {
  useModel(fakeModel(400), t);
  await OnnxPolicy.warmup(['zen']);
  assert.equal(OnnxPolicy.supportsTeams('zen'), false);
  assert.match(console.error.mock.calls.map((c) => c.arguments.join(' ')).join('\n'), /passt zu keiner Kodierung \(Eingabe 400/);
  const g = normalGame();
  assert.equal(await OnnxPolicy.chooseDiscardCard(g, g.currentPlayer().id, 'zen'), null);
  useModel(fakeModel(SE.OBS_SIZE_V2, { fail: true }), t);
  assert.equal(await OnnxPolicy.chooseDiscardCard(g, g.currentPlayer().id, 'zen'), null, 'inference error');
  g.destroy();
});

const REFERENCE = (() => {
  const counts = new Map();
  for (const c of createDeck()) counts.set(c.id, (counts.get(c.id) || 0) + 1);
  return counts;
})();
function deckErrors(g) {
  const found = new Map();
  const add = (c) => { if (c && c.id) found.set(c.id, (found.get(c.id) || 0) + 1); };
  for (const p of g.players) (p.hand || []).forEach(add);
  for (const m of g.tableMelds || []) for (const s of m.slots || []) { add(s.real); add(s.joker); }
  [...(g.drawPile || []), ...(g.discardPile || []), ...(g.retiredJokers || []), ...(g._pendingDeck || [])].forEach(add);
  const errors = [];
  for (const [id, n] of REFERENCE) if ((found.get(id) || 0) !== n) errors.push(`${id}: ${found.get(id) || 0}x`);
  return errors;
}

test('E2E: a team match of four v2-net Zen bots ends, keeps all 110 cards and never throws a joker', async (t) => {
  let seed = 7;
  const rnd = () => { seed = (seed * 1103515245 + 12345) >>> 0; return seed / 2 ** 32; };
  const m = useModel(fakeModel(SE.OBS_SIZE_V2, { logits: () => Float32Array.from({ length: SE.ACTION_SIZE }, rnd) }), t);
  await OnnxPolicy.warmup(['zen']);
  const g = teamGame('zen');
  const jokerDiscards = [];
  const origDiscard = g.discard.bind(g);
  g.discard = (pid, cardId) => {
    const p = g.players.find((x) => x.id === pid);
    const c = p && p.hand.find((x) => x.id === cardId);
    if (c && c.isJoker && p.hand.length > 1) jokerDiscards.push(cardId);
    return origDiscard(pid, cardId);
  };
  let steps = 0;
  while (g.phase !== 'gameOver' && steps++ < 20000) {
    if (g.phase === 'roundEnd') { g.startNewRound(); continue; }
    const cp = g.currentPlayer();
    const before = g.turnIndexInRound;
    assert.equal(g._botTurnUsesOnnx(cp), true);
    await g._runBotTurnWithOnnx(cp.id);
    if (g.phase === 'playing' && g.turnIndexInRound === before && g.currentPlayer().id === cp.id) g.finishRound(null);
    assert.deepEqual(deckErrors(g), [], `card conservation after step ${steps}`);
  }
  assert.equal(g.phase, 'gameOver', 'no deadlock');
  assert.equal(g.gameOverInfo.teamMode, true);
  assert.deepEqual(jokerDiscards, []);
  assert.ok(m.runs.length > 100 && m.runs.every((r) => r.dims[1] === 385), 'the net decided, on v2 observations');
  g.destroy();
});

// The training bridge (scripts/rl-env-server.js) over its real wire protocol:
// observation versions, normal and "2 gegen 2" episodes, self-play seats,
// the reward and the size contract with python/ and every trained model.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { spawn, spawnSync } = require('child_process');
const SE = require('../game/StateEncoder');

const ROOT = path.join(__dirname, '..');
const SERVER = path.join(ROOT, 'scripts', 'rl-env-server.js');

function bridge(t) {
  const proc = spawn(process.execPath, [SERVER], { stdio: ['pipe', 'pipe', 'pipe'] });
  const lines = readline.createInterface({ input: proc.stdout });
  const waiting = [];
  lines.on('line', (l) => waiting.shift()(JSON.parse(l)));
  t.after(() => proc.kill());
  return (msg) => new Promise((resolve) => {
    waiting.push(resolve);
    proc.stdin.write(JSON.stringify(msg) + '\n');
  });
}

/** Deterministic legal actions (bots other than easy play deterministically on a seeded deck). */
function picker(seed) {
  let s = seed >>> 0;
  return (mask) => {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0;
    const legal = mask.map((m, i) => (m ? i : -1)).filter((i) => i >= 0);
    return legal[s % legal.length];
  };
}

/** Plays one episode; every decision is answered by `pick`. */
async function episode(rpc, reset, pick, onDecision = () => {}) {
  let r = await rpc({ cmd: 'reset', ...reset });
  let reward = 0;
  for (let n = 0; !r.done; n++) {
    assert.ok(n < 5000, 'the episode ends (no deadlock)');
    onDecision(r);
    assert.equal(r.mask.length, SE.ACTION_SIZE);
    assert.ok(r.mask.some(Boolean), 'a decision always has a legal action');
    r = await rpc({ cmd: 'step', action: pick(r.mask) });
    reward += r.reward;
  }
  return { final: r, reward };
}

test('bridge: meta reports v1 by default, v2 on request, and refuses unknown versions', async (t) => {
  const rpc = bridge(t);
  assert.deepEqual(await rpc({ cmd: 'meta' }), { obs_size: 377, action_size: 54, obs_version: 1 });
  assert.deepEqual(await rpc({ cmd: 'meta', obsVersion: 2 }), { obs_size: 385, action_size: 54, obs_version: 2 });
  assert.match((await rpc({ cmd: 'meta', obsVersion: 3 })).error, /unknown observation version 3/);
});

test('bridge: a v1 normal episode runs to the end; the reward sums to the final margin plus the result', async (t) => {
  const rpc = bridge(t);
  await rpc({ cmd: 'meta' });
  const { final, reward } = await episode(rpc, { opponentDifficulties: ['hard'], seed: 5 }, picker(5), (r) => {
    assert.equal(r.obs.length, 377);
    assert.equal(r.seat, 0, 'only the agent decides without self-play seats');
  });
  assert.equal(typeof final.won, 'boolean');
  // Every round counts, the final one included: the sum is the match margin plus the result.
  const margin = (final.totals.agent - final.totals.opp1) / 100; // one opponent: its score is the mean
  assert.ok(Math.abs(reward - margin - (final.won ? 1 : -1)) < 1e-9, `rewards ${reward} = margin ${margin} +/- 1`);
});

test('bridge: a v2 team episode reads the team block, rewards the team and ends at 2000', async (t) => {
  const rpc = bridge(t);
  await rpc({ cmd: 'meta', obsVersion: 2 });
  const { final, reward } = await episode(
    rpc, { opponentDifficulties: ['hard', 'zen', 'medium'], teamMode: true, seed: 11 }, picker(11),
    (r) => {
      assert.equal(r.obs.length, 385);
      assert.equal(r.obs[377], 1, 'team mode flag');
      assert.deepEqual(r.obs.slice(378, 381), [0, 1, 0], 'the partner is the second opponent slot (seat 2)');
    }
  );
  assert.equal(final.teamMode, true);
  const [mine, other] = final.teamTotals;
  assert.ok(Math.max(mine, other) >= 2000);
  assert.equal(final.won, mine > other);
  assert.equal(mine, final.totals.agent + final.totals.opp2, 'agent and seat 2 are one team');
  assert.ok(Math.abs(reward - (mine - other) / 200 - (final.won ? 1 : -1)) < 1e-9, `team rewards ${reward}`);
});

test('bridge: "self" seats are answered by the caller, from their own point of view', async (t) => {
  const rpc = bridge(t);
  await rpc({ cmd: 'meta', obsVersion: 2 });
  const seats = new Set();
  const pick = picker(3);
  // Opponent slots list the other seats in seat order: seat 1 sees its partner (3) last, seat 3 its partner (1) second.
  const partnerSlot = { 0: [0, 1, 0], 1: [0, 0, 1], 3: [0, 1, 0] };
  const { final } = await episode(rpc, { opponentDifficulties: ['self', 'hard', 'self'], teamMode: true, seed: 3 }, pick, (r) => {
    seats.add(r.seat);
    assert.equal(r.obs[377], 1);
    assert.deepEqual(r.obs.slice(378, 381), partnerSlot[r.seat], `seat ${r.seat}`);
  });
  assert.deepEqual([...seats].sort(), [0, 1, 3], 'agent and both self-play seats decide, the hard bot never asks');
  assert.equal(final.done, true);
});

test('bridge: normal tables of 2 to 4 seats keep the v2 team block at zero', async (t) => {
  const rpc = bridge(t);
  await rpc({ cmd: 'meta', obsVersion: 2 });
  for (const opp of [['zen'], ['zen', 'medium'], ['zen', 'medium', 'hard']]) {
    const r = await rpc({ cmd: 'reset', opponentDifficulties: opp, seed: 1 });
    assert.equal(r.obs.length, 385);
    assert.deepEqual(r.obs.slice(377), new Array(8).fill(0), `${opp.length + 1} players`);
  }
});

test('bridge: a StateEncoder that breaks the size contract stops the server before training starts', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pikdame-contract-'));
  const preload = path.join(dir, 'break.js');
  fs.writeFileSync(preload, `const SE = require(${JSON.stringify(path.join(ROOT, 'game', 'StateEncoder'))});
const size = SE.obsSize; SE.obsSize = (v) => (v === 2 ? 390 : size(v));\n`);
  try {
    const res = spawnSync(process.execPath, ['--require', preload, SERVER], { input: '{"cmd":"meta"}\n', encoding: 'utf8' });
    assert.equal(res.status, 1);
    assert.equal(res.stdout, '', 'nothing on the wire');
    assert.match(res.stderr, /broke the training contract \(v2 observation 390 != 385\)/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

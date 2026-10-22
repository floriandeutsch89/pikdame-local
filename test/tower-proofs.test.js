/** Every committed Kartenhaus deal stays winnable: Zen in the human seat replays
 *  each floor (deterministic) and must earn a star with the recorded game hash
 *  (test/fixtures/tower-proofs.json, from scripts/tower-seeds.js); Hard replays
 *  where it has a proof (always on floors 1-2: the easy bots' dice). Without
 *  onnxruntime only Hard on floors without a Zen bot runs here, the CI job
 *  `tower-proofs` runs all of it. The old October tower (floors 1-10) predates
 *  the rule: only its hashes are checked.
 *  Intended bot change: `node scripts/tower-seeds.js --prove` refreshes the hashes. */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const BotTower = require('../game/BotTower');
const OnnxPolicy = require('../game/OnnxPolicy');
const TowerSeeds = require('../game/TowerSeeds');
const proofs = require('./fixtures/tower-proofs.json');
const { playFloor, needsNet } = require('../scripts/tower-play');
const { mediumWindow } = require('../scripts/tower-rule');

const net = OnnxPolicy.enabled() && OnnxPolicy.available();
const legacy = (month, stage) => month === BotTower.LEGACY_MONTH && stage <= 10;

test('every committed month has its proof games', () => {
  assert.deepStrictEqual(Object.keys(proofs).sort(), Object.keys(TowerSeeds).sort());
  for (const [month, seeds] of Object.entries(TowerSeeds)) {
    assert.deepStrictEqual(proofs[month].map((f) => f.seed), seeds, `${month}: proofs belong to the committed deals`);
    let prev = null;
    proofs[month].forEach((f, i) => {
      const stage = i + 1;
      if (legacy(month, stage)) return;
      assert.ok(f.zen[0] >= 1, `${month} floor ${stage}: picked with a star for Zen`);
      if (f.hard) assert.ok(f.hard[0] >= 1, `${month} floor ${stage}: a Hard proof is a won game`);
      if (stage <= 2) assert.ok(f.hard, `${month} floor ${stage}: Hard proves the easy bots' dice`);
      if (stage > 10) {
        const [lo, hi] = mediumWindow(stage, prev);
        assert.ok(f.medium10 >= lo && f.medium10 <= hi, `${month} floor ${stage}: medium ${f.medium10} % outside ${lo.toFixed(1)}-${hi.toFixed(1)}`);
        prev = f.medium10;
      }
    });
  }
});

test('the CI job really has the net', { skip: process.env.PIKDAME_TOWER_PROOFS_NET !== '1' }, () => {
  assert.ok(net, 'onnxruntime-node and the model must load in the tower-proofs job');
});

for (const proxy of ['hard', 'zen']) {
  const cases = [];
  for (const month of Object.keys(proofs).sort()) {
    proofs[month].forEach((f, i) => { if (f[proxy]) cases.push({ month, stage: i + 1, seed: f.seed, want: f[proxy] }); });
  }
  // Zen plays the net in the human seat; Hard's opponents may be Zen bots.
  const runnable = cases.filter((c) => net || (proxy === 'hard' && !needsNet(c.stage)));
  const skip = runnable.length ? false : 'needs onnxruntime-node (CI job tower-proofs)';
  test(`${proxy} replays ${runnable.length}/${cases.length} floors with a star and the recorded game`, { skip }, async () => {
    const bad = [];
    for (const c of runnable) {
      const o = await playFloor({ seed: c.seed, stage: c.stage, month: c.month, proxy });
      const [stars, margin, hash] = c.want;
      if (o.hash !== hash || o.stars !== stars || o.margin !== margin) {
        bad.push(`${c.month} floor ${c.stage}: ${o.stars}*/${o.margin}/${o.hash}, recorded ${stars}*/${margin}/${hash}`);
      }
      if (!legacy(c.month, c.stage) && o.stars < 1) bad.push(`${c.month} floor ${c.stage}: no star`);
    }
    assert.deepStrictEqual(bad, [], 'the bots or the engine play these deals differently now');
  });
}

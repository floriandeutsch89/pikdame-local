#!/usr/bin/env node
// Picks the Kartenhaus deals (game/TowerSeeds.js) by simulation: per month and
// floor the first candidate seed on which the "hard" heuristic in the human seat
// earns a star against that floor's bots and modifiers, Zen on the net. Floors
// with an easy bot (random play) need a star in 34 of 40 runs, the others in 2
// of 3; floors 1-10 must also stay tight (median margin cap). Math.random is
// seeded per run, so a rerun picks the same deals. October 2026 keeps the old
// fixed bot tower on floors 1-10 (its stars count there).
// Run with onnxruntime-node installed OUTSIDE the repo (CLAUDE.md), e.g.
//   NODE_PATH=/path/ort/node_modules node scripts/tower-seeds.js 2026-10 2027-12
//   NODE_PATH=/path/ort/node_modules node scripts/tower-seeds.js --rate 300
// The first form rewrites game/TowerSeeds.js (months outside the range stay);
// --rate N plays N random deals per floor and prints how often a star falls.
'use strict';
const fs = require('fs');
const path = require('path');
const GameManager = require('../game/GameManager');
const BotTower = require('../game/BotTower');
const OnnxPolicy = require('../game/OnnxPolicy');

const FILE = path.join(__dirname, '..', 'game', 'TowerSeeds.js');
// The old fixed tower: October 2026, floors 1-10.
const LEGACY = { month: '2026-10', seeds: [84, 10, 78, 24, 63, 131, 34, 89, 28, 170] };
const marginCap = (stage) => (stage <= 10 ? 260 - 20 * stage : Infinity); // floor 10: 60
const randomBots = (stage) => BotTower.stageConfig(stage).bots.includes('easy');

function monthsBetween(from, to) {
  const out = [];
  let [y, m] = from.split('-').map(Number);
  const [ty, tm] = to.split('-').map(Number);
  while (y < ty || (y === ty && m <= tm)) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  return out;
}

/** murmur3's finalizer: neighbouring inputs give unrelated PRNG seeds (a plain
 *  sum gave correlated runs that overrated deals against easy bots). */
function mix(h) {
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** mulberry32: a small seeded PRNG for Math.random during one play. */
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** One play of `seed` as floor `stage` (its bots, head start and modifiers); the human seat plays "hard". */
async function playOnce(seed, stage, run = 0) {
  const random = Math.random;
  Math.random = prng(mix(mix(seed) ^ mix(stage * 0x9e3779b1 + run)));
  try {
    const g = new GameManager(() => {}, { deckSeed: seed, towerStage: stage });
    g.addOrReconnectPlayer('me', 'Sim');
    g.syncLobbyBots();
    if (g.startTowerRound().error) throw new Error(`floor ${stage} did not start`);
    g.players.find((p) => p.id === 'me').botDifficulty = 'hard';
    let guard = 0;
    while (g.phase === 'playing' && guard++ < 5000) {
      const cp = g.currentPlayer();
      const before = g.turnIndexInRound;
      if (cp.isBot && g._botTurnUsesOnnx(cp)) await g._runBotTurnWithOnnx(cp.id);
      else g.runBotTurn(cp.id, { forced: !cp.isBot });
      if (g.phase === 'playing' && g.turnIndexInRound === before && g.currentPlayer().id === cp.id) g.finishRound(null);
    }
    const record = g.lastGameRecord;
    g.destroy();
    if (!record) throw new Error(`floor ${stage}, seed ${seed}: no game over`);
    return BotTower.outcomeFromRecord(record, 'me');
  } finally {
    Math.random = random;
  }
}

async function judge(seed, stage) {
  const runs = randomBots(stage) ? 40 : 3;
  const need = randomBots(stage) ? 34 : 2;
  const margins = [];
  let wins = 0;
  for (let i = 0; i < runs; i++) {
    const o = await playOnce(seed, stage, i);
    margins.push(o.margin);
    if (o.stars >= 1) wins += 1;
    if (wins >= need || i + 1 - wins > runs - need) break; // decided early
  }
  margins.sort((a, b) => a - b);
  const median = margins[Math.floor(margins.length / 2)];
  return { ok: wins >= need && median <= marginCap(stage), wins, runs: margins.length, median };
}

/** --rate N: the star rate of the heuristic per floor over N random deals. */
async function rate(n) {
  for (const { stage, bots, handicap, mods } of BotTower.TOWER_STAGES) {
    let stars = 0;
    for (let i = 0; i < n; i++) if ((await playOnce(900000 + i, stage)).stars >= 1) stars += 1;
    console.log(`floor ${stage} (${bots.join(',')} +${handicap}${mods ? ` ${mods.join('+')}` : ''}): star in ${stars}/${n} deals (${(100 * stars / n).toFixed(1)} %)`);
  }
}

async function main() {
  process.stderr.write(`net ${OnnxPolicy.enabled() ? 'ON' : 'OFF'}\n`);
  if (!OnnxPolicy.enabled()) process.stderr.write('WARNING: Zen falls back to the heuristic - seeds are not prod-calibrated\n');
  const rateIdx = process.argv.indexOf('--rate');
  if (rateIdx > -1) return rate(Number(process.argv[rateIdx + 1]) || 100);
  const [from, to] = process.argv.slice(2);
  if (!from || !to) throw new Error('usage: tower-seeds.js <from YYYY-MM> <to YYYY-MM> | --rate N');
  const out = { ...require(FILE) };
  const months = monthsBetween(from, to);
  for (const m of months) delete out[m];
  const used = new Set(Object.values(out).flat());
  // Floors 1-10 draw from 1000 up, the harder floors 11-20 from 10000 up.
  const next = { low: 1000, high: 10000 };
  for (const month of months) {
    out[month] = [];
    for (const { stage } of BotTower.TOWER_STAGES) {
      if (month === LEGACY.month && stage <= LEGACY.seeds.length) {
        out[month].push(LEGACY.seeds[stage - 1]);
        continue;
      }
      const pool = stage <= 10 ? 'low' : 'high';
      for (let tries = 1; ; tries++) {
        const seed = next[pool]++;
        if (used.has(seed)) continue;
        const v = await judge(seed, stage);
        if (!v.ok) continue;
        used.add(seed);
        out[month].push(seed);
        process.stderr.write(`${month} floor ${stage}: seed ${seed} (star ${v.wins}/${v.runs}, median margin ${v.median}, ${tries} candidates)\n`);
        break;
      }
    }
  }
  const lines = Object.keys(out).sort().map((m) => `  '${m}': [${out[m].join(', ')}],`).join('\n');
  const header = fs.readFileSync(FILE, 'utf8').split('module.exports')[0];
  fs.writeFileSync(FILE, `${header}module.exports = {\n${lines}\n};\n`);
}

main().catch((e) => { console.error(e); process.exit(1); });

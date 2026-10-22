#!/usr/bin/env node
// Picks the Kartenhaus deals (game/TowerSeeds.js) by simulation. A floor is
// deterministic per seed and line of play, so one game is a proof: a deal is
// taken only when BOTH Hard and Zen in the human seat earn a star on it.
// Floors 1-10 also stay tight (Hard's margin under a cap); floors 11-20 must
// give a medium player (medium heuristic with 10 % random moves, 100 games) a
// star rate in a band around a target falling from 45 % (floor 11) to 13 %
// (floor 20). October 2026 keeps the old tower on floors 1-10 (its stars count).
// Writes test/fixtures/tower-proofs.json (hash of each proof game, drift check).
// Run with onnxruntime-node installed OUTSIDE the repo (CLAUDE.md), e.g.
//   NODE_PATH=/path/ort/node_modules node scripts/tower-seeds.js 2026-10 2027-12 [--jobs 4]
//   NODE_PATH=/path/ort/node_modules node scripts/tower-seeds.js --prove
//   NODE_PATH=/path/ort/node_modules node scripts/tower-seeds.js --rate 300
// The first form rewrites the months in range (others stay); --prove replays
// the committed deals and rewrites only the proofs (after an intended bot
// change), failing when a floor lost its star; --rate N prints Hard's star
// rate over N random deals per floor.
'use strict';
process.env.PIKDAME_LOG_GAMES = '0'; // simulated games are no human moves (they filled the disk once)
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const BotTower = require('../game/BotTower');
const OnnxPolicy = require('../game/OnnxPolicy');
const { playFloor, slipRate } = require('./tower-play');

const FILE = path.join(__dirname, '..', 'game', 'TowerSeeds.js');
const PROOFS = path.join(__dirname, '..', 'test', 'fixtures', 'tower-proofs.json');
// The old fixed tower: October 2026, floors 1-10.
const LEGACY = { month: '2026-10', seeds: [84, 10, 78, 24, 63, 131, 34, 89, 28, 170] };
const isLegacy = (month, stage) => month === LEGACY.month && stage <= LEGACY.seeds.length;
const marginCap = (stage) => (stage <= 10 ? 260 - 20 * stage : Infinity); // floor 10: 60
// Medium player's star rate on floors 11-20: target T, accepted [T-6, T+10], never below 8 %.
const target = (stage) => 45 - ((stage - 11) * 32) / 9;
const band = (stage) => [Math.max(8, target(stage) - 6), target(stage) + 10];
const MEDIUM_GAMES = 100;
const MAX_TRIES = 3000; // floors 11-20: then the deal closest to the band
const RESULT = '\n@@tower-month@@';
const ANCHOR = '2026-10'; // seed blocks per month count from here (reruns pick the same deals)

const monthIndex = (m) => Number(m.slice(0, 4)) * 12 + Number(m.slice(5, 7)) - 1;

function monthsBetween(from, to) {
  const out = [];
  for (let i = monthIndex(from); i <= monthIndex(to); i++) {
    out.push(`${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`);
  }
  return out;
}

const proofOf = (o) => [o.stars, o.margin, o.hash];

/** Hard and Zen on one deal: the proof games. */
async function prove(seed, stage, month) {
  const hard = await playFloor({ seed, stage, month, proxy: 'hard' });
  const zen = await playFloor({ seed, stage, month, proxy: 'zen' });
  return { hard, zen };
}

/** Picks the twenty deals of one month (runs in a worker process). */
async function pickMonth(month, exclude) {
  const k = monthIndex(month) - monthIndex(ANCHOR);
  if (k < 0) throw new Error(`months before ${ANCHOR} are not supported`);
  // Disjoint seed blocks per month: no deal repeats, months run in parallel.
  const next = { low: 100000 + k * 10000, high: 1000000 + k * 100000 };
  const floors = [];
  for (const { stage } of BotTower.TOWER_STAGES) {
    const t0 = Date.now();
    if (isLegacy(month, stage)) {
      const seed = LEGACY.seeds[stage - 1];
      const p = await prove(seed, stage, month);
      floors.push({ stage, seed, tries: 0, hard: proofOf(p.hard), zen: proofOf(p.zen), legacy: true });
      continue;
    }
    const pool = stage <= 10 ? 'low' : 'high';
    let pick = null;
    let best = null;
    let tries = 0;
    while (!pick) {
      const seed = next[pool]++;
      if (exclude.has(seed)) continue;
      tries += 1;
      if (stage > 10 && tries > MAX_TRIES) { pick = best; break; }
      const hard = await playFloor({ seed, stage, month, proxy: 'hard' });
      if (hard.stars < 1 || hard.margin > marginCap(stage)) continue;
      const zen = await playFloor({ seed, stage, month, proxy: 'zen' });
      if (zen.stars < 1) continue;
      const cand = { seed, hard: proofOf(hard), zen: proofOf(zen) };
      if (stage > 10) {
        const rate = await slipRate({ seed, stage, month, n: MEDIUM_GAMES });
        const [lo, hi] = band(stage);
        const off = rate < lo ? lo - rate : rate > hi ? rate - hi : 0;
        Object.assign(cand, { medium10: rate, off });
        if (!best || off < best.off) best = cand;
        if (off > 0) continue;
      }
      pick = cand;
    }
    if (!pick) throw new Error(`${month} floor ${stage}: no deal won by Hard and Zen`);
    floors.push({ stage, ...pick, tries });
    process.stderr.write(`${month} floor ${stage}: seed ${pick.seed} after ${tries} candidates`
      + `${pick.medium10 != null ? `, medium ${pick.medium10} %${pick.off ? ` (${pick.off} off the band)` : ''}` : ''}`
      + ` (${((Date.now() - t0) / 1000).toFixed(0)} s)\n`);
  }
  return floors;
}

function writeSeeds(out) {
  const lines = Object.keys(out).sort().map((m) => `  '${m}': [${out[m].join(', ')}],`).join('\n');
  const header = fs.readFileSync(FILE, 'utf8').split('module.exports')[0];
  fs.writeFileSync(FILE, `${header}module.exports = {\n${lines}\n};\n`);
}

/** One floor per line: { month: [{ seed, hard: [stars, margin, hash], zen: [...], medium10? }] }. */
function writeProofs(proofs) {
  const months = Object.keys(proofs).sort();
  const body = months.map((m) => `  ${JSON.stringify(m)}: [\n${proofs[m].map((f) => `    ${JSON.stringify(f)}`).join(',\n')}\n  ]`).join(',\n');
  fs.mkdirSync(path.dirname(PROOFS), { recursive: true });
  fs.writeFileSync(PROOFS, `{\n${body}\n}\n`);
}

function readProofs() {
  try { return JSON.parse(fs.readFileSync(PROOFS, 'utf8')); } catch (e) { return {}; }
}

const proofEntry = (f) => ({ seed: f.seed, hard: f.hard, zen: f.zen, ...(f.medium10 != null ? { medium10: f.medium10 } : {}) });

/** Runs one month in a child process (the parent fans out over --jobs). */
function runWorker(month, from, to) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [__filename, '--worker', month, from, to], { stdio: ['ignore', 'pipe', 'inherit'] });
    let stdout = '';
    child.stdout.on('data', (d) => { stdout += d; });
    // The runtime logs to stdout too: the result follows the last marker.
    child.on('close', (code) => (code === 0 ? resolve(JSON.parse(stdout.split(RESULT).pop())) : reject(new Error(`${month}: worker exited ${code}`))));
  });
}

async function generate(from, to, jobs) {
  const t0 = Date.now();
  const seeds = { ...require(FILE) };
  const proofs = readProofs();
  const months = monthsBetween(from, to);
  const results = {};
  const queue = [...months];
  await Promise.all(Array.from({ length: Math.max(1, jobs) }, async () => {
    while (queue.length) {
      const m = queue.shift();
      results[m] = await runWorker(m, from, to);
    }
  }));
  for (const m of months) {
    seeds[m] = results[m].map((f) => f.seed);
    proofs[m] = results[m].map(proofEntry);
  }
  writeSeeds(seeds);
  writeProofs(proofs);
  process.stderr.write(`done: ${months.length} months in ${((Date.now() - t0) / 60000).toFixed(1)} min\n`);
}

/** --prove: replay every committed deal, refresh the proofs, fail on a lost star. */
async function proveAll() {
  const seeds = require(FILE);
  const old = readProofs();
  const proofs = {};
  const lost = [];
  for (const month of Object.keys(seeds).sort()) {
    proofs[month] = [];
    for (const { stage } of BotTower.TOWER_STAGES) {
      const seed = seeds[month][stage - 1];
      const p = await prove(seed, stage, month);
      const prev = (old[month] || [])[stage - 1];
      proofs[month].push(proofEntry({ seed, hard: proofOf(p.hard), zen: proofOf(p.zen), medium10: prev && prev.seed === seed ? prev.medium10 : undefined }));
      if (!isLegacy(month, stage) && (p.hard.stars < 1 || p.zen.stars < 1)) lost.push(`${month} floor ${stage}`);
    }
  }
  writeProofs(proofs);
  if (lost.length) {
    console.error(`no star for Hard or Zen on: ${lost.join(', ')} - regenerate those months`);
    process.exit(1);
  }
}

/** --rate N: Hard's star rate per floor over N random deals. */
async function rate(n) {
  for (const { stage, bots, handicap, mods } of BotTower.TOWER_STAGES) {
    let stars = 0;
    for (let i = 0; i < n; i++) if ((await playFloor({ seed: 900000 + i, stage, month: '2027-01' })).stars >= 1) stars += 1;
    console.log(`floor ${stage} (${bots.join(',')} +${handicap}${mods ? ` ${mods.join('+')}` : ''}): star in ${stars}/${n} deals (${(100 * stars / n).toFixed(1)} %)`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === '--worker') {
    const [, month, from, to] = args;
    const inRange = new Set(monthsBetween(from, to));
    const seeds = require(FILE);
    const exclude = new Set(Object.keys(seeds).filter((m) => !inRange.has(m)).flatMap((m) => seeds[m]));
    for (const s of LEGACY.seeds) exclude.add(s);
    process.stdout.write(RESULT + JSON.stringify(await pickMonth(month, exclude)));
    return;
  }
  process.stderr.write(`net ${OnnxPolicy.enabled() ? 'ON' : 'OFF'}\n`);
  if (!OnnxPolicy.available()) {
    throw new Error('onnxruntime-node or the model is missing: Zen would play the heuristic and the deals would not be prod-proven');
  }
  const rateIdx = args.indexOf('--rate');
  if (rateIdx > -1) return rate(Number(args[rateIdx + 1]) || 100);
  if (args.includes('--prove')) return proveAll();
  const jobsIdx = args.indexOf('--jobs');
  const jobs = jobsIdx > -1 ? Number(args[jobsIdx + 1]) || 1 : 4;
  const [from, to] = args.filter((a) => /^\d{4}-\d{2}$/.test(a));
  if (!from || !to) throw new Error('usage: tower-seeds.js <from YYYY-MM> <to YYYY-MM> [--jobs N] | --prove | --rate N');
  await generate(from, to, jobs);
}

main().catch((e) => { console.error(e); process.exit(1); });

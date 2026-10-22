#!/usr/bin/env node
// Picks the Kartenhaus deals (game/TowerSeeds.js) by simulation. A floor is
// deterministic per seed and line of play, so one game is a proof: a deal is
// taken only when Zen in the human seat earns a star on it (Hard's game is
// recorded where it wins too). Floors 1-10 also need Hard's star under a margin
// cap (tight floors); floors 11-20 must give a medium player (medium heuristic
// with 10 % random moves, 100 games) a star rate within +-10 pp of a target
// falling from 45 % (floor 11) to 13 % (floor 20), at least 8 %, and at most
// 5 pp above the floor below (the staircase never gets easier). No fallback:
// a floor that finds no deal within MAX_TRIES is reported and keeps its deal.
// Floors that already meet the rule are kept (stable proofs); October 2026
// keeps the old tower on floors 1-10 (its stars count).
// Writes test/fixtures/tower-proofs.json (hash of each proof game, drift check).
// Run with onnxruntime-node installed OUTSIDE the repo (CLAUDE.md), e.g.
//   NODE_PATH=/path/ort/node_modules node scripts/tower-seeds.js 2026-10 2027-12 [--jobs 4]
//   NODE_PATH=/path/ort/node_modules node scripts/tower-seeds.js --prove
//   NODE_PATH=/path/ort/node_modules node scripts/tower-seeds.js --rate 300
// The first form re-picks the floors in range that break the rule (others
// stay); --prove replays the committed deals and rewrites only the proofs
// (after an intended bot change), failing when Zen lost a star; --rate N
// prints Hard's star rate over N random deals per floor.
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
const marginCap = (stage) => 260 - 20 * stage; // floors 1-10 (floor 10: 60)
const { target, mediumWindow } = require('./tower-rule');
const MEDIUM_GAMES = 100;
const MAX_TRIES = 20000; // per floor 11-20; then the floor is reported, never taken off the rule
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
const log = (msg) => process.stderr.write(`${msg}\n`);

/** Hard and Zen on one deal: the proof games (Hard only kept when it wins). */
async function prove(seed, stage, month) {
  const hard = await playFloor({ seed, stage, month, proxy: 'hard' });
  const zen = await playFloor({ seed, stage, month, proxy: 'zen' });
  return { hard, zen };
}
const hardProof = (hard) => (hard.stars >= 1 ? proofOf(hard) : undefined);

/** Floors 1-10: Hard's star under the margin cap, and Zen's star. */
async function searchLow(month, stage, next, exclude) {
  for (let tries = 1; ; tries++) {
    const seed = next.low++;
    if (exclude.has(seed)) { tries -= 1; continue; }
    const hard = await playFloor({ seed, stage, month, proxy: 'hard' });
    if (hard.stars < 1 || hard.margin > marginCap(stage)) continue;
    const zen = await playFloor({ seed, stage, month, proxy: 'zen' });
    if (zen.stars < 1) continue;
    return { seed, hard: proofOf(hard), zen: proofOf(zen), tries };
  }
}

/** Floors 11-20: Zen's star and the medium rate inside [lo, hi]; null after MAX_TRIES. */
async function searchHigh(month, stage, [lo, hi], k, exclude, offset = 0) {
  let seed = 5000000 + k * 1000000 + (stage - 11) * 100000 + offset; // own block per month and floor
  for (let tries = 1; tries <= MAX_TRIES; tries++, seed++) {
    if (exclude.has(seed)) continue;
    const zen = await playFloor({ seed, stage, month, proxy: 'zen' });
    if (zen.stars < 1) continue;
    const rate = await slipRate({ seed, stage, month, n: MEDIUM_GAMES, within: [lo, hi] });
    if (rate == null) continue;
    const hard = await playFloor({ seed, stage, month, proxy: 'hard' });
    return { seed, hard: hardProof(hard), zen: proofOf(zen), medium10: rate, tries };
  }
  return null;
}

/** The twenty deals of one month (runs in a worker process): keeps every floor
 *  that meets the rule, re-picks the others. `old` = the month's committed proofs. */
async function pickMonth(month, exclude, old) {
  const k = monthIndex(month) - monthIndex(ANCHOR);
  if (k < 0) throw new Error(`months before ${ANCHOR} are not supported`);
  const next = { low: 100000 + k * 10000 };
  const floors = [];
  const failed = [];
  let prev = null; // the medium rate of the floor below (floors 11-20)
  for (const { stage } of BotTower.TOWER_STAGES) {
    const t0 = Date.now();
    const kept = old && old[stage - 1];
    if (isLegacy(month, stage)) {
      const seed = LEGACY.seeds[stage - 1];
      if (kept && kept.seed === seed) { floors.push(kept); continue; }
      const p = await prove(seed, stage, month);
      floors.push({ seed, hard: proofOf(p.hard), zen: proofOf(p.zen) });
      continue;
    }
    if (stage <= 10) {
      if (kept && kept.zen && kept.zen[0] >= 1) { floors.push(kept); continue; }
      const pick = await searchLow(month, stage, next, exclude);
      floors.push(pick);
      log(`${month} floor ${stage}: seed ${pick.seed} after ${pick.tries} candidates (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
      continue;
    }
    const win = mediumWindow(stage, prev);
    if (kept && kept.zen && kept.zen[0] >= 1 && kept.medium10 >= win[0] && kept.medium10 <= win[1]) {
      floors.push(kept);
      prev = kept.medium10;
      continue;
    }
    let pick = null;
    let used = win; // the window the pick was searched in (for the log)
    const open = mediumWindow(stage, null);
    if (stage > 11 && win[1] < open[1]) {
      // The floor below caps this one (+5 pp): search without the cap first, then
      // re-pick the floor below so it fits (one step back, never further).
      const wide = await searchHigh(month, stage, open, k, exclude);
      if (wide) used = open;
      if (wide && wide.medium10 <= win[1]) pick = wide;
      else if (wide) {
        const below = floors[floors.length - 1];
        const twoDown = stage > 12 ? floors[floors.length - 2].medium10 : null;
        const bw = mediumWindow(stage - 1, twoDown);
        const lower = await searchHigh(month, stage - 1, [Math.max(bw[0], wide.medium10 - 5), bw[1]], k, exclude, 50000);
        if (lower) {
          floors[floors.length - 1] = lower;
          exclude.add(lower.seed);
          if (failed.length && failed[failed.length - 1].stage === stage - 1) failed.pop(); // fixed by the re-pick
          log(`${month} floor ${stage - 1}: re-picked seed ${lower.seed} (medium ${lower.medium10} %, was ${below.medium10} %) to fit floor ${stage}`);
          pick = wide;
        }
      }
    }
    if (!pick) { used = win; pick = await searchHigh(month, stage, win, k, exclude); }
    if (!pick) {
      failed.push({ month, stage, window: win, kept: kept ? kept.medium10 : null });
      log(`${month} floor ${stage}: NO deal in [${win[0].toFixed(1)}, ${win[1].toFixed(1)}] after ${MAX_TRIES} candidates, keeps ${kept ? kept.medium10 : '-'} %`);
      if (!kept) throw new Error(`${month} floor ${stage}: no deal and nothing to keep`);
      floors.push(kept);
      prev = kept.medium10;
      continue;
    }
    floors.push(pick);
    prev = pick.medium10;
    log(`${month} floor ${stage}: seed ${pick.seed} after ${pick.tries} candidates, medium ${pick.medium10} % `
      + `(target ${target(stage).toFixed(1)}, window ${used[0].toFixed(1)}-${used[1].toFixed(1)}) (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
  }
  return { floors, failed };
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

const proofEntry = (f) => ({
  seed: f.seed,
  ...(f.hard ? { hard: f.hard } : {}),
  zen: f.zen,
  ...(f.medium10 != null ? { medium10: f.medium10 } : {}),
});

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
  const failed = [];
  for (const m of months) {
    seeds[m] = results[m].floors.map((f) => f.seed);
    proofs[m] = results[m].floors.map(proofEntry);
    failed.push(...results[m].failed);
  }
  writeSeeds(seeds);
  writeProofs(proofs);
  log(`done: ${months.length} months in ${((Date.now() - t0) / 60000).toFixed(1)} min`);
  if (failed.length) {
    log(`OFF THE RULE (no deal within ${MAX_TRIES} candidates): ${failed.map((f) => `${f.month} floor ${f.stage} (kept ${f.kept} %, window ${f.window.map((x) => x.toFixed(1)).join('-')})`).join('; ')}`);
    process.exitCode = 2;
  }
}

/** --prove: replay every committed deal, refresh the proofs, fail when Zen lost a star. */
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
      const legacy = isLegacy(month, stage);
      proofs[month].push(proofEntry({ seed, hard: legacy ? proofOf(p.hard) : hardProof(p.hard), zen: proofOf(p.zen), medium10: prev && prev.seed === seed ? prev.medium10 : undefined }));
      if (!legacy && p.zen.stars < 1) lost.push(`${month} floor ${stage}`);
      if (!legacy && stage <= 2 && p.hard.stars < 1) lost.push(`${month} floor ${stage} (Hard, easy-bot replay)`);
    }
  }
  writeProofs(proofs);
  if (lost.length) {
    console.error(`no star on: ${lost.join(', ')} - regenerate those months`);
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
    // Committed deals of other floors in range stay unique too.
    for (const m of inRange) for (const s of seeds[m] || []) exclude.add(s);
    for (const s of LEGACY.seeds) exclude.add(s);
    process.stdout.write(RESULT + JSON.stringify(await pickMonth(month, exclude, readProofs()[month])));
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

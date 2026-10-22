// A stand-in for game/TowerPlay.js in the Kartenhaus generator tests: same
// interface, deterministic per seed, no games played (milliseconds per month).
// Steering via env (a worker thread gets a copy of process.env at its start):
//   TOWER_STUB_ZEN_NEVER=13,14   Zen wins no deal on these floors (emergency lock)
//   TOWER_STUB_ZEN_LOSES=123,456 Zen no longer wins these seeds ("the bots changed")
//   TOWER_STUB_MEDIUM_NEVER=15   no medium rate fits the band (emergency relax)
//   TOWER_STUB_DELAY_MS=2        each game takes this long (a stop mid-run)
'use strict';
const { fnv } = require('../../game/TowerRule');

const list = (name) => String(process.env[name] || '').split(',').filter(Boolean).map(Number);
let calls = 0;

const delay = () => new Promise((resolve) => setTimeout(resolve, Number(process.env.TOWER_STUB_DELAY_MS) || 0));

async function playFloor({ seed, stage, proxy = 'hard' }) {
  calls += 1;
  if (process.env.TOWER_STUB_DELAY_MS) await delay();
  const h = fnv(`${seed}|${proxy}`);
  let stars = h % 3 === 0 ? 0 : 1 + (h % 2);
  if (proxy === 'zen' && (list('TOWER_STUB_ZEN_NEVER').includes(stage) || list('TOWER_STUB_ZEN_LOSES').includes(seed))) stars = 0;
  return ({ stars, margin: stars ? (h >>> 4) % 200 : -((h >>> 4) % 90), hash: h.toString(16).padStart(12, '0').slice(0, 12), turns: 30 });
}

async function slipRate({ seed, stage, within = null, beforeGame = null }) {
  calls += 1;
  if (beforeGame) beforeGame();
  if (process.env.TOWER_STUB_DELAY_MS) await delay();
  let r = (fnv(`${seed}|medium`) >>> 3) % 71; // 0-70 %
  if (list('TOWER_STUB_MEDIUM_NEVER').includes(stage)) r = 99;
  if (within && (r < within[0] || r > within[1])) return null;
  return r;
}

module.exports = { playFloor, slipRate, calls: () => calls };

// game/TowerGen.js - picks a month's Kartenhaus deals by the rule in TowerRule.js.
// One generator for the server (its worker, TowerWorker.js) and
// scripts/tower-seeds.js. Playing is injected (`play`, `rate`: TowerPlay.js in
// production, a stub in tests), so this file has no game I/O of its own.
//
// A floor entry: { seed, zen: [stars, margin, hash], hard?, medium10?, relaxed?, locked? }
// - zen: the proof game (Zen in the human seat, undisturbed) - always required.
// - hard: Hard's game where it wins (floors 1-10 need it, see marginCap).
// - relaxed: an emergency pick, the medium band was not met (never the proof).
// - locked: no proven deal found; the floor stays closed (never an unproven deal).
'use strict';
const R = require('./TowerRule');

const proofOf = (o) => [o.stars, o.margin, o.hash];
const tick = () => new Promise((resolve) => setImmediate(resolve));

/** Is this entry a playable, proven deal? */
const proven = (f) => !!(f && !f.locked && Number.isInteger(f.seed) && Array.isArray(f.zen) && f.zen[0] >= 1);

/**
 * @param {object} o
 * @param {string} o.month 'YYYY-MM'
 * @param {Array} [o.floors] the stored entries (null = missing), index = stage - 1
 * @param {'rule'|'missing'} [o.mode] 'rule': re-pick every floor that breaks the
 *   rule (a month nobody plays yet); 'missing': fill only missing floors and keep
 *   the rest (the running month: players have stars on those deals)
 * @param {boolean} [o.emergency] smaller search; when it finds nothing, relax the
 *   medium band (never Zen's proof), and lock the floor as the last resort
 * @param {function} o.play ({seed, stage, month, proxy}) => {stars, margin, hash}
 * @param {function} o.rate ({seed, stage, month, n, within}) => rate | null
 * @param {object} [o.fixed] stage -> seed kept as is (October 2026's old floors)
 */
async function generateMonth({
  month, floors = [], mode = 'rule', emergency = false, play, rate,
  maxTries = R.MAX_TRIES, fixed = {}, pause = tick, onFloor = () => {}, log = () => {},
}) {
  const out = Array.from({ length: 20 }, (_, i) => floors[i] || null);
  const failed = [];
  const changed = new Set();
  const set = (stage, entry) => { out[stage - 1] = entry; changed.add(stage); onFloor(stage, entry); };
  const taken = () => new Set(out.filter(Boolean).map((f) => f.seed));

  /** The first candidate of `lane` that `accept` takes (null after `tries`). */
  async function search(stage, lane, tries, accept) {
    const used = taken();
    for (let i = 0; i < tries; i++) {
      const seed = R.candidateSeed(month, stage, i, lane);
      if (used.has(seed)) continue;
      const pick = await accept(seed);
      if (pick) return { ...pick, tries: i + 1 };
      await pause();
    }
    return null;
  }
  const zenProof = async (seed, stage) => {
    const zen = await play({ seed, stage, month, proxy: 'zen' });
    return zen.stars >= 1 ? proofOf(zen) : null;
  };
  const hardIfWon = async (seed, stage) => {
    const hard = await play({ seed, stage, month, proxy: 'hard' });
    return hard.stars >= 1 ? proofOf(hard) : undefined;
  };
  /** Floors 11-20: Zen's star and the medium rate in [lo, hi]. */
  const high = (stage, [lo, hi]) => async (seed) => {
    const zen = await zenProof(seed, stage);
    if (!zen) return null;
    const medium10 = await rate({ seed, stage, month, n: R.MEDIUM_GAMES, within: [lo, hi] });
    if (medium10 == null) return null;
    return { seed, zen, hard: await hardIfWon(seed, stage), medium10 };
  };
  const tries = emergency ? Math.min(maxTries, 2000) : maxTries;
  /** Emergency fallback: Zen's proof only, the medium band relaxed. */
  async function relaxedOrLocked(stage) {
    const pick = await search(stage, 'r', tries, async (seed) => {
      const zen = await zenProof(seed, stage);
      if (!zen) return null;
      const medium10 = stage > 10 ? await rate({ seed, stage, month, n: R.MEDIUM_GAMES }) : undefined;
      return { seed, zen, hard: await hardIfWon(seed, stage), ...(medium10 != null ? { medium10 } : {}), relaxed: true };
    });
    if (pick) log(`${month} floor ${stage}: emergency pick ${pick.seed} (band relaxed)`);
    else log(`${month} floor ${stage}: LOCKED - no deal Zen wins within ${tries} candidates`);
    return pick || { locked: true };
  }
  const strip = ({ tries: _t, ...entry }) => Object.fromEntries(Object.entries(entry).filter(([, v]) => v !== undefined));

  let prev = null; // the medium rate of the floor below (floors 11-20)
  for (let stage = 1; stage <= 20; stage++) {
    const kept = out[stage - 1];
    if (fixed[stage] != null) {
      if (!kept || kept.seed !== fixed[stage]) {
        const seed = fixed[stage];
        set(stage, strip({ seed, zen: proofOf(await play({ seed, stage, month, proxy: 'zen' })), hard: proofOf(await play({ seed, stage, month, proxy: 'hard' })) }));
      }
      continue;
    }
    const keep = (entry) => { if (stage > 10) prev = entry.medium10 != null ? entry.medium10 : prev; };
    if (stage <= 10) {
      if (proven(kept)) { keep(kept); continue; }
      let pick = await search(stage, 'a', tries, async (seed) => {
        const hard = await play({ seed, stage, month, proxy: 'hard' });
        if (hard.stars < 1 || hard.margin > R.marginCap(stage)) return null;
        const zen = await zenProof(seed, stage);
        return zen ? { seed, zen, hard: proofOf(hard) } : null;
      });
      if (pick) log(`${month} floor ${stage}: seed ${pick.seed} after ${pick.tries} candidates`);
      else if (emergency) pick = await relaxedOrLocked(stage);
      else failed.push({ month, stage });
      if (pick) set(stage, strip(pick));
      continue;
    }
    const win = R.mediumWindow(stage, prev);
    const fits = (f) => proven(f) && !f.relaxed && f.medium10 >= win[0] && f.medium10 <= win[1];
    // 'missing' keeps what players may already have stars on - unless the floor
    // below was just re-picked and the staircase now breaks (+5 pp).
    const keepIt = mode === 'missing' ? proven(kept) && (!changed.has(stage - 1) || fits(kept)) : fits(kept);
    if (keepIt) { keep(kept); continue; }
    let pick = null;
    const open = R.mediumWindow(stage, null);
    if (mode === 'rule' && stage > 11 && win[1] < open[1] && !fixed[stage - 1]) {
      // The floor below caps this one: search without the cap, then re-pick the
      // floor below to fit (one step back, never further).
      const wide = await search(stage, 'a', tries, high(stage, open));
      if (wide && wide.medium10 <= win[1]) pick = wide;
      else if (wide) {
        const twoDown = stage > 12 ? out[stage - 3] && out[stage - 3].medium10 : null;
        const bw = R.mediumWindow(stage - 1, twoDown == null ? null : twoDown);
        const lower = await search(stage - 1, 'b', tries, high(stage - 1, [Math.max(bw[0], wide.medium10 - R.STEP_PP), bw[1]]));
        if (lower) {
          log(`${month} floor ${stage - 1}: re-picked ${lower.seed} (medium ${lower.medium10} %) to fit floor ${stage}`);
          set(stage - 1, strip(lower));
          const gone = failed.findIndex((f) => f.stage === stage - 1);
          if (gone > -1) failed.splice(gone, 1);
          pick = wide;
        }
      }
    }
    if (!pick) pick = await search(stage, 'a', tries, high(stage, win));
    if (pick) {
      log(`${month} floor ${stage}: seed ${pick.seed} after ${pick.tries} candidates, medium ${pick.medium10} %`);
      set(stage, strip(pick));
      prev = pick.medium10;
      continue;
    }
    if (emergency) {
      const e = await relaxedOrLocked(stage);
      set(stage, strip(e));
      if (e.medium10 != null) prev = e.medium10;
      continue;
    }
    failed.push({ month, stage, window: win });
    log(`${month} floor ${stage}: NO deal in [${win[0].toFixed(1)}, ${win[1].toFixed(1)}] after ${tries} candidates`);
    if (proven(kept)) keep(kept);
  }
  return { floors: out, failed };
}

/** Replays the Zen proofs: the stages whose deal Zen no longer wins (bots or net changed). */
async function staleFloors({ month, floors, play, pause = tick }) {
  const bad = [];
  for (let stage = 1; stage <= 20; stage++) {
    const f = floors[stage - 1];
    if (!proven(f)) continue;
    const zen = await play({ seed: f.seed, stage, month, proxy: 'zen' });
    if (zen.stars < 1) bad.push(stage);
    await pause();
  }
  return bad;
}

module.exports = { generateMonth, staleFloors, proven };

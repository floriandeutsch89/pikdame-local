// game/TowerRule.js - the ONE acceptance rule of Kartenhaus deals, shared by the
// server's generator (TowerGen.js), scripts/tower-seeds.js and the tests.
'use strict';

/** Bump when the rule or the candidate order changes: stored months record it. */
const GEN_VERSION = 1;
const MEDIUM_GAMES = 100; // games of the medium player per candidate (floors 11-20)
const MAX_TRIES = 20000; // candidates per floor before it is reported
const BAND_PP = 10; // floors 11-20: medium rate within +-10 pp of the target
const STEP_PP = 5; // ... and at most 5 pp above the floor below
const MIN_RATE = 8; // ... and never below 8 %

/** Target star rate (%) of a medium player (Mittel, 10 % random moves): 45 on floor 11 down to 13 on floor 20. */
const target = (stage) => 45 - ((stage - 11) * 32) / 9;

/** Floors 1-10: Hard's star must not be a landslide (floor 10: 60 points). */
const marginCap = (stage) => 260 - 20 * stage;

/** Accepted medium rate on floors 11-20; `prev` is the floor below (null on floor 11). */
function mediumWindow(stage, prev) {
  const t = target(stage);
  const hi = prev == null ? t + BAND_PP : Math.min(t + BAND_PP, prev + STEP_PP);
  return [Math.max(MIN_RATE, t - BAND_PP), hi];
}

/** FNV-1a (32 bit). */
function fnv(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

/** The i-th candidate deal of a floor: the same on every replica and after every
 *  restart. `lane` keeps separate searches (backtrack, emergency) apart. */
const candidateSeed = (month, stage, i, lane = 'a') => fnv(`${month}|${stage}|${lane}|${i}`) || 1;

module.exports = {
  GEN_VERSION, MEDIUM_GAMES, MAX_TRIES, BAND_PP, STEP_PP, MIN_RATE,
  target, marginCap, mediumWindow, fnv, candidateSeed,
};

// game/TowerRule.js - the ONE acceptance rule of Kartenhaus deals, shared by the
// server's generator (TowerGen.js), scripts/tower-seeds.js and the tests.
'use strict';

/** Bump when the rule or the candidate order changes: stored months record it. */
const GEN_VERSION = 3; // 3: Hard's gate per floor (hardMin), a wide medium window, no staircase
const MEDIUM_GAMES = 100; // games of the medium player per candidate (floors 11-20)
const HARD_GAMES = 100; // ... and of Hard
const MAX_TRIES = 20000; // candidates per floor before it is reported
const NEAREST_TRIES = 2000; // candidates for the nearest-window fallback (TowerGen.js)

/** Floors 11-20: Hard with 10 % slips earns a star in at least this share (%) of its
 *  games, 50 on floor 11 down to 30 on floor 20 - a solid player can win every floor. */
const hardMin = (stage) => 50 - ((stage - 11) * 20) / 9;

/** ... and Mittel with 10 % slips in 40-80 % (floor 11) down to 10-50 % (floor 20): wide,
 *  since gated deals' medium rates split into ~0-20 % and ~60-100 % (docs/overview.md). */
const mediumMin = (stage) => 40 - ((stage - 11) * 30) / 9;
const mediumMax = (stage) => mediumMin(stage) + 40;

/** Floors 1-10: Hard's star must not be a landslide (floor 10: 60 points). */
const marginCap = (stage) => 260 - 20 * stage;

/** Accepted medium rate [lo, hi] on floors 11-20. */
const mediumWindow = (stage) => [mediumMin(stage), mediumMax(stage)];

/** FNV-1a (32 bit). */
function fnv(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

/** The i-th candidate deal of a floor: the same on every replica and after every
 *  restart. `lane` keeps separate searches (fallback, emergency) apart. */
const candidateSeed = (month, stage, i, lane = 'a') => fnv(`${month}|${stage}|${lane}|${i}`) || 1;

module.exports = {
  GEN_VERSION, MEDIUM_GAMES, HARD_GAMES, MAX_TRIES, NEAREST_TRIES,
  hardMin, mediumMin, mediumMax, mediumWindow, marginCap, fnv, candidateSeed,
};

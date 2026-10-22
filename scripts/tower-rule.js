// scripts/tower-rule.js - the acceptance rule of Kartenhaus floors 11-20, shared
// by tower-seeds.js and test/tower-proofs.test.js (so the test checks what the
// generator promises).
'use strict';

/** Target star rate (%) of a medium player (Mittel, 10 % random moves): 45 on floor 11 down to 13 on floor 20. */
const target = (stage) => 45 - ((stage - 11) * 32) / 9;

/** Accepted medium rate: within +-10 pp of the target, at least 8 %, at most
 *  5 pp above the floor below (`prev`, null on floor 11). */
function mediumWindow(stage, prev) {
  const t = target(stage);
  const hi = prev == null ? t + 10 : Math.min(t + 10, prev + 5);
  return [Math.max(8, t - 10), hi];
}

module.exports = { target, mediumWindow };

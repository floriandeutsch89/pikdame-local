// game/Celebrations.js
// The ONE list of victory celebrations: the server accepts a choice only from
// here, the client mirrors ids and levels (contract test) and owns the
// bilingual names. Only the id travels over the wire.
//
// 'standard' is the classic confetti only the winner sees; every other one is
// shown to the whole table when its owner wins.

const CELEBRATION_DEFS = [
  { id: 'standard', level: 1 },
  { id: 'cats', level: 10 },
  { id: 'fireworks', level: 20 },
  { id: 'cardfan', level: 35 },
  { id: 'goldqueen', level: 50 },
];

const CELEBRATION_IDS = CELEBRATION_DEFS.map((c) => c.id);

function isCelebration(id) {
  return typeof id === 'string' && CELEBRATION_IDS.includes(id);
}

/** Level needed for a celebration (1 for 'standard'); unknown ids are never unlocked. */
function celebrationLevel(id) {
  const def = CELEBRATION_DEFS.find((c) => c.id === id);
  return def ? def.level : Infinity;
}

module.exports = { CELEBRATION_DEFS, CELEBRATION_IDS, isCelebration, celebrationLevel };

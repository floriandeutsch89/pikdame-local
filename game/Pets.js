// game/Pets.js
// The ONE list of table pets: the server accepts a choice only from here, the
// client mirrors ids and levels (contract test) and owns names and drawings.
// Only the id travels over the wire. 'none' is no pet; every other one sits
// at its owner's seat for the whole table to see.

const PET_DEFS = [
  { id: 'none', level: 1 },
  { id: 'cat', level: 12 },
];

const PET_IDS = PET_DEFS.map((p) => p.id);

function isPet(id) {
  return typeof id === 'string' && PET_IDS.includes(id);
}

/** Level needed for a pet (1 for 'none'); unknown ids are never unlocked. */
function petLevel(id) {
  const def = PET_DEFS.find((p) => p.id === id);
  return def ? def.level : Infinity;
}

module.exports = { PET_DEFS, PET_IDS, isPet, petLevel };

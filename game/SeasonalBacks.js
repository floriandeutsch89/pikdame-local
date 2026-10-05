// game/SeasonalBacks.js
// Seasonal card backs: unlocked by finishing a game in their month (German
// game day, see GameDay), kept forever. The client mirrors ids and months
// (contract test) - it only draws, the profile is the record.

const SEASONAL_BACKS = [
  { id: 'pumpkin', month: 10 },
  { id: 'winter', month: 12 },
];

/** The seasonal back that a game finished on `dateStr` ("YYYY-MM-DD") unlocks, or null. */
function seasonalBackFor(dateStr) {
  const month = Number(String(dateStr || '').slice(5, 7));
  const hit = SEASONAL_BACKS.find((b) => b.month === month);
  return hit ? hit.id : null;
}

module.exports = { SEASONAL_BACKS, seasonalBackFor };

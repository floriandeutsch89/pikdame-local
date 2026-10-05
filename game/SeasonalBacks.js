// game/SeasonalBacks.js
// Seasonal card backs: unlocked by finishing a game inside their window
// (German game day, see GameDay), kept forever. The client mirrors the ids
// (contract test) - it only draws, the profile is the record.

const { addDays } = require('./GameDay');

/** Easter Sunday of `year` as "YYYY-MM-DD" (anonymous Gregorian algorithm). */
function easterSunday(year) {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

const SEASONAL_BACKS = [
  { id: 'pumpkin', open: (d) => d.slice(5, 7) === '10' },
  { id: 'winter', open: (d) => d.slice(5, 7) === '12' },
  { id: 'christmas', open: (d) => d.slice(5) >= '12-24' && d.slice(5) <= '12-26' },
  { id: 'easter', open: (d) => {
    const sunday = easterSunday(Number(d.slice(0, 4)));
    return d >= addDays(sunday, -2) && d <= addDays(sunday, 1); // Good Friday .. Easter Monday
  } },
];

/** Seasonal backs a game finished on `dateStr` ("YYYY-MM-DD") unlocks (may be several). */
function seasonalBacksFor(dateStr) {
  const d = String(dateStr || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return [];
  return SEASONAL_BACKS.filter((b) => b.open(d)).map((b) => b.id);
}

module.exports = { SEASONAL_BACKS, seasonalBacksFor, easterSunday };

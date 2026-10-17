// game/Holidays.js
// Holiday decor on the start screen, for everyone. The server's German game
// day decides (GameDay); clients only learn today's and tomorrow's windows
// (via /statusz), so they can switch at midnight without knowing a date.

const { gameDay, addDays, dayEnd } = require('./GameDay');
const { easterSunday } = require('./SeasonalBacks');

const FIXED_DAYS = {
  '10-31': 'halloween',
  '12-06': 'nikolaus',
  '12-24': 'christmas',
  '12-25': 'christmas',
  '12-26': 'christmas',
  '12-31': 'silvester',
  '01-01': 'newyear',
};
const HOLIDAY_IDS = ['halloween', 'nikolaus', 'christmas', 'silvester', 'newyear', 'easter'];

/** Holiday id of a "YYYY-MM-DD" game day, or null. */
function holidayFor(date) {
  const d = String(date || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return null;
  if (FIXED_DAYS[d.slice(5)]) return FIXED_DAYS[d.slice(5)];
  // Easter Sunday and Monday; Good Friday is a quiet holiday, no bunnies.
  const sunday = easterSunday(Number(d.slice(0, 4)));
  return d === sunday || d === addDays(sunday, 1) ? 'easter' : null;
}

/** `[{ id, from, until }]` (epoch ms) for today and tomorrow, at most two. */
function holidayWindows(now = Date.now()) {
  const today = gameDay(now);
  const out = [];
  for (const date of [today, addDays(today, 1)]) {
    const id = holidayFor(date);
    if (id) out.push({ id, from: dayEnd(addDays(date, -1)), until: dayEnd(date) });
  }
  return out;
}

/** What /statusz sends: the windows plus when they go stale (next game day),
 *  so an open client asks again once a day instead of polling. */
function holidayStatus(now = Date.now()) {
  return { windows: holidayWindows(now), refreshAt: dayEnd(gameDay(now)) };
}

module.exports = { HOLIDAY_IDS, holidayFor, holidayWindows, holidayStatus };

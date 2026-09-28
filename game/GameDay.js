// game/GameDay.js
// The ONE definition of "today" for everything daily: challenge deck and
// leaderboard, daily quests, daily puzzle, streak, week and season. The day
// flips at midnight German time (Europe/Berlin, DST-aware) - the table
// decided that the new challenge must be playable at 00:00 local time, not
// at 02:00 (00:00 UTC in summer). Dates are "YYYY-MM-DD" strings; all day
// arithmetic works on those calendar strings, never in 24h steps (DST days
// have 23 or 25 hours).

const GAME_TZ = 'Europe/Berlin';
const DAY_MS = 24 * 60 * 60 * 1000;

let formatter = null;
try {
  // en-CA formats as YYYY-MM-DD. Node ships full ICU (also node:alpine).
  formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: GAME_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
} catch (e) {
  formatter = null; // no time zone data: fall back to UTC below
}

/** Calendar date of the game day at `now` (epoch ms). */
function gameDay(now = Date.now()) {
  if (formatter) {
    const s = formatter.format(new Date(now));
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  }
  return new Date(now).toISOString().slice(0, 10);
}

/** Calendar arithmetic on a "YYYY-MM-DD" string. */
function addDays(date, days) {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** Weekday of a "YYYY-MM-DD" string, Monday = 0 .. Sunday = 6. */
function weekdayIndex(date) {
  return (new Date(Date.parse(`${date}T00:00:00Z`)).getUTCDay() + 6) % 7;
}

/** Offset of the game time zone from UTC at instant `t`, in ms. */
function zoneOffsetMs(t) {
  if (!formatter) return 0;
  try {
    const parts = {};
    for (const p of new Intl.DateTimeFormat('en-US', {
      timeZone: GAME_TZ,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    }).formatToParts(new Date(t))) parts[p.type] = Number(p.value);
    const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
    return asUtc - Math.floor(t / 1000) * 1000;
  } catch (e) {
    return 0;
  }
}

/** Epoch ms at which `date` ends (next midnight in the game time zone). */
function dayEnd(date) {
  const start = Date.parse(`${date}T00:00:00Z`);
  if (!Number.isFinite(start)) return 0;
  const utcMidnight = start + DAY_MS;
  // DST switches happen at 02:00/03:00, never at midnight, so one
  // correction step lands exactly on local midnight.
  return utcMidnight - zoneOffsetMs(utcMidnight - zoneOffsetMs(utcMidnight));
}

module.exports = { GAME_TZ, gameDay, addDays, weekdayIndex, dayEnd };

// game/GreetingDays.js
// Greeting days for configured accounts (PIKDAME_BIRTHDAY, "MM-DD:account"
// entries, comma separated). The server alone knows them; a signed-in account
// learns its own window, nobody else learns anything.

const { gameDay, addDays, dayEnd } = require('./GameDay');

const MONTH_DAY = /^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

/** Parses the variable. Returns the valid entries and the 1-based positions of
 *  the invalid ones (positions only: the values are personal). */
function parseGreetingDays(raw) {
  const entries = [];
  const invalid = [];
  String(raw || '').split(',').forEach((part, i) => {
    if (!part.trim()) return;
    const sep = part.indexOf(':');
    const md = sep > 0 ? part.slice(0, sep).trim() : '';
    const name = sep > 0 ? part.slice(sep + 1).trim().toLowerCase() : '';
    // 2024 is a leap year: rejects 02-30 and 04-31, keeps 02-29.
    const real = MONTH_DAY.test(md) && new Date(`2024-${md}T00:00:00Z`).toISOString().slice(5, 10) === md;
    if (real && name) entries.push({ md, name });
    else invalid.push(i + 1);
  });
  return { entries, invalid };
}

/** `{ from, until }` (epoch ms) of the account's greeting day when that game
 *  day is today or tomorrow, else null - far-away dates are never revealed. */
function greetingWindow(entries, username, now = Date.now()) {
  const name = String(username || '').trim().toLowerCase();
  if (!name || !entries || !entries.length) return null;
  const today = gameDay(now);
  for (const date of [today, addDays(today, 1)]) {
    if (entries.some((e) => e.name === name && e.md === date.slice(5))) {
      return { from: dayEnd(addDays(date, -1)), until: dayEnd(date) };
    }
  }
  return null;
}

module.exports = { parseGreetingDays, greetingWindow };

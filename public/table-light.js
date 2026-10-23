// public/table-light.js
// The table's light follows the time of day in German time: four phase weights
// for #table (--tod-m/d/e/n). Colours live in style.css ("Table light"); this
// file only knows the clock. Loaded before client.js; the tests require() it.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PikdameTableLight = api;
}(typeof self !== 'undefined' ? self : this, () => {
  'use strict';

  const TZ = 'Europe/Berlin'; // the game's zone (game/GameDay.js)
  const DAY_MIN = 24 * 60;
  const UPDATE_MS = 60 * 1000; // one step a minute stays below a visible colour change
  const PHASES = ['m', 'd', 'e', 'n'];
  const H = (h, m = 0) => h * 60 + m;
  // Plateaus round the clock (Berlin minutes); a smoothstep ramp joins each to
  // the next. The night covers 02:00-03:00, so a DST switch never shows.
  const PLATEAUS = [
    { phase: 'n', from: H(23, 30), to: H(5) },
    { phase: 'm', from: H(7), to: H(9, 30) },
    { phase: 'd', from: H(11), to: H(16, 30) },
    { phase: 'e', from: H(18, 30), to: H(22) },
  ];

  let clock = null;
  try {
    clock = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hourCycle: 'h23', hour: 'numeric', minute: 'numeric', second: 'numeric' });
  } catch (e) {
    clock = null; // no time zone data: UTC below, like GameDay
  }

  /** Minutes since midnight in German time at `now` (epoch ms), seconds as a
   *  fraction; UTC without time zone data. */
  function berlinMinutes(now = Date.now()) {
    if (clock) {
      try {
        const p = {};
        for (const part of clock.formatToParts(new Date(now))) p[part.type] = Number(part.value);
        const h = p.hour % 24; // some engines print midnight as 24
        if (Number.isInteger(h) && Number.isInteger(p.minute) && Number.isInteger(p.second) && h >= 0 && p.minute < 60) {
          return h * 60 + p.minute + p.second / 60;
        }
      } catch (e) { /* fall through to UTC */ }
    }
    const d = new Date(now);
    return d.getUTCHours() * 60 + d.getUTCMinutes() + d.getUTCSeconds() / 60;
  }

  const smooth = (x) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));
  const inArc = (x, a, b) => (a <= b ? x >= a && x < b : x >= a || x < b);

  /** Phase weights { m, d, e, n } (sum 1) at `minutes` past Berlin midnight. */
  function phaseWeights(minutes) {
    const x = ((minutes % DAY_MIN) + DAY_MIN) % DAY_MIN;
    const w = { m: 0, d: 0, e: 0, n: 0 };
    for (let i = 0; i < PLATEAUS.length; i++) {
      const p = PLATEAUS[i];
      const next = PLATEAUS[(i + 1) % PLATEAUS.length];
      if (inArc(x, p.from, p.to)) {
        w[p.phase] = 1;
        return w;
      }
      if (inArc(x, p.to, next.from)) {
        const span = (next.from - p.to + DAY_MIN) % DAY_MIN;
        const t = smooth(((x - p.to + DAY_MIN) % DAY_MIN) / span);
        w[p.phase] = 1 - t;
        w[next.phase] = t;
        return w;
      }
    }
    w.d = 1; // not reached: the arcs cover the whole day
    return w;
  }

  /** The weights at `now` as #table custom properties ({ '--tod-m': '0.0000', ... }). */
  function cssWeights(now = Date.now()) {
    const w = phaseWeights(berlinMinutes(now));
    const out = {};
    for (const k of PHASES) out[`--tod-${k}`] = w[k].toFixed(4);
    return out;
  }

  return { TZ, UPDATE_MS, PHASES, PLATEAUS, berlinMinutes, phaseWeights, cssWeights };
}));

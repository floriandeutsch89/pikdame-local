// game/PuzzleAttempts.js
// Daily-puzzle attempts for play_attempts (written through PlayEvents.record): one per
// name and live day, from the first look until solved (won), the solution shown (lost)
// or the day over with something tried (abandoned, 'dayEnd'). Open attempts live here
// and in the session snapshot; the attempt id `puzzle:<day>:<name key>` keeps a day
// one row, also when a restart closes it twice. Never throws into the puzzle handler.
'use strict';
const { nameKey, PUZZLE_FAULTS, puzzleCause } = require('./PlayEvents');

const KINDS = ['meld', 'turn', 'out'];
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
// Attempts begun per day at most (names are client input): bounds memory and rows.
const MAX_PER_DAY = 20000;

/** The mistake a meld check shows: an invalid meld, a malformed one, or none. */
function meldFault(check) {
  if (!check || check.valid) return null;
  return check.fault === 'meld' ? 'meld' : 'other';
}

/** The mistake a graded answer shows (DailyPuzzle.checkAnswer), or none for a solve. */
function answerFault(kind, result) {
  if (!result) return 'other';
  if (!result.valid) return result.fault === 'meld' || result.fault === 'discard' ? result.fault : 'other';
  if (result.solved) return null;
  return kind === 'out' ? 'notOut' : 'points';
}

const over = (status) => !!(status && (status.solved || status.revealed));

/**
 * @param {object} o
 * @param {(event: object) => any} o.record  PlayEvents.record (background, never throws)
 * @param {() => number} [o.now]
 * @param {number} [o.maxPerDay]
 * @param {(line: string) => void} [o.log]
 */
function createPuzzleAttempts({ record, now = () => Date.now(), maxPerDay = MAX_PER_DAY, log = (line) => console.log(line) } = {}) {
  const open = new Map(); // `${day}|${key}` -> attempt
  const closed = new Set(); // written in this run: no second write of the same day
  const begun = new Map(); // day -> attempts begun

  const idOf = (day, key) => `${day}|${key}`;

  function find(name, day, kind, create) {
    const key = nameKey(name);
    if (!key || !DAY_RE.test(String(day))) return null;
    const id = idOf(day, key);
    if (closed.has(id)) return null;
    let a = open.get(id);
    if (!a && create) {
      const n = begun.get(day) || 0;
      if (n >= maxPerDay) {
        if (n === maxPerDay) log(`[play-events] puzzle: ${maxPerDay} attempts on ${day}, no more tracked that day`);
        begun.set(day, n + 1);
        return null;
      }
      begun.set(day, n + 1);
      a = { name: '', day, kind: 'meld', openedAt: now(), lastAt: null, tries: 0, wrong: {}, firstWrong: null };
      open.set(id, a);
    }
    if (a) {
      a.name = String(name).trim();
      if (KINDS.includes(kind)) a.kind = kind;
    }
    return a;
  }

  function forget(name, day) {
    open.delete(idOf(day, nameKey(name)));
  }

  function mistake(a, fault) {
    a.wrong[fault] = (a.wrong[fault] || 0) + 1;
    if (!a.firstWrong) a.firstWrong = fault;
  }

  function close(a, outcome, extra, endedAt = now()) {
    const key = nameKey(a.name);
    open.delete(idOf(a.day, key));
    closed.add(idOf(a.day, key));
    const mistakes = Object.values(a.wrong).reduce((n, v) => n + v, 0);
    const facts = { kind: a.kind, mistakes, wrong: { ...a.wrong }, ...extra };
    if (a.firstWrong) facts.firstWrong = a.firstWrong;
    if (outcome !== 'won') facts.cause = puzzleCause(facts);
    record({
      attemptId: `puzzle:${a.day}:${key}`,
      startedAt: a.openedAt,
      endedAt,
      name: a.name,
      mode: 'puzzle',
      period: a.day,
      stage: null,
      outcome,
      turns: a.tries,
      facts,
    });
  }

  const guard = (fn) => (...args) => {
    try { return fn(...args); } catch (e) { log(`[play-events] puzzle attempt not tracked: ${e.message}`); return undefined; }
  };

  /** Days before `today` are over: something tried = abandoned, a mere look is dropped. */
  function sweep(today) {
    for (const [id, a] of open) {
      if (a.day >= today) continue;
      if (a.lastAt) close(a, 'abandoned', { reason: 'dayEnd' }, a.lastAt);
      else open.delete(id);
    }
    for (const id of closed) if (id.slice(0, 10) < today) closed.delete(id);
    for (const day of begun.keys()) if (day < today) begun.delete(day);
  }

  /** Back from a snapshot (checked field by field), then the days that are over are swept. */
  function restore(list, today) {
    const int = (v) => (Number.isFinite(v) && v >= 0 ? Math.round(v) : 0);
    for (const raw of Array.isArray(list) ? list : []) {
      if (!raw || typeof raw.name !== 'string' || !nameKey(raw.name) || !DAY_RE.test(String(raw.day))) continue;
      const wrong = {};
      for (const f of PUZZLE_FAULTS) if (int(raw.wrong && raw.wrong[f]) > 0) wrong[f] = int(raw.wrong[f]);
      begun.set(raw.day, (begun.get(raw.day) || 0) + 1);
      open.set(idOf(raw.day, nameKey(raw.name)), {
        name: raw.name.trim(),
        day: raw.day,
        kind: KINDS.includes(raw.kind) ? raw.kind : 'meld',
        openedAt: int(raw.openedAt) || now(),
        lastAt: int(raw.lastAt) || null,
        tries: int(raw.tries),
        wrong,
        firstWrong: PUZZLE_FAULTS.includes(raw.firstWrong) ? raw.firstWrong : null,
      });
    }
    if (today) sweep(today);
  }

  return {
    /** getPuzzle of the live day: the clock starts at the first look. */
    opened: guard((name, day, kind, status) => {
      if (over(status)) return forget(name, day);
      find(name, day, kind, true);
    }),
    /** checkPuzzleMeld: a refused meld is a mistake, never a try. */
    meldChecked: guard((name, day, kind, check, status) => {
      if (over(status)) return forget(name, day);
      const a = find(name, day, kind, true);
      if (!a) return;
      a.lastAt = now();
      const fault = meldFault(check);
      if (fault) mistake(a, fault);
    }),
    /** solvePuzzle; `status` is the profile's day after the try (PlayerStore). */
    tried: guard((name, day, kind, result, status) => {
      const st = status || {};
      if (!st.justSolved && over(st)) return forget(name, day);
      const a = find(name, day, kind, true);
      if (!a) return;
      a.lastAt = now();
      a.tries = Number.isInteger(st.tries) ? st.tries : a.tries + 1;
      if (st.justSolved) return close(a, 'won', { stars: Number(st.stars) || 0 });
      const fault = answerFault(a.kind, result);
      if (fault) mistake(a, fault);
    }),
    /** revealPuzzle: given up, unless the day was solved already. */
    revealed: guard((name, day, kind, status) => {
      const st = status || {};
      if (st.solved) return forget(name, day);
      const a = find(name, day, kind, true);
      if (!a) return;
      a.lastAt = now();
      if (Number.isInteger(st.tries)) a.tries = st.tries;
      close(a, 'lost', { gaveUp: true });
    }),
    sweep: guard(sweep),
    restore: guard(restore),
    /** Open attempts for the session snapshot. */
    serialize: () => [...open.values()].map((a) => ({ ...a, wrong: { ...a.wrong } })),
    size: () => open.size,
  };
}

module.exports = { createPuzzleAttempts, meldFault, answerFault, MAX_PER_DAY };

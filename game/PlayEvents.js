// game/PlayEvents.js
// Play attempts for balancing and support: one row per finished or abandoned
// attempt in play_attempts (admin tab "Festhänger"), kept RETENTION_DAYS. The ONE
// module that writes, prunes and reads them. A write never blocks or breaks a game.
// Instants are ms here and TIMESTAMPTZ in the table (converted at this boundary).
// Modes: 'tower' (a Kartenhaus floor), 'puzzle' (a name's daily puzzle, built in
// PuzzleAttempts.js), 'tutorial' (round 1 of one tutorial table).
'use strict';
const { createPool } = require('./Database');
const { ensureMigrated } = require('./Migrations');
const { gameDay } = require('./GameDay');
const { cardValue, isPikDame } = require('./Card');
const BotTower = require('./BotTower');
const { TUTORIAL_VERSION, TUTORIAL_STEPS, isTutorialStep, tutorialStepIndex } = require('./TutorialSteps');

const RETENTION_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;
const MODES = ['tower', 'puzzle', 'tutorial'];
const OUTCOMES = ['won', 'lost', 'abandoned'];
// facts.reason of an abandoned attempt: given up in the game, left from the
// start screen, did not come back in time, table removed while open, lost in a
// restart; tutorial hints switched off; a puzzle day over with tries but no solve.
const ABANDON_REASONS = ['forfeit', 'left', 'timeout', 'expired', 'restart', 'skipped', 'dayEnd'];
// facts.cause of a Kartenhaus attempt without a star; ties go to the earlier one.
const TOWER_CAUSES = ['queen', 'jokers', 'goOut', 'emptyDraw', 'stalemate', 'margin', 'abandoned'];
const STUCK_MIN_ATTEMPTS = 3;
// "Knick": a floor's win rate at most half the floor below's, both with this many attempts.
const WALL_MIN_ATTEMPTS = 5;
// Puzzle mistakes (facts.wrong, firstWrong, cause): a meld that is no set or run, no
// card left to discard, short of the target, cards left over (out), malformed; ties: earlier.
const PUZZLE_FAULTS = ['meld', 'discard', 'points', 'notOut', 'other'];
const PUZZLE_CAUSES = [...PUZZLE_FAULTS, 'noTry'];
// A puzzle attempt is stuck without a solve: given up, or this many mistakes.
const PUZZLE_STUCK_MISTAKES = 3;
const PUZZLE_STUCK_SQL = `outcome <> 'won' AND (outcome = 'lost' OR COALESCE((facts->>'mistakes')::int, 0) >= ${PUZZLE_STUCK_MISTAKES})`;
// "schwer": the days with the lowest solve rate, each with this many attempts.
const PUZZLE_HARD_DAYS = 3;
const PUZZLE_HARD_MIN_ATTEMPTS = 5;
// facts.cause of a tutorial stopped early; refusals at its last lesson that make it 'stuck'.
const TUTORIAL_CAUSES = ['stuck', 'skipped', 'left', 'away'];
const TUTORIAL_STUCK_REFUSALS = 3;
// Tutorial "Knick": a lesson losing at least twice the average share, with enough players.
const FUNNEL_WALL_MIN_REACHED = 5;
const FUNNEL_WALL_MIN_DROPPED = 3;

const nameKey = (name) => String(name || '').trim().toLowerCase();
const toInt = (v) => (Number.isFinite(v) ? Math.max(-2147483648, Math.min(2147483647, Math.round(v))) : null);
const points = (cards) => (cards || []).reduce((n, c) => n + cardValue(c), 0);

/** What a hand held when the attempt ended. */
function handFacts(hand = []) {
  return {
    queenInHand: hand.filter(isPikDame).length,
    jokersInHand: hand.filter((c) => c.isJoker).length,
    handCards: hand.length,
    handPoints: points(hand),
  };
}

/** Why a played-out floor gave no star. A Queen of Spades or jokers in hand
 *  count only when they alone cost the star. */
function towerCause(f) {
  if (f.mods && f.mods.includes('goOut') && f.end !== 'me' && f.margin > 0) return 'goOut';
  if (f.queenInHand > 0 && f.margin + 100 * f.queenInHand > 0) return 'queen';
  if (f.jokersInHand > 0 && f.margin + 20 * f.jokersInHand > 0) return 'jokers';
  if (f.end === 'emptyDraw' || f.end === 'stalemate') return f.end;
  return 'margin';
}

/** The row of a Kartenhaus attempt (null for other games); `game` is a GameManager or its snapshot
 *  state. 'finished' grades the record (won = a star), 'abandoned' scores the table as it stood. */
function towerAttemptEvent(game, { outcome, reason = null } = {}, endedAt = Date.now()) {
  const human = game && game.towerStage && game.roundNumber > 0 ? (game.players || []).find((p) => !p.isBot) : null;
  const cfg = human ? BotTower.stageConfig(game.towerStage, game.towerMonth || null) : null;
  if (!cfg) return null;
  const event = {
    startedAt: game.gameStartedAt || null,
    endedAt,
    name: human.name,
    mode: 'tower',
    period: cfg.month,
    stage: cfg.stage,
    turns: game.gameTurnCount || 0,
    attemptId: game.attemptId || null,
  };
  const mods = cfg.mods ? { mods: [...cfg.mods] } : {};
  if (outcome === 'finished') {
    const record = game.lastGameRecord;
    const o = BotTower.outcomeFromRecord(record, human.id);
    if (!o) return null;
    const round = record.rounds[0];
    let end = 'stalemate'; // nobody out, cards left to draw: 160 turns without a meld
    if (round.winnerId) end = round.winnerId === human.id ? 'me' : 'bot';
    else if (!(game.drawPile || []).length) end = 'emptyDraw';
    const facts = {
      stars: o.stars, score: o.myScore, bestBot: o.bestBot, handicap: o.handicap, margin: o.margin, end,
      queenLaid: (round.results[human.id].breakdown || {}).pikDameLaidOut || 0,
      ...handFacts(human.hand), ...mods,
    };
    if (o.stars < 1) facts.cause = towerCause(facts);
    if (record.startedAt && record.finishedAt) event.startedAt = endedAt - (record.finishedAt - record.startedAt);
    return { ...event, outcome: o.stars >= 1 ? 'won' : 'lost', facts };
  }
  const score = (p) => points(p.laidOutCards) - points(p.hand);
  const bots = game.players.filter((p) => p.isBot);
  const myScore = score(human);
  const bestBot = bots.length ? Math.max(...bots.map(score)) : 0;
  const facts = {
    reason: ABANDON_REASONS.includes(reason) ? reason : 'expired',
    cause: 'abandoned',
    score: myScore, bestBot, handicap: cfg.handicap, margin: myScore - cfg.handicap - bestBot,
    ...handFacts(human.hand), ...mods,
  };
  return { ...event, outcome: 'abandoned', facts };
}

/** Why a tutorial stopped before its end: refused again and again at its last
 *  lesson, hints switched off, left the table, or gone without coming back. */
function tutorialCause(f) {
  if (f.step && ((f.errors || {})[f.step] || 0) >= TUTORIAL_STUCK_REFUSALS) return 'stuck';
  if (f.reason === 'skipped') return 'skipped';
  if (f.reason === 'left' || f.reason === 'forfeit') return 'left';
  return 'away';
}

/** The row of a tutorial attempt (null for other games): 'finished' is the scoring of
 *  round 1, anything else ended it early. Lessons and times come from tutorialTrack. */
function tutorialAttemptEvent(game, { outcome, reason = null } = {}, endedAt = Date.now()) {
  const t = game && game.tutorialMode && game.roundNumber > 0 ? game.tutorialTrack : null;
  const human = t ? (game.players || []).find((p) => !p.isBot) : null;
  if (!human) return null;
  const won = outcome === 'finished';
  const at = (map, key) => (map && Number.isFinite(map[key]) ? map[key] : null);
  const first = (key) => Math.min(at(t.shown, key) ?? Infinity, at(t.done, key) ?? Infinity);
  // Order of first appearance; a lesson done without being shown was reached too.
  const reached = TUTORIAL_STEPS.map((s) => s.key).filter((k) => first(k) < Infinity).sort((a, b) => first(a) - first(b));
  // The scoring of round 1 IS the last lesson: it shows with the round sheet.
  if (won && !reached.includes('roundend')) reached.push('roundend');
  const step = won ? 'roundend' : (isTutorialStep(t.last) ? t.last : reached[reached.length - 1] || null);
  const sec = {};
  for (const k of reached) {
    const from = at(t.shown, k);
    const to = at(t.done, k) ?? (k === step && !won ? endedAt : null);
    if (from != null && to != null && to >= from) sec[k] = Math.round((to - from) / 1000);
  }
  const errors = {};
  for (const k of reached) if (Number(t.errors && t.errors[k]) > 0) errors[k] = Math.round(Number(t.errors[k]));
  const facts = {
    step, reached, done: reached.filter((k) => at(t.done, k) != null || (won && k === 'roundend')),
    sec, errors, refusals: Number(t.refusals) || 0,
  };
  if (!won) {
    facts.reason = ABANDON_REASONS.includes(reason) ? reason : 'expired';
    facts.cause = tutorialCause(facts);
  }
  return {
    startedAt: game.gameStartedAt || null,
    endedAt,
    name: human.name,
    mode: 'tutorial',
    period: typeof t.version === 'string' ? t.version : TUTORIAL_VERSION,
    stage: tutorialStepIndex(step),
    turns: game.gameTurnCount || 0,
    attemptId: game.attemptId || null,
    outcome: won ? 'won' : 'abandoned',
    facts,
  };
}

/** The row for the end of a solo table's attempt (Kartenhaus or tutorial), or null. */
function attemptEvent(game, info, endedAt = Date.now()) {
  return towerAttemptEvent(game, info, endedAt) || tutorialAttemptEvent(game, info, endedAt);
}

/** The mistake most of a puzzle attempt's mistakes share ('noTry': none at all). */
function puzzleCause(facts) {
  const best = topCause((facts && facts.wrong) || {}, PUZZLE_FAULTS);
  return best ? best.cause : 'noTry';
}

/** An attempt that has begun and not been written yet (a snapshot's tables). */
function attemptOpen(game) {
  return !!(game && game.roundNumber > 0 && !game.attemptOver && !['gameOver', 'abandoned', 'lobby'].includes(game.phase));
}

/** The cause most of a stuck player's attempts share: { cause, n }; ties: earlier in `order`. */
function topCause(causes = {}, order = TOWER_CAUSES) {
  let best = null;
  for (const cause of order) {
    const n = Number(causes[cause]) || 0;
    if (n > 0 && (!best || n > best.n)) best = { cause, n };
  }
  return best;
}

/** Rates per floor plus the "Knick": a win rate at most half the floor below's. */
function shapeFloors(rows, stuckByStage) {
  const floors = rows.map((r) => ({
    stage: r.stage,
    attempts: r.attempts,
    players: r.players,
    cleared: r.cleared,
    won: r.won,
    abandoned: r.abandoned,
    winRate: r.attempts ? r.won / r.attempts : null,
    abandonRate: r.attempts ? r.abandoned / r.attempts : null,
    medianTurns: r.median_turns == null ? null : Math.round(Number(r.median_turns)),
    stuck: stuckByStage[r.stage] || 0,
    wall: false,
  }));
  for (let i = 1; i < floors.length; i++) {
    const f = floors[i];
    const below = floors[i - 1];
    f.wall = below.stage === f.stage - 1 && f.attempts >= WALL_MIN_ATTEMPTS && below.attempts >= WALL_MIN_ATTEMPTS
      && below.winRate > 0 && f.winRate <= below.winRate / 2;
  }
  return floors;
}

const rate = (n, of) => (of ? n / of : null);

// Seconds as histogram buckets (exact to 10 min, then minutes, capped at 3 h): a hash
// aggregate instead of percentile_cont, whose sort of every row spilled past work_mem.
const secBucketSql = (sec) => `CASE WHEN ${sec} < 600 THEN ${sec} WHEN ${sec} < 10800 THEN ${sec} / 60 * 60 ELSE 10800 END`;

/** The median (lower middle, like percentile_disc) of [value, count] pairs, or null. */
function histogramMedian(pairs) {
  const sorted = pairs.filter(([, n]) => n > 0).sort((a, b) => a[0] - b[0]);
  const total = sorted.reduce((s, [, n]) => s + n, 0);
  let seen = 0;
  for (const [value, n] of sorted) {
    seen += n;
    if (seen * 2 >= total) return value;
  }
  return null;
}

/** Puzzle days, newest first: rates, their most common mistake and "schwer" (the
 *  lowest solve rates with enough attempts). `faultRows`: { day, fault, n }. */
function shapePuzzleDays(rows, faultRows = []) {
  const faults = new Map();
  for (const r of faultRows) {
    const day = faults.get(r.day) || {};
    day[r.fault] = (day[r.fault] || 0) + r.n;
    faults.set(r.day, day);
  }
  const days = rows.map((r) => ({
    day: r.day,
    kind: r.kind || 'meld',
    attempts: r.attempts,
    solved: r.solved,
    gaveUp: r.gave_up,
    leftOpen: r.left_open,
    solveRate: rate(r.solved, r.attempts),
    giveUpRate: rate(r.gave_up, r.attempts),
    solveTries: r.solve_tries,
    avgTries: r.solved ? r.solve_tries / r.solved : null,
    stuck: r.stuck,
    faults: faults.get(r.day) || {},
    topFault: topCause(faults.get(r.day) || {}, PUZZLE_FAULTS),
    hard: false,
  }));
  days.filter((d) => d.attempts >= PUZZLE_HARD_MIN_ATTEMPTS)
    .sort((a, b) => a.solveRate - b.solveRate || b.attempts - a.attempts)
    .slice(0, PUZZLE_HARD_DAYS)
    .forEach((d) => { d.hard = true; });
  return days;
}

/** Per kind (meld, turn, out) from the shaped days; `solveRows`: { kind, sec, n } (a histogram). */
function shapePuzzleKinds(days, solveRows = []) {
  const kinds = [];
  for (const kind of ['meld', 'turn', 'out']) {
    const list = days.filter((d) => d.kind === kind);
    if (!list.length) continue;
    const sum = (f) => list.reduce((n, d) => n + d[f], 0);
    const faults = {};
    for (const d of list) for (const [f, n] of Object.entries(d.faults)) faults[f] = (faults[f] || 0) + n;
    kinds.push({
      kind,
      days: list.length,
      attempts: sum('attempts'),
      solved: sum('solved'),
      gaveUp: sum('gaveUp'),
      stuck: sum('stuck'),
      solveRate: rate(sum('solved'), sum('attempts')),
      giveUpRate: rate(sum('gaveUp'), sum('attempts')),
      avgTries: sum('solved') ? sum('solveTries') / sum('solved') : null,
      solveSec: histogramMedian(solveRows.filter((r) => r.kind === kind).map((r) => [Number(r.sec), r.n])),
      topFault: topCause(faults, PUZZLE_FAULTS),
    });
  }
  return kinds;
}

/** Tutorial lessons in their order: reached, done, stopped here, time and refusals,
 *  and the "Knick": a lesson losing at least twice the average share of its players.
 *  `factRows`: { fact: 'reached'|'done'|'errors', key, n } and { fact: 'sec', key, sec, n }. */
function shapeFunnel(factRows, dropRows) {
  const byKey = new Map(TUTORIAL_STEPS.map((s) => [s.key, { reached: 0, done: 0, refusals: 0, secs: [] }]));
  for (const r of factRows) {
    const step = byKey.get(r.key);
    if (!step) continue;
    if (r.fact === 'sec') step.secs.push([Number(r.sec), r.n]);
    else if (r.fact === 'errors') step.refusals += r.n;
    else if (r.fact === 'reached' || r.fact === 'done') step[r.fact] += r.n;
  }
  const dropped = {};
  for (const r of dropRows) dropped[r.step || ''] = (dropped[r.step || ''] || 0) + r.n;
  const steps = TUTORIAL_STEPS.map((s, i) => {
    const r = byKey.get(s.key);
    const out = dropped[s.key] || 0;
    return {
      key: s.key, index: i + 1, optional: s.optional, reached: r.reached, done: r.done, doneRate: rate(r.done, r.reached),
      dropped: out, dropRate: rate(out, r.reached), medianSec: histogramMedian(r.secs), refusals: r.refusals, wall: false,
    };
  });
  const reached = steps.reduce((n, s) => n + s.reached, 0);
  const avgDrop = reached ? steps.reduce((n, s) => n + s.dropped, 0) / reached : null;
  for (const s of steps) {
    s.wall = avgDrop > 0 && s.reached >= FUNNEL_WALL_MIN_REACHED && s.dropped >= FUNNEL_WALL_MIN_DROPPED && s.dropRate >= 2 * avgDrop;
  }
  return { steps, beforeFirst: dropped[''] || 0, avgDropRate: avgDrop };
}

// The periods of one mode, newest first: a loose index scan, one probe per period.
const PERIODS_SQL = `WITH RECURSIVE m AS (
    SELECT max(period) AS period FROM play_attempts WHERE mode = $1
    UNION ALL
    SELECT (SELECT max(period) FROM play_attempts WHERE mode = $1 AND period < m.period)
    FROM m WHERE m.period IS NOT NULL)
  SELECT period FROM m WHERE period IS NOT NULL LIMIT 12`;

const INSERT_SQL = `INSERT INTO play_attempts
  (attempt_id, player_key, player_name, mode, period, stage, outcome, game_day, started_at, ended_at, turns, facts)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
  ON CONFLICT (attempt_id) DO NOTHING`;

/** `db`: a connection string (own pool, ended by close()) or the server's shared pool.
 *  now() for tests; logError(line) takes the failures (console.error). */
function createPlayEvents(db, { now = () => Date.now(), logError = (line) => console.error(line) } = {}) {
  const ownsPool = typeof db === 'string';
  const pool = ownsPool ? createPool(db) : db;
  const ready = () => ensureMigrated(pool);
  const pending = new Set();
  let timers = null;

  function rowOf(ev) {
    if (!ev || !OUTCOMES.includes(ev.outcome)) throw new Error(`unknown outcome ${ev && ev.outcome}`);
    const name = String(ev.name || '').trim();
    if (!name || !MODES.includes(ev.mode) || !ev.period) throw new Error('name, a known mode and period are required');
    const endedAt = Number.isFinite(ev.endedAt) ? Math.round(ev.endedAt) : now();
    // Unknown or impossible start: the attempt counts as instant (ended_at - started_at = 0).
    const startedAt = Number.isFinite(ev.startedAt) && ev.startedAt <= endedAt ? Math.round(ev.startedAt) : endedAt;
    return [ev.attemptId ? String(ev.attemptId) : null, nameKey(name), name, String(ev.mode), String(ev.period),
      toInt(ev.stage), ev.outcome, gameDay(endedAt), new Date(startedAt), new Date(endedAt), toInt(ev.turns),
      JSON.stringify(ev.facts || {})];
  }

  /** Writes one attempt in the background and never throws. Resolves true when
   *  stored, false for a duplicate attempt or a failure (logged, never silent). */
  function record(ev) {
    const job = (async () => {
      const row = rowOf(ev);
      await ready();
      return (await pool.query(INSERT_SQL, row)).rowCount === 1;
    })().catch((e) => {
      logError(`[play-events] ${ev && ev.mode} ${ev && ev.period}/${ev && ev.stage} ${ev && ev.outcome} not stored: ${e.message}`);
      return false;
    });
    pending.add(job);
    job.then(() => pending.delete(job));
    return job;
  }

  /** Waits for every write still on its way (tests, shutdown). */
  async function flush() {
    while (pending.size) await Promise.all([...pending]);
  }

  /** Deletes attempts older than RETENTION_DAYS: the count, or null on failure. */
  async function prune() {
    try {
      await ready();
      const r = await pool.query('DELETE FROM play_attempts WHERE ended_at < $1', [new Date(now() - RETENTION_DAYS * DAY_MS)]);
      if (r.rowCount) console.log(`[play-events] ${r.rowCount} attempt(s) older than ${RETENTION_DAYS} days deleted`);
      return r.rowCount;
    } catch (e) {
      logError(`[play-events] retention failed: ${e.message}`);
      return null;
    }
  }

  /** Prunes soon after the start and then every few hours; the timers never keep the process alive. */
  function startRetention({ firstMs = 60 * 1000, everyMs = 6 * 60 * 60 * 1000 } = {}) {
    stopRetention();
    timers = [setTimeout(prune, firstMs), setInterval(prune, everyMs)];
    for (const t of timers) t.unref();
  }

  function stopRetention() {
    if (!timers) return;
    clearTimeout(timers[0]);
    clearInterval(timers[1]);
    timers = null;
  }

  /** Every attempt of a name (its account was deleted): the count, or null on failure. */
  async function deleteByName(name) {
    const key = nameKey(name);
    if (!key) return 0;
    try {
      await ready();
      return (await pool.query('DELETE FROM play_attempts WHERE player_key = $1', [key])).rowCount;
    } catch (e) {
      logError(`[play-events] delete failed: ${e.message}`);
      return null;
    }
  }

  /** Admin "Festhänger": a month's totals, its floors and the players stuck on one
   *  (minAttempts tries, no star), most tries first. { error } on failure. */
  async function towerReport(month, { minAttempts = STUCK_MIN_ATTEMPTS, limit = 50 } = {}) {
    try {
      await ready();
      const where = "mode = 'tower' AND period = $1 AND stage IS NOT NULL";
      const stuckGroups = `SELECT player_key, stage FROM play_attempts WHERE ${where}
        GROUP BY player_key, stage HAVING count(*) >= $2 AND NOT bool_or(outcome = 'won')`;
      const causeCounts = TOWER_CAUSES.map((c) => `'${c}', count(*) FILTER (WHERE facts->>'cause' = '${c}')`).join(', ');
      const [months, totals, floors, stuckPerFloor, stuck] = await Promise.all([
        pool.query(PERIODS_SQL, ['tower']),
        pool.query(`SELECT count(*)::int AS attempts, count(DISTINCT player_key)::int AS players,
          (count(*) FILTER (WHERE outcome = 'won'))::int AS won,
          (count(*) FILTER (WHERE outcome = 'abandoned'))::int AS abandoned
          FROM play_attempts WHERE ${where}`, [month]),
        pool.query(`SELECT stage, count(*)::int AS attempts,
          count(DISTINCT player_key)::int AS players,
          (count(DISTINCT player_key) FILTER (WHERE outcome = 'won'))::int AS cleared,
          (count(*) FILTER (WHERE outcome = 'won'))::int AS won,
          (count(*) FILTER (WHERE outcome = 'abandoned'))::int AS abandoned,
          percentile_cont(0.5) WITHIN GROUP (ORDER BY turns) FILTER (WHERE outcome <> 'abandoned') AS median_turns
          FROM play_attempts WHERE ${where} GROUP BY 1 ORDER BY 1`, [month]),
        pool.query(`SELECT stage, count(*)::int AS n FROM (${stuckGroups}) s GROUP BY 1`, [month, minAttempts]),
        pool.query(`SELECT (array_agg(player_name ORDER BY ended_at DESC))[1] AS name, stage,
          count(*)::int AS attempts, max(ended_at) AS last_at, jsonb_build_object(${causeCounts}) AS causes,
          percentile_disc(0.5) WITHIN GROUP (ORDER BY turns) FILTER (WHERE outcome = 'abandoned') AS quit_turn,
          percentile_disc(0.5) WITHIN GROUP (ORDER BY -(facts->>'margin')::int) FILTER (WHERE facts->>'cause' = 'margin') AS miss
          FROM play_attempts WHERE ${where}
          GROUP BY player_key, stage HAVING count(*) >= $2 AND NOT bool_or(outcome = 'won')
          ORDER BY attempts DESC, last_at DESC LIMIT $3`, [month, minAttempts, limit]),
      ]);
      const stuckByStage = Object.fromEntries(stuckPerFloor.rows.map((r) => [r.stage, r.n]));
      const t = totals.rows[0];
      return {
        month,
        months: months.rows.map((r) => r.period),
        minAttempts,
        totals: {
          attempts: t.attempts,
          players: t.players,
          winRate: t.attempts ? t.won / t.attempts : null,
          abandonRate: t.attempts ? t.abandoned / t.attempts : null,
          stuck: Object.values(stuckByStage).reduce((n, v) => n + v, 0),
        },
        floors: shapeFloors(floors.rows, stuckByStage),
        stuck: stuck.rows.map((r) => ({
          name: r.name,
          stage: r.stage,
          attempts: r.attempts,
          lastAt: r.last_at.getTime(),
          top: topCause(r.causes),
          quitTurn: r.quit_turn == null ? null : Number(r.quit_turn),
          miss: r.miss == null ? null : Number(r.miss),
        })),
      };
    } catch (e) {
      logError(`[play-events] tower report failed: ${e.message}`);
      return { error: e.message };
    }
  }

  /** Admin "Festhänger", daily puzzle: the days `from`..`to` (YYYY-MM-DD) with kind,
   *  rates and mistakes, per kind, and the players stuck on a day (given up, or
   *  PUZZLE_STUCK_MISTAKES mistakes without a solve), most days first. { error } on failure. */
  async function puzzleReport({ from, to, limit = 50 } = {}) {
    try {
      await ready();
      const where = "mode = 'puzzle' AND period >= $1 AND period <= $2";
      const causeCounts = PUZZLE_CAUSES.map((c) => `'${c}', count(*) FILTER (WHERE cause = '${c}')`).join(', ');
      const [days, faults, players, solveTimes, stuck] = await Promise.all([
        // One kind per day: grouped by the day alone (a hash of a few rows, no sort).
        pool.query(`SELECT period AS day, min(facts->>'kind') AS kind, count(*)::int AS attempts,
          (count(*) FILTER (WHERE outcome = 'won'))::int AS solved,
          (count(*) FILTER (WHERE outcome = 'lost'))::int AS gave_up,
          (count(*) FILTER (WHERE outcome = 'abandoned'))::int AS left_open,
          COALESCE(sum(turns) FILTER (WHERE outcome = 'won'), 0)::int AS solve_tries,
          (count(*) FILTER (WHERE ${PUZZLE_STUCK_SQL}))::int AS stuck
          FROM play_attempts WHERE ${where} GROUP BY period ORDER BY period DESC`, [from, to]),
        pool.query(`SELECT period AS day, f.key AS fault, sum(f.value::int)::int AS n
          FROM play_attempts, jsonb_each_text(facts->'wrong') AS f WHERE ${where} GROUP BY 1, 2`, [from, to]),
        // Players and stuck players in one pass (a hash per name, no count(DISTINCT) sort).
        pool.query(`SELECT count(*)::int AS players, (count(*) FILTER (WHERE stuck))::int AS stuck
          FROM (SELECT bool_or(${PUZZLE_STUCK_SQL}) AS stuck FROM play_attempts WHERE ${where} GROUP BY player_key) p`, [from, to]),
        pool.query(`SELECT facts->>'kind' AS kind, ${secBucketSql('x.took')} AS sec, count(*)::int AS n
          FROM play_attempts, LATERAL (SELECT extract(epoch FROM ended_at - started_at)::int AS took) AS x
          WHERE ${where} AND outcome = 'won' GROUP BY 1, 2`, [from, to]),
        // Narrow rows first: the ordered aggregates sort them, not the whole facts.
        pool.query(`SELECT (array_agg(name ORDER BY ended_at DESC))[1] AS name, count(*)::int AS days, max(day) AS last_day,
          (array_agg(kind ORDER BY day DESC))[1] AS last_kind, (array_agg(outcome ORDER BY day DESC))[1] AS last_outcome,
          sum(mistakes)::int AS mistakes, jsonb_build_object(${causeCounts}) AS causes
          FROM (SELECT player_key, player_name AS name, ended_at, period AS day, facts->>'kind' AS kind, outcome,
            COALESCE((facts->>'mistakes')::int, 0) AS mistakes, facts->>'cause' AS cause
            FROM play_attempts WHERE ${where} AND ${PUZZLE_STUCK_SQL}) s
          GROUP BY player_key ORDER BY days DESC, last_day DESC LIMIT $3`, [from, to, limit]),
      ]);
      const shaped = shapePuzzleDays(days.rows, faults.rows);
      const sum = (f) => shaped.reduce((n, d) => n + d[f], 0);
      return {
        from,
        to,
        stuckMistakes: PUZZLE_STUCK_MISTAKES,
        totals: {
          attempts: sum('attempts'),
          players: players.rows[0].players,
          solveRate: rate(sum('solved'), sum('attempts')),
          giveUpRate: rate(sum('gaveUp'), sum('attempts')),
          avgTries: sum('solved') ? sum('solveTries') / sum('solved') : null,
          stuck: players.rows[0].stuck,
        },
        kinds: shapePuzzleKinds(shaped, solveTimes.rows),
        days: shaped,
        stuck: stuck.rows.map((r) => ({
          name: r.name,
          days: r.days,
          lastDay: r.last_day,
          lastKind: r.last_kind || 'meld',
          lastOutcome: r.last_outcome,
          mistakes: r.mistakes,
          top: topCause(r.causes, PUZZLE_CAUSES),
        })),
      };
    } catch (e) {
      logError(`[play-events] puzzle report failed: ${e.message}`);
      return { error: e.message };
    }
  }

  /** Admin "Festhänger", tutorial: one version's lessons as a funnel (reached, done,
   *  where players stopped and why) and the versions with data. { error } on failure. */
  async function tutorialReport(version = TUTORIAL_VERSION) {
    try {
      await ready();
      const where = "mode = 'tutorial' AND period = $1";
      const [versions, totals, steps, drops] = await Promise.all([
        pool.query(PERIODS_SQL, ['tutorial']),
        pool.query(`SELECT count(*)::int AS attempts, count(DISTINCT player_key)::int AS players,
          (count(*) FILTER (WHERE outcome = 'won'))::int AS completed,
          (count(*) FILTER (WHERE outcome = 'abandoned'))::int AS abandoned,
          (count(*) FILTER (WHERE outcome = 'abandoned' AND facts->>'reason' = 'skipped'))::int AS skipped,
          percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM ended_at - started_at)) FILTER (WHERE outcome = 'won') AS median_sec
          FROM play_attempts WHERE ${where}`, [version]),
        // The four lesson facts read once, then counted per lesson (times as a histogram).
        pool.query(`WITH t AS MATERIALIZED (SELECT facts->'reached' AS r, facts->'done' AS d, facts->'sec' AS s, facts->'errors' AS e
            FROM play_attempts WHERE ${where})
          SELECT 'reached' AS fact, k AS key, NULL::int AS sec, count(*)::int AS n FROM t, jsonb_array_elements_text(t.r) AS k GROUP BY 2
          UNION ALL SELECT 'done', k, NULL, count(*)::int FROM t, jsonb_array_elements_text(t.d) AS k GROUP BY 2
          UNION ALL SELECT 'sec', x.key, ${secBucketSql('x.value::int')}, count(*)::int FROM t, jsonb_each_text(t.s) AS x GROUP BY 2, 3
          UNION ALL SELECT 'errors', x.key, NULL, sum(x.value::int)::int FROM t, jsonb_each_text(t.e) AS x GROUP BY 2`, [version]),
        pool.query(`SELECT facts->>'step' AS step, facts->>'reason' AS reason, facts->>'cause' AS cause, count(*)::int AS n
          FROM play_attempts WHERE ${where} AND outcome = 'abandoned' GROUP BY 1, 2, 3`, [version]),
      ]);
      const t = totals.rows[0];
      const countBy = (field) => {
        const out = {};
        for (const r of drops.rows) if (r[field]) out[r[field]] = (out[r[field]] || 0) + r.n;
        return out;
      };
      const versionNo = (v) => Number(String(v).replace(/\D/g, '')) || 0;
      return {
        version,
        versions: versions.rows.map((r) => r.period).sort((a, b) => versionNo(b) - versionNo(a)),
        totals: {
          attempts: t.attempts,
          players: t.players,
          completeRate: rate(t.completed, t.attempts),
          skipRate: rate(t.skipped, t.attempts),
          leaveRate: rate(t.abandoned - t.skipped, t.attempts),
          medianSec: t.median_sec == null ? null : Math.round(Number(t.median_sec)),
        },
        ...shapeFunnel(steps.rows, drops.rows),
        reasons: countBy('reason'),
        causes: countBy('cause'),
      };
    } catch (e) {
      logError(`[play-events] tutorial report failed: ${e.message}`);
      return { error: e.message };
    }
  }

  /** A player's latest attempts of one mode (support), newest first. { error } on failure. */
  async function playerAttempts(name, { mode = 'tower', limit = 50 } = {}) {
    try {
      await ready();
      const r = await pool.query(`SELECT player_name, period, stage, outcome, started_at, ended_at, turns, facts
        FROM play_attempts WHERE player_key = $1 AND mode = $2 ORDER BY ended_at DESC, id DESC LIMIT $3`,
      [nameKey(name), mode, limit]);
      return {
        name: r.rows.length ? r.rows[0].player_name : String(name || '').trim(),
        attempts: r.rows.map((x) => ({
          period: x.period, stage: x.stage, outcome: x.outcome, startedAt: x.started_at.getTime(), endedAt: x.ended_at.getTime(),
          turns: x.turns, facts: x.facts || {},
        })),
      };
    } catch (e) {
      logError(`[play-events] player attempts failed: ${e.message}`);
      return { error: e.message };
    }
  }

  async function close() {
    stopRetention();
    await flush();
    if (ownsPool) await pool.end().catch(() => {});
  }

  return {
    record, flush, prune, startRetention, stopRetention, deleteByName, towerReport, puzzleReport, tutorialReport, playerAttempts, close,
  };
}

module.exports = {
  createPlayEvents, attemptEvent, towerAttemptEvent, tutorialAttemptEvent, towerCause, tutorialCause, puzzleCause,
  attemptOpen, topCause, shapeFloors, shapePuzzleDays, shapePuzzleKinds, shapeFunnel, histogramMedian, nameKey,
  RETENTION_DAYS, MODES, ABANDON_REASONS, TOWER_CAUSES, STUCK_MIN_ATTEMPTS, WALL_MIN_ATTEMPTS,
  PUZZLE_FAULTS, PUZZLE_CAUSES, PUZZLE_STUCK_MISTAKES, PUZZLE_HARD_DAYS, PUZZLE_HARD_MIN_ATTEMPTS,
  TUTORIAL_CAUSES, TUTORIAL_STUCK_REFUSALS, FUNNEL_WALL_MIN_REACHED, FUNNEL_WALL_MIN_DROPPED,
};

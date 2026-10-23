// game/PlayEvents.js
// Play attempts for balancing and support: one row per finished or abandoned
// attempt in play_attempts (admin tab "Festhänger"), kept RETENTION_DAYS. The ONE
// module that writes, prunes and reads them. A write never blocks or breaks a game.
// Instants are ms here and TIMESTAMPTZ in the table (converted at this boundary).
'use strict';
const { createPool } = require('./Database');
const { ensureMigrated } = require('./Migrations');
const { gameDay } = require('./GameDay');
const { cardValue, isPikDame } = require('./Card');
const BotTower = require('./BotTower');

const RETENTION_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;
const OUTCOMES = ['won', 'lost', 'abandoned'];
// facts.reason of an abandoned attempt: given up in the game, left from the
// start screen, did not come back in time, table removed while open, lost in a restart.
const ABANDON_REASONS = ['forfeit', 'left', 'timeout', 'expired', 'restart'];
// facts.cause of a Kartenhaus attempt without a star; ties go to the earlier one.
const TOWER_CAUSES = ['queen', 'jokers', 'goOut', 'emptyDraw', 'stalemate', 'margin', 'abandoned'];
const STUCK_MIN_ATTEMPTS = 3;
// "Knick": a floor's win rate at most half the floor below's, both with this many attempts.
const WALL_MIN_ATTEMPTS = 5;

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

/** An attempt that has begun and not been written yet (a snapshot's tables). */
function attemptOpen(game) {
  return !!(game && game.roundNumber > 0 && !game.attemptOver && !['gameOver', 'abandoned', 'lobby'].includes(game.phase));
}

/** The cause most of a stuck player's attempts share: { cause, n }. */
function topCause(causes = {}) {
  let best = null;
  for (const cause of TOWER_CAUSES) {
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

// player_id: the player row of the name (created, or marked seen at the attempt's end).
const INSERT_SQL = `WITH p AS (INSERT INTO players AS p (player_key, player_name, created_at, updated_at, last_seen_at)
    VALUES ($2, $3, $10, $10, $10) ON CONFLICT (player_key) DO UPDATE
    SET last_seen_at = GREATEST(p.last_seen_at, EXCLUDED.last_seen_at), updated_at = EXCLUDED.updated_at RETURNING id)
  INSERT INTO play_attempts
  (attempt_id, player_key, player_name, mode, period, stage, outcome, game_day, started_at, ended_at, turns, facts, player_id)
  SELECT $1::text, $2::text, $3::text, $4::text, $5::text, $6::int, $7::text, $8::date, $9::timestamptz, $10::timestamptz,
    $11::int, $12::jsonb, p.id FROM p
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
    if (!name || !ev.mode || !ev.period) throw new Error('name, mode and period are required');
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
        // Loose index scan: one probe per month instead of reading every row.
        pool.query(`WITH RECURSIVE m AS (
            SELECT max(period) AS period FROM play_attempts WHERE mode = 'tower'
            UNION ALL
            SELECT (SELECT max(period) FROM play_attempts WHERE mode = 'tower' AND period < m.period)
            FROM m WHERE m.period IS NOT NULL)
          SELECT period AS month FROM m WHERE period IS NOT NULL LIMIT 12`),
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
        months: months.rows.map((r) => r.month),
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

  return { record, flush, prune, startRetention, stopRetention, deleteByName, towerReport, playerAttempts, close };
}

module.exports = {
  createPlayEvents, towerAttemptEvent, towerCause, attemptOpen, topCause, shapeFloors, nameKey,
  RETENTION_DAYS, ABANDON_REASONS, TOWER_CAUSES, STUCK_MIN_ATTEMPTS, WALL_MIN_ATTEMPTS,
};

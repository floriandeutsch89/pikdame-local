// game/BadgeRarity.js
// Badge rarity like Steam's achievement percentages: the share of players holding each
// badge. Players = confirmed accounts whose player finished a match (guests are typed
// names; sign-ups that never played would dilute it). See docs/developer/schema.md.
'use strict';
const { ensureMigrated } = require('./Migrations');
const { BADGE_IDS } = require('./Badges');

const RARITY_MIN_PLAYERS = 20; // fewer: a share says nothing (and a dev server shows none)
const RARE_BELOW_PERCENT = 10;
const RARITY_REFRESH_MS = 15 * 60 * 1000;

// One statement: the badge_id NULL row is the denominator, the rest count its holders. A
// semi-join hashes the counted ids; a CTE joined to the badges hashed all badges (spilled).
const COUNTED = `SELECT p.id FROM users u JOIN players p ON p.id = u.player_id
  WHERE u.email_verified AND p.games_played > 0`;
const RARITY_SQL = `SELECT NULL::text AS badge_id, count(*)::int AS holders FROM (${COUNTED}) counted
  UNION ALL
  SELECT b.badge_id, count(*)::int FROM player_badges b WHERE b.player_id IN (${COUNTED}) GROUP BY b.badge_id`;

/** Whole percent of `players` holding a badge. 0 stands for "under 1 %" (the client
 *  never shows 0: a guest may hold it); 100 only when every one of them does. */
function percentOf(holders, players) {
  const share = (100 * holders) / players;
  if (!(share >= 1)) return 0;
  return holders >= players ? 100 : Math.min(99, Math.round(share));
}

/** Query rows -> the profiles message's `badgeRarity`, or null below the guard. */
function rarityFromRows(rows, minPlayers = RARITY_MIN_PLAYERS) {
  const total = (rows.find((r) => r.badge_id === null) || {}).holders || 0;
  if (total < Math.max(1, minPlayers)) return null;
  const held = new Map(rows.filter((r) => r.badge_id !== null).map((r) => [r.badge_id, r.holders]));
  const percent = Object.fromEntries(BADGE_IDS.map((id) => [id, percentOf(held.get(id) || 0, total)]));
  return { rareBelow: RARE_BELOW_PERCENT, percent };
}

/**
 * The cached rarity for the profiles message: refreshed by a timer, never on a request.
 * A failed refresh keeps the last good one (shares move slowly); none yet: null.
 */
function createBadgeRarity(pool, { minPlayers = RARITY_MIN_PLAYERS, logError = (m) => console.error(m) } = {}) {
  let rarity = null;
  let running = null;
  let timer = null;

  async function load() {
    try {
      await ensureMigrated(pool);
      rarity = rarityFromRows((await pool.query(RARITY_SQL)).rows, minPlayers);
    } catch (e) {
      logError(`[badges] rarity not refreshed: ${e.message}`);
    }
    return rarity;
  }

  /** Never rejects; a call while one runs joins it. */
  function refresh() {
    if (!running) running = load().finally(() => { running = null; });
    return running;
  }

  /** Loads now and every `everyMs`; the timer never keeps the process alive. */
  function start({ everyMs = RARITY_REFRESH_MS } = {}) {
    stop();
    refresh();
    timer = setInterval(refresh, everyMs);
    timer.unref();
    return timer;
  }

  function stop() {
    clearInterval(timer);
    timer = null;
  }

  return { get: () => rarity, refresh, start, stop };
}

module.exports = {
  createBadgeRarity, rarityFromRows, percentOf, RARITY_SQL, RARITY_MIN_PLAYERS, RARE_BELOW_PERCENT, RARITY_REFRESH_MS,
};

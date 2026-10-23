// A PlayerStore on a fresh PostgreSQL schema (ended with test `t`); no players.json import.
const { testPool } = require('./test-db');
const { createPlayerStore } = require('../../game/PlayerStore');

function testPlayerStore(t, opts = {}) {
  const pool = testPool(t, 'players');
  return { store: createPlayerStore(pool, { legacyFile: null, ...opts }), pool };
}

module.exports = { testPlayerStore };

const test = require('node:test');
const assert = require('node:assert');
const { createPool, connectionStringFor } = require('../game/Db');
const { hasPg, freshSchema } = require('./helpers/pg');

test('Db: no PIKDAME_DATABASE_URL means no pool (play-only)', () => {
  assert.equal(createPool({}), null);
});

test('Db: a password from a secret is injected URL-encoded', () => {
  const s = connectionStringFor('postgres://pikdame@db:5432/pikdame', 'p@ss/w:rd');
  assert.equal(new URL(s).password, encodeURIComponent('p@ss/w:rd'));
  assert.equal(connectionStringFor('postgres://u@h/db', undefined), 'postgres://u@h/db');
});

test('test helper: freshSchema isolates by search_path', { skip: !hasPg && 'needs PIKDAME_TEST_PG_URL' }, async () => {
  const s = await freshSchema();
  try {
    const r = await s.pool.query('SELECT current_schema() AS s');
    assert.equal(r.rows[0].s, s.name);
  } finally { await s.drop(); }
});

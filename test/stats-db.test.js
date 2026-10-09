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

const { upsert, stableJson, num } = require('../game/SqlRows');
const { ensureStatsSchema, STATS_TABLES } = require('../game/StatsSchema');

test('SqlRows: upsert builds an ON CONFLICT statement', () => {
  const s = upsert('kv', ['k', 'v'], ['k'], ['a', 1]);
  assert.equal(s.text, 'INSERT INTO kv (k, v) VALUES ($1, $2) ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v');
  assert.deepEqual(s.values, ['a', 1]);
  assert.match(upsert('kv', ['k'], ['k'], ['a']).text, /DO NOTHING$/);
});

test('SqlRows: stableJson sorts keys, strips NUL, keeps null for undefined', () => {
  assert.equal(stableJson({ b: 1, a: { d: 2, c: [3, { z: 1, y: 2 }] } }), '{"a":{"c":[3,{"y":2,"z":1}],"d":2},"b":1}');
  assert.equal(stableJson({ n: 'a\u0000b' }), '{"n":"ab"}');
  assert.equal(stableJson(undefined), null);
});

test('SqlRows: NUL bytes are stripped from text values', () => {
  assert.deepEqual(upsert('kv', ['k', 'v'], ['k'], ['a\u0000b', 1]).values, ['ab', 1]);
});

test('SqlRows: num parses BIGINT strings and keeps null as undefined', () => {
  assert.equal(num('9007199254740991'), 9007199254740991);
  assert.equal(num(null), undefined);
});

test('StatsSchema: creates all tables and is idempotent', { skip: !hasPg && 'needs PIKDAME_TEST_PG_URL' }, async () => {
  const s = await freshSchema();
  try {
    await ensureStatsSchema(s.pool);
    await ensureStatsSchema(s.pool);
    const r = await s.pool.query('SELECT table_name FROM information_schema.tables WHERE table_schema = $1', [s.name]);
    assert.deepEqual(r.rows.map((x) => x.table_name).sort(), [...STATS_TABLES].sort());
  } finally { await s.drop(); }
});

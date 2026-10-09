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

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createFakePool } = require('./helpers/fake-pool');
const { createWriteBehind } = require('../game/WriteBehind');
const { createPgDocument, createMemoryDocument } = require('../game/PgDocument');
const { writePending, replayPending } = require('../game/PendingStats');

// A tiny codec: { items: { key: number } } <-> table kv(k, v).
const kvCodec = {
  name: 'kv',
  table: 'kv',
  normalize: (p) => ({ items: (p && p.items) || {} }),
  *rows(doc) { for (const [k, v] of Object.entries(doc.items)) yield [k, upsert('kv', ['k', 'v'], ['k'], [k, v])]; },
  deleteRow: (k) => ({ text: 'DELETE FROM kv WHERE k = $1', values: [k] }),
  async load(q) {
    const r = await q.query('SELECT k, v FROM kv ORDER BY k');
    return { items: Object.fromEntries((r.rows || []).map((x) => [x.k, x.v])) };
  },
};
const quiet = { log() {}, error() {} };

test('PgDocument: read before load throws (stats must be loaded before serving)', () => {
  const d = createPgDocument({ pool: createFakePool(), codec: kvCodec, log: quiet });
  assert.throws(() => d.read(), /before load/);
});

test('PgDocument: flush writes only rows that changed since the last flush', async () => {
  const pool = createFakePool();
  const d = createPgDocument({ pool, codec: kvCodec, flushDelayMs: 60000, log: quiet });
  await d.load();
  assert.equal(pool.dataStatements().length, 0, 'loading writes nothing');
  d.write({ items: { a: 1, b: 2 } });
  await d.flush();
  assert.equal(pool.dataStatements().length, 2);
  const doc = d.read();
  doc.items.b = 3;
  d.write(doc);
  await d.flush();
  const last = pool.dataStatements().slice(2);
  assert.equal(last.length, 1);
  assert.deepEqual(last[0].values, ['b', 3]);
  await d.flush();
  assert.equal(pool.dataStatements().length, 3, 'nothing dirty, nothing written');
});

test('PgDocument: vanished rows are deleted only when the codec allows it', async () => {
  const pool = createFakePool();
  const d = createPgDocument({ pool, codec: kvCodec, flushDelayMs: 60000, log: quiet });
  await d.load();
  d.write({ items: { a: 1, b: 2 } });
  await d.flush();
  d.write({ items: { a: 1 } });
  await d.flush();
  assert.match(pool.dataStatements().at(-1).text, /^DELETE FROM kv/);
  const keepPool = createFakePool();
  const keep = createPgDocument({ pool: keepPool, codec: { ...kvCodec, deleteRow: undefined }, flushDelayMs: 60000, log: quiet });
  await keep.load();
  keep.write({ items: { a: 1 } });
  await keep.flush();
  keep.write({ items: {} });
  await keep.flush();
  assert.equal(keepPool.dataStatements().length, 1, 'only the insert, no delete');
  assert.equal(keepPool.dataStatements().filter((q) => /^DELETE/.test(q.text)).length, 0);
  assert.deepEqual(keep.pendingStatements(), []);
});

test('PgDocument: a failed flush keeps the rows, reports degraded, and retries', async () => {
  const pool = createFakePool();
  const d = createPgDocument({ pool, codec: kvCodec, flushDelayMs: 60000, log: quiet });
  await d.load();
  pool.failNext(Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' }));
  d.write({ items: { a: 1 } });
  await assert.rejects(d.flush(), /connection refused/);
  assert.equal(d.status(), 'degraded');
  assert.equal(d.pendingStatements().length, 1, 'unsaved row is still pending');
  await d.flush();
  assert.equal(d.status(), 'ok');
  assert.deepEqual(d.pendingStatements(), []);
  assert.deepEqual(pool.dataStatements().at(-1).values, ['a', 1]);
});

test('PgDocument: writes flush by themselves after the delay', async () => {
  const pool = createFakePool();
  const d = createPgDocument({ pool, codec: kvCodec, flushDelayMs: 10, log: quiet });
  await d.load();
  d.write({ items: { a: 1 } });
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(pool.dataStatements().length, 1);
});

test('WriteBehind: one row Postgres rejects is skipped and logged, the rest commits', async () => {
  const pool = createFakePool();
  const errors = [];
  const stmts = [{ text: 'INSERT INTO kv VALUES ($1)', values: ['bad'] }, { text: 'INSERT INTO kv VALUES ($1)', values: ['good'] }];
  let committed = 0;
  const wb = createWriteBehind({
    pool, name: 'kv', flushDelayMs: 60000, log: { log() {}, error: (m) => errors.push(m) },
    collect: () => ({ statements: stmts, token: 1 }), commit: () => { committed += 1; },
  });
  // Batch fails on 'bad' (data error), then one by one: 'bad' fails again, 'good' passes.
  pool.failNext(Object.assign(new Error('invalid input'), { code: '22P02' }));
  pool.failNext(Object.assign(new Error('invalid input'), { code: '22P02' }));
  wb.markDirty();
  await wb.flush();
  assert.equal(committed, 1);
  assert.equal(wb.status(), 'ok');
  assert.match(errors.join('\n'), /rejected a statement, skipped.*bad/);
  assert.deepEqual(pool.dataStatements().at(-1).values, ['good']);
});

test('MemoryDocument: same interface, RAM only', async () => {
  const d = createMemoryDocument();
  assert.equal(d.read(), undefined);
  d.write({ x: 1 });
  assert.deepEqual(d.read(), { x: 1 });
  await d.flush();
  assert.deepEqual(d.pendingStatements(), []);
  assert.equal(d.status(), 'ok');
});

test('PendingStats: dump on shutdown, replay in order on start, file removed', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pikpend-'));
  const file = path.join(dir, 'pending-stats.json');
  assert.equal(writePending(file, []), false, 'nothing pending, no file');
  assert.equal(fs.existsSync(file), false);
  const stmts = [upsert('player_profiles', ['k', 'v'], ['k'], ['a', 1]), upsert('player_profiles', ['k', 'v'], ['k'], ['b', 2])];
  assert.equal(writePending(file, stmts), true);
  const pool = createFakePool();
  assert.equal(await replayPending(pool, file), 2);
  assert.deepEqual(pool.dataStatements().map((q) => q.values), [['a', 1], ['b', 2]]);
  assert.equal(fs.existsSync(file), false);
  assert.equal(await replayPending(pool, file), 0, 'no file, nothing to do');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('PgDocument: round trip through Postgres', { skip: !hasPg && 'needs PIKDAME_TEST_PG_URL' }, async () => {
  const s = await freshSchema();
  try {
    await s.pool.query('CREATE TABLE kv (k TEXT PRIMARY KEY, v INT)');
    const d = createPgDocument({ pool: s.pool, codec: kvCodec, log: quiet });
    await d.load();
    d.write({ items: { a: 1, b: 2 } });
    await d.flush();
    const d2 = createPgDocument({ pool: s.pool, codec: kvCodec, log: quiet });
    await d2.load();
    assert.deepEqual(d2.read(), { items: { a: 1, b: 2 } });
  } finally { await s.drop(); }
});

// Fix round 1: backoff, outage logging, concurrency and replay of bad rows.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const connErr = () => Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' });
const badErr = () => Object.assign(new Error('invalid byte sequence'), { code: '22P05' });
const oneStmt = { text: 'INSERT INTO kv (k, v) VALUES ($1, $2)', values: ['a', 1] };
const countWB = (overrides = {}) => {
  let committed = 0;
  return {
    get committed() { return committed; },
    opts: { collect: () => ({ statements: [oneStmt], token: 1 }), commit: () => { committed += 1; }, ...overrides },
  };
};

test('WriteBehind: a failed write is retried by the backoff timer alone, status back to ok', async () => {
  const pool = createFakePool();
  const c = countWB();
  const wb = createWriteBehind({ pool, name: 'kv', flushDelayMs: 5, backoffMs: [20, 40], log: quiet, ...c.opts });
  pool.failNext(connErr());
  wb.markDirty();
  await sleep(120);
  assert.equal(c.committed, 1);
  assert.equal(wb.status(), 'ok');
  assert.equal(pool.dataStatements().length, 2, 'one failed attempt, one retry');
});

test('WriteBehind: during an outage with ongoing writes, retries follow the backoff, not flushDelayMs', async () => {
  const pool = createFakePool();
  pool.delay(10);
  for (let i = 0; i < 500; i += 1) pool.failNext(connErr());
  const c = countWB();
  const wb = createWriteBehind({ pool, name: 'kv', flushDelayMs: 5, backoffMs: [100, 100], log: quiet, ...c.opts });
  const start = Date.now();
  while (Date.now() - start < 600) { wb.markDirty(); await sleep(2); }
  const elapsed = Date.now() - start;
  const attempts = pool.dataStatements().length;
  assert.ok(attempts <= Math.floor(elapsed / 100) + 2, `${attempts} attempts in ${elapsed} ms`);
  assert.equal(wb.status(), 'degraded');
});

test('WriteBehind: one error line per outage, and one "reachable again" on recovery', async () => {
  const pool = createFakePool();
  const logs = [];
  const errors = [];
  const c = countWB();
  const wb = createWriteBehind({
    pool, name: 'kv', flushDelayMs: 5, backoffMs: [20, 40],
    log: { log: (m) => logs.push(m), error: (m) => errors.push(m) }, ...c.opts,
  });
  pool.failNext(connErr());
  pool.failNext(connErr());
  pool.failNext(connErr());
  wb.markDirty();
  await sleep(300);
  assert.equal(errors.length, 1, 'logged once for the whole outage');
  assert.equal(logs.filter((m) => /reachable again/.test(m)).length, 1);
  assert.equal(wb.status(), 'ok');
  pool.failNext(connErr());
  wb.markDirty();
  await sleep(150);
  assert.equal(errors.length, 2, 'a new outage logs again');
  assert.equal(logs.filter((m) => /reachable again/.test(m)).length, 2);
});

test('PgDocument: a write that arrives during an in-flight flush is saved by the next flush', async () => {
  const pool = createFakePool();
  const d = createPgDocument({ pool, codec: kvCodec, flushDelayMs: 60000, log: quiet });
  await d.load();
  d.write({ items: { a: 1 } });
  const hold = pool.holdNext();
  const first = d.flush();
  d.write({ items: { a: 1, b: 2 } });
  hold.release();
  await first;
  await d.flush();
  assert.deepEqual(pool.committed().map((q) => q.values), [['a', 1], ['b', 2]]);
  assert.deepEqual(d.pendingStatements(), []);
});

test('PgDocument: concurrent flush() calls run one transaction at a time', async () => {
  const pool = createFakePool();
  const d = createPgDocument({ pool, codec: kvCodec, flushDelayMs: 60000, log: quiet });
  await d.load();
  d.write({ items: { a: 1 } });
  const hold = pool.holdNext();
  const p1 = d.flush();
  d.write({ items: { a: 1, b: 2 } });
  const p2 = d.flush();
  hold.release();
  await Promise.all([p1, p2]);
  const tx = pool.log.map((q) => q.text).filter((t) => /^(BEGIN|COMMIT|ROLLBACK)$/.test(t));
  assert.deepEqual(tx, ['BEGIN', 'COMMIT', 'BEGIN', 'COMMIT']);
  assert.deepEqual(pool.committed().map((q) => q.values), [['a', 1], ['b', 2]]);
});

test('PgDocument: pendingStatements() during an in-flight flush still lists the in-flight rows', async () => {
  const pool = createFakePool();
  const d = createPgDocument({ pool, codec: kvCodec, flushDelayMs: 60000, log: quiet });
  await d.load();
  d.write({ items: { a: 1 } });
  const hold = pool.holdNext();
  const p = d.flush();
  assert.equal(d.pendingStatements().length, 1);
  hold.release();
  await p;
  assert.deepEqual(d.pendingStatements(), []);
});

test('replayPending: a data-error statement is skipped and logged, the rest applied, file removed', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pikpend-'));
  const file = path.join(dir, 'pending-stats.json');
  const stmts = [
    upsert('player_profiles', ['k', 'v'], ['k'], ['a', 1]),
    upsert('player_profiles', ['k', 'v'], ['k'], ['bad', 2]),
    upsert('player_profiles', ['k', 'v'], ['k'], ['c', 3]),
  ];
  fs.writeFileSync(file, JSON.stringify({ version: 1, statements: stmts }));
  const pool = createFakePool();
  pool.failWhere((q) => q.values[0] === 'bad', badErr());
  const errors = [];
  assert.equal(await replayPending(pool, file, { log() {}, error: (m) => errors.push(m) }), 3);
  assert.deepEqual(pool.committed().map((q) => q.values[0]), ['a', 'c']);
  assert.match(errors.join('\n'), /skipped.*bad/);
  assert.equal(fs.existsSync(file), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('replayPending: a corrupt pending file rejects, names the file, and is kept', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pikpend-'));
  const file = path.join(dir, 'pending-stats.json');
  fs.writeFileSync(file, '{not json');
  await assert.rejects(replayPending(createFakePool(), file, quiet), (e) => e.message.includes(file));
  assert.equal(fs.existsSync(file), true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('replayPending: only stats-table inserts and the Stammtisch delete run, everything else is rejected and logged', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pikpend-'));
  const file = path.join(dir, 'pending-stats.json');
  const ok1 = upsert('player_profiles', ['name_key', 'name'], ['name_key'], ['a', 'A']);
  const ok2 = { text: 'DELETE FROM stammtisch_tables WHERE code = $1', values: ['STAB12'] };
  const evil = [
    { text: 'DROP TABLE player_profiles', values: [] },
    { text: 'DELETE FROM player_profiles', values: [] },
    { text: 'INSERT INTO accounts (id) VALUES ($1)', values: ['x'] },
    { text: 'UPDATE player_profiles SET name = $1', values: ['x'] },
    { text: 42, values: [] },
  ];
  fs.writeFileSync(file, JSON.stringify({ version: 1, statements: [ok1, ...evil, ok2] }));
  const pool = createFakePool();
  const errors = [];
  await replayPending(pool, file, { log() {}, error: (m) => errors.push(m) });
  assert.deepEqual(pool.committed().map((q) => q.text), [ok1.text, ok2.text]);
  assert.equal(errors.filter((m) => /rejected/.test(m)).length, evil.length, errors.join('\n'));
  assert.match(errors.join('\n'), /DROP TABLE/);
  assert.equal(fs.existsSync(file), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

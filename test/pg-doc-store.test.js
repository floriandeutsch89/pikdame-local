// PgDocStore: one-time import of the old JSON files, write-behind batches
// that touch only changed rows, deletes, retry after a failed write.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Pool } = require('pg');
const { createPgDocStore } = require('../game/PgDocStore');
const { createPlayerStore } = require('../game/PlayerStore');
const { createStammtischStore } = require('../game/StammtischStore');
const { testDatabaseUrl } = require('./helpers/test-db');

const quiet = { log() {}, error() {} };
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pikdame-pgdoc-'));
const rowsOf = async (url, table) => {
  const pool = new Pool({ connectionString: url, max: 1 });
  try {
    return (await pool.query(`SELECT key, doc, updated_at FROM ${table} ORDER BY key`)).rows;
  } finally {
    await pool.end();
  }
};

function docStore(db, extra = {}) {
  return createPgDocStore(db, {
    table: 'docs',
    toRows: (s) => Object.entries(s.items),
    fromRows: (rows) => ({ items: Object.fromEntries(rows.map((r) => [r.key, r.doc])) }),
    log: quiet,
    ...extra,
  });
}

test('the old players.json and stammtisch.json are imported once, then renamed', async () => {
  const dir = tmpDir();
  const url = testDatabaseUrl('pgdoc');
  const players = path.join(dir, 'players.json');
  const tables = path.join(dir, 'stammtisch.json');
  fs.writeFileSync(players, JSON.stringify({ players: [
    { id: 'profile-1', name: 'Oma Inge', gamesPlayed: 7, gamesWon: 3, xp: 420, badges: { first_win: 1 } },
    { name: 'Ohne Id', gamesPlayed: 1 },
    { id: 'profile-1', name: 'Oma Inge', gamesPlayed: 7, gamesWon: 3, xp: 420, badges: { first_win: 1 } }, // twice in an old file
  ] }));
  fs.writeFileSync(tables, JSON.stringify({ tables: { STAB12: { code: 'STAB12', name: 'Familie', members: {}, games: [] } } }));

  const ps = createPlayerStore(url, { legacyFile: players });
  const st = createStammtischStore(url, { legacyFile: tables });
  await Promise.all([ps.load(), st.load()]);
  assert.equal(ps.getPlayerByName('oma inge').xp, 420);
  assert.ok(ps.getPlayerByName('Ohne Id').id, 'a profile without id gets one');
  assert.equal(st.get('stab12').name, 'Familie');
  assert.ok(!fs.existsSync(players) && fs.existsSync(`${players}.migrated`), 'renamed after the commit');
  assert.ok(fs.existsSync(`${tables}.migrated`));
  assert.equal((await rowsOf(url, 'player_profiles')).length, 2);

  // A file that shows up again (an old backup) is never imported twice.
  fs.copyFileSync(`${players}.migrated`, players);
  const again = createPlayerStore(url, { legacyFile: players });
  await again.load();
  assert.equal(again.listPlayers().length, 2);
  assert.ok(fs.existsSync(players), 'left alone, only logged');
});

test('two instances loading at once import once', async () => {
  const dir = tmpDir();
  const url = testDatabaseUrl('pgdoc');
  const file = path.join(dir, 'players.json');
  fs.writeFileSync(file, JSON.stringify({ players: [{ id: 'p-1', name: 'A' }, { id: 'p-2', name: 'B' }] }));
  const a = createPlayerStore(url, { legacyFile: file });
  const b = createPlayerStore(url, { legacyFile: file });
  await Promise.all([a.load(), b.load()]);
  assert.equal((await rowsOf(url, 'player_profiles')).length, 2);
  const pool = new Pool({ connectionString: url, max: 1 });
  assert.equal((await pool.query('SELECT rows FROM pikdame_imports WHERE name = $1', ['player_profiles'])).rows[0].rows, 2);
  await pool.end();
});

test('a flush writes only the changed rows and deletes removed ones', async () => {
  const url = testDatabaseUrl('pgdoc');
  const s = docStore(url, { flushDelayMs: 10_000 });
  await s.load();
  s.write({ items: { a: { n: 1 }, b: { n: 2 }, c: { n: 3 } } });
  await s.flush();
  const first = await rowsOf(url, 'docs');
  assert.deepEqual(first.map((r) => [r.key, r.doc.n]), [['a', 1], ['b', 2], ['c', 3]]);

  await new Promise((r) => setTimeout(r, 5));
  const store = s.read();
  store.items.b.n = 20; // mutated in place, like the stores do
  delete store.items.c;
  s.write(store);
  await s.flush();
  const second = await rowsOf(url, 'docs');
  assert.deepEqual(second.map((r) => [r.key, r.doc.n]), [['a', 1], ['b', 20]]);
  assert.equal(second[0].updated_at, first[0].updated_at, 'an unchanged row is not rewritten');
  assert.ok(Number(second[1].updated_at) > Number(first[1].updated_at));
});

test('used before load() it throws instead of overwriting the table', async () => {
  const s = docStore(testDatabaseUrl('pgdoc'));
  assert.throws(() => s.read(), /before load/);
  assert.throws(() => s.write({ items: {} }), /before load/);
  await s.flush(); // nothing to do, never rejects
});

test('a failed write stays pending and lands on the next flush', async () => {
  const url = testDatabaseUrl('pgdoc');
  const real = new Pool({ connectionString: url, max: 2 });
  let down = false;
  const flaky = {
    connect: () => (down ? Promise.reject(new Error('connection refused')) : real.connect()),
    query: (...a) => (down ? Promise.reject(new Error('connection refused')) : real.query(...a)),
  };
  const errors = [];
  const s = docStore(flaky, { flushDelayMs: 10_000, log: { log() {}, error: (m) => errors.push(m) } });
  await s.load();
  down = true;
  s.write({ items: { a: { n: 1 } } });
  await s.flush(); // never rejects
  assert.match(errors.join('\n'), /write failed, retrying/);
  down = false;
  await s.flush();
  assert.deepEqual((await rowsOf(url, 'docs')).map((r) => r.key), ['a']);
  await real.end();
});

test('an unreadable old file stops the load and is imported once it is fixed', async () => {
  const dir = tmpDir();
  const url = testDatabaseUrl('pgdoc');
  const file = path.join(dir, 'docs.json');
  fs.writeFileSync(file, '{"items": {"a": ');
  const broken = docStore(url, { legacyFile: file });
  await assert.rejects(broken.load(), /unreadable/);
  await broken.close();
  assert.ok(fs.existsSync(file), 'the broken file stays for the operator');

  fs.writeFileSync(file, JSON.stringify({ items: { a: { n: 1 } } }));
  const fixed = docStore(url, { legacyFile: file });
  await fixed.load();
  assert.deepEqual(fixed.read(), { items: { a: { n: 1 } } });
  assert.ok(fs.existsSync(`${file}.migrated`));
  await fixed.close();
});

// A private PostgreSQL schema per call inside PIKDAME_TEST_PG_URL, so test
// files run in parallel without seeing each other's rows. Synchronous (a
// short child process) so a plain startServer() can use it.
const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');

const BASE_URL = process.env.PIKDAME_TEST_PG_URL || '';
const created = [];

function requireBaseUrl() {
  if (!BASE_URL) {
    throw new Error('PIKDAME_TEST_PG_URL is not set: the tests need a PostgreSQL database '
      + '(e.g. postgres://pikdame@127.0.0.1:5432/pikdame_test), see docs/developer/contributing.md');
  }
  return BASE_URL;
}

function runSql(sql) {
  const script = `const { Client } = require('pg');
const c = new Client({ connectionString: process.env.BASE });
c.connect().then(() => c.query(process.env.SQL)).then(() => c.end(), (e) => { console.error(e.message); process.exit(1); });`;
  execFileSync(process.execPath, ['-e', script], {
    cwd: __dirname, env: { ...process.env, BASE: requireBaseUrl(), SQL: sql }, stdio: ['ignore', 'ignore', 'inherit'],
  });
}

/** Connection string whose search_path is a fresh, empty schema. */
function testDatabaseUrl(tag = 't') {
  const schema = `t_${String(tag).toLowerCase().replace(/[^a-z0-9]/g, '_').slice(0, 20)}_${crypto.randomBytes(4).toString('hex')}`;
  runSql(`CREATE SCHEMA ${schema}`);
  if (!created.length) process.once('exit', dropAll);
  created.push(schema);
  const base = requireBaseUrl();
  return `${base}${base.includes('?') ? '&' : '?'}options=${encodeURIComponent(`-c search_path=${schema}`)}`;
}

function dropAll() {
  try {
    runSql(created.map((s) => `DROP SCHEMA IF EXISTS ${s} CASCADE;`).join('\n'));
  } catch (e) { /* a leftover schema in a test database is harmless */ }
}

/** A pg Pool on a fresh schema, ended when test `t` is done. */
function testPool(t, tag = 't') {
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: testDatabaseUrl(tag), max: 4 });
  t.after(() => pool.end());
  return pool;
}

module.exports = { testDatabaseUrl, testPool };

'use strict';
// The test database helper itself: schemas are dropped at exit, one transaction each.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('node:child_process');
const { testPool } = require('./helpers/test-db');

test('schemas of a finished test process are gone, each dropped in its own transaction', async (t) => {
  const helper = path.join(__dirname, 'helpers', 'test-db.js');
  const child = `const { testDatabaseUrl } = require(${JSON.stringify(helper)});
const { Client } = require('pg');
(async () => {
  for (let i = 0; i < 3; i++) {
    const url = testDatabaseUrl('dropme');
    const c = new Client({ connectionString: url });
    await c.connect(); await c.query('CREATE TABLE x (id INT PRIMARY KEY)'); await c.end();
    console.log(new URL(url).searchParams.get('options').split('=')[1]);
  }
})();`;
  const names = execFileSync(process.execPath, ['-e', child], { cwd: __dirname, encoding: 'utf8' }).trim().split('\n');
  assert.strictEqual(names.length, 3);
  const pool = testPool(t, 'helper');
  const left = await pool.query('SELECT nspname FROM pg_namespace WHERE nspname = ANY($1)', [names]);
  assert.deepStrictEqual(left.rows, [], 'dropped at exit');
  // One multi-statement string is one transaction: its locks on every dropped
  // table pile up until commit and starved parallel test files (CI).
  const src = fs.readFileSync(helper, 'utf8');
  assert.doesNotMatch(src, /DROP SCHEMA[^\n]*\.join\(/, 'never join the drops into one statement');
});

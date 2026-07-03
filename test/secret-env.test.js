const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { readSecret } = require('../game/secretEnv');

test('readSecret: direct env wins, _FILE fallback works, missing file degrades', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sec-'));
  const f = path.join(dir, 'pw.txt');
  fs.writeFileSync(f, 'from-file\n');
  assert.equal(readSecret({ X: 'direct', X_FILE: f }, 'X'), 'direct');
  assert.equal(readSecret({ X_FILE: f }, 'X'), 'from-file'); // trimmed
  assert.equal(readSecret({ X_FILE: path.join(dir, 'missing') }, 'X'), undefined);
  assert.equal(readSecret({}, 'X'), undefined);
});

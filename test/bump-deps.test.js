// Guard for scripts/bump-deps.js (dependabot-auto.yml): a dependency update
// becomes the changelog fragment changes/deps-<PR>.md, never a version bump.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { depsFragment } = require('../scripts/bump-deps');
const { parseFragment, fragmentLevel } = require('../scripts/release');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'bump-deps.js');

test('patch updates carry the patch marker, everything else is a plain "Changed" (minor)', () => {
  const patch = depsFragment({ list: 'ws 8.22.0→8.22.1', level: 'patch' });
  assert.strictEqual(patch, '<!-- bump: patch -->\n### Changed\n- Abhängigkeiten aktualisiert (automatischer Dependabot-Check): ws 8.22.0→8.22.1\n');
  assert.strictEqual(fragmentLevel(parseFragment(patch, 'changes/deps-1.md')), 'patch');

  const minor = depsFragment({ list: 'node 26.1→26.2', kind: 'docker' });
  assert.strictEqual(minor, '### Changed\n- Container-Basis-Images aktualisiert (automatischer Dependabot-Check): node 26.1→26.2\n');
  assert.strictEqual(fragmentLevel(parseFragment(minor, 'changes/deps-2.md')), 'minor');

  // A list with line breaks must stay one bullet.
  assert.match(depsFragment({ list: 'ws 1→2,\n  pg 3→4' }), /: ws 1→2, pg 3→4\n$/);
});

test('CLI writes changes/deps-<pr>.md and prints its path; bad arguments fail', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pikdame-deps-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cli = (...args) => spawnSync(process.execPath, [SCRIPT, ...args, `--root=${root}`], { encoding: 'utf8' });

  const ok = cli('ws 8.22.0→8.23.0, pg 8.23.1→8.24.0', '--pr=357', '--level=minor', '--kind=npm');
  assert.strictEqual(ok.status, 0, ok.stderr);
  assert.strictEqual(ok.stdout.trim(), 'changes/deps-357.md');
  const text = fs.readFileSync(path.join(root, 'changes', 'deps-357.md'), 'utf8');
  assert.strictEqual(fragmentLevel(parseFragment(text, 'changes/deps-357.md')), 'minor');
  assert.deepStrictEqual(fs.readdirSync(root), ['changes'], 'no package.json or CHANGELOG.md is touched');

  assert.match(cli('ws 1→2').stderr, /--pr=<number> required/);
  assert.match(cli('ws 1→2', '--pr=abc').stderr, /--pr=<number> required/);
  assert.match(cli('ws 1→2', '--pr=1', '--level=major').stderr, /unknown --level=major/);
  assert.match(cli('--pr=1').stderr, /update list argument required/);
  assert.strictEqual(cli('--pr=1').status, 1);
});

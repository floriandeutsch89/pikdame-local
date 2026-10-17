// Guard for scripts/check-changes.js (CI job changelog-fragment), driven by
// fixture diffs: which PRs need a fragment, and who may touch the version.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { checkChanges, legacyProblem } = require('../scripts/check-changes');

const pkg = (over = {}) =>
  `${JSON.stringify({ name: 'pik-dame', version: '2.67.0', scripts: { test: 'node --test' }, dependencies: { ws: '^8.22.0' }, devDependencies: { jsdom: '^30.1.2' }, ...over }, null, 2)}\n`;
const lock = (version = '2.67.0', ws = '8.22.0') =>
  `${JSON.stringify({ name: 'pik-dame', version, lockfileVersion: 3, requires: true, packages: { '': { name: 'pik-dame', version }, 'node_modules/ws': { version: ws } } }, null, 2)}\n`;
const INTRO = '# Changelog\n\nAlle Änderungen.\n\n';
const RELEASED = '## [2.67.0] - 2026-10-17\n\n### Changed\n- Immer nur ein Spiel gleichzeitig\n';
const section = (v) => `## [${v}] - 2026-10-17\n\n### Fixed\n- Etwas repariert\n\n`;

/** Runs the check on a fixture: base files plus the head's changes (null = deleted). */
function run({ base = {}, head = {}, branch = '' } = {}) {
  const b = { 'package.json': pkg(), 'package-lock.json': lock(), 'CHANGELOG.md': INTRO + RELEASED, ...base };
  const h = { ...b, ...head };
  const diff = [];
  for (const p of [...new Set([...Object.keys(b), ...Object.keys(h)])].sort()) {
    const [x, y] = [b[p] ?? null, h[p] ?? null];
    if (x !== y) diff.push({ status: x === null ? 'A' : y === null ? 'D' : 'M', path: p });
  }
  return checkChanges({ diff, read: (side, p) => (side === 'base' ? b : h)[p] ?? null, branch });
}
const messages = (r) => r.errors.map((e) => e.message).join('\n');
const FRAGMENT = '### Fixed\n- Der Dialog ist jetzt übersetzt\n';

test('docs, tests, CI and skills alone need no fragment', () => {
  const r = run({
    head: {
      'docs/admin/auto-deploy.md': 'x',
      'test/new.test.js': 'x',
      '.github/workflows/ci.yml': 'x',
      '.claude/skills/steward/SKILL.md': 'x',
      'scripts/sim-bots.js': 'x',
      'models/README.md': 'Markdown next to the models is documentation',
      'CHANGELOG.md': `# Changelog\n\nNeue Einleitung.\n\n${RELEASED}`,
    },
  });
  assert.deepStrictEqual(r.errors, []);
  assert.deepStrictEqual(r.shipped, []);
  assert.match(r.notes.join('\n'), /No shipped change/);
});

test('a shipped change without a fragment fails, with one it passes', () => {
  for (const p of ['public/client.js', 'server.js', 'game/Rules.js', 'models/pikdame-zen.onnx', 'docker/Dockerfile', 'scripts/minify-assets.js']) {
    const r = run({ head: { [p]: 'changed' } });
    assert.match(messages(r), new RegExp(`changes the shipped game \\(${p.replace(/\./g, '\\.')}\\) but adds no changelog fragment`), p);
  }
  const ok = run({ head: { 'public/client.js': 'changed', 'changes/dialog-i18n.md': FRAGMENT } });
  assert.deepStrictEqual(ok.errors, []);
  assert.deepStrictEqual(ok.fragments, ['changes/dialog-i18n.md']);
});

test('fragments are validated: malformed content and bad names fail with their location', () => {
  const bad = run({ head: { 'public/client.js': 'x', 'changes/oops.md': '## [2.68.0]\n### Fixed\n- x\n' } });
  assert.strictEqual(bad.errors.length, 2, 'the broken fragment, then the missing valid one');
  assert.deepStrictEqual([bad.errors[0].file, bad.errors[0].line], ['changes/oops.md', 1]);
  assert.match(bad.errors[0].message, /no version header/);
  for (const name of ['changes/Tutorial.md', 'changes/two words.md', 'changes/sub/x.md', 'changes/notes.txt']) {
    const r = run({ head: { [name]: FRAGMENT } });
    assert.match(messages(r), /a fragment is changes\/<topic>\.md/, name);
  }
});

test('stacked and follow-up PRs: an edited fragment counts, deletions and README edits are free', () => {
  const base = { 'changes/tutorial.md': FRAGMENT, 'changes/old.md': FRAGMENT };
  const edited = run({ base, head: { 'public/style.css': 'x', 'changes/tutorial.md': `${FRAGMENT}- Noch ein Punkt\n` } });
  assert.deepStrictEqual(edited.errors, []);
  assert.deepStrictEqual(run({ base, head: { 'changes/old.md': null } }).errors, []);
  assert.deepStrictEqual(run({ head: { 'changes/README.md': 'anything' } }).errors, []);
});

test('package.json: dependencies are shipped, scripts are not', () => {
  const deps = run({ head: { 'package.json': pkg({ dependencies: { ws: '^8.23.0' } }) } });
  assert.deepStrictEqual(deps.shipped, ['package.json (dependencies)']);
  assert.match(messages(deps), /adds no changelog fragment/);
  const dev = run({ head: { 'package.json': pkg({ devDependencies: { jsdom: '^30.2.0' } }) } });
  assert.deepStrictEqual(dev.shipped, ['package.json (dependencies)']);
  assert.deepStrictEqual(run({ head: { 'package.json': pkg({ scripts: { test: 'x', lint: 'y' } }) } }).errors, []);
});

test('package-lock.json: a dependency change is shipped; its version lines belong to the release', () => {
  const dep = run({ head: { 'package-lock.json': lock('2.67.0', '8.23.0'), 'changes/deps-1.md': FRAGMENT } });
  assert.deepStrictEqual(dep.errors, []);
  assert.deepStrictEqual(dep.shipped, ['package-lock.json']);
  const version = run({ head: { 'package-lock.json': lock('2.71.0') } });
  assert.match(messages(version), /belong to the release PR/);
});

test('a feature PR may not bump the version or write a CHANGELOG release section', () => {
  const bump = run({ head: { 'package.json': pkg({ version: '2.71.0' }), 'changes/x.md': FRAGMENT } });
  assert.match(messages(bump), /belong to the release PR.*v2\.71\.0 is above v2\.70\.0/s);
  const sectionOnly = run({ head: { 'CHANGELOG.md': INTRO + section('2.71.0') + RELEASED, 'changes/x.md': FRAGMENT } });
  assert.match(messages(sectionOnly), /belong to the release PR.*the version did not change/s);
  assert.strictEqual(sectionOnly.errors[0].file, 'CHANGELOG.md');
  const history = run({ head: { 'CHANGELOG.md': INTRO + RELEASED.replace('Spiel', 'Spielchen') } });
  assert.match(messages(history), /belong to the release PR/, 'released sections are history');
});

test('transition: old-style PRs up to v2.70.0 keep their bump (#351, #353, the tutorial PR)', () => {
  for (const v of ['2.68.0', '2.69.0', '2.70.0']) {
    const r = run({
      head: {
        'package.json': pkg({ version: v }),
        'package-lock.json': lock(v),
        'CHANGELOG.md': INTRO + section(v) + RELEASED,
        'public/client.js': 'feature',
      },
    });
    assert.deepStrictEqual(r.errors, [], v);
    assert.strictEqual(r.legacy, true);
    assert.match(r.notes.join('\n'), new RegExp(`old-style bump to v${v.replace(/\./g, '\\.')} accepted`));
  }
  // Merged in order: the tutorial PR (v2.69.0) after #351 (v2.68.0) is on main.
  const after351 = run({
    base: { 'package.json': pkg({ version: '2.68.0' }), 'package-lock.json': lock('2.68.0'), 'CHANGELOG.md': INTRO + section('2.68.0') + RELEASED },
    head: { 'package.json': pkg({ version: '2.69.0' }), 'package-lock.json': lock('2.69.0'), 'CHANGELOG.md': INTRO + section('2.69.0') + section('2.68.0') + RELEASED, 'game/x.js': 'y' },
  });
  assert.deepStrictEqual(after351.errors, []);
});

test('transition: what it does not cover', () => {
  const legacy = (over) => run({ head: { 'package.json': pkg({ version: '2.68.0' }), 'CHANGELOG.md': INTRO + section('2.68.0') + RELEASED, 'game/x.js': 'y', ...over } });
  // main already passed the number (e.g. the release PR or #353 went first): convert.
  const passed = run({
    base: { 'package.json': pkg({ version: '2.70.0' }), 'CHANGELOG.md': INTRO + section('2.70.0') + RELEASED },
    head: { 'package.json': pkg({ version: '2.68.0' }), 'CHANGELOG.md': INTRO + section('2.70.0') + section('2.68.0') + RELEASED },
  });
  assert.match(messages(passed), /v2\.68\.0 is not above v2\.70\.0 on the base branch/);
  assert.match(messages(legacy({ 'CHANGELOG.md': INTRO + section('2.69.0') + RELEASED })), /must be ## \[2\.68\.0\]/);
  assert.match(messages(legacy({ 'CHANGELOG.md': INTRO + RELEASED })), /no new section for v2\.68\.0/);
  assert.match(messages(legacy({ 'CHANGELOG.md': INTRO + section('2.68.0') + RELEASED.replace('Spiel', 'Spielchen') })), /more than one new section/);
  assert.match(messages(legacy({ 'changes/x.md': FRAGMENT })), /would ship twice/);
  assert.strictEqual(
    legacyProblem({ baseVersion: '2.67.0', headVersion: '2.68.0', baseRelease: RELEASED, headRelease: section('2.68.0') + RELEASED }),
    ''
  );
});

test('the release PR (release/next) may write the version and the CHANGELOG section', () => {
  const head = {
    'package.json': pkg({ version: '2.71.0' }),
    'package-lock.json': lock('2.71.0'),
    'CHANGELOG.md': INTRO + section('2.71.0') + RELEASED,
    'changes/a.md': null,
  };
  const base = { 'changes/a.md': FRAGMENT };
  assert.deepStrictEqual(run({ base, head, branch: 'release/next' }).errors, []);
  assert.match(messages(run({ base, head, branch: 'feature/release-next' })), /belong to the release PR/);
});

test('CLI: compares two commits of a real repository', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pikdame-check-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));
  const git = (...args) =>
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], { cwd: dir, env, encoding: 'utf8' }).trim();
  const write = (p, text) => {
    fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
    fs.writeFileSync(path.join(dir, p), text);
  };
  const check = (...args) =>
    spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'check-changes.js'), ...args], { cwd: dir, env: { ...env, GITHUB_ACTIONS: 'true' }, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  write('package.json', pkg());
  write('CHANGELOG.md', INTRO + RELEASED);
  write('public/client.js', 'a');
  git('add', '.');
  git('commit', '-q', '-m', 'base');
  const base = git('rev-parse', 'HEAD');
  write('public/client.js', 'b');
  git('commit', '-q', '-am', 'feature');

  const red = check(`--base=${base}`);
  assert.strictEqual(red.status, 1);
  assert.match(red.stderr, /^::error::This PR changes the shipped game \(public\/client\.js\)/m);
  write('changes/feature.md', '### Fixed\n- x\n\n### Geändert\n- y\n');
  git('add', '.');
  git('commit', '-q', '-m', 'fragment');
  assert.match(check(`--base=${base}`).stderr, /^::error file=changes\/feature\.md,line=4::/m);
  write('changes/feature.md', '### Fixed\n- x\n');
  git('commit', '-q', '-am', 'fix fragment');
  const green = check(`--base=${base}`, '--head=HEAD');
  assert.strictEqual(green.status, 0, green.stderr);
  assert.match(green.stdout, /Changelog check passed/);
  assert.strictEqual(check('--bogus').status, 1);
});

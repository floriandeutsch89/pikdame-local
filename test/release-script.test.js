// Guard for scripts/release.js: fragment parsing, bump rules, assembly order,
// mixed mode with old-style bumps, and the CLI end to end in a scratch git repo.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const R = require('../scripts/release');

const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'release.js');
const frag = (text, file = 'changes/x.md') => R.parseFragment(text, file);
// Child processes must not inherit a GIT_DIR or similar from a hook or worktree.
const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));

test('parseFragment: headings, bullets, continuation lines, nested bullets, comments', () => {
  const f = frag(
    [
      '<!-- bump: Patch -->',
      '<!-- a note for the reviewer -->',
      '### Fixed',
      '- Erster Punkt',
      '  geht hier weiter',
      '  - verschachtelt',
      '',
      '-   Zweiter Punkt',
      '### added',
      '- Neu',
      '',
    ].join('\r\n')
  );
  assert.strictEqual(f.bump, 'patch');
  assert.deepStrictEqual([...f.sections.keys()], ['Fixed', 'Added']);
  assert.deepStrictEqual(f.sections.get('Fixed'), ['- Erster Punkt\n  geht hier weiter\n  - verschachtelt', '- Zweiter Punkt']);
  assert.deepStrictEqual(f.sections.get('Added'), ['- Neu']);
});

test('parseFragment: malformed input fails with file:line and a clear reason', () => {
  const cases = [
    ['## [2.68.0] - 2026-10-17\n### Added\n- x', /x\.md:1: no version header/],
    ['## Added\n- x', /x\.md:1: use ### headings/],
    ['### Geändert\n- x', /x\.md:1: headings are English: ### Changed instead of ### Geändert/],
    ['### Improvements\n- x', /x\.md:1: unknown heading "### Improvements"/],
    ['- x', /x\.md:1: bullet before the first ### heading/],
    ['### Added\nSatz ohne Punkt', /x\.md:2: text outside a bullet/],
    ['### Added\n* x', /x\.md:2: bullets start with '- '/],
    ['### Added\n-x', /x\.md:2: bullets start with '- '/],
    ['### Added\n- ', /x\.md:2: empty bullet/],
    ['### Added\n  eingerückt', /x\.md:2: indented line outside a bullet/],
    ['### Added\n- x\n<!-- bump: major -->', /x\.md:3: the bump marker must be the very first line/],
    ['<!-- bump: huge -->\n### Added\n- x', /x\.md:1: unknown bump "huge"/],
    ['<!-- offen\n### Added\n- x', /x\.md:1: an HTML comment must open and close/],
    ['### Added\n### Fixed\n- x', /x\.md:1: ### Added has no bullets/],
    ['', /x\.md: empty fragment/],
    ['<!-- bump: minor -->\n\n', /x\.md: empty fragment/],
  ];
  for (const [text, want] of cases) {
    assert.throws(() => frag(text), (e) => e instanceof R.FragmentError && want.test(e.message), `${JSON.stringify(text)} -> ${want}`);
  }
});

test('bump rules: Fixed/Security only is patch, anything else minor, the marker overrides', () => {
  const level = (text) => R.fragmentLevel(frag(text));
  assert.strictEqual(level('### Fixed\n- a'), 'patch');
  assert.strictEqual(level('### Security\n- a'), 'patch');
  assert.strictEqual(level('### Fixed\n- a\n### Security\n- b'), 'patch');
  for (const h of ['Added', 'Changed', 'Removed', 'Deprecated']) assert.strictEqual(level(`### ${h}\n- a`), 'minor', h);
  assert.strictEqual(level('### Fixed\n- a\n### Changed\n- b'), 'minor');
  // Override in both directions: dependency patches are "Changed" but patch.
  assert.strictEqual(level('<!-- bump: patch -->\n### Changed\n- a'), 'patch');
  assert.strictEqual(level('<!-- bump: minor -->\n### Fixed\n- a'), 'minor');
});

test('bump rules: major only via the marker; the release takes the highest fragment level', () => {
  const plan = (texts) => R.planRelease({
    fragments: texts.map((t, i) => frag(t, `changes/f${i}.md`)),
    packageVersion: '2.80.4',
    date: '2026-10-17',
  });
  assert.strictEqual(plan(['### Removed\n- Alles weg']).version, '2.81.0', 'Removed alone is no major');
  assert.strictEqual(plan(['### Fixed\n- a', '### Fixed\n- b']).version, '2.80.5');
  assert.strictEqual(plan(['### Fixed\n- a', '### Added\n- b']).version, '2.81.0');
  const major = plan(['### Fixed\n- a', '<!-- bump: major -->\n### Changed\n- b', '### Added\n- c']);
  assert.strictEqual(major.version, '3.0.0');
  assert.strictEqual(major.level, 'major');
  assert.deepStrictEqual(major.fragments.map((f) => f.level), ['patch', 'major', 'minor']);
});

test('next version = bump(max(highest reachable tag, package.json))', () => {
  assert.strictEqual(R.bumpVersion('2.9.9', 'patch'), '2.9.10');
  assert.strictEqual(R.bumpVersion('2.9.9', 'minor'), '2.10.0');
  assert.strictEqual(R.bumpVersion('2.9.9', 'major'), '3.0.0');
  const fixed = [frag('### Fixed\n- a')];
  const next = (packageVersion, tags) => R.planRelease({ fragments: fixed, packageVersion, tags, date: 'd' });
  assert.strictEqual(next('2.67.0', ['2.66.0', '2.67.0']).version, '2.67.1');
  assert.strictEqual(next('2.67.0', ['2.67.0', '2.68.0', 'not-semver', '2.68.0-rc.1']).version, '2.68.1', 'a higher tag wins');
  assert.strictEqual(next('2.70.0', ['2.67.0']).version, '2.70.1', 'package.json ahead of the tags (old-style bump)');
  assert.strictEqual(next('2.70.0', []).version, '2.70.1', 'no tags fetched');
  assert.strictEqual(next('2.70.0', []).tag, null);
});

test('assembly: headings Added, Changed, Fixed, Removed, then the rest; bullets in fragment order', () => {
  const fragments = [
    frag('### Security\n- S1\n### Fixed\n- F1', 'changes/one.md'),
    frag('### Changed\n- C2\n  zweite Zeile\n### Added\n- A2', 'changes/two.md'),
    frag('### Fixed\n- F3\n### Deprecated\n- D3\n### Removed\n- R3\n### Added\n- A3', 'changes/three.md'),
  ];
  const section = R.renderSection('2.71.0', '2026-10-17', fragments);
  assert.strictEqual(
    section,
    [
      '## [2.71.0] - 2026-10-17',
      '',
      '### Added',
      '- A2',
      '- A3',
      '',
      '### Changed',
      '- C2',
      '  zweite Zeile',
      '',
      '### Fixed',
      '- F1',
      '- F3',
      '',
      '### Removed',
      '- R3',
      '',
      '### Deprecated',
      '- D3',
      '',
      '### Security',
      '- S1',
      '',
      '',
    ].join('\n')
  );
});

test('insertSection: below the intro lines, above the newest release', () => {
  const intro = '# Changelog\n\nAlle Änderungen.\nFormat nach Keep a Changelog\n\n';
  const old = '## [2.67.0] - 2026-10-17\n\n### Changed\n- Alt\n';
  const section = '## [2.68.0] - 2026-10-18\n\n### Added\n- Neu\n\n';
  assert.strictEqual(R.insertSection(intro + old, section), intro + section + old);
  assert.strictEqual(R.insertSection('# Changelog\n\nIntro\n', section), '# Changelog\n\nIntro\n\n## [2.68.0] - 2026-10-18\n\n### Added\n- Neu\n');
});

test('mixed mode: an old-style PR already bumped package.json and wrote its section', () => {
  // v2.68.0 merged the old way; release.yml may not even have tagged it yet.
  const changelog = '# Changelog\n\n## [2.68.0] - 2026-10-17\n\n### Fixed\n- Alt\n\n## [2.67.0] - 2026-10-16\n';
  const plan = R.planRelease({
    fragments: [frag('### Fixed\n- Neu')],
    packageVersion: '2.68.0',
    tags: ['2.67.0'],
    changelog,
    date: '2026-10-18',
  });
  assert.strictEqual(plan.version, '2.68.1');
  assert.strictEqual(plan.base, '2.68.0');
  const out = R.insertSection(changelog, plan.section);
  assert.match(out, /^# Changelog\n\n## \[2\.68\.1\] - 2026-10-18\n\n### Fixed\n- Neu\n\n## \[2\.68\.0\]/);
});

test('refuses to write below a CHANGELOG that is already at or above the next version', () => {
  assert.throws(
    () => R.planRelease({
      fragments: [frag('### Added\n- x')],
      packageVersion: '2.67.0',
      changelog: '## [2.68.0] - x\n\n## [2.67.0] - y\n',
      date: 'd',
    }),
    /CHANGELOG\.md already has \[2\.68\.0\], which is not below the next version 2\.68\.0/
  );
});

test('auto-merge: off for a major release and for numbers still reserved by old-style PRs', () => {
  const plan = (packageVersion, text) => R.planRelease({ fragments: [frag(text)], packageVersion, date: 'd' });
  assert.strictEqual(R.LEGACY_LAST, '2.71.0');
  assert.deepStrictEqual(pick(plan('2.67.0', '### Added\n- x')), { version: '2.68.0', autoMerge: false, hold: 'transition' });
  assert.deepStrictEqual(pick(plan('2.69.0', '### Fixed\n- x')), { version: '2.69.1', autoMerge: false, hold: 'transition' });
  assert.deepStrictEqual(pick(plan('2.70.0', '### Added\n- x')), { version: '2.71.0', autoMerge: false, hold: 'transition' });
  assert.deepStrictEqual(pick(plan('2.71.0', '### Fixed\n- x')), { version: '2.71.1', autoMerge: true, hold: '' });
  assert.deepStrictEqual(pick(plan('2.71.0', '### Added\n- x')), { version: '2.72.0', autoMerge: true, hold: '' });
  assert.deepStrictEqual(pick(plan('2.71.0', '<!-- bump: major -->\n### Changed\n- x')), { version: '3.0.0', autoMerge: false, hold: 'major' });
  function pick(p) {
    return { version: p.version, autoMerge: p.autoMerge, hold: p.hold };
  }
});

test('manifests: exactly the version line of package.json and the two of package-lock.json change', () => {
  const changedLines = (a, b) => a.split('\n').filter((l, i) => l !== b.split('\n')[i]);
  const pkg = fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8');
  const lock = fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8');
  const newPkg = R.bumpPackageJson(pkg, '9.8.7');
  const newLock = R.bumpLockfile(lock, '9.8.7');
  assert.deepStrictEqual(changedLines(newPkg, pkg), ['  "version": "9.8.7",']);
  assert.deepStrictEqual(changedLines(newLock, lock), ['  "version": "9.8.7",', '      "version": "9.8.7",']);
  assert.strictEqual(JSON.parse(newLock).packages[''].version, '9.8.7');
  // A layout where the first "version" is not the root one is refused, never half-bumped.
  assert.throws(() => R.bumpPackageJson('{\n  "x": { "version": "1.0.0" },\n  "version": "1.0.0"\n}\n', '1.1.0'), /package\.json: .*by hand/);
  assert.throws(() => R.bumpLockfile('{\n  "version": "1.0.0",\n  "packages": { "a": { "version": "3.0.0" }, "": { "version": "1.0.0" } }\n}\n', '1.1.0'), /package-lock\.json/);
});

test('no fragments: planRelease returns null', () => {
  assert.strictEqual(R.planRelease({ fragments: [], packageVersion: '2.67.0', date: 'd' }), null);
});

// --- CLI end to end in a scratch repository -----------------------------------

function scratchRepo(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pikdame-release-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const env = cleanEnv();
  const gitWith = (extraEnv, args) =>
    execFileSync(
      'git',
      ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args],
      { cwd: dir, env: { ...env, ...extraEnv }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
    );
  const git = (...args) => gitWith({}, args);
  const gitAt = (date, ...args) => gitWith({ GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date }, args);
  const file = (p) => path.join(dir, p);
  const write = (p, text) => {
    fs.mkdirSync(path.dirname(file(p)), { recursive: true });
    fs.writeFileSync(file(p), text);
  };
  const read = (p) => fs.readFileSync(file(p), 'utf8');
  const commit = (msg, ...paths) => {
    git('add', '--', ...paths);
    git('commit', '-q', '-m', msg);
  };
  const cli = (...args) => spawnSync(process.execPath, [SCRIPT, `--root=${dir}`, '--date=2026-10-18', ...args], { env, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  return { dir, git, gitAt, file, write, read, commit, cli };
}

const manifest = (v) => `${JSON.stringify({ name: 'demo', version: v, dependencies: { ws: '^8.0.0' } }, null, 2)}\n`;
const lockfile = (v) =>
  `${JSON.stringify({ name: 'demo', version: v, lockfileVersion: 3, requires: true, packages: { '': { name: 'demo', version: v }, 'node_modules/ws': { version: '8.0.0' } } }, null, 2)}\n`;

test('CLI: git order, mixed mode, apply, and a second run is a no-op', (t) => {
  const r = scratchRepo(t);
  r.write('package.json', manifest('1.4.0'));
  r.write('package-lock.json', lockfile('1.4.0'));
  r.write('CHANGELOG.md', '# Changelog\n\nIntro.\n\n## [1.4.0] - 2026-10-01\n\n### Added\n- Start\n');
  r.write('changes/README.md', '# Fragments\n\nNot a fragment.\n');
  r.commit('init', '.');
  r.git('tag', 'v1.4.0');
  // A higher tag on a branch main never merged must not count.
  r.git('switch', '-q', '-c', 'side');
  r.write('side.txt', 'x');
  r.commit('side', 'side.txt');
  r.git('tag', 'v9.0.0');
  r.git('switch', '-q', 'main');
  // Old-style PR merged: package.json at 1.5.0, untagged (mixed mode).
  r.write('package.json', manifest('1.5.0'));
  r.write('package-lock.json', lockfile('1.5.0'));
  r.write('CHANGELOG.md', r.read('CHANGELOG.md').replace('## [1.4.0]', '## [1.5.0] - 2026-10-02\n\n### Fixed\n- Alt\n\n## [1.4.0]'));
  r.commit('feat: old style (v1.5.0)', '.');
  // Merged in this order: zeta first, then alpha - git order, not the name, decides.
  r.write('changes/zeta.md', '### Fixed\n- Zeta kam zuerst\n');
  r.commit('fix: zeta', 'changes/zeta.md');
  r.write('changes/alpha.md', '### Added\n- Alpha kam danach\n### Fixed\n- Alpha repariert\n');
  r.commit('feat: alpha', 'changes/alpha.md');
  r.write('changes/new.md', '### Fixed\n- Noch nicht committet\n'); // uncommitted: last

  const dry = r.cli('--json');
  assert.strictEqual(dry.status, 0, dry.stderr);
  const plan = JSON.parse(dry.stdout);
  assert.strictEqual(plan.release, true);
  assert.strictEqual(plan.applied, false);
  assert.strictEqual(plan.version, '1.6.0', 'bump(max(tag 1.4.0, package.json 1.5.0), minor)');
  assert.strictEqual(plan.tag, '1.4.0', 'v9.0.0 is not reachable from HEAD');
  assert.deepStrictEqual(plan.fragments.map((f) => f.file), ['changes/zeta.md', 'changes/alpha.md', 'changes/new.md']);
  assert.match(plan.section, /### Fixed\n- Zeta kam zuerst\n- Alpha repariert\n- Noch nicht committet\n/);
  assert.strictEqual(r.read('package.json'), manifest('1.5.0'), 'dry run writes nothing');

  const human = r.cli('--dry-run');
  assert.strictEqual(human.status, 0, human.stderr);
  assert.match(human.stdout, /Next release: v1\.6\.0 \(minor\)/);
  assert.match(human.stdout, /Dry run - nothing written/);

  const applied = r.cli('--apply', '--json');
  assert.strictEqual(applied.status, 0, applied.stderr);
  assert.strictEqual(JSON.parse(applied.stdout).applied, true);
  assert.strictEqual(JSON.parse(r.read('package.json')).version, '1.6.0');
  const lock = JSON.parse(r.read('package-lock.json'));
  assert.deepStrictEqual([lock.version, lock.packages[''].version, lock.packages['node_modules/ws'].version], ['1.6.0', '1.6.0', '8.0.0']);
  assert.strictEqual(
    r.read('CHANGELOG.md'),
    '# Changelog\n\nIntro.\n\n## [1.6.0] - 2026-10-18\n\n### Added\n- Alpha kam danach\n\n### Fixed\n- Zeta kam zuerst\n- Alpha repariert\n- Noch nicht committet\n\n' +
      '## [1.5.0] - 2026-10-02\n\n### Fixed\n- Alt\n\n## [1.4.0] - 2026-10-01\n\n### Added\n- Start\n'
  );
  assert.deepStrictEqual(fs.readdirSync(r.file('changes')), ['README.md'], 'fragments deleted, README kept');

  // Idempotent: nothing left to release, nothing touched.
  const before = ['package.json', 'package-lock.json', 'CHANGELOG.md'].map(r.read);
  const again = r.cli('--apply', '--json');
  assert.strictEqual(again.status, 0, again.stderr);
  assert.deepStrictEqual(JSON.parse(again.stdout), { release: false });
  assert.deepStrictEqual(['package.json', 'package-lock.json', 'CHANGELOG.md'].map(r.read), before);
  assert.match(r.cli().stdout, /No changelog fragments in changes\/ - nothing to release\./);
});

test('CLI: a merged branch counts at its merge commit, not at its old commit date', (t) => {
  const r = scratchRepo(t);
  r.write('package.json', manifest('2.71.0'));
  r.write('CHANGELOG.md', '# Changelog\n\n## [2.71.0] - 2026-10-01\n');
  r.commit('init', '.');
  r.git('switch', '-q', '-c', 'feature');
  r.write('changes/early.md', '### Added\n- Lag lange auf dem Branch\n');
  r.git('add', 'changes/early.md');
  r.gitAt('2020-01-01T12:00:00Z', 'commit', '-q', '-m', 'old branch commit');
  r.git('switch', '-q', 'main');
  r.write('changes/direct.md', '### Added\n- Direkt auf main\n');
  r.commit('direct', 'changes/direct.md');
  r.git('merge', '-q', '--no-ff', 'feature', '-m', 'Merge pull request #1 from feature');
  const res = r.cli('--json');
  assert.strictEqual(res.status, 0, res.stderr);
  assert.deepStrictEqual(JSON.parse(res.stdout).fragments.map((f) => f.file), ['changes/direct.md', 'changes/early.md']);
});

test('CLI: a malformed fragment fails with its location and writes nothing', (t) => {
  const r = scratchRepo(t);
  r.write('package.json', manifest('1.0.0'));
  r.write('CHANGELOG.md', '# Changelog\n\n## [1.0.0] - 2026-10-01\n');
  r.write('changes/good.md', '### Added\n- Gut\n');
  r.write('changes/bad.md', '### Added\n- Gut\n\n### Geändert\n- Schlecht\n');
  r.commit('init', '.');
  const res = r.cli('--apply');
  assert.strictEqual(res.status, 1);
  assert.match(res.stderr, /changes\/bad\.md:4: headings are English: ### Changed instead of ### Geändert/);
  assert.strictEqual(JSON.parse(r.read('package.json')).version, '1.0.0');
  assert.ok(fs.existsSync(r.file('changes/good.md')), 'nothing deleted');
  assert.strictEqual(r.cli('--apply', '--dry-run').status, 1, 'contradicting modes are refused');
  assert.strictEqual(r.cli('--date=17.10.2026').status, 1, 'a malformed date is refused');
});

test('fragments in this repository and the example in changes/README.md are valid', () => {
  const dir = path.join(ROOT, 'changes');
  for (const name of R.listFragments(ROOT)) R.parseFragment(fs.readFileSync(path.join(dir, name), 'utf8'), `changes/${name}`);
  const example = /```markdown\n([\s\S]*?)```/.exec(fs.readFileSync(path.join(dir, 'README.md'), 'utf8'));
  assert.ok(example, 'changes/README.md shows an example fragment');
  const f = R.parseFragment(example[1], 'changes/README.md (example)');
  assert.strictEqual(R.fragmentLevel(f), 'patch', 'the example uses the override marker');
});

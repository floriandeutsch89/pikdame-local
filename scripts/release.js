#!/usr/bin/env node
// Turns the fragments in changes/ into the next release: version in package.json
// and package-lock.json, a new CHANGELOG.md section, fragments deleted. Run by
// release-pr.yml; format and bump rules: changes/README.md.
//
// Usage: node scripts/release.js [--dry-run | --apply] [--json] [--date=YYYY-MM-DD]
//   --dry-run  (default) print the next version and section, write nothing
//   --apply    write it; a second run finds no fragments and does nothing
//   --json     machine-readable summary on stdout (release-pr.yml reads it)
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { gameDay } = require('../game/GameDay');

const ROOT = path.join(__dirname, '..');
const CHANGES = 'changes';
// Output order; Keep a Changelog's two remaining types go last.
const HEADINGS = ['Added', 'Changed', 'Fixed', 'Removed', 'Deprecated', 'Security'];
const PATCH_HEADINGS = new Set(['Fixed', 'Security']);
const LEVELS = ['patch', 'minor', 'major'];
// Transition, delete once main is past it: old-style PRs (#351, #353, tutorial)
// hold the numbers up to here; check-changes.js accepts them, no auto-merge into them.
const LEGACY_LAST = '2.70.0';
// The usual slip (bump-deps.js once wrote "### Geändert"), answered in English.
const GERMAN_HEADINGS = {
  hinzugefügt: 'Added',
  neu: 'Added',
  geändert: 'Changed',
  änderungen: 'Changed',
  behoben: 'Fixed',
  fehlerbehebungen: 'Fixed',
  entfernt: 'Removed',
  veraltet: 'Deprecated',
  sicherheit: 'Security',
};
const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)$/;

class FragmentError extends Error {
  constructor(file, line, reason) {
    super(`${file}${line ? `:${line}` : ''}: ${reason}`);
    this.file = file;
    this.line = line;
  }
}

function parseVersion(v) {
  const m = VERSION_RE.exec(String(v));
  if (!m) throw new Error(`not a version: "${v}"`);
  return m.slice(1).map(Number);
}

function compareVersions(a, b) {
  const [x, y] = [parseVersion(a), parseVersion(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}

function bumpVersion(v, level) {
  const [major, minor, patch] = parseVersion(v);
  if (level === 'major') return `${major + 1}.0.0`;
  if (level === 'minor') return `${major}.${minor + 1}.0`;
  if (level === 'patch') return `${major}.${minor}.${patch + 1}`;
  throw new Error(`unknown bump level "${level}"`);
}

const maxVersion = (list) => list.reduce((m, v) => (m === null || compareVersions(v, m) > 0 ? v : m), null);

/** Parses one fragment into { file, bump, sections: Map(heading -> [bullet]) };
 *  throws FragmentError ("file:line: reason") on malformed input. */
function parseFragment(text, file) {
  const fail = (line, reason) => {
    throw new FragmentError(file, line, reason);
  };
  const lines = String(text ?? '').replace(/^﻿/, '').replace(/\r\n?/g, '\n').split('\n');
  const sections = new Map();
  const headingAt = new Map();
  let bump = null;
  let bullets = null; // bullets under the current heading
  lines.forEach((raw, i) => {
    const n = i + 1;
    const line = raw.replace(/\s+$/, '');
    if (!line) return;
    const marker = /^<!--\s*bump\s*:\s*(.*?)\s*-->$/i.exec(line);
    if (marker) {
      if (i !== 0) fail(n, 'the bump marker must be the very first line');
      bump = marker[1].toLowerCase();
      if (!LEVELS.includes(bump)) fail(n, `unknown bump "${marker[1]}" - use patch, minor or major`);
      return;
    }
    if (/^<!--.*-->$/.test(line)) return; // a note for reviewers, never released
    if (line.startsWith('<!--')) fail(n, 'an HTML comment must open and close on the same line');
    const heading = /^(#+)\s*(.*)$/.exec(line);
    if (heading) {
      const title = heading[2].trim();
      if (heading[1] !== '###') {
        fail(n, /^\[?\d+\.\d+\.\d+/.test(title)
          ? 'no version header in a fragment - the release PR adds it'
          : `use ### headings: ${HEADINGS.map((h) => `### ${h}`).join(', ')}`);
      }
      const name = HEADINGS.find((h) => h.toLowerCase() === title.toLowerCase());
      if (!name) {
        const english = GERMAN_HEADINGS[title.toLowerCase()];
        fail(n, english
          ? `headings are English: ### ${english} instead of ### ${title}`
          : `unknown heading "### ${title}" - use one of ${HEADINGS.join(', ')}`);
      }
      if (!sections.has(name)) {
        sections.set(name, []);
        headingAt.set(name, n);
      }
      bullets = sections.get(name);
      return;
    }
    if (/^[*+]\s/.test(line)) fail(n, "bullets start with '- '");
    if (line.startsWith('-')) {
      const m = /^-[ \t]+(\S.*)$/.exec(line);
      if (!m) fail(n, /^-\s*$/.test(line) ? 'empty bullet' : "bullets start with '- ' (dash, space)");
      if (!bullets) fail(n, 'bullet before the first ### heading');
      bullets.push(`- ${m[1]}`);
      return;
    }
    if (/^\s/.test(line)) {
      // Indented: a continuation line or a nested bullet of the bullet above.
      if (!bullets || !bullets.length) fail(n, 'indented line outside a bullet');
      bullets[bullets.length - 1] += `\n${line}`;
      return;
    }
    fail(n, "text outside a bullet - every entry is a '- ' bullet under a ### heading");
  });
  if (!sections.size) fail(0, "empty fragment - add a ### heading with at least one '- ' bullet");
  for (const [name, list] of sections) if (!list.length) fail(headingAt.get(name), `### ${name} has no bullets`);
  return { file, bump, sections };
}

/** Marker if present, else patch for Fixed/Security only, minor otherwise. */
function fragmentLevel(fragment) {
  if (fragment.bump) return fragment.bump;
  return [...fragment.sections.keys()].every((h) => PATCH_HEADINGS.has(h)) ? 'patch' : 'minor';
}

/** `fragments` in release order; bullets keep that order inside each heading. */
function renderSection(version, date, fragments) {
  let out = `## [${version}] - ${date}\n`;
  for (const heading of HEADINGS) {
    const bullets = fragments.flatMap((f) => f.sections.get(heading) || []);
    if (bullets.length) out += `\n### ${heading}\n${bullets.join('\n')}\n`;
  }
  return `${out}\n`;
}

/** Puts the section above the first release, below the intro lines. */
function insertSection(changelog, section) {
  const at = changelog.search(/^## \[/m);
  if (at >= 0) return changelog.slice(0, at) + section + changelog.slice(at);
  const intro = changelog.replace(/\s+$/, '');
  return `${intro ? `${intro}\n\n` : ''}${section.replace(/\n+$/, '\n')}`;
}

const changelogVersions = (text) => [...String(text).matchAll(/^## \[(\d+\.\d+\.\d+)\]/gm)].map((m) => m[1]);

/** Sets the first `count` "version" values, leaving every other byte alone;
 *  `expect` mutates the parsed original into what the result must parse to. */
function setVersions(text, next, count, file, expect) {
  let seen = 0;
  const out = text.replace(/("version"\s*:\s*")[^"]*(")/g, (m, a, b) => (seen++ < count ? a + next + b : m));
  const want = JSON.parse(text);
  expect(want);
  if (JSON.stringify(want) !== JSON.stringify(JSON.parse(out))) {
    throw new Error(`${file}: the first ${count} "version" field(s) are not the top-level one(s) - unexpected layout, bump it by hand`);
  }
  return out;
}

const bumpPackageJson = (text, next) => setVersions(text, next, 1, 'package.json', (p) => {
  p.version = next;
});

// The lockfile carries the version twice (root + packages[""]); both move.
const bumpLockfile = (text, next) => setVersions(text, next, 2, 'package-lock.json', (l) => {
  l.version = next;
  if (l.packages && l.packages['']) l.packages[''].version = next;
});

/** Pure core: the next release from parsed `fragments` (release order) and the
 *  versions of the v* `tags` reachable from HEAD; null without fragments. */
function planRelease({ fragments, packageVersion, tags = [], changelog = '', date }) {
  if (!fragments.length) return null;
  const tag = maxVersion(tags.filter((t) => VERSION_RE.test(t)));
  // Old-style PRs bump package.json before release.yml tags it (mixed mode).
  const base = tag && compareVersions(tag, packageVersion) > 0 ? tag : packageVersion;
  const levels = fragments.map(fragmentLevel);
  const level = levels.reduce((a, b) => (LEVELS.indexOf(b) > LEVELS.indexOf(a) ? b : a));
  const version = bumpVersion(base, level);
  const top = maxVersion(changelogVersions(changelog));
  if (top && compareVersions(top, version) >= 0) {
    throw new Error(`CHANGELOG.md already has [${top}], which is not below the next version ${version} - package.json is behind the CHANGELOG`);
  }
  let hold = '';
  if (level === 'major') hold = 'major';
  else if (compareVersions(version, LEGACY_LAST) <= 0) hold = 'transition';
  return {
    version,
    base,
    tag,
    packageVersion,
    level,
    date,
    autoMerge: !hold,
    hold,
    fragments: fragments.map((f, i) => ({ file: f.file, level: levels[i] })),
    section: renderSection(version, date, fragments),
  };
}

function git(root, args) {
  return execFileSync('git', ['-c', 'core.quotePath=false', '-c', 'log.showRoot=true', ...args], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

/** Versions of the v* tags reachable from HEAD; [] without git or tags. */
function reachableTags(root) {
  try {
    return git(root, ['tag', '--merged', 'HEAD', '--list', 'v*'])
      .split('\n')
      .map((t) => t.trim().replace(/^v/, ''))
      .filter((t) => VERSION_RE.test(t));
  } catch (e) {
    return [];
  }
}

/** Fragment names (README.md and non-Markdown files excluded). */
function listFragments(root) {
  const dir = path.join(root, CHANGES);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isFile() && d.name.endsWith('.md') && d.name.toLowerCase() !== 'readme.md')
    .map((d) => d.name);
}

/** Merge order on the first-parent line (a merge commit counts, not the branch
 *  commit's date); re-added names count from the newest add, uncommitted last. */
function orderFragments(root, names) {
  let log = '';
  try {
    log = git(root, ['log', '--first-parent', '--diff-merges=first-parent', '--diff-filter=A', '--no-renames',
      '--name-only', '--format=%x00', '--', `${CHANGES}/`]);
  } catch (e) {
    if (names.length) console.error('release: no git history for changes/ - fragments ordered by name');
  }
  const age = new Map(); // name -> index of its newest add commit (0 = newest)
  log.split('\0').slice(1).forEach((chunk, i) => {
    for (const p of chunk.split('\n')) {
      const name = p.startsWith(`${CHANGES}/`) ? p.slice(CHANGES.length + 1) : '';
      if (name && !age.has(name)) age.set(name, i);
    }
  });
  const key = (n) => (age.has(n) ? -age.get(n) : 1);
  return [...names].sort((a, b) => key(a) - key(b) || (a < b ? -1 : a > b ? 1 : 0));
}

const USAGE = 'usage: node scripts/release.js [--dry-run | --apply] [--json] [--date=YYYY-MM-DD]';

function main(argv = process.argv.slice(2)) {
  const opts = { mode: null, json: false, date: null, root: ROOT };
  for (const a of argv) {
    if (a === '--apply' || a === '--dry-run') {
      if (opts.mode && opts.mode !== a) throw new Error('--apply and --dry-run exclude each other');
      opts.mode = a;
    } else if (a === '--json') opts.json = true;
    else if (a.startsWith('--date=')) opts.date = a.slice('--date='.length);
    else if (a.startsWith('--root=')) opts.root = path.resolve(a.slice('--root='.length)); // tests
    else throw new Error(`unknown argument "${a}"\n${USAGE}`);
  }
  if (opts.date !== null && !/^\d{4}-\d{2}-\d{2}$/.test(opts.date)) throw new Error(`--date must be YYYY-MM-DD, got "${opts.date}"`);
  const apply = opts.mode === '--apply';
  const root = opts.root;
  const file = (...p) => path.join(root, ...p);

  const names = orderFragments(root, listFragments(root));
  if (!names.length) {
    if (opts.json) console.log(JSON.stringify({ release: false }));
    else console.log('No changelog fragments in changes/ - nothing to release.');
    return 0;
  }
  const fragments = [];
  const problems = [];
  for (const name of names) {
    try {
      fragments.push(parseFragment(fs.readFileSync(file(CHANGES, name), 'utf8'), `${CHANGES}/${name}`));
    } catch (e) {
      if (!(e instanceof FragmentError)) throw e;
      problems.push(e);
    }
  }
  if (problems.length) {
    for (const e of problems) console.error(annotation(e.message, e.file, e.line));
    console.error(`${problems.length} malformed fragment(s) - format: changes/README.md`);
    return 1;
  }

  const pkgText = fs.readFileSync(file('package.json'), 'utf8');
  const changelog = fs.readFileSync(file('CHANGELOG.md'), 'utf8');
  const plan = planRelease({
    fragments,
    packageVersion: JSON.parse(pkgText).version,
    tags: reachableTags(root),
    changelog,
    date: opts.date || gameDay(),
  });

  if (apply) {
    // Everything is computed before the first write, so a bad manifest aborts cleanly.
    const writes = [
      ['package.json', bumpPackageJson(pkgText, plan.version)],
      ['CHANGELOG.md', insertSection(changelog, plan.section)],
    ];
    if (fs.existsSync(file('package-lock.json'))) {
      writes.push(['package-lock.json', bumpLockfile(fs.readFileSync(file('package-lock.json'), 'utf8'), plan.version)]);
    }
    for (const [name, text] of writes) fs.writeFileSync(file(name), text);
    for (const f of plan.fragments) fs.unlinkSync(file(f.file));
  }

  if (opts.json) {
    console.log(JSON.stringify({ release: true, applied: apply, ...plan }));
    return 0;
  }
  const holdText = {
    major: 'no - major release, waits for a review',
    transition: `no - v${plan.version} is still reserved for an old-style PR (transition, up to v${LEGACY_LAST})`,
  };
  console.log(`Next release: v${plan.version} (${plan.level}) - auto-merge: ${plan.autoMerge ? 'yes' : holdText[plan.hold]}`);
  console.log(`Base: ${plan.base} (package.json ${plan.packageVersion}, highest tag ${plan.tag ? `v${plan.tag}` : 'none'})`);
  console.log('Fragments, oldest first:');
  for (const f of plan.fragments) console.log(`  ${f.file} (${f.level})`);
  console.log(`\n${plan.section.trimEnd()}\n`);
  console.log(apply
    ? `Applied: package.json, package-lock.json and CHANGELOG.md updated, ${plan.fragments.length} fragment(s) deleted.`
    : 'Dry run - nothing written. --apply writes it.');
  return 0;
}

/** A GitHub annotation inside Actions, a plain line elsewhere. */
function annotation(message, file, line) {
  if (process.env.GITHUB_ACTIONS !== 'true') return `error: ${message}`;
  const esc = (s) => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
  const prop = (s) => esc(s).replace(/:/g, '%3A').replace(/,/g, '%2C');
  const where = file ? ` file=${prop(file)}${line ? `,line=${line}` : ''}` : '';
  return `::error${where}::${esc(message)}`;
}

if (require.main === module) {
  try {
    process.exitCode = main();
  } catch (e) {
    console.error(annotation(`release: ${e.message}`));
    process.exitCode = 1;
  }
}

module.exports = {
  HEADINGS,
  LEGACY_LAST,
  FragmentError,
  annotation,
  bumpLockfile,
  bumpPackageJson,
  bumpVersion,
  compareVersions,
  fragmentLevel,
  insertSection,
  listFragments,
  orderFragments,
  parseFragment,
  planRelease,
  renderSection,
  main,
};

#!/usr/bin/env node
// Pull-request guard (CI job changelog-fragment): a PR that changes the shipped
// game adds a changelog fragment (changes/README.md), and only the release PR
// touches the version or the released CHANGELOG.md sections.
//
// Usage: node scripts/check-changes.js [--base=<rev>] [--head=<rev>] [--branch=<name>]
//   --base    default: merge-base of origin/main and --head (CI: the merge commit's HEAD^1)
//   --head    default: HEAD - only committed changes count
//   --branch  the PR's head branch; release/next is the release PR
'use strict';

const { execFileSync } = require('child_process');
const { FragmentError, LEGACY_LAST, annotation, compareVersions, parseFragment } = require('./release');

const RELEASE_BRANCH = 'release/next';
// What the image is built from (docker/Dockerfile); Markdown in there is docs.
const SHIPPED = [/^public\//, /^game\//, /^models\//, /^docker\//, /^server\.js$/, /^scripts\/minify-assets\.js$/, /^scripts\/admin-role\.js$/];
const DEP_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'overrides'];
const FRAGMENT_NAME = /^changes\/[a-z0-9][a-z0-9._-]*\.md$/;
const README = 'changes/README.md';

/** CHANGELOG.md from the first release section on (the intro is free). */
function releasePart(text) {
  const s = String(text ?? '');
  const at = s.search(/^## \[/m);
  return at < 0 ? '' : s.slice(at);
}

const lockVersions = (l) => JSON.stringify([l.version, l.packages && l.packages[''] && l.packages[''].version]);
function lockWithoutVersions(l) {
  const copy = JSON.parse(JSON.stringify(l));
  delete copy.version;
  if (copy.packages && copy.packages['']) delete copy.packages[''].version;
  return JSON.stringify(copy);
}

/** Why an old-style bump (version + one CHANGELOG section) is NOT acceptable;
 *  '' when it is: above the base and at most LEGACY_LAST (transition). */
function legacyProblem({ baseVersion, headVersion, baseRelease, headRelease }) {
  if (baseVersion === headVersion) return 'the version did not change';
  if (!/^\d+\.\d+\.\d+$/.test(`${headVersion}`) || !/^\d+\.\d+\.\d+$/.test(`${baseVersion}`)) {
    return 'package.json has no X.Y.Z version';
  }
  if (compareVersions(headVersion, baseVersion) <= 0) {
    return `v${headVersion} is not above v${baseVersion} on the base branch - main has passed this number`;
  }
  if (compareVersions(headVersion, LEGACY_LAST) > 0) {
    return `v${headVersion} is above v${LEGACY_LAST}, the last number an old-style PR may take`;
  }
  if (headRelease === baseRelease) return `CHANGELOG.md has no new section for v${headVersion}`;
  const second = headRelease.slice(1).search(/^## \[/m);
  const top = second < 0 ? headRelease : headRelease.slice(0, second + 1);
  const rest = second < 0 ? '' : headRelease.slice(second + 1);
  if (!top.startsWith(`## [${headVersion}]`)) return `the new CHANGELOG.md section on top must be ## [${headVersion}]`;
  if (rest !== baseRelease) return 'CHANGELOG.md changes more than one new section on top';
  return '';
}

/** Pure core. `diff`: [{ status (A/M/D/T), path }] base -> head; `read(side, path)`
 *  gives the content on 'base' or 'head' (null when missing). */
function checkChanges({ diff, read, branch = '' }) {
  const errors = [];
  const notes = [];
  const isRelease = branch === RELEASE_BRANCH;
  const changed = new Set(diff.map((d) => d.path));
  const parsed = new Map();
  const json = (side, file) => {
    const key = `${side}:${file}`;
    if (!parsed.has(key)) {
      try {
        parsed.set(key, JSON.parse(read(side, file)));
      } catch (e) {
        errors.push({ file, message: `${file} on the ${side} side is not valid JSON` });
        parsed.set(key, null);
      }
    }
    return parsed.get(key);
  };

  const fragments = [];
  for (const { status, path: p } of diff) {
    if (!p.startsWith('changes/') || p === README || status === 'D') continue;
    if (!FRAGMENT_NAME.test(p)) {
      errors.push({ file: p, message: `${p}: a fragment is changes/<topic>.md - lowercase letters, digits, "-", "." or "_", directly in changes/` });
      continue;
    }
    try {
      parseFragment(read('head', p), p);
      fragments.push(p);
    } catch (e) {
      if (!(e instanceof FragmentError)) throw e;
      errors.push({ file: e.file, line: e.line, message: e.message });
    }
  }

  const shipped = diff.filter((d) => SHIPPED.some((re) => re.test(d.path)) && !d.path.endsWith('.md')).map((d) => d.path);
  let versionChanged = false;
  if (changed.has('package.json')) {
    const [b, h] = [json('base', 'package.json'), json('head', 'package.json')];
    if (b && h) {
      if (DEP_FIELDS.some((k) => JSON.stringify(b[k]) !== JSON.stringify(h[k]))) shipped.push('package.json (dependencies)');
      if (b.version !== h.version) versionChanged = true;
    }
  }
  if (changed.has('package-lock.json')) {
    const [b, h] = [json('base', 'package-lock.json'), json('head', 'package-lock.json')];
    if (b && h) {
      if (lockVersions(b) !== lockVersions(h)) versionChanged = true;
      if (lockWithoutVersions(b) !== lockWithoutVersions(h)) shipped.push('package-lock.json');
    }
  }
  const baseRelease = changed.has('CHANGELOG.md') ? releasePart(read('base', 'CHANGELOG.md')) : '';
  const headRelease = changed.has('CHANGELOG.md') ? releasePart(read('head', 'CHANGELOG.md')) : '';
  const changelogChanged = baseRelease !== headRelease;

  let legacy = false;
  if (isRelease) {
    notes.push(`Release PR (${RELEASE_BRANCH}): version and CHANGELOG.md belong to it.`);
  } else if (versionChanged || changelogChanged) {
    const base = json('base', 'package.json');
    const head = json('head', 'package.json');
    const why = base && head
      ? legacyProblem({ baseVersion: base.version, headVersion: head.version, baseRelease, headRelease })
      : 'package.json unreadable';
    if (!why && fragments.length) {
      errors.push({
        file: 'CHANGELOG.md',
        message: 'Old-style bump AND a changelog fragment - the entry would ship twice. Either keep the bump and drop the fragment, or convert fully (fragment only).',
      });
    } else if (!why) {
      legacy = true;
      notes.push(`Transition: old-style bump to v${head.version} accepted (numbers up to v${LEGACY_LAST} were claimed before changelog fragments).`);
    } else {
      errors.push({
        file: changelogChanged ? 'CHANGELOG.md' : 'package.json',
        message:
          'The version and the released CHANGELOG.md sections belong to the release PR. Put your entry into ' +
          'changes/<topic>.md (format: changes/README.md) and leave package.json, package-lock.json and the ' +
          `CHANGELOG.md sections as they are on main. (Transition rule not met: ${why}.)`,
      });
    }
  }

  if (shipped.length && !fragments.length && !legacy && !isRelease) {
    const list = shipped.slice(0, 5).join(', ') + (shipped.length > 5 ? `, +${shipped.length - 5} more` : '');
    errors.push({
      message: `This PR changes the shipped game (${list}) but adds no changelog fragment. Add changes/<topic>.md - format: changes/README.md.`,
    });
  } else if (shipped.length && fragments.length) {
    notes.push(`Shipped change with fragment(s): ${fragments.join(', ')}.`);
  } else if (!shipped.length && !isRelease && !errors.length) {
    notes.push('No shipped change - no fragment needed.');
  }
  return { errors, notes, shipped, fragments, legacy };
}

function git(args) {
  return execFileSync('git', ['-c', 'core.quotePath=false', ...args], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function main(argv = process.argv.slice(2)) {
  const opts = { base: null, head: 'HEAD', branch: '' };
  for (const a of argv) {
    const m = /^--(base|head|branch)=(.*)$/.exec(a);
    if (!m) throw new Error(`unknown argument "${a}"`);
    opts[m[1]] = m[2];
  }
  const base = opts.base || git(['merge-base', 'origin/main', opts.head]).trim();
  const raw = git(['diff', '--name-status', '--no-renames', '-z', base, opts.head]).split('\0');
  if (raw[raw.length - 1] === '') raw.pop();
  const diff = [];
  for (let i = 0; i + 1 < raw.length; i += 2) diff.push({ status: raw[i][0], path: raw[i + 1] });
  const read = (side, p) => {
    try {
      return git(['show', `${side === 'base' ? base : opts.head}:${p}`]);
    } catch (e) {
      return null;
    }
  };

  const result = checkChanges({ diff, read, branch: opts.branch });
  for (const n of result.notes) console.log(n);
  for (const e of result.errors) console.error(annotation(e.message, e.file, e.line));
  if (result.errors.length) {
    console.error(`${result.errors.length} problem(s) - changelog fragments: changes/README.md`);
    return 1;
  }
  console.log('Changelog check passed.');
  return 0;
}

if (require.main === module) {
  try {
    process.exitCode = main();
  } catch (e) {
    console.error(annotation(`check-changes: ${e.message}`));
    process.exitCode = 1;
  }
}

module.exports = { checkChanges, legacyProblem, releasePart, RELEASE_BRANCH, SHIPPED };

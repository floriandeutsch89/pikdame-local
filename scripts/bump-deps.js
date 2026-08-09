#!/usr/bin/env node
/**
 * Used by .github/workflows/dependabot-auto.yml: bumps the version and
 * prepends a German changelog entry for a dependency chore. Kept as a
 * standalone script so it is testable outside the workflow.
 *
 * Usage:
 *   node scripts/bump-deps.js "<list>" [--level=minor|patch] [--kind=npm|docker]
 *     <list>  e.g. "ws 8.21.3→8.22.0, pg 8.23.0→8.24.0"
 *     --level minor (default) or patch
 *     --kind  wording of the changelog line: dependencies (npm) or base images
 *
 * Prints the new version to stdout.
 */
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const list = (args.find((a) => !a.startsWith('--')) || '').trim();
const flag = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const level = flag('level', 'minor');
const kind = flag('kind', 'npm');

if (!list) {
  console.error('bump-deps: update list argument required');
  process.exit(1);
}
if (level !== 'minor' && level !== 'patch') {
  console.error(`bump-deps: unknown --level=${level} (minor|patch)`);
  process.exit(1);
}

const root = path.join(__dirname, '..');
const pkgPath = path.join(root, 'package.json');
const lockPath = path.join(root, 'package-lock.json');
const clPath = path.join(root, 'CHANGELOG.md');

const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
const [maj, min, patch] = pkg.version.split('.').map(Number);
const next = level === 'patch' ? `${maj}.${min}.${patch + 1}` : `${maj}.${min + 1}.0`;
pkg.version = next;
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');

// The lockfile carries the version twice (root + packages[""]). Keeping it in
// sync avoids a spurious diff on the next `npm install`.
if (fs.existsSync(lockPath)) {
  const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  lock.version = next;
  if (lock.packages && lock.packages['']) lock.packages[''].version = next;
  fs.writeFileSync(lockPath, JSON.stringify(lock, null, 2) + '\n');
}

const what =
  kind === 'docker'
    ? `Container-Basis-Images aktualisiert (automatischer Dependabot-Check): ${list}`
    : `Abhängigkeiten aktualisiert (automatischer Dependabot-Check): ${list}`;
const date = new Date().toISOString().slice(0, 10);
const entry = `## [${next}] - ${date}

### Geändert
- ${what}

`;
const cl = fs.readFileSync(clPath, 'utf8');
const anchor = cl.indexOf('## [');
if (anchor === -1) {
  console.error('bump-deps: CHANGELOG anchor not found');
  process.exit(1);
}
fs.writeFileSync(clPath, cl.slice(0, anchor) + entry + cl.slice(anchor));
console.log(next);

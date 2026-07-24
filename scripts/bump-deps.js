#!/usr/bin/env node
/**
 * Used by .github/workflows/deps-update.yml: bumps the MINOR version and
 * prepends a German changelog entry for a dependency chore. Kept as a
 * standalone script so it is unit-testable outside the workflow.
 *
 * Usage: node scripts/bump-deps.js "<update list, e.g. 'ws 8.1.0→8.2.0, pg 8.11→8.12'>"
 * Prints the new version to stdout.
 */
const fs = require('fs');
const path = require('path');

const list = (process.argv[2] || '').trim();
if (!list) {
  console.error('bump-deps: update list argument required');
  process.exit(1);
}

const root = path.join(__dirname, '..');
const pkgPath = path.join(root, 'package.json');
const clPath = path.join(root, 'CHANGELOG.md');

const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
const [maj, min] = pkg.version.split('.').map(Number);
const next = `${maj}.${min + 1}.0`; // chore updates release as MINOR (user decision)
pkg.version = next;
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');

const date = new Date().toISOString().slice(0, 10);
const entry = `## [${next}] - ${date}

### Geändert
- Abhängigkeiten aktualisiert (wöchentlicher automatischer Check): ${list}

`;
const cl = fs.readFileSync(clPath, 'utf8');
const anchor = cl.indexOf('## [');
if (anchor === -1) {
  console.error('bump-deps: CHANGELOG anchor not found');
  process.exit(1);
}
fs.writeFileSync(clPath, cl.slice(0, anchor) + entry + cl.slice(anchor));
console.log(next);

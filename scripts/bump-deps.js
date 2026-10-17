#!/usr/bin/env node
/**
 * Used by .github/workflows/dependabot-auto.yml: writes the changelog fragment
 * changes/deps-<PR number>.md; the release PR makes the version out of it.
 *
 * Usage:
 *   node scripts/bump-deps.js "<list>" --pr=<number> [--level=minor|patch] [--kind=npm|docker]
 *     <list>  e.g. "ws 8.21.3→8.22.0, pg 8.23.0→8.24.0"
 *     --pr    number of the Dependabot PR, names the fragment
 *     --level patch adds <!-- bump: patch -->; minor (default) needs no marker
 *     --kind  wording of the line: dependencies (npm) or base images (docker)
 * Prints the fragment path (relative to the repository root).
 */
'use strict';

const fs = require('fs');
const path = require('path');

function depsFragment({ list, level = 'minor', kind = 'npm' }) {
  const what = kind === 'docker'
    ? 'Container-Basis-Images aktualisiert (automatischer Dependabot-Check)'
    : 'Abhängigkeiten aktualisiert (automatischer Dependabot-Check)';
  const marker = level === 'patch' ? '<!-- bump: patch -->\n' : '';
  return `${marker}### Changed\n- ${what}: ${String(list).replace(/\s+/g, ' ').trim()}\n`;
}

function main(argv = process.argv.slice(2)) {
  const list = (argv.find((a) => !a.startsWith('--')) || '').trim();
  const flag = (name, fallback) => {
    const hit = argv.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : fallback;
  };
  const pr = flag('pr', '');
  const level = flag('level', 'minor');
  const kind = flag('kind', 'npm');
  const root = path.resolve(flag('root', path.join(__dirname, '..'))); // tests
  if (!list) throw new Error('update list argument required');
  if (!/^\d+$/.test(pr)) throw new Error(`--pr=<number> required, got "${pr}"`);
  if (level !== 'minor' && level !== 'patch') throw new Error(`unknown --level=${level} (minor|patch)`);
  if (kind !== 'npm' && kind !== 'docker') throw new Error(`unknown --kind=${kind} (npm|docker)`);

  const rel = `changes/deps-${pr}.md`;
  fs.mkdirSync(path.join(root, 'changes'), { recursive: true });
  fs.writeFileSync(path.join(root, rel), depsFragment({ list, level, kind }));
  console.log(rel);
}

if (require.main === module) {
  try {
    main();
  } catch (e) {
    console.error(`bump-deps: ${e.message}`);
    process.exitCode = 1;
  }
}

module.exports = { depsFragment, main };

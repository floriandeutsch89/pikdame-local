#!/usr/bin/env node
// Fails if a tracked file LOOKS like a secret or like private runtime data -
// by name, before any content scanner has to guess. Complements gitleaks in
// CI (content patterns across the full history) and .gitignore (which only
// protects files that were never added).
//
// Usage: node scripts/check-secret-files.js   (npm run secrets:check)
// Zero dependencies; reads `git ls-files`.
'use strict';

const { execFileSync } = require('child_process');
const path = require('path');

// Templates are fine - they are how the real files get documented.
const TEMPLATE = /\.(example|sample|template|dist)$/i;

/** Returns a reason string if `file` (repo-relative, forward slashes) must
 *  not be committed, otherwise null. */
function forbiddenReason(file) {
  const base = path.posix.basename(file);
  if (TEMPLATE.test(base)) return null;
  if (base === '.env' || base.startsWith('.env.')) return 'environment file (.env)';
  if (/\.(pem|key|p12|pfx|jks|keystore)$/i.test(base)) return 'private key / certificate store';
  if (/^id_(rsa|dsa|ecdsa|ed25519)$/.test(base)) return 'SSH private key';
  if (/\.tfvars(\.json)?$/.test(base)) return 'Terraform variables (may hold the Hetzner token)';
  if (/\.tfstate(\.backup)?$/.test(base)) return 'Terraform state (contains secrets in plain text)';
  if (file.startsWith('docker/secrets/')) return 'Docker secret';
  // Runtime data: player profiles, statistics and the account DB (e-mail
  // addresses, password hashes). CLAUDE.md: delete before every commit.
  if (/^data\/.+\.(json|jsonl|db|db-wal|db-shm|log)$/.test(file)) return 'runtime data (profiles/accounts)';
  if (base === '.npmrc' || base === '.pypirc' || base === '.netrc') return 'credentials file';
  return null;
}

function main() {
  const out = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' });
  const offenders = out
    .split('\0')
    .filter(Boolean)
    .map((f) => [f, forbiddenReason(f)])
    .filter(([, reason]) => reason);
  if (offenders.length) {
    for (const [f, reason] of offenders) console.error(`::error file=${f}::tracked secret-like file: ${f} (${reason})`);
    console.error(
      `\n${offenders.length} file(s) must not be in the repository. Remove them with ` +
      '`git rm --cached <file>`, add them to .gitignore - and ROTATE any secret ' +
      'they contained: once pushed, it is public (history, forks, caches).'
    );
    process.exit(1);
  }
  console.log('No secret-like files tracked.');
}

if (require.main === module) main();
module.exports = { forbiddenReason };

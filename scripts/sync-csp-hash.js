/** Keeps the CSP script hashes in docker/caddy/Caddyfile in sync with the
 *  inline scripts in public/index.html.
 *
 *  Why this exists: the browser only runs the inline head script if its exact
 *  sha256 is listed in script-src. Edit the script by one byte without
 *  touching the Caddyfile and the script is silently BLOCKED - no crawler
 *  detection, splash on every load, lobby flash. Nothing throws, nothing logs.
 *
 *  test/csp-contract.test.js fails the build on that drift. This script is the
 *  other half: it FIXES it, so the answer to a red test is one command instead
 *  of copying base64 by hand.
 *
 *  Run: node scripts/sync-csp-hash.js          (rewrites the Caddyfile)
 *       node scripts/sync-csp-hash.js --check  (reports drift, writes nothing)
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const root = path.join(__dirname, '..');
const HTML = path.join(root, 'public', 'index.html');
const CADDY = path.join(root, 'docker', 'caddy', 'Caddyfile');

// Git stores LF; a CRLF working copy would hash differently from the bytes the
// container serves (see .gitattributes).
const read = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');

/** Inline <script> bodies. JSON-LD data blocks are excluded: they are not
 *  executed, so script-src does not apply to them. */
function inlineScripts(html) {
  const re = /<script(?![^>]*\bsrc=)(?![^>]*application\/ld\+json)[^>]*>([\s\S]*?)<\/script>/g;
  const out = [];
  let m;
  while ((m = re.exec(html))) out.push(m[1]);
  return out;
}

const hashOf = (body) => `sha256-${crypto.createHash('sha256').update(body, 'utf8').digest('base64')}`;

function main() {
  const checkOnly = process.argv.includes('--check');
  const wanted = inlineScripts(read(HTML)).map(hashOf);
  if (wanted.length === 0) {
    console.error('No inline script found in public/index.html - refusing to touch the CSP.');
    process.exit(1);
  }

  const caddy = read(CADDY);
  const line = caddy.split('\n').find((l) => l.trim().startsWith('Content-Security-Policy '));
  if (!line) {
    console.error('No Content-Security-Policy header in docker/caddy/Caddyfile.');
    process.exit(1);
  }

  const present = [...line.matchAll(/'(sha256-[A-Za-z0-9+/=]+)'/g)].map((m) => m[1]);
  const missing = wanted.filter((h) => !present.includes(h));
  const stale = present.filter((h) => !wanted.includes(h));

  if (missing.length === 0 && stale.length === 0) {
    console.log('CSP hashes are in sync.');
    return;
  }

  for (const h of missing) console.log(`  missing: '${h}'`);
  for (const h of stale) console.log(`  stale  : '${h}'`);

  if (checkOnly) {
    console.error('\nCSP hashes drifted from public/index.html. Fix: npm run csp:sync');
    process.exit(1);
  }

  // Only the hash TOKENS are rewritten, never the surrounding whitespace: the
  // header sits on a tab-indented line and an earlier version that normalised
  // spaces ate that indentation. Each " 'sha256-...'" is consumed together
  // with the space in front of it; the full list lands where the first one was.
  const list = wanted.map((h) => `'${h}'`).join(' ');
  let seen = 0;
  const fixed = line.replace(/ ?'sha256-[A-Za-z0-9+/=]+'/g, () => {
    seen += 1;
    return seen === 1 ? ` ${list}` : '';
  });

  fs.writeFileSync(CADDY, caddy.replace(line, fixed));
  console.log('\ndocker/caddy/Caddyfile updated. Commit it together with public/index.html.');
}

main();

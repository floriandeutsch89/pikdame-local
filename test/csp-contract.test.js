/** The Content-Security-Policy lives in docker/caddy/Caddyfile, the inline script it
 *  allows lives in public/index.html. Nothing links the two at runtime: if the
 *  splash pre-check is edited, its sha256 changes and the browser silently
 *  refuses to run it (lobby flashes, or worse). These tests recompute the hash
 *  from the HTML and fail the build on any drift. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const root = path.join(__dirname, '..');
// Git stores LF, the Windows working copy has CRLF (core.autocrlf) - the
// browser only ever sees the LF bytes from the Linux checkout, so normalise.
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8').replace(/\r\n/g, '\n');
const html = read('public/index.html');
const caddyfile = read('docker/caddy/Caddyfile');

/** Inline <script> bodies: no src attribute, and JSON-LD data blocks excluded
 *  (they are not executed, so CSP script-src does not apply to them). */
function inlineScripts(source) {
  const re = /<script(?![^>]*\bsrc=)(?![^>]*application\/ld\+json)[^>]*>([\s\S]*?)<\/script>/g;
  const out = [];
  let m;
  while ((m = re.exec(source))) out.push(m[1]);
  return out;
}

const cspLine = caddyfile
  .split('\n')
  .find((l) => l.trim().startsWith('Content-Security-Policy '));

test('Caddyfile ships a Content-Security-Policy', () => {
  assert.ok(cspLine, 'no Content-Security-Policy header found in docker/caddy/Caddyfile');
  for (const directive of [
    "default-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ]) {
    assert.ok(cspLine.includes(directive), `CSP is missing: ${directive}`);
  }
  assert.ok(
    !/script-src[^;]*'unsafe-inline'/.test(cspLine),
    "script-src must not allow 'unsafe-inline' - use a sha256 hash"
  );
});

test('every inline script in index.html is allowed by a CSP hash', () => {
  const scripts = inlineScripts(html);
  assert.ok(scripts.length > 0, 'expected at least the splash pre-check');
  for (const body of scripts) {
    const hash = `sha256-${crypto.createHash('sha256').update(body, 'utf8').digest('base64')}`;
    assert.ok(
      cspLine.includes(`'${hash}'`),
      `inline script not covered by the CSP. Run: npm run csp:sync (adds '${hash}' to docker/caddy/Caddyfile).`
    );
  }
});

test('the CSP carries no stale script hashes', () => {
  const allowed = new Set(
    inlineScripts(html).map(
      (b) => `sha256-${crypto.createHash('sha256').update(b, 'utf8').digest('base64')}`
    )
  );
  for (const [, hash] of cspLine.matchAll(/'(sha256-[A-Za-z0-9+/=]+)'/g)) {
    assert.ok(allowed.has(hash), `CSP allows a hash no inline script uses any more: '${hash}'`);
  }
});

/** The CSP hash only protects anything if the Caddyfile that carries it
 *  actually reaches the server WITH the matching index.html. It used to be
 *  bind-mounted, i.e. versioned separately from the app image - a host with a
 *  stale copy silently blocked the head script. These two tests keep the
 *  config inside the image and out of the compose mounts. */
test('the Caddy image bakes the Caddyfile in', () => {
  const dockerfile = read('docker/caddy/Dockerfile');
  assert.match(
    dockerfile,
    /^COPY\s+Caddyfile\s+\/etc\/caddy\/Caddyfile\s*$/m,
    'docker/caddy/Dockerfile must COPY the Caddyfile - otherwise the image ships without a config'
  );
  // It has to sit in the build context, or the COPY cannot see it AND the
  // release workflow's rebuild gate (a fingerprint over docker/caddy/**)
  // would retag a stale image instead of rebuilding it.
  assert.ok(
    fs.existsSync(path.join(root, 'docker/caddy/Caddyfile')),
    'the Caddyfile must live next to the Dockerfile that copies it'
  );
});

test('no compose file bind-mounts a Caddyfile over the baked-in one', () => {
  for (const f of ['docker/docker-compose.yml', 'docker/docker-compose.ghcr.yml', 'docker/docker-compose.prod.yml']) {
    const active = read(f)
      .split('\n')
      .filter((l) => !l.trim().startsWith('#')) // a documented opt-out is fine
      .join('\n');
    assert.ok(
      !/:\/etc\/caddy\/Caddyfile/.test(active),
      `${f} mounts a Caddyfile over the image - it would age out of sync with the CSP hash`
    );
  }
});

/** Third layer. The first two catch a WRONG hash; this one catches a right
 *  hash that never ships. The release workflow rebuilds the Caddy image only
 *  when its recipe fingerprint changes - a hash over docker/caddy/**. That is
 *  the only reason the Caddyfile lives in that directory. Move it out and a
 *  CSP change would be silently RETAGGED onto the old image. */
test('the release workflow rebuilds the Caddy image when the Caddyfile changes', () => {
  const wf = read('.github/workflows/release.yml');
  const fingerprint = wf.split('\n').find((l) => l.includes('RECIPE=') && l.includes('find'));
  assert.ok(fingerprint, 'the caddy rebuild gate no longer fingerprints anything');
  assert.match(
    fingerprint, /find\s+docker\/caddy\s/,
    'the fingerprint must cover docker/caddy/** - that is what makes a Caddyfile change rebuild the image'
  );
  // And the build must read the Dockerfile from that same directory, or the
  // COPY would not see the Caddyfile at all.
  assert.match(wf, /context:\s*docker\/caddy/, 'the Caddy build context must be docker/caddy');
});

test('index.html loads no third-party resources (hotspot has no internet)', () => {
  // Only LOADED subresources count - a plain <a href> to GitHub is fine.
  const loaded = [
    ...[...html.matchAll(/<script[^>]*\bsrc="([^"]+)"/g)].map((m) => m[1]),
    ...[...html.matchAll(/<link[^>]*\bhref="([^"]+)"/g)].map((m) => m[1]),
    ...[...html.matchAll(/<(?:img|source|iframe)[^>]*\bsrc="([^"]+)"/g)].map((m) => m[1]),
  ];
  const offenders = loaded.filter(
    (u) => /^(?:https?:)?\/\//.test(u) && !u.startsWith('https://play.pikdame.online/')
  );
  assert.deepStrictEqual(offenders, [], `external resources are not allowed: ${offenders}`);
});

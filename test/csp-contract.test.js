/** The app sends the Content-Security-Policy itself (game/SecurityHeaders.js)
 *  and hashes index.html's inline scripts at startup, so script and hash ship
 *  in one image. These tests pin the policy's shape and that coverage. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { createSecurityHeaders, inlineScripts, hashOf } = require('../game/SecurityHeaders');

const root = path.join(__dirname, '..');
// Git stores LF, the Windows working copy has CRLF (core.autocrlf) - the
// browser only ever sees the LF bytes from the Linux checkout, so normalise.
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8').replace(/\r\n/g, '\n');
const html = read('public/index.html');
const prod = createSecurityHeaders({ html, baseUrl: 'https://play.pikdame.online' });
const cspLine = prod('ignored')['Content-Security-Policy'];

test('the app ships a Content-Security-Policy', () => {
  assert.ok(cspLine, 'no Content-Security-Policy header');
  for (const directive of [
    "default-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    'connect-src \'self\' wss://play.pikdame.online',
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
    assert.ok(cspLine.includes(`'${hashOf(body)}'`), 'inline script not covered by the CSP');
  }
});

test('the CSP carries no stale script hashes', () => {
  const allowed = new Set(inlineScripts(html).map(hashOf));
  for (const [, hash] of cspLine.matchAll(/'(sha256-[A-Za-z0-9+/=]+)'/g)) {
    assert.ok(allowed.has(hash), `CSP allows a hash no inline script uses any more: '${hash}'`);
  }
});

test('HSTS only over https; local stacks follow the Host header, never a hostile one', () => {
  assert.match(prod('x')['Strict-Transport-Security'], /max-age=31536000/);
  const local = createSecurityHeaders({ html, baseUrl: undefined });
  assert.strictEqual(local('192.168.1.5:8080')['Strict-Transport-Security'], undefined);
  assert.match(local('192.168.1.5:8080')['Content-Security-Policy'], /connect-src 'self' ws:\/\/192\.168\.1\.5:8080;/);
  assert.match(local("evil; script-src *")['Content-Security-Policy'], /connect-src 'self';/);
});

test('no Caddy config sets a CSP again (it would drift from index.html)', () => {
  for (const f of fs.readdirSync(path.join(root, 'docker/caddy'))) {
    assert.ok(!/Content-Security-Policy/.test(read(`docker/caddy/${f}`)), `docker/caddy/${f} sets a CSP`);
  }
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

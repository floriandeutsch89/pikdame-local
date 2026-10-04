// The server scripts download files from the repo by path. A file that moved
// in the repo only failed at deploy time with a bare `curl: (22) ... 404`
// (docker/Caddyfile -> docker/caddy/Caddyfile in v2.9.0 broke
// server-update.sh unnoticed until the first automatic deploy).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

function forList(src, prefix) {
  const m = src.match(new RegExp(`for ${prefix} in ([^;]+); do`));
  assert.ok(m, `server-update.sh has a 'for ${prefix} in ...' download loop`);
  return m[1].trim().split(/\s+/);
}

test('server-update.sh downloads only stack files that exist under docker/', () => {
  for (const f of forList(read('scripts/server-update.sh'), 'f')) {
    assert.ok(fs.existsSync(path.join(ROOT, 'docker', f)), `docker/${f} is fetched by server-update.sh but does not exist`);
  }
});

test('server-update.sh downloads only scripts that exist under scripts/', () => {
  for (const s of forList(read('scripts/server-update.sh'), 's')) {
    assert.ok(fs.existsSync(path.join(ROOT, 'scripts', s)), `scripts/${s} is fetched by server-update.sh but does not exist`);
  }
});

test('every local file the prod compose mounts or builds from is fetched by server-update.sh', () => {
  const fetched = new Set(forList(read('scripts/server-update.sh'), 'f'));
  const compose = read('docker/docker-compose.prod.yml');
  // Bind mounts "./x:/y" (not commented out) and the Caddy build context.
  const mounts = [...compose.matchAll(/^\s*-\s+\.\/([^:\s]+):/gm)].map((m) => m[1]);
  for (const m of mounts) {
    if (m.startsWith('secrets/')) continue; // stay on the server, never downloaded
    assert.ok(fetched.has(m), `prod compose mounts ./${m}, but server-update.sh does not fetch it`);
  }
  // Only when Caddy is built on the server (an uncommented build: line);
  // the default pulls the prebuilt image from GHCR.
  if (/^\s+build:\s*\.\/caddy/m.test(compose)) {
    const caddyFiles = fs.readdirSync(path.join(ROOT, 'docker', 'caddy')).map((f) => `caddy/${f}`);
    for (const f of caddyFiles) assert.ok(fetched.has(f), `Caddy build needs ${f}, but server-update.sh does not fetch it`);
  }
});

test('prod compose: Caddy is the prebuilt GHCR image and updates with the app', () => {
  const compose = read('docker/docker-compose.prod.yml');
  const caddy = compose.slice(compose.indexOf('\n  caddy:'), compose.indexOf('\n  crowdsec:'));
  assert.match(caddy, /^\s+image:\s*ghcr\.io\/[^/]+\/pikdame-local-caddy:/m, 'no build on the server by default');
  assert.doesNotMatch(caddy, /^\s+build:/m);
  // The image carries the CSP hash of the app's inline script: if Watchtower
  // updated only the app, the two would drift apart overnight.
  assert.match(caddy, /com\.centurylinklabs\.watchtower\.enable=true/);
});

test('pikdame-deploy.sh only pulls and restarts - it never fetches stack files', () => {
  const src = read('scripts/pikdame-deploy.sh').replace(/^\s*#.*$/gm, '');
  assert.doesNotMatch(src, /curl|wget|server-update/, 'no downloads, no server-update.sh');
  assert.match(src, /compose -f "\$FILE" pull --ignore-buildable/);
  assert.match(src, /compose -f "\$FILE" up -d/);
  assert.doesNotMatch(src, /compose[^\n]* build/, 'nothing is built on the server');
});

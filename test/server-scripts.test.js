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

test('prod compose: joins the shared Caddy only through its own external network', () => {
  const compose = read('docker/docker-compose.prod.yml');
  assert.match(compose, /\n {2}caddy_play_pikdame:\n\s+external:\s*true/, 'app network must be external');
  assert.doesNotMatch(compose, /^\s+ports:/m, 'only the shared Caddy publishes ports');
  // caddy_egress sits next to CrowdSec's API (caddy-crowdsec README).
  assert.doesNotMatch(compose.replace(/^\s*#.*$/gm, ''), /caddy_egress/);
  // The shared stack runs Caddy, CrowdSec and Watchtower; a second copy would fight it.
  for (const svc of ['caddy', 'crowdsec', 'watchtower', 'dockerproxy']) {
    assert.doesNotMatch(compose, new RegExp(`\\n {2}${svc}:\\n`), `prod still runs its own ${svc}`);
  }
  const alias = compose.match(/caddy_play_pikdame:\n\s+aliases:\s*\[(\w[\w-]*)\]/);
  assert.ok(alias, 'the app needs a stack-independent alias on caddy_play_pikdame');
  const site = read('docker/shared-caddy/play.pikdame.caddy');
  assert.match(site, new RegExp(`reverse_proxy ${alias[1]}:8080`), 'site file proxies to another name');
  assert.match(site, /import common/, 'site file must use the shared hardening snippet');
  assert.doesNotMatch(site, /Content-Security-Policy/, 'the CSP comes from the app');
});

test('pikdame-deploy.sh only pulls and restarts - it never fetches stack files', () => {
  const src = read('scripts/pikdame-deploy.sh').replace(/^\s*#.*$/gm, '');
  assert.doesNotMatch(src, /curl|wget|server-update/, 'no downloads, no server-update.sh');
  assert.match(src, /compose -f "\$FILE" pull --ignore-buildable/);
  assert.match(src, /compose -f "\$FILE" up -d/);
  assert.doesNotMatch(src, /compose[^\n]* build/, 'nothing is built on the server');
});

// Beta runs PR code on its own host: these checks keep it off the prod host.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const active = (src) => src.split(/\r?\n/).filter((l) => !/^\s*#/.test(l)).join('\n');

const beta = active(read('docker/docker-compose.beta.yml'));
const prod = active(read('docker/docker-compose.prod.yml'));
const prodSite = active(read('docker/shared-caddy/play.pikdame.caddy'));
const betaCaddyfile = active(read('docker/caddy/Caddyfile.beta'));
const workflow = read('.github/workflows/beta.yml');
const deploy = active(read('scripts/pikdame-deploy.sh'));

/** Text of one top-level service block (two-space indent). */
function service(src, name) {
  const start = src.indexOf(`\n  ${name}:\n`);
  assert.ok(start >= 0, `service ${name} not found`);
  const rest = src.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}[a-z][\w-]*:\n|\n[a-z]/);
  return next < 0 ? rest : rest.slice(0, next + 1);
}

const names = (src, key) => [...src.matchAll(new RegExp(`^\\s+${key}:\\s*(\\S+)`, 'gm'))].map((m) => m[1]);

test('beta: its own compose project, no container name shared with prod', () => {
  assert.match(beta, /^name:\s*pikdame-beta\s*$/m);
  const clash = names(beta, 'container_name').filter((n) => names(prod, 'container_name').includes(n));
  assert.deepEqual(clash, [], 'beta would replace prod containers');
});

test('beta: self-contained, needs nothing from a prod stack', () => {
  assert.doesNotMatch(beta, /^\s+external:\s*true/m, 'an external network/volume ties beta to another stack');
  assert.doesNotMatch(beta, /pikdame-(data|pgdata):/, 'beta uses a prod volume');
  assert.doesNotMatch(beta, /^\s+-\s+db_password\s*$/m, 'beta reads the prod DB password');
  assert.match(beta, /file:\s*\.\/secrets\/beta_db_password\.txt/);
});

test('prod: no trace of beta in its compose file or site file', () => {
  assert.doesNotMatch(prod, /beta/i, 'prod compose still references beta');
  assert.doesNotMatch(prodSite, /beta/i, 'prod site file still serves beta');
});

test('beta: the app carries the full OWASP hardening of prod', () => {
  const app = service(beta, 'pikdame-beta');
  for (const [what, re] of [
    ['cap_drop ALL', /cap_drop:\s*\n\s+-\s+ALL/],
    ['read_only', /read_only:\s*true/],
    ['AppArmor', /apparmor=docker-default/],
    ['no-new-privileges', /no-new-privileges:true/],
    ['pids limit', /pids:\s*\d+/],
    ['tmpfs /tmp', /\/tmp:rw,noexec,nosuid/],
  ]) assert.match(app, re, `beta app lacks ${what}`);
  assert.doesNotMatch(app, /^\s+ports:/m, 'only Caddy may reach the beta app');
});

test('beta: only its Caddy publishes ports, from the per-PR :beta image', () => {
  const caddy = service(beta, 'caddy-beta');
  assert.match(caddy, /^\s+image:\s*ghcr\.io\/[^/]+\/pikdame-local-caddy:beta\s*$/m);
  assert.match(caddy, /^\s+container_name:\s*pikdame-beta-caddy\s*$/m);
  assert.equal((beta.match(/^\s+ports:/gm) || []).length, 1, 'a second service publishes ports');
  assert.match(beta, /\n {2}caddy_beta:\n\s+internal:\s*true/, 'Caddy <-> app network must be internal');
});

test('beta: Watchtower never updates it (deploys only through the beta workflow)', () => {
  assert.doesNotMatch(beta, /watchtower\.enable=true/);
});

test('Caddyfile.beta: shared hardened snippet, proxies to the beta app, noindex, no CrowdSec', () => {
  const site = betaCaddyfile.match(/^\{\$PIKDAME_BETA_DOMAIN\} \{\n([\s\S]*?)\n\}/m);
  assert.ok(site, 'beta site block missing');
  const upstream = site[1].match(/import site \S+ (\S+):8080/);
  assert.ok(upstream, 'beta site must import the shared snippet');
  assert.ok(names(beta, 'container_name').includes(upstream[1]), `Caddy proxies to ${upstream[1]}, no such beta container`);
  assert.match(site[1], /X-Robots-Tag "noindex/);
  // Stock Caddy image: a crowdsec directive would fail to load.
  assert.doesNotMatch(betaCaddyfile, /crowdsec/);
  assert.doesNotMatch(active(read('docker/caddy/Dockerfile.beta')), /xcaddy/);
});

test('beta: socat target and TLS servername come from the same variable', () => {
  const servername = beta.match(/^\s+-\s+PIKDAME_SMTP_TLS_SERVERNAME=\$\{([A-Z_]+)/m);
  const socat = beta.match(/^\s+command:\s.*tcp-connect:\$\{([A-Z_]+)/m);
  assert.ok(servername && socat);
  assert.equal(socat[1], servername[1]);
});

test('beta workflow: stays off until BETA_HOST and BETA_URL are set', () => {
  assert.match(workflow, /vars\.BETA_HOST != ''/);
  assert.match(workflow, /vars\.BETA_URL != ''/);
});

test('beta workflow: never aims at the prod host', () => {
  assert.doesNotMatch(workflow, /vars\.DEPLOY_(HOST|USER|PORT)/, 'beta must not reuse the prod connection');
  assert.match(workflow, /@\$\{\{ vars\.BETA_HOST \}\}/);
});

test('beta workflow: forks and Dependabot never deploy', () => {
  assert.doesNotMatch(workflow, /^\s*pull_request_target:/m, 'pull_request_target would hand secrets to fork code');
  assert.match(workflow, /github\.event\.pull_request\.head\.repo\.full_name == github\.repository/);
  assert.match(workflow, /!startsWith\(github\.head_ref, 'dependabot\/'\)/);
  assert.match(workflow, /name:\s*beta\b/, 'secrets must come from the beta environment, not production');
});

test('beta workflow: labels both images with the head commit it hands the server', () => {
  assert.match(workflow, /HEAD_SHA:\s*\$\{\{\s*github\.event\.pull_request\.head\.sha\s*\}\}/);
  const labels = workflow.match(/org\.opencontainers\.image\.revision=\$\{\{\s*env\.HEAD_SHA\s*\}\}/g) || [];
  assert.equal(labels.length, 2, 'app and Caddy image both need the revision label');
  assert.match(workflow, /\}\}-caddy:beta\s*$/m, 'the beta Caddy image is not built');
  assert.match(workflow, /file:\s*docker\/caddy\/Dockerfile\.beta/);
  assert.match(workflow, /"\$HEAD_SHA"\s*$/m, 'the SSH command must be the head commit');
  assert.match(workflow, /cancel-in-progress:\s*false/, 'a rollout must never be cut off halfway');
});

test('deploy script: the mode comes from authorized_keys, never from the client', () => {
  assert.match(deploy, /if \[ "\$\{1:-\}" = "beta" \]; then/);
  assert.doesNotMatch(deploy, /SSH_ORIGINAL_COMMAND[^\n]*beta/);
  assert.match(deploy, /pikdame-deploy-\$MODE\.lock/, 'beta and prod need separate locks');
  assert.match(deploy, /org\.opencontainers\.image\.revision/, 'beta must verify the running revision');
  for (const c of ['pikdame-beta', 'pikdame-beta-caddy']) {
    assert.ok(names(beta, 'container_name').includes(c), `${c} is not a beta container`);
    assert.match(deploy, new RegExp(`\\b${c}\\b`), `deploy does not verify ${c}`);
  }
});

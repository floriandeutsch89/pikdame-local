// Beta runs on the prod host: these checks keep the two stacks apart.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const active = (src) => src.split(/\r?\n/).filter((l) => !/^\s*#/.test(l)).join('\n');

const beta = active(read('docker/docker-compose.beta.yml'));
const prod = active(read('docker/docker-compose.prod.yml'));
const caddyfile = read('docker/caddy/Caddyfile');
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

test('beta: never mounts prod volumes or the prod DB password', () => {
  assert.doesNotMatch(beta, /pikdame-(data|pgdata):/, 'beta uses a prod volume');
  assert.doesNotMatch(beta, /^\s+-\s+db_password\s*$/m, 'beta reads the prod DB password');
  assert.match(beta, /file:\s*\.\/secrets\/beta_db_password\.txt/);
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

test('beta: Watchtower never updates it (deploys only through the beta workflow)', () => {
  assert.doesNotMatch(beta, /watchtower\.enable=true/);
});

test('beta: Caddy reaches it over one named network that prod creates', () => {
  const prodNet = prod.match(/\n {2}caddy_beta:\n\s+name:\s*(\S+)\n\s+internal:\s*true/);
  assert.ok(prodNet, 'prod must declare caddy_beta with a fixed name, internal');
  const betaNet = beta.match(/\n {2}caddy_beta:\n\s+name:\s*(\S+)\n\s+external:\s*true/);
  assert.ok(betaNet, 'beta must join caddy_beta as external');
  assert.equal(betaNet[1], prodNet[1]);
  assert.match(service(prod, 'caddy'), /^\s+-\s+caddy_beta$/m, 'Caddy is not on the beta network');
});

test('Caddyfile: prod and beta share one hardened snippet; beta is noindex', () => {
  assert.match(caddyfile, /^\(site\) \{/m);
  assert.match(caddyfile, /^\{\$PIKDAME_DOMAIN\} \{\n\timport site \{\$PIKDAME_DOMAIN\} pikdame:8080\n\}/m);
  const betaSite = caddyfile.match(/^\{\$PIKDAME_BETA_DOMAIN:[^}]+\} \{\n([\s\S]*?)\n\}/m);
  assert.ok(betaSite, 'beta site with a default domain missing');
  const upstream = betaSite[1].match(/import site \S+ (\S+):8080/);
  assert.ok(upstream, 'beta site must import the shared snippet');
  assert.ok(names(beta, 'container_name').includes(upstream[1]), `Caddy proxies to ${upstream[1]}, no such beta container`);
  assert.match(betaSite[1], /X-Robots-Tag "noindex/);
});

test('prod compose: the beta domain is never empty (Caddy would refuse to start)', () => {
  // Caddy's {$VAR:default} ignores empty values -> config rejected, prod down.
  const line = prod.match(/^\s+-\s+PIKDAME_BETA_DOMAIN=(.+)$/m);
  assert.ok(line, 'Caddy needs PIKDAME_BETA_DOMAIN');
  assert.match(line[1], /^\$\{PIKDAME_BETA_DOMAIN:-[^}]+\}$/, `needs a non-empty default: ${line[1]}`);
});

test('beta: socat target and TLS servername come from the same variable', () => {
  const servername = beta.match(/^\s+-\s+PIKDAME_SMTP_TLS_SERVERNAME=\$\{([A-Z_]+)/m);
  const socat = beta.match(/^\s+command:\s.*tcp-connect:\$\{([A-Z_]+)/m);
  assert.ok(servername && socat);
  assert.equal(socat[1], servername[1]);
});

test('beta workflow: stays off until DEPLOY_HOST and BETA_URL are set', () => {
  assert.match(workflow, /vars\.DEPLOY_HOST != ''/);
  assert.match(workflow, /vars\.BETA_URL != ''/);
});

test('beta workflow: forks and Dependabot never deploy', () => {
  assert.doesNotMatch(workflow, /^\s*pull_request_target:/m, 'pull_request_target would hand secrets to fork code');
  assert.match(workflow, /github\.event\.pull_request\.head\.repo\.full_name == github\.repository/);
  assert.match(workflow, /!startsWith\(github\.head_ref, 'dependabot\/'\)/);
  assert.match(workflow, /name:\s*beta\b/, 'secrets must come from the beta environment, not production');
});

test('beta workflow: labels the image with the head commit it hands the server', () => {
  assert.match(workflow, /HEAD_SHA:\s*\$\{\{\s*github\.event\.pull_request\.head\.sha\s*\}\}/);
  assert.match(workflow, /org\.opencontainers\.image\.revision=\$\{\{\s*env\.HEAD_SHA\s*\}\}/);
  assert.match(workflow, /"\$HEAD_SHA"\s*$/m, 'the SSH command must be the head commit');
  assert.match(workflow, /cancel-in-progress:\s*false/, 'a rollout must never be cut off halfway');
});

test('deploy script: the mode comes from authorized_keys, never from the client', () => {
  assert.match(deploy, /if \[ "\$\{1:-\}" = "beta" \]; then/);
  assert.doesNotMatch(deploy, /SSH_ORIGINAL_COMMAND[^\n]*beta/);
  assert.match(deploy, /pikdame-deploy-\$MODE\.lock/, 'beta and prod need separate locks');
  assert.match(deploy, /org\.opencontainers\.image\.revision/, 'beta must verify the running revision');
});

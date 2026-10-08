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
const betaSite = active(read('docker/shared-caddy/beta.play.pikdame.caddy'));
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
  const externals = [...beta.matchAll(/\n {2}([\w-]+):\n\s+external:\s*true/g)].map((m) => m[1]);
  assert.deepEqual(externals, ['caddy_beta_play_pikdame'], 'only the beta host\'s Caddy network may be external');
  assert.doesNotMatch(beta, /caddy_play_pikdame/, 'beta joins the prod app network');
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

test('beta: no published ports, reached only through the shared Caddy', () => {
  assert.doesNotMatch(beta, /^\s+ports:/m);
  assert.doesNotMatch(beta, /caddy_egress/, 'caddy_egress sits next to CrowdSec\'s API');
  const alias = beta.match(/caddy_beta_play_pikdame:\n\s+aliases:\s*\[([\w-]+)\]/);
  assert.ok(alias, 'the app needs an alias on caddy_beta_play_pikdame');
  assert.match(betaSite, new RegExp(`reverse_proxy ${alias[1]}:8080`), 'site file proxies to another name');
});

test('beta: Watchtower never updates it (deploys only through the beta workflow)', () => {
  assert.doesNotMatch(beta, /watchtower\.enable=true/);
});

test('beta site file: shared hardening, beta domain only, noindex', () => {
  assert.match(betaSite, /^beta\.play\.pikdame\.online \{$/m);
  assert.match(betaSite, /import common/);
  assert.match(betaSite, /X-Robots-Tag "noindex/);
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

test('beta workflow: labels the image with the head commit it hands the server', () => {
  assert.match(workflow, /HEAD_SHA:\s*\$\{\{\s*github\.event\.pull_request\.head\.sha\s*\}\}/);
  assert.match(workflow, /org\.opencontainers\.image\.revision=\$\{\{\s*env\.HEAD_SHA\s*\}\}/);
  assert.match(workflow, /"\$HEAD_SHA"\s*$/m, 'the SSH command must be the head commit');
  assert.match(workflow, /cancel-in-progress:\s*false/, 'a rollout must never be cut off halfway');
});

test('beta workflow: the optional tailnet hop stores no Tailscale secret and is tagged', () => {
  const step = workflow.slice(workflow.indexOf('tailscale/github-action@'));
  assert.ok(workflow.includes('tailscale/github-action@'), 'tailnet step missing');
  assert.ok(workflow.indexOf('tailscale/github-action@') < workflow.indexOf('- name: SSH to the server'),
    'the tailnet must be up before the SSH step');
  // Workload identity: a stolen beta secret must not be a tailnet credential.
  assert.doesNotMatch(step.slice(0, 600), /oauth-secret|authkey/);
  assert.match(step.slice(0, 600), /tags:\s*tag:ci\s*$/m, 'the policy restricts tag:ci to the beta host');
  assert.match(workflow, /id-token:\s*write/);
  assert.match(workflow, /if:\s*vars\.TS_OAUTH_CLIENT_ID != ''/, 'without Tailscale vars the run must use plain SSH');
});

test('deploy script: the mode comes from authorized_keys, never from the client', () => {
  assert.match(deploy, /if \[ "\$\{1:-\}" = "beta" \]; then/);
  assert.doesNotMatch(deploy, /SSH_ORIGINAL_COMMAND[^\n]*beta/);
  assert.match(deploy, /pikdame-deploy-\$MODE\.lock/, 'beta and prod need separate locks');
  assert.match(deploy, /org\.opencontainers\.image\.revision/, 'beta must verify the running revision');
  for (const c of ['pikdame-beta']) {
    assert.ok(names(beta, 'container_name').includes(c), `${c} is not a beta container`);
    assert.match(deploy, new RegExp(`\\b${c}\\b`), `deploy does not verify ${c}`);
  }
});

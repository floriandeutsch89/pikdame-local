// Contract between the committed compose files and the server's configuration
// reading. Background: PIKDAME_SMTP_* only ever existed as COMMENTED examples
// in the simple stacks, so setting them in .env changed nothing - compose
// passes only the variables a service lists, and registration kept reporting
// "no mail server configured" while the operator was sure it was set.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const dockerDir = path.join(__dirname, '..', 'docker');
const read = (f) => fs.readFileSync(path.join(dockerDir, f), 'utf8');

// Every variable the mail path reads must be forwarded into the container.
const MAIL_VARS = [
  'PIKDAME_BASE_URL',
  'PIKDAME_SMTP_HOST',
  'PIKDAME_SMTP_PORT',
  'PIKDAME_SMTP_SECURE',
  'PIKDAME_SMTP_USER',
  'PIKDAME_MAIL_FROM',
];

for (const file of ['docker-compose.yml', 'docker-compose.ghcr.yml']) {
  test(`compose contract: ${file} forwards the mail configuration from .env`, () => {
    const lines = read(file)
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.startsWith('- ')); // active entries only, no '# - ' examples
    for (const name of MAIL_VARS) {
      const entry = lines.find((l) => l.startsWith(`- ${name}=`));
      assert.ok(entry, `${name} wird in ${file} nicht durchgereicht`);
      assert.ok(
        entry.includes(`\${${name}`),
        `${name} in ${file} kommt nicht aus .env: ${entry}`
      );
    }
  });
}

test('compose contract: the production stack keeps its egress-proxy SMTP wiring', () => {
  const text = read('docker-compose.prod.yml');
  // The proxy stays the DEFAULT (the app has no internet route), but every
  // value is overridable so switching provider - or going direct - is an
  // .env change instead of a compose patch.
  assert.match(text, /^\s*-\sPIKDAME_SMTP_HOST=\$\{PIKDAME_SMTP_HOST:-smtp-egress\}$/m);
  assert.match(text, /^\s*-\sPIKDAME_SMTP_PASS_FILE=\/run\/secrets\/smtp_password$/m);
});

test('compose contract: one variable drives BOTH the socat target and the TLS name', () => {
  // The app verifies the certificate of the REAL mail server while connecting
  // to the proxy. Hardcoding that name twice means changing the provider in
  // one place and silently failing the certificate check in the other.
  const text = read('docker-compose.prod.yml');
  const servername = text.match(/^\s*-\sPIKDAME_SMTP_TLS_SERVERNAME=(.+)$/m);
  const socat = text.match(/^\s*command:\s.*tcp-connect:(\S+?):/m);
  assert.ok(servername, 'prod must set PIKDAME_SMTP_TLS_SERVERNAME');
  assert.ok(socat, 'prod must define the socat egress target');
  const varName = (s) => (s.match(/\$\{([A-Z_]+)/) || [, null])[1];
  assert.ok(varName(servername[1]), `TLS servername is hardcoded: ${servername[1].trim()}`);
  assert.equal(
    varName(socat[1]),
    varName(servername[1]),
    `socat target (${socat[1]}) and TLS servername (${servername[1].trim()}) must come from the same variable`
  );
});

test('compose contract: no committed compose file carries a real SMTP password', () => {
  for (const file of ['docker-compose.yml', 'docker-compose.ghcr.yml', 'docker-compose.prod.yml']) {
    const bad = read(file)
      .split(/\r?\n/)
      .filter((l) => /^\s*-\sPIKDAME_SMTP_PASS=/.test(l) && !/\$\{/.test(l));
    assert.deepEqual(bad, [], `Klartext-Passwort in ${file}: ${bad.join(' | ')}`);
  }
});

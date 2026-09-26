// Guard for scripts/check-secret-files.js: which tracked paths count as
// secrets or private runtime data, and that templates stay allowed.
const test = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { forbiddenReason } = require('../scripts/check-secret-files');

test('secret-like paths are flagged', () => {
  for (const f of [
    '.env', 'docker/.env', '.env.production', 'terraform/prod.tfvars', 'terraform/x.auto.tfvars.json',
    'terraform/terraform.tfstate', 'terraform/terraform.tfstate.backup', 'certs/server.key', 'tls/cert.pem',
    'id_ed25519', 'docker/secrets/db_password.txt', 'data/users.db', 'data/players.json',
    'data/human-moves.jsonl', '.npmrc',
  ]) {
    assert.ok(forbiddenReason(f), `${f} must be flagged`);
  }
});

test('templates and ordinary files pass', () => {
  for (const f of [
    'docker/.env.example', 'docker/secrets/db_password.txt.example', 'data/.gitkeep', 'game/secretEnv.js',
    'test/secret-env.test.js', 'id_ed25519.pub', 'README.md', 'public/client.js',
  ]) {
    assert.strictEqual(forbiddenReason(f), null, `${f} must pass`);
  }
});

test('the repository itself tracks no secret-like file', () => {
  const out = execFileSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'check-secret-files.js')], { encoding: 'utf8' });
  assert.match(out, /No secret-like files tracked/);
});

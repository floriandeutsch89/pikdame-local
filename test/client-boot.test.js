const test = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

// Boots the real client in jsdom (lobby + playing state). Guards against the
// exact bug class that shipped in v1.41.0: a top-level/init-time crash left
// every PWA and browser stuck at "Connecting...".
test('client boots in jsdom and renders lobby + playing state without errors', () => {
  const out = execFileSync(
    process.execPath,
    [path.join(__dirname, '..', 'scripts', 'client-boot-smoke.js')],
    { encoding: 'utf8', timeout: 30000 }
  );
  assert.match(out, /CLIENT BOOT SMOKE: OK/);
});

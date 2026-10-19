'use strict';
// Preloaded into every test file (npm test --require): keeps the move log out of the shared data/.
const fs = require('fs');
const os = require('os');
const path = require('path');

if (!process.env.PIKDAME_LOG_PATH) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pikdame-testlog-'));
  process.env.PIKDAME_LOG_PATH = path.join(dir, 'human-moves.jsonl');
  process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* best effort */ } });
}

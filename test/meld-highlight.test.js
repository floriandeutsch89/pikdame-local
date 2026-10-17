// Melds have no frame of their own since v2.63, so the lay-off highlight is
// the only thing that marks a target. A rule written for another class never
// applies: `.meld.layOffTarget` kept the pulse running in a hidden app.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const pub = path.join(__dirname, '..', 'public');

test('lay-off target rules use the class the client sets', () => {
  const js = fs.readFileSync(path.join(pub, 'client.js'), 'utf8');
  assert.match(js, /group\.className = 'meldGroup'/, 'melds render as .meldGroup');
  assert.match(js, /group\.classList\.add\('layOffTarget'\)/, 'targets get .layOffTarget');
  const css = fs.readFileSync(path.join(pub, 'style.css'), 'utf8');
  const selectors = [...css.matchAll(/([^{}]*\.layOffTarget\b[^{}]*)\{/g)]
    .flatMap((m) => m[1].split(','))
    .filter((s) => s.includes('.layOffTarget'));
  assert.ok(selectors.length >= 3, 'highlight, reduced motion and hidden-app rules exist');
  for (const s of selectors) assert.match(s, /\.meldGroup\.layOffTarget\b/, `"${s.trim()}" targets a class the client never sets`);
});

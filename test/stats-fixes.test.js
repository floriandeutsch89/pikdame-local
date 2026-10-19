/** Stats/score polish: language-aware dates and numbers, plurals, sprite
 *  icons instead of emoji icons, tokens instead of raw sizes, one "me" mark. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const pub = path.join(__dirname, '..', 'public');
const html = fs.readFileSync(path.join(pub, 'index.html'), 'utf8');
const js = fs.readFileSync(path.join(pub, 'client.js'), 'utf8');
const css = fs.readFileSync(path.join(pub, 'style.css'), 'utf8');

function boot() {
  const { window } = new JSDOM(html, { url: 'https://play.example/', runScripts: 'outside-only', pretendToBeVisual: true });
  window.matchMedia = (q) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
  window.requestAnimationFrame = () => 0;
  window.scrollTo = () => {};
  window.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve({}), text: () => Promise.resolve('') });
  window.WebSocket = class { constructor() { this.readyState = 0; } addEventListener() {} removeEventListener() {} send() {} close() {} };
  window.WebSocket.OPEN = 1;
  window.sessionStorage.setItem('pikdame_splash_seen', '1');
  for (const src of ['i18n.js', 'client.js']) window.eval(fs.readFileSync(path.join(pub, src), 'utf8'));
  return window;
}

test('formatters: numbers follow the language, negatives use the real minus', () => {
  const w = boot();
  const f = w.PikFormat;
  assert.strictEqual(f.fmtNum(1385, 'de'), '1.385');
  assert.strictEqual(f.fmtNum(1385, 'en'), '1,385');
  assert.strictEqual(f.fmtNum(-45, 'de'), '−45');
  assert.strictEqual(f.fmtNum(-1385, 'en'), '−1,385');
  assert.strictEqual(f.fmtSigned(270, 'de'), '+270');
  assert.strictEqual(f.fmtSigned(-35, 'en'), '−35');
  assert.strictEqual(f.fmtSigned(0, 'de'), '0');
  w.close();
});

test('formatters: dates follow the language, a game day becomes a human date', () => {
  const w = boot();
  const f = w.PikFormat;
  const ts = Date.UTC(2026, 9, 17, 12);
  assert.strictEqual(f.fmtDate(ts, { day: 'numeric', month: 'numeric', year: 'numeric', timeZone: 'UTC' }, 'de'), '17.10.2026');
  assert.strictEqual(f.fmtDate(ts, { day: 'numeric', month: 'numeric', year: 'numeric', timeZone: 'UTC' }, 'en'), '17/10/2026');
  assert.strictEqual(f.fmtDay('2026-10-19', undefined, 'de'), '19. Okt. 2026');
  assert.match(f.fmtDay('2026-10-19', undefined, 'en'), /^19 Oct 2026$/);
  assert.strictEqual(f.fmtDay('nonsense', undefined, 'de'), 'nonsense');
  w.close();
});

test('formatters: singular for exactly one, in both languages, (plain space)', () => {
  const w = boot();
  const f = w.PikFormat;
  assert.strictEqual(f.fmtCount(1, 'win', 'de'), '1 Sieg');
  assert.strictEqual(f.fmtCount(2, 'win', 'de'), '2 Siege');
  assert.strictEqual(f.fmtCount(1, 'game', 'de'), '1 Partie');
  assert.strictEqual(f.fmtCount(1385, 'game', 'de'), '1.385 Partien');
  assert.strictEqual(f.fmtCount(1, 'round', 'de'), '1 Runde');
  assert.strictEqual(f.fmtCount(0, 'round', 'de'), '0 Runden');
  assert.strictEqual(f.fmtCount(1, 'win', 'en'), '1 win');
  assert.strictEqual(f.fmtCount(3, 'round', 'en'), '3 rounds');
  assert.strictEqual(f.unitWord(1, 'turn', 'de'), 'Zug');
  w.close();
});

test('no locale-less date formatting is left in the client', () => {
  assert.doesNotMatch(js, /toLocaleDateString\(\)/);
  assert.doesNotMatch(js, /toLocaleDateString\(undefined/);
  assert.doesNotMatch(js, /toLocaleString\(lang === 'en'/);
});

test('"N× Hand aus" never breaks after the multiplication sign', () => {
  assert.match(js, /\$\{fmt\(g\.handAusRounds\)\}×\$\{NBSP\}Hand aus/);
  assert.match(js, /\$\{fmt\(g\.handAusRounds\)\}×\$\{NBSP\}out in one/);
});

test('sprite has the new icons and every sprite icon the stats code uses', () => {
  const doc = new JSDOM(html).window.document;
  for (const id of ['i-calendar', 'i-medal', 'i-magnet', 'i-cards', 'i-palette', 'i-tag', 'i-sparkle', 'i-check']) {
    assert.ok(doc.getElementById(id), `sprite symbol ${id}`);
  }
  for (const name of ['calendar', 'medal', 'magnet', 'check']) assert.match(js, new RegExp(`iconHtml\\('${name}'\\)`));
});

test('emoji are not used as icons in the stats, challenge and progress areas', () => {
  // Badge emoji (achievement content) stay; only headings, history and reward labels are checked.
  for (const emoji of ['<h3>🗓️', '<h4>🗓️', '<h3>🎖️', '🧲 ${', '· 🧲', '🥇 ${escapeHtml(d.top', '`🎴 ', '`🎨 ', '`🏷️ ']) {
    assert.ok(!js.includes(emoji), `emoji icon ${emoji} still in client.js`);
  }
  assert.doesNotMatch(js, /['`]♠Q & 🃏/);
  assert.doesNotMatch(js, /<th>\$\{L\('🃏/);
  assert.doesNotMatch(js, /'🃏'\.repeat/);
  // The emote reward IS its emoji (content) and keeps it.
  assert.match(js, /kind: 'emote', id, label: `\$\{id\} /);
});

test('stats areas use the type scale, not raw font sizes', () => {
  assert.match(css, /--fs-display:/);
  const rule = (sel) => { const m = css.match(new RegExp(`${sel.replace(/[.#]/g, '\\$&')}[^{]*\\{[^}]*\\}`)); assert.ok(m, sel); return m[0]; };
  for (const sel of ['.resultWinnerScore', '.handAusNote', '.badgeBox h3', '.challengeBoardBox h3', '.challengeYour', '.challengeHistory', '.challengeWeekly h4', '.weeklyHint', '.achTile .achEmoji']) {
    assert.doesNotMatch(rule(sel), /font-size:\s*[0-9.]+(rem|em|px)/, `${sel} uses a raw size`);
  }
  assert.doesNotMatch(css, /\.resultWinnerGame \.resultWinnerScore \{ font-size: 2rem/);
});

test('one "me" mark everywhere; the round winner is a chip, not a green row', () => {
  assert.doesNotMatch(css, /winnerRow/);
  assert.doesNotMatch(js, /winnerRow/);
  assert.match(css, /\.boardRow\.isMe, \.ladderRow\.isMe, \.histStandings li\.me \{[^}]*inset 3px 0 0 var\(--paper-accent\)/);
  assert.match(css, /\.statsTable tr\.isMe td:first-child \{[^}]*inset 3px 0 0/);
  assert.match(css, /\.winChip \{/);
  assert.match(js, /class="winChip"/);
  assert.match(css, /\.statsTable td\.nameCell \{ text-align: left/);
});

test('chart: other players keep full colour, text stays at the micro size', () => {
  assert.doesNotMatch(css, /polyline\.other\s*\{[^}]*opacity/);
  assert.match(css, /\.scoreChartSvg \.axisLabel \{[^}]*calc\(var\(--fs-micro\) \* var\(--k/);
  assert.match(css, /\.scoreChartSvg \.endLabel \{[^}]*calc\(var\(--fs-micro\) \* var\(--k/);
  assert.match(js, /stroke-width="\$\{mine \? 3 : 1\.6\}"/);
});

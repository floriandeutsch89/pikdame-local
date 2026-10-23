/** Start-screen contracts: one icon per meaning, colour only for state, and the
 *  two-column layout in landscape and on desktop (portrait keeps one column).
 *  Markup and CSS only, no browser; the theme distances live in theme-contrast. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const pub = path.join(__dirname, '..', 'public');
const html = fs.readFileSync(path.join(pub, 'index.html'), 'utf8');
const client = fs.readFileSync(path.join(pub, 'client.js'), 'utf8');
const css = fs.readFileSync(path.join(pub, 'style.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const doc = new JSDOM(html).window.document;

const iconOf = (el) => {
  assert.ok(el, 'element exists');
  const use = el.querySelector('svg.icon use');
  assert.ok(use, `${el.id || el.tagName} has a sprite icon`);
  return use.getAttribute('href');
};
const h2Icon = (overlayId) => iconOf(doc.querySelector(`#${overlayId} h2`));

test('start screen: one icon per meaning (Stammtisch, account, puzzle, tips, challenge)', () => {
  for (const id of ['i-group', 'i-puzzle', 'i-podium', 'i-cardhouse']) {
    assert.strictEqual(doc.querySelectorAll(`symbol#${id}`).length, 1, `${id} is defined once`);
  }
  // Stammtisch = group, everywhere it appears; a single person is the account.
  assert.strictEqual(iconOf(doc.getElementById('stammtischBtn')), '#i-group');
  assert.strictEqual(h2Icon('stammtischOverlay'), '#i-group');
  assert.strictEqual(h2Icon('stammtischSheetOverlay'), '#i-group');
  assert.match(client, /class="stRecentRow"[^`]*`\s*\+\s*`<svg class="icon" aria-hidden="true"><use href="#i-group"\/>/, 'Stammtisch chips use the group');
  assert.strictEqual(iconOf(doc.getElementById('accountBtn')), '#i-user');
  assert.strictEqual(iconOf(doc.getElementById('accountTitle')), '#i-user');
  const userUses = [...doc.querySelectorAll('use[href="#i-user"]')].map((u) => u.closest('[id]').id);
  assert.deepStrictEqual(userUses.sort(), ['accountBtn', 'accountTitle'], 'the person icon means the account only');
  assert.ok(!/#i-user"|iconHtml\('user'\)/.test(client), 'client.js draws no person icon for something else');

  // Daily puzzle = card with "?"; the bulb stays "Spiel-Tipps".
  assert.strictEqual(iconOf(doc.getElementById('puzzleBtn')), '#i-puzzle');
  assert.strictEqual(h2Icon('puzzleOverlay'), '#i-puzzle');
  assert.strictEqual(iconOf(doc.querySelector('label[for="aidTipsCheckbox"]')), '#i-bulb');
  // Daily challenge = podium (rank); the calendar is left for the weekly range.
  assert.strictEqual(iconOf(doc.getElementById('challengeBtn')), '#i-podium');
  assert.strictEqual(h2Icon('challengeIntroOverlay'), '#i-podium');
  for (const m of client.matchAll(/(?:href="#i-|iconHtml\(')([a-z-]+)[^\n]*Tages-Challenge/g)) {
    assert.strictEqual(m[1], 'podium', `challenge line uses the podium: ${m[0].slice(0, 80)}`);
  }
});

// Per-mode tints collided with the accent in four of six themes (felt and
// bordeaux gold, love pink, kitchen rust): icons now follow the text, and
// colour says state only - accent = new/open, star gold, streak orange.
const START_ICON_HOSTS = ['#puzzleBtn', '#challengeBtn', '#tutorialBtn', '#stammtischBtn', '.todayTile',
  '.towerTile', '.stRecentRow', '.lobbyTool', '.yearChip', '.menuChips'];
function rules() {
  const out = [];
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) out.push({ sel: m[1].trim(), body: m[2] });
  return out;
}
const bodyOf = (selector) => {
  const r = rules().find((x) => x.sel === selector);
  assert.ok(r, `rule ${selector} exists`);
  return r.body;
};

test('start screen: icons take the text colour, colour marks state only', () => {
  const offenders = [];
  for (const { sel, body } of rules()) {
    for (const s of sel.split(',').map((x) => x.trim())) {
      const iconRule = /\.icon(?::first-child)?$/.test(s) && START_ICON_HOSTS.some((h) => s.includes(h));
      if (iconRule && /(?:^|;)\s*(?:color|fill|stroke)\s*:/.test(body)) offenders.push(`${s} { ${body.trim()} }`);
    }
  }
  assert.deepStrictEqual(offenders, [], 'start-screen icons must not be tinted per mode');
  // The state colours come from tokens, so every theme keeps one meaning per colour.
  assert.match(bodyOf('.todayTile[data-state="new"]::after'), /background:\s*var\(--accent\)/);
  assert.match(bodyOf('.todayTile[data-state="new"] .ttStatus, .todayTile[data-state="open"] .ttStatus'), /color:\s*var\(--accent\)/);
  const star = bodyOf('.towerTile .ttStar');
  assert.match(star, /color:\s*var\(--star-edge\)/);
  assert.match(star, /fill:\s*var\(--star-fill\)/);
  assert.match(bodyOf('.ttStatus .puzzleStars'), /var\(--star-fill\)/);
  assert.match(bodyOf('.identityStreak .icon'), /var\(--streak\)/);
  assert.match(bodyOf('.lobbyTool .icon'), /stroke-width:\s*2\.2/, 'footer icons match the heavier stroke');
});

test('start screen: two columns in landscape and on desktop, portrait unchanged', () => {
  // The right column wraps exactly the daily block, the modes and the Stammtisch chips.
  const daily = doc.querySelector('#sessionSetup > .lobbyDaily');
  assert.ok(daily, '.lobbyDaily sits in #sessionSetup');
  assert.deepStrictEqual([...daily.children].map((c) => c.id || c.className),
    ['todaySection', 'menuChips menuChipsTwo', 'stammtischRecent']);
  assert.match(bodyOf('.lobbyDaily'), /display:\s*contents/, 'invisible wrapper in portrait');

  const marker = '@media (orientation: landscape) and (max-height: 540px) and (min-width: 720px), (min-width: 1100px)';
  const at = css.lastIndexOf(marker, css.indexOf('#lobby:not(.inSession) {'));
  assert.ok(at > 0, 'two-column block exists for landscape and desktop');
  assert.ok(at < css.lastIndexOf('@media (orientation: landscape) and (max-height: 540px) {'),
    'it stays before the final landscape block (that one must end style.css)');
  const block = css.slice(at, css.indexOf('\n}\n', at));
  assert.match(block, /#lobby:not\(\.inSession\) \{[^}]*display:\s*grid/, 'start screen only, as a grid');
  assert.match(block, /grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*var\(--lobby-w\)\)\)/);
  assert.match(block, /\.lobbyDaily \{[^}]*grid-column:\s*2/, 'daily things on the right');
  assert.ok(!block.includes('#lobby.inSession'), 'the session lobby is untouched');
  // An open game lifts "resume" with order: -1; brand and identity must stay above it.
  assert.match(block, /:is\(\.lobbyHeader, #identityChip, #nameInput\) \{\s*order:\s*-2/);
});

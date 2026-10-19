/** Theme contrast contract: dialogs are light paper in every theme, while the
 *  theme colours are tuned for the dark table. The pairs that meet on screen
 *  must pass WCAG (4.5:1 text, 3:1 controls) in all themes - computed from
 *  style.css, no browser. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8');
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '');

function varsOf(block) {
  const vars = {};
  for (const m of stripComments(block).matchAll(/(--[a-z0-9-]+):\s*([^;]+);/g)) vars[m[1]] = m[2].trim();
  return vars;
}
function themeVars(name) {
  const m = css.match(new RegExp(`\\[data-theme="${name}"\\] \\{([\\s\\S]*?)\\n\\}`));
  assert.ok(m, `theme block ${name} exists`);
  return varsOf(m[1]);
}
const ruleBody = (selector) => {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = css.match(new RegExp(`(?:^|\\n)${esc} \\{([^}]*)\\}`));
  assert.ok(m, `rule ${selector} exists`);
  return stripComments(m[1]);
};
const THEMES = [...new Set([...css.matchAll(/\[data-theme="([a-z]+)"\] \{/g)].map((m) => m[1]))];
const ROOT = varsOf(css.match(/\n:root \{([\s\S]*?)\n\}/)[1]);
const PAPER = varsOf(ruleBody('.overlay-card'));

// --- WCAG 2.x relative luminance and contrast ---------------------------------
function parse(c) {
  let m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(c);
  if (m) {
    const h = m[1].length === 3 ? [...m[1]].map((x) => x + x).join('') : m[1];
    return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16), a: 1 };
  }
  m = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(c);
  assert.ok(m, `parsable colour: ${c}`);
  return { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] };
}
const over = (top, bottom) => ({
  r: top.r * top.a + bottom.r * (1 - top.a),
  g: top.g * top.a + bottom.g * (1 - top.a),
  b: top.b * top.a + bottom.b * (1 - top.a),
  a: 1,
});
function lum({ r, g, b }) {
  const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
function ratio(fg, bg) {
  const x = lum(fg.a < 1 ? over(fg, bg) : fg);
  const y = lum(bg);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
const WHITE = parse('#ffffff');
const GREY_TRACK = parse('rgba(0, 0, 0, 0.06)'); // tabs, tinted rows, field fills

test('theme contrast: every theme is parsed', () => {
  assert.deepEqual(THEMES.sort(), ['bordeaux', 'felt', 'kitchen', 'love', 'night', 'table']);
});

for (const theme of THEMES) {
  const v = themeVars(theme);
  const paper = parse(v['--card-bg']);
  const grey = over(GREY_TRACK, paper);
  const soft = over(parse(v['--accent-soft']), paper);
  const check = (what, r, need) => assert.ok(r >= need, `${theme}: ${what} ${r.toFixed(2)} < ${need}`);

  test(`theme contrast (${theme}): paper inks read on the paper and on grey rows`, () => {
    for (const k of ['--paper-accent', '--paper-success', '--paper-danger']) {
      check(`${k} on paper`, ratio(parse(v[k]), paper), 4.5);
      check(`${k} on a grey row`, ratio(parse(v[k]), grey), 4.5);
    }
    check('muted text on paper', ratio(parse(PAPER['--text-muted']), paper), 4.5);
    check('muted text on an accent-soft row', ratio(parse(PAPER['--text-muted']), soft), 4.5);
  });

  test(`theme contrast (${theme}): gold banner text and the filled win boxes`, () => {
    const gold = over(parse(ROOT['--gold-soft']), paper);
    check('ink on the gold banner', ratio(parse(v['--card-ink']), gold), 4.5);
    check('muted text on the gold chip', ratio(parse(PAPER['--text-muted']), gold), 4.5);
    check('white letter on a won box', ratio(WHITE, parse(v['--paper-success'])), 4.5);
  });

  test(`theme contrast (${theme}): switches, fields and selection rings reach 3:1`, () => {
    const line = over(parse(ROOT['--paper-line']), paper);
    check('field edge / off track', ratio(line, paper), 3);
    check('white thumb on the off track', ratio(WHITE, line), 3);
    check('white thumb on the on track', ratio(WHITE, parse(v['--paper-accent'])), 3);
    check('selection ring on a grey track', ratio(parse(v['--paper-accent']), grey), 3);
  });

  test(`theme contrast (${theme}): filled buttons and the toast`, () => {
    check('--danger-ink on --danger', ratio(parse(v['--danger-ink']), parse(v['--danger'])), 4.5);
    check('--accent-ink on --accent', ratio(parse(v['--accent-ink']), parse(v['--accent'])), 4.5);
    // The toast sits on 92% --bg-deep over whatever is below: paper or table.
    const toastBg = (under) => over({ ...parse(v['--bg-deep']), a: 0.92 }, under);
    check('toast text over a dialog', ratio(parse(v['--text']), toastBg(paper)), 4.5);
    check('toast text over the table', ratio(parse(v['--text']), toastBg(parse(v['--bg']))), 4.5);
  });
}

test('theme contrast: dialog parts use the paper inks, not the table colours', () => {
  const uses = [
    ['.changelogContent h3', /color:\s*var\(--paper-accent\)/],
    ['.changelogContent a', /color:\s*var\(--paper-accent\)/],
    ['.linkBtn', /color:\s*var\(--paper-accent\)/],
    ['.linkBtn.armed', /color:\s*var\(--paper-danger\)/],
    ['.settingsCheckbox', /background:\s*var\(--paper-line\)/],
    ['.settingsCheckbox:checked', /background:\s*var\(--paper-accent\)/],
    ['.resultTabBtn.active', /inset 0 0 0 2px var\(--paper-accent\)/],
    ['.resultSortBtn.active', /inset 0 0 0 2px var\(--paper-accent\)/],
    ['.accountTabs .accountTab.active', /inset 0 0 0 2px var\(--paper-accent\)/],
    ['.btn-danger', /color:\s*var\(--danger-ink\)/],
    ['.stAction.armed', /color:\s*var\(--danger-ink\)/],
    ['.bdPlus b', /color:\s*var\(--paper-success\)/],
    ['.bdMinus b', /color:\s*var\(--paper-danger\)/],
    ['.achTile.earned', /background:\s*var\(--accent-soft\)/],
    ['#toastContainer', /background:\s*color-mix\(in srgb, var\(--bg-deep\)/],
  ];
  for (const [selector, re] of uses) assert.match(ruleBody(selector), re, selector);
});

test('theme contrast: locked items fade the picture, never the text', () => {
  // Fading the whole tile left "6/7" at 2.1:1.
  assert.doesNotMatch(ruleBody('.achTile'), /opacity\s*:/, '.achTile must not fade as a whole');
  assert.doesNotMatch(css, /\.cardbackTile\.locked \{[^}]*opacity/, 'locked card backs must not fade as a whole');
  // Near-black ink on the kitchen accent was 3.9:1; --accent-ink pairs with every accent.
  assert.doesNotMatch(stripComments(css), /background:\s*var\(--accent\);\s*color:\s*#0b0b0b/);
});

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

// --- Kartenhaus: the red edge of floors 11-20 (--paper-mod) ---------------------
// It must read on the paper and against the dark built cards, and stay apart from
// the accent (the next floor, the play button) also for colour-blind players:
// CIEDE2000 between the two, under Machado et al. (2009) simulations at full
// severity. Tritanopia is rare and the edge also differs by its dash, so it may
// come closer.
const MACHADO = {
  protan: [[0.152286, 1.052583, -0.204868], [0.114503, 0.786281, 0.099216], [-0.003882, -0.048116, 1.051998]],
  deutan: [[0.367322, 0.860646, -0.227968], [0.280085, 0.672501, 0.047413], [-0.011820, 0.042940, 0.968881]],
  tritan: [[1.255528, -0.076749, -0.178779], [-0.078411, 0.930809, 0.147602], [0.004733, 0.691367, 0.303900]],
};
const toLin = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
const toSrgb = (v) => { v = Math.min(1, Math.max(0, v)); return 255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055); };
function simulate({ r, g, b }, kind) {
  if (!MACHADO[kind]) return [r, g, b];
  const l = [r, g, b].map(toLin);
  return MACHADO[kind].map((row) => toSrgb(row[0] * l[0] + row[1] * l[1] + row[2] * l[2]));
}
function toLab(rgb) {
  const [r, g, b] = rgb.map(toLin);
  const f = (t) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
  const x = f((0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047);
  const y = f(0.2126 * r + 0.7152 * g + 0.0722 * b);
  const z = f((0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}
function deltaE2000([L1, a1, b1], [L2, a2, b2]) {
  const rad = Math.PI / 180;
  const Cb = (Math.hypot(a1, b1) + Math.hypot(a2, b2)) / 2;
  const G = 0.5 * (1 - Math.sqrt(Cb ** 7 / (Cb ** 7 + 25 ** 7)));
  const [a1p, a2p] = [(1 + G) * a1, (1 + G) * a2];
  const [C1p, C2p] = [Math.hypot(a1p, b1), Math.hypot(a2p, b2)];
  const hue = (b, a) => { const v = Math.atan2(b, a) / rad; return v < 0 ? v + 360 : v; };
  const [h1p, h2p] = [hue(b1, a1p), hue(b2, a2p)];
  let dhp = 0;
  if (C1p * C2p) { dhp = h2p - h1p; if (dhp > 180) dhp -= 360; else if (dhp < -180) dhp += 360; }
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin((dhp * rad) / 2);
  const Lbp = (L1 + L2) / 2;
  const Cbp = (C1p + C2p) / 2;
  let hbp = h1p + h2p;
  if (C1p * C2p) { hbp = Math.abs(h1p - h2p) > 180 ? (h1p + h2p + 360) / 2 : (h1p + h2p) / 2; if (hbp >= 360) hbp -= 360; }
  const T = 1 - 0.17 * Math.cos((hbp - 30) * rad) + 0.24 * Math.cos(2 * hbp * rad) + 0.32 * Math.cos((3 * hbp + 6) * rad) - 0.2 * Math.cos((4 * hbp - 63) * rad);
  const Rc = 2 * Math.sqrt(Cbp ** 7 / (Cbp ** 7 + 25 ** 7));
  const Rt = -Math.sin(2 * 30 * Math.exp(-(((hbp - 275) / 25) ** 2)) * rad) * Rc;
  const Sl = 1 + (0.015 * (Lbp - 50) ** 2) / Math.sqrt(20 + (Lbp - 50) ** 2);
  const Sc = 1 + 0.045 * Cbp;
  const Sh = 1 + 0.015 * Cbp * T;
  const [dL, dC, dH] = [(L2 - L1) / Sl, (C2p - C1p) / Sc, dHp / Sh];
  return Math.sqrt(dL ** 2 + dC ** 2 + dH ** 2 + Rt * dC * dH);
}
const cvdDistance = (c1, c2, kind) => deltaE2000(toLab(simulate(c1, kind)), toLab(simulate(c2, kind)));

for (const theme of THEMES) {
  test(`theme contrast (${theme}): the Kartenhaus red edge reads and stays apart from the accent`, () => {
    const v = themeVars(theme);
    assert.ok(v['--paper-mod'], `${theme}: --paper-mod defined`);
    const mod = parse(v['--paper-mod']);
    const paper = parse(v['--card-bg']);
    const check = (what, r, need) => assert.ok(r >= need, `${theme}: ${what} ${r.toFixed(2)} < ${need}`);
    check('--paper-mod on paper (chip text)', ratio(mod, paper), 4.5);
    check('--paper-mod against a built card (--suit-black)', ratio(mod, parse(v['--suit-black'])), 2);
    for (const other of ['--paper-accent', '--accent']) {
      for (const kind of ['normal', 'protan', 'deutan']) {
        check(`ΔE2000 ${other} (${kind})`, cvdDistance(mod, parse(v[other]), kind), 13);
      }
      check(`ΔE2000 ${other} (tritan)`, cvdDistance(mod, parse(v[other]), 'tritan'), 6);
    }
    // Red-ish: the hue stays between crimson and vermillion.
    const [, a, b] = toLab([mod.r, mod.g, mod.b]);
    const h = (Math.atan2(b, a) * 180) / Math.PI;
    assert.ok(h > -10 && h < 50, `${theme}: --paper-mod hue ${h.toFixed(0)}° is red-ish`);
  });
}

test('theme contrast: the Kartenhaus draws with the paper tokens', () => {
  assert.match(ruleBody('.khFloor.mod .khCard, .khFloor.mod .khPlate'), /stroke:\s*var\(--paper-mod\)/);
  assert.match(ruleBody('.khFloor.built.mod .khCard, .khFloor.built.mod .khPlate'), /stroke:\s*var\(--paper-mod\)/);
  assert.match(ruleBody('.khFloor.next .khHalo'), /stroke:\s*var\(--paper-accent\)/);
  assert.match(ruleBody('.khMod'), /color:\s*var\(--paper-mod\)/);
  assert.match(ruleBody('.khStar.on'), /fill:\s*var\(--star-fill\)/);
});

// Start screen: icons are drawn in --text, colour marks state only (accent =
// new/open, star gold, streak orange). A neutral icon must never read as "new",
// and the state colours must stand out from the neutral icons, in every theme.
for (const theme of THEMES) {
  test(`theme contrast (${theme}): start-screen icons in text colour stay apart from the state colours`, () => {
    const v = { ...ROOT, ...themeVars(theme) };
    const text = parse(v['--text']);
    const check = (what, d, need) => assert.ok(d >= need, `${theme}: ΔE2000 ${what} ${d.toFixed(1)} < ${need}`);
    for (const kind of ['normal', 'protan', 'deutan']) {
      check(`--text vs --accent (${kind})`, cvdDistance(text, parse(v['--accent']), kind), 12);
      check(`--text vs --star-fill (${kind})`, cvdDistance(text, parse(v['--star-fill']), kind), 20);
      check(`--text vs --streak (${kind})`, cvdDistance(text, parse(v['--streak']), kind), 20);
    }
  });
}

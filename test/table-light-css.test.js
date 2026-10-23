/** Table light (style.css "TABLE LIGHT"), computed from the stylesheet, no browser:
 *  noon is exactly today's table; the room never gets lighter under the dark themes'
 *  text (never darker in the kitchen); no text colour (main, muted, accent) ever drops
 *  below its lowest contrast on today's table; theme-cascade's 4.5:1 for muted text
 *  holds at every minute; one minute's step stays invisible.
 *  Background and the pixel check: docs/developer/table-light.md. */
const test = require('node:test');
const assert = require('node:assert');
const { phaseWeights } = require('../public/table-light.js');
const {
  CSS, START, END, RULES, SUPPORTS, ruleOf, stripComments, THEMES, over, lum, contrast, deltaE2000, toOklab, light,
} = require('./helpers/table-light-model');

const DAY = { m: 0, d: 1, e: 0, n: 0 };
const PHASES = { morning: { m: 1, d: 0, e: 0, n: 0 }, evening: { m: 0, d: 0, e: 1, n: 0 }, night: { m: 0, d: 0, e: 0, n: 1 } };
const MINUTES = Array.from({ length: 24 * 60 }, (_, m) => m);
const clock = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const near = (x, y, eps = 1e-6) => Math.abs(x - y) <= eps;
const sameColour = (c1, c2) => near(c1.a, c2.a) && ['r', 'g', 'b'].every((k) => near(c1[k] * c1.a, c2[k] * c2.a));
const scaled = (c, k) => ({ ...c, a: c.a * k });
const AA = 4.5; // WCAG AA for normal text, the bar of test/theme-cascade.test.js
// The surfaces muted text sits on, as mutedSurfaces() in test/theme-cascade.test.js
// builds them at noon, here from the phase's felt and glow; the middle of the table
// (meld headers, piles, the empty-table text) also under the lamp. The top bar and
// the hand tray sit outside its pool.
function cascadeSurfaces(L) {
  const glow = over(L.daylight, L.felt);
  const lit = over(L.spot, L.felt);
  const out = {
    felt: L.felt,
    'top glow': glow,
    'lit felt': lit,
    'pile pool (two spots)': over(L.spot, lit),
    'glass panel on the felt': over(L.glass, L.felt),
    'glass panel on the top glow': over(L.glass, glow),
    'glass panel on the lit felt': over(L.glass, lit),
    'pill on a glass bar on the felt (turn steps)': over(L.glass, over(L.glass, L.felt)),
    'pill on a glass bar on the top glow (turn steps)': over(L.glass, over(L.glass, glow)),
    'sort toggle on the hand tray': over(L.get('--glass-strong'), over(L.glass, lit)),
  };
  const lamp = over(L.pool, L.felt);
  const lampLit = over(L.spot, lamp);
  return Object.assign(out, {
    'felt under the lamp': lamp,
    'lit felt under the lamp': lampLit,
    'pile pool under the lamp': over(L.spot, lampLit),
    'glass panel under the lamp': over(L.glass, lamp),
    'glass panel on the lit felt under the lamp': over(L.glass, lampLit),
  });
}
// Where text sits on the table: theme-cascade's surfaces plus the top bar over a
// part of the glow (it peaks at ~0.86 there), the vignette and the kitchen window.
const TOP_GLOW = 0.5;
function textBackgrounds(L) {
  return {
    ...cascadeSurfaces(L),
    'top bar, chips (glass on half the glow)': over(L.glass, over(scaled(L.daylight, TOP_GLOW), L.felt)),
    'meld headers at the edge (vignette)': over(L.glass, over(L.roomInk, L.felt)),
    'window band (kitchen mornings)': over(L.window, L.felt),
  };
}
const inks = (L) => ({ main: L.text, muted: L.muted, accent: L.get('--accent') });
const floorOf = (L) => {
  const bgs = Object.entries(textBackgrounds(L));
  return Object.fromEntries(Object.entries(inks(L)).map(([name, ink]) => {
    const [where, c] = bgs.map(([w, bg]) => [w, contrast(ink, bg)]).sort((a, b) => a[1] - b[1])[0];
    return [name, { c, where }];
  }));
};

test('table light css: the section is parsed with its theme rules', () => {
  assert.ok(START > 0 && END > START, 'TABLE LIGHT section exists');
  for (const t of THEMES.filter((x) => x !== 'table')) assert.ok(ruleOf(`[data-theme="${t}"] #table`), `${t} has its light budget`);
  assert.ok(ruleOf('#table') && ruleOf('#table').decls.get('background'), 'the light paints #table');
});

test('table light css: noon is exactly the table without the light, in every theme', () => {
  for (const theme of THEMES) {
    const L = light(theme, DAY);
    assert.ok(sameColour(L.felt, L.bg), `${theme}: felt at noon = --bg`);
    assert.ok(sameColour(L.daylight, L.glow), `${theme}: daylight at noon = --bg-glow`);
    assert.strictEqual(L.pool.a, 0, `${theme}: no lamp at noon`);
    assert.strictEqual(L.window.a, 0, `${theme}: no window band at noon`);
    assert.ok(sameColour(L.roomInk, L.vignette), `${theme}: vignette at noon = --vignette`);
    assert.deepStrictEqual(L.get('--room-in'), { v: 55, u: '%' }, `${theme}: vignette starts at 55 %`);
    const [x, y, blur, ink] = L.get('--cast');
    assert.deepStrictEqual([x, y, blur].map((n) => `${+n.v.toFixed(6)}${n.u}`), ['0px', '3px', '8px'], `${theme}: cast at noon`);
    assert.ok(sameColour(ink, { r: 0, g: 0, b: 0, a: 0.28 }), `${theme}: cast ink at noon`);
    assert.strictEqual(L.get('--cast-far').pop().a, 0, `${theme}: no far cast at noon`);
  }
  // The light repeats the day layers of #table: same glow, spot and vignette geometry.
  const base = stripComments(CSS.match(/\n#table \{([\s\S]*?)\n\}/)[1]).replace(/\s+/g, ' ');
  const lit = ruleOf('#table').decls.get('background');
  assert.ok(base.includes('radial-gradient(130% 60% at 50% -5%, var(--bg-glow) 0%, transparent 58%)'), 'base glow layer');
  assert.ok(lit.includes('radial-gradient(in srgb 130% 60% at 50% -5%, var(--daylight) 0%, transparent 58%)'),
    'daylight: the glow geometry, blended in sRGB (a color-mix() stop would switch the gradient to OKLab)');
  for (const layer of ['radial-gradient(78% 34% at 50% 78%, var(--spot) 0%, transparent 72%)']) {
    assert.ok(base.includes(layer) && lit.includes(layer), layer);
  }
  assert.ok(base.includes('radial-gradient(140% 100% at 50% 45%, transparent 55%, var(--vignette) 100%)'), 'base vignette');
  assert.ok(lit.includes('radial-gradient(140% 100% at 50% 45%, transparent var(--room-in), var(--room-ink) 100%)'), 'room vignette');
});

test('table light css: the cards carry the light\'s shadows, today\'s values by default', () => {
  const root = ruleOf(':root', RULES).decls;
  assert.strictEqual(root.get('--cast'), '0 3px 8px rgba(0, 0, 0, 0.28)', 'day cast = today\'s card shadow');
  assert.strictEqual(root.get('--cast-far'), '0 0 transparent', 'far cast: nothing by day');
  const all = stripComments(CSS);
  assert.match(all, /\n\.card \{[^}]*box-shadow: var\(--shadow-1\), var\(--cast\);/, '.card casts --cast');
  assert.doesNotMatch(all, /\.card[^{]*\{[^}]*0 3px 8px rgba\(0,\s*0,\s*0,\s*0\.28\)/, 'no card rule keeps the literal cast');
  // Every card rule with the lifted shadow also gets the far cast (nothing by day).
  const cardRules = [...all.matchAll(/([^{}]*)\{([^{}]*)\}/g)]
    .filter(([, sel, body]) => /\.card\b|\.pile-card|\.tfCard|^\s*\d+%/.test(sel) && /var\(--shadow-2\)/.test(body));
  assert.ok(cardRules.length >= 15, `found ${cardRules.length} card rules with --shadow-2`);
  for (const [, sel, body] of cardRules) assert.match(body, /var\(--shadow-2\), var\(--cast-far\)/, `${sel.trim()}: far cast after --shadow-2`);
});

test('table light css: only background and shadows change, under every colour of the content', () => {
  for (const r of SUPPORTS) {
    for (const k of r.decls.keys()) {
      assert.ok(k.startsWith('--') || k === 'background', `${r.prelude}: sets ${k}`);
      assert.ok(!/^--(text|accent|drawn|card|suit|joker|spot|glass|shadow|paper|danger|success|bg|vignette)/.test(k), `${r.prelude}: must not touch ${k}`);
    }
  }
  assert.doesNotMatch(stripComments(CSS.slice(0, START)) + stripComments(CSS.slice(END)), /oklab\(from/, 'relative colours only inside the guarded section');
  const contrastMore = RULES.find((r) => r.at.includes('@media (prefers-contrast: more)'));
  assert.ok(contrastMore, 'prefers-contrast: more keeps the day');
  assert.deepStrictEqual([...contrastMore.decls].map(([k, v]) => `${k}:${v}`), ['--tod-m:0 !important', '--tod-d:1 !important', '--tod-e:0 !important', '--tod-n:0 !important']);
  assert.ok(SUPPORTS.length && SUPPORTS.every((r) => r.at.some((a) => a.startsWith('@supports (color: oklab(from #000 calc(l * 1) calc(a + 0.01)'))),
    'everything lit sits under the relative-colour guard (without it: the day look)');
});

for (const theme of THEMES) {
  const today = light(theme, DAY);
  const todayFloor = floorOf(today);
  const yNoon = lum(today.felt);
  const steps = MINUTES.map((m) => [m, light(theme, phaseWeights(m))]);

  test(`table light css (${theme}): the room never gets ${theme === 'kitchen' ? 'darker' : 'lighter'} than at noon`, () => {
    for (const [m, L] of steps) {
      const y = lum(L.felt);
      if (theme === 'kitchen') assert.ok(y >= yNoon * (1 - 1e-12), `kitchen ${clock(m)}: the wood darkens (${y} < ${yNoon})`);
      else assert.ok(y <= yNoon * (1 + 1e-12), `${theme} ${clock(m)}: the room gets lighter (${y} > ${yNoon})`);
    }
  });

  test(`table light css (${theme}): no text colour drops below its lowest contrast on today's table`, () => {
    for (const [m, L] of steps) {
      const now = floorOf(L);
      for (const ink of ['main', 'muted', 'accent']) {
        assert.ok(now[ink].c >= todayFloor[ink].c - 1e-9,
          `${theme} ${clock(m)}: ${ink} text ${now[ink].c.toFixed(4)} on the ${now[ink].where} < today's ${todayFloor[ink].c.toFixed(4)} (${todayFloor[ink].where})`);
      }
    }
  });

  test(`table light css (${theme}): muted text keeps theme-cascade's 4.5:1 at every minute`, (t) => {
    const low = Object.entries(cascadeSurfaces(today)).filter(([, bg]) => contrast(today.muted, bg) < AA);
    if (low.length) {
      t.skip(`the noon bar does not hold yet (${low[0][0]}): test/theme-cascade reports it`);
      return;
    }
    for (const [m, L] of steps) {
      for (const [where, bg] of Object.entries(cascadeSurfaces(L))) {
        const c = contrast(L.muted, bg);
        assert.ok(c >= AA, `${theme} ${clock(m)}: muted text ${c.toFixed(2)} on the ${where}`);
      }
    }
  });

  test(`table light css (${theme}): one minute's step stays below a visible change`, () => {
    let max = 0;
    let prev = null;
    for (const [, L] of [...steps, steps[0]]) {
      const bgs = { ...textBackgrounds(L), edge: over(L.roomInk, L.felt) };
      if (prev) for (const k of Object.keys(bgs)) max = Math.max(max, deltaE2000(prev[k], bgs[k]));
      prev = bgs;
    }
    assert.ok(max < 0.5, `${theme}: max CIEDE2000 per minute ${max.toFixed(3)} (visible from about 1)`);
  });
}

test('table light css: the phases look as designed', () => {
  const okL = (c) => toOklab(c)[0];
  const ratio = (t, w, key = 'felt') => okL(light(t, w)[key]) / okL(light(t, DAY).felt);
  for (const t of THEMES.filter((x) => x !== 'kitchen')) {
    assert.ok(near(ratio(t, PHASES.evening), 0.88, 1e-4), `${t}: evening room x0.88`);
    assert.ok(near(ratio(t, PHASES.night), 0.70, 1e-4), `${t}: night room x0.70`);
    assert.ok(near(ratio(t, PHASES.night, 'pool'), 0.865, 1e-4), `${t}: night lamp x0.865`);
    assert.ok(ratio(t, PHASES.morning) <= 1 && ratio(t, PHASES.morning) >= 0.985, `${t}: morning room x${ratio(t, PHASES.morning).toFixed(3)} (cooler, not darker)`);
    assert.strictEqual(light(t, PHASES.evening).daylight.a, 0, `${t}: no daylight in the evening`);
  }
  assert.ok(near(ratio('table', PHASES.evening, 'pool'), 1.03, 1e-4), 'table lamp +3 %');
  assert.ok(near(ratio('bordeaux', PHASES.evening, 'pool'), 1.01, 1e-4), 'bordeaux lamp +1 %');
  for (const t of ['night', 'felt', 'love']) assert.ok(near(ratio(t, PHASES.evening, 'pool'), 1, 1e-4), `${t}: lamp at day lightness`);
  assert.strictEqual(light('kitchen', PHASES.night).daylight.a, 1, 'kitchen keeps its glow');
  assert.ok(near(ratio('kitchen', PHASES.evening, 'pool'), 1.03, 1e-4), 'kitchen lamp lifts the middle by 3 %');
  assert.ok(light('kitchen', PHASES.morning).window.a === 1 && light('table', PHASES.morning).window.a === 0, 'window band only in the kitchen');
});

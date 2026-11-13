/** Turn light: a soft pool of light on the felt in front of the seat on turn (public/turn-light.js
 *  plans it, client.js applyTurnLight places it, style.css TURN LIGHT colours it). It lies only on
 *  the felt between the seats and the hand; it only ever adds light, and no text over it drops
 *  below the table's noon minimum, in any theme at any hour; a mark in the felt is left out; only
 *  transform and opacity change, nothing loops; "Zuglicht" in "Optionen" switches it off.
 *  Background: docs/developer/table-light.md. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const TL = require('../public/turn-light.js');
const { phaseWeights } = require('../public/table-light.js');
const { CSS, stripComments, THEMES, over, lum, contrast, deltaE2000, light, inks, floorOf } = require('./helpers/table-light-model');

const pub = path.join(__dirname, '..', 'public');
const css = stripComments(CSS);
const SECTION = stripComments(CSS.slice(CSS.indexOf('/* --- TURN LIGHT'), CSS.indexOf('/* The occasion\'s hat')));
const HTML = fs.readFileSync(path.join(pub, 'index.html'), 'utf8');
const CLIENT = fs.readFileSync(path.join(pub, 'client.js'), 'utf8');
/** Declarations of the first rule `selector { … }` in `text`, as a Map. */
function declsOf(selector, text = SECTION) {
  const at = text.indexOf(`${selector} {`);
  assert.ok(at >= 0, `rule ${selector}`);
  const body = text.slice(text.indexOf('{', at) + 1, text.indexOf('}', at));
  const out = new Map();
  let depth = 0;
  let from = 0;
  for (let i = 0; i <= body.length; i++) {
    if (body[i] === '(') depth++;
    else if (body[i] === ')') depth--;
    else if ((body[i] === ';' || i === body.length) && depth === 0) {
      const m = /^([a-z-]+)\s*:\s*([\s\S]+)$/i.exec(body.slice(from, i).trim());
      from = i + 1;
      if (m) out.set(m[1], m[2].replace(/\s+/g, ' ').trim());
    }
  }
  return out;
}
const box = (left, top, width, height) => ({ left, top, width, height });

// --- Geometry (public/turn-light.js) ----------------------------------------------------------
// Boxes of the three table layouts as the browser lays them out: table, opponents' row, hand, a chip.
const LAYOUTS = {
  phone: { table: box(0, 0, 393, 852), layer: box(0, 0, 393, 852), seats: box(0, 61, 393, 80), hand: box(0, 707, 393, 145), chip: box(137, 71, 120, 64) },
  land: { table: box(0, 0, 874, 402), layer: box(0, 118, 874, 284), seats: box(0, 52, 874, 66), hand: box(0, 275, 874, 127), chip: box(285, 55, 180, 60) },
  desk: { table: box(20, 0, 1400, 900), layer: box(20, 145, 1400, 755), seats: box(20, 62, 1400, 83), hand: box(20, 703, 1400, 187), chip: box(605, 71, 230, 68) },
};

test('turn light geometry: the pool lies on the felt in front of the seat, in every layout', () => {
  for (const [name, r] of Object.entries(LAYOUTS)) {
    for (const mine of [false, true]) {
      const p = TL.plan({ table: r.table, layer: r.layer, seats: r.seats, hand: r.hand, seat: mine ? r.hand : r.chip, mine });
      assert.ok(p, `${name}: a plan`);
      // The band: from below the seats to the hand's upper edge, the table's width, in the layer's pixels.
      assert.deepStrictEqual(p.band, {
        left: r.table.left - r.layer.left, top: r.seats.top + r.seats.height - r.layer.top,
        width: r.table.width, height: r.hand.top - (r.seats.top + r.seats.height),
      }, `${name}: the band is the felt between the seats and the hand`);
      const seat = mine ? r.hand : r.chip;
      assert.strictEqual(p.cx, seat.left + seat.width / 2 - r.table.left, `${name}: centred on the seat`);
      assert.strictEqual(p.cy, mine ? p.band.height : 0, `${name}: ${mine ? 'rises from the hand\'s edge' : 'hangs from the seats\' row'}`);
      assert.ok(p.h / 2 <= p.band.height && p.h / 2 >= 90, `${name}: half the ellipse shows, ${p.h / 2}px high`);
      assert.ok(p.w <= r.table.width && p.w >= 250 && p.w > p.h, `${name}: wide and low (${p.w}x${p.h})`);
      const m = /^translate\(([-\d.]+)px, ([-\d.]+)px\) scale\(([\d.]+), ([\d.]+)\)$/.exec(p.transform);
      assert.ok(m, `${name}: only a transform moves and sizes the pool (${p.transform})`);
      assert.ok(Math.abs(Number(m[1]) + TL.BASE / 2 - p.cx) < 0.01 && Math.abs(Number(m[2]) + TL.BASE / 2 - p.cy) < 0.01, `${name}: the box centre lands on the pool's`);
      assert.ok(Math.abs(Number(m[3]) * TL.BASE - p.w) < 0.05 && Math.abs(Number(m[4]) * TL.BASE - p.h) < 0.05, `${name}: scaled from the BASE box`);
    }
  }
});

test('turn light geometry: a seat at the edge, a table without room, no seat', () => {
  const r = LAYOUTS.phone;
  const edge = TL.plan({ ...r, seat: box(10, 71, 114, 64) });
  assert.strictEqual(edge.cx, 67, 'the pool stays under an outer chip; the band clips what leaves the table');
  assert.strictEqual(TL.plan({ ...r, seat: null }), null, 'no seat: no light');
  assert.strictEqual(TL.plan({ ...r, seat: box(0, 0, 0, 0) }), null, 'a seat without a box (hidden): no light');
  assert.strictEqual(TL.plan({ ...r, hand: box(0, 150, 393, 700), seat: r.chip }), null, 'no felt between the seats and the hand: no light');
  assert.strictEqual(TL.plan({ table: box(0, 0, 0, 0), seat: r.chip }), null, 'a hidden table');
  const low = TL.plan({ ...r, hand: box(0, 201, 393, 600), seat: r.chip });
  assert.strictEqual(low.h / 2, 60, 'a low band: the pool is never higher than the felt');
  // No layer box (display: none under prefers-contrast): the table's own pixels.
  assert.deepStrictEqual(TL.plan({ ...r, layer: box(0, 0, 0, 0), seat: r.chip }).band, TL.plan({ ...r, seat: r.chip }).band);
});

test('turn light: whose seat it marks', () => {
  assert.strictEqual(TL.seatOf({ phase: 'playing', currentPlayerId: 'b1' }, 'b1'), 'b1');
  assert.strictEqual(TL.seatOf({ phase: 'playing', currentPlayerId: 'p1' }, 'b1'), 'b1', 'cards still in flight: the light stays with them, like the ring');
  assert.strictEqual(TL.seatOf({ phase: 'playing', currentPlayerId: 'p1' }), 'p1');
  for (const phase of ['lobby', 'cutting', 'roundEnd', 'gameOver']) assert.strictEqual(TL.seatOf({ phase, currentPlayerId: 'p1' }, 'p1'), null, `${phase}: nobody is on turn`);
  assert.strictEqual(TL.seatOf(null), null);
});

// --- The stylesheet: where it sits, what may change, what it costs ----------------------------
test('turn light css: on the felt under everything, takes no tap and no space', () => {
  const layer = declsOf('#turnLight');
  assert.strictEqual(layer.get('position'), 'absolute', 'out of the flow: no layout change');
  assert.strictEqual(layer.get('inset'), '0');
  assert.strictEqual(layer.get('z-index'), '-1', 'under every card, chip and caption (below --z-table-fx and every dialog)');
  // Over the mark and the grain (both -2): a pool moving under the grain would lift the grain's
  // blend onto a layer of its own with every glide (measured: three times the raster work).
  assert.match(css, /\n#table::after \{[^}]*mix-blend-mode: overlay;[^}]*z-index: -2;/, 'the grain below the light');
  assert.match(css, /\n#table\[data-mark\]::before \{[^}]*z-index: -2;/, 'the mark below the light');
  assert.strictEqual(layer.get('pointer-events'), 'none');
  assert.strictEqual(layer.get('opacity'), '0', 'dark until client.js switches it on');
  assert.strictEqual(declsOf('#turnLight.on').get('opacity'), 'var(--turn-light-a)', 'the strength is the layer\'s opacity');
  const band = declsOf('#turnLight > span');
  assert.strictEqual(band.get('overflow'), 'hidden', 'the band clips the pool: nothing under the seats or the hand, no page overflow');
  assert.strictEqual(band.get('position'), 'absolute');
  const pool = declsOf('#turnLight i');
  assert.strictEqual(pool.get('width'), `${TL.BASE}px`, 'the BASE box of turn-light.js');
  assert.strictEqual(pool.get('height'), `${TL.BASE}px`);
  assert.match(pool.get('background'), /^radial-gradient\(closest-side, rgb\(var\(--turn-light-c\)\) 0%, .* rgb\(var\(--turn-light-c\) \/ 0\) 100%\)$/, 'one colour fading out to nothing at the edge');
  const stops = [...pool.get('background').matchAll(/rgb\(var\(--turn-light-c\)(?: \/ ([\d.]+))?\) (\d+)%/g)].map((m) => [m[1] === undefined ? 1 : Number(m[1]), Number(m[2])]);
  assert.ok(stops.length >= 4, 'a soft fall-off');
  for (let i = 1; i < stops.length; i++) assert.ok(stops[i][0] <= stops[i - 1][0] && stops[i][1] > stops[i - 1][1], 'the light only fades towards the edge');
  // The layer is the table's first child, before everything that takes space.
  assert.match(HTML, /<section id="table" class="screen hidden">\s*(<!--[\s\S]*?-->\s*)?<div id="turnLight" aria-hidden="true"><span><i><\/i><\/span><\/div>/, 'first in #table, hidden from screen readers');
  // More contrast asked for: the felt stays plain, like the marks and the hour's light.
  assert.match(SECTION, /@media \(prefers-contrast: more\), \(forced-colors: active\) \{\s*#turnLight \{ display: none !important; \}/);
});

test('turn light css: cheap - only transform and opacity change, nothing loops, no blend mode or filter', () => {
  for (const costly of ['animation', '@keyframes', 'infinite', 'mix-blend-mode', 'backdrop-filter', 'filter:', 'clip-path', 'will-change', 'box-shadow', 'blur(']) {
    assert.ok(!SECTION.includes(costly), `no ${costly} in the turn light`);
  }
  const transitions = [...SECTION.matchAll(/([^{}]+)\{[^{}]*?transition:\s*([^;]+);/g)].map((m) => [m[1].trim().split('\n').pop().trim(), m[2].trim()]);
  assert.deepStrictEqual(transitions, [
    ['#turnLight', 'opacity 0.45s ease'],
    ['#turnLight i.glide', 'transform 0.7s cubic-bezier(0.4, 0, 0.2, 1)'],
    ['#turnLight, #turnLight i.glide', 'none'],
  ], 'the layer fades, the pool glides, and neither with reduced motion');
  assert.match(SECTION, /@media \(prefers-reduced-motion: reduce\) \{\s*#turnLight, #turnLight i\.glide \{ transition: none; \}/);
  // A mask only where a mark needs its hole; never on the pool that moves.
  assert.ok(!declsOf('#turnLight i').has('mask') && !declsOf('#turnLight').has('mask'));
  // client.js: placed once per frame after a render or a resize, never polled.
  const block = CLIENT.slice(CLIENT.indexOf('// --- Turn light:'), CLIENT.indexOf('let lastToneAt'));
  assert.ok(block.length > 500, 'the turn light block of client.js');
  assert.doesNotMatch(block, /setInterval|setTimeout/, 'no timer: nothing runs while the table is idle');
  assert.match(block, /if \(!turnLight \|\| turnLightQueued\) return;\s*turnLightQueued = true;\s*requestAnimationFrame\(applyTurnLight\);/, 'batched: one placement per frame, none while the tab is hidden');
  assert.match(block, /new ResizeObserver\(syncTurnLight\)/, 'the seats\' boxes are read again only when the layout changes');
  assert.match(block, /if \(shown !== turnLightShown\)/, 'same geometry: no style is written');
  assert.match(block, /pool\.classList\.toggle\('glide', turnLightSeat !== null && turnLightSeat !== target\.id && !reducedMotion\)/, 'only a turn passing on glides, never with reduced motion');
});

// --- Colour: only more light, and never past the table's contrast budget ------------------------
/** The light of `theme`: its colour and strength from the stylesheet (the graphite's is #table's own). */
function turnLightOf(theme) {
  const own = declsOf(theme === 'table' ? '\n#table' : `[data-theme="${theme}"] #table`);
  const c = own.get('--turn-light-c');
  const a = Number(own.get('--turn-light-a'));
  assert.match(c, /^\d+ \d+ \d+$/, `${theme}: --turn-light-c as "r g b"`);
  assert.ok(a > 0 && a <= 1, `${theme}: --turn-light-a`);
  const [r, g, b] = c.split(' ').map((n) => Number(n) / 255);
  return { r, g, b, a };
}
/** `top` (a translucent colour) painted over `base`, at `share` of its strength. */
const lit = (top, base, share = 1) => over({ ...top, a: top.a * share }, base);
// Where text meets the light: the felt between the seats and the hand - what is left of the top
// glow below the seats' row (measured: at most 0.45), the piles' spot, the lamp, the vignette and
// the kitchen's window band; bare, under the meld groups' glass, the own group's stronger glass
// and the piles' own pool (above the light).
const GLOW_BELOW_SEATS = 0.5;
const BASES = (L) => {
  const glow = over({ ...L.daylight, a: L.daylight.a * GLOW_BELOW_SEATS }, L.felt);
  return {
    felt: L.felt,
    'top glow below the seats': glow,
    'lit felt': over(L.spot, L.felt),
    'felt under the lamp': over(L.pool, L.felt),
    'lit felt under the lamp': over(L.spot, over(L.pool, L.felt)),
    'edge (vignette)': over(L.roomInk, L.felt),
    'window band (kitchen mornings)': over(L.window, glow),
  };
};
const LAYERS = (L) => ({ '': null, 'glass panel on the ': L.glass, 'own meld group on the ': L.get('--glass-strong'), 'pile pool on the ': L.spot });
const MINUTES = Array.from({ length: 96 }, (_, i) => i * 15); // every quarter hour of the table light
const DAY = { m: 0, d: 1, e: 0, n: 0 };
const NIGHT = { m: 0, d: 0, e: 0, n: 1 };
const AA = 4.5; // WCAG AA for normal text, the bar of test/theme-cascade.test.js
// Accent text has two places in the band: the header of the own melds (below the seats and in the
// middle of the table, off the piles' spot) and the hint line on the bare felt above the hand.
const accentPlace = (layerName, where) => (layerName === 'own meld group on the ' && !/lit felt|window/.test(where)) || (layerName === '' && /felt/.test(where));
const clock = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

test('turn light css: every theme brings its light, the table\'s own first', () => {
  assert.match(SECTION, /\n#table \{ --turn-light-c: \d+ \d+ \d+; --turn-light-a: [\d.]+; \}/, 'the graphite\'s on #table');
  for (const t of THEMES.filter((x) => x !== 'table')) {
    assert.match(SECTION, new RegExp(`\\n\\[data-theme="${t}"\\] #table \\{ --turn-light-c: \\d+ \\d+ \\d+; --turn-light-a: [\\d.]+; \\}`), `${t} has its own light`);
  }
  // Nothing else names the colour: the pool is the only thing it paints.
  assert.strictEqual((css.match(/var\(--turn-light-c\)/g) || []).length, (SECTION.match(/var\(--turn-light-c\)/g) || []).length);
});

for (const theme of THEMES) {
  const top = turnLightOf(theme);

  test(`turn light (${theme}): it only ever adds light, at any hour`, () => {
    for (const m of MINUTES) {
      const L = light(theme, phaseWeights(m));
      for (const [where, base] of Object.entries(BASES(L))) {
        for (const share of [0.3, 0.72, 1]) { // the pool's fall-off
          assert.ok(lum(lit(top, base, share)) >= lum(base) - 1e-12, `${theme} ${clock(m)}: the ${where} gets darker under the light (x${share})`);
        }
      }
    }
  });

  test(`turn light (${theme}): no text over it drops below the table's noon minimum or loses AA, at any hour`, () => {
    const day = light(theme, DAY);
    const floor = floorOf(day); // the bar of test/table-light-css.test.js
    const noon = { inks: inks(day), bases: BASES(day), layers: LAYERS(day) };
    for (const m of MINUTES) {
      const L = light(theme, phaseWeights(m));
      for (const [where, base] of Object.entries(BASES(L))) {
        for (const [layerName, layer] of Object.entries(LAYERS(L))) {
          const plain = layer ? over(layer, base) : base;
          const bright = layer ? over(layer, lit(top, base)) : lit(top, base);
          for (const [name, ink] of Object.entries(inks(L))) {
            // A surface the model's floor does not know (the kitchen's edge under glass) must not lose any.
            const unlit = contrast(ink, plain);
            // Text that reaches AA on today's table keeps it in the light (an accent's own minimum is lower).
            const noonPlain = noon.layers[layerName] ? over(noon.layers[layerName], noon.bases[where]) : noon.bases[where];
            const keepsAA = (name !== 'accent' || accentPlace(layerName, where)) && contrast(noon.inks[name], noonPlain) >= AA;
            const bar = Math.max(Math.min(floor[name].c, unlit), keepsAA ? AA : 0);
            assert.ok(contrast(ink, bright) >= bar - 1e-9,
              `${theme} ${clock(m)}: ${name} text on the ${layerName}${where} in the light ${contrast(ink, bright).toFixed(3)} ` +
              `< ${bar.toFixed(3)} (noon minimum ${floor[name].c.toFixed(3)}, ${floor[name].where}; ${unlit.toFixed(3)} without the light)`);
          }
        }
      }
    }
  });

  test(`turn light (${theme}): it reads on the felt, by day and at night`, () => {
    for (const [when, w] of [['noon', DAY], ['night', NIGHT]]) {
      const L = light(theme, w);
      const step = deltaE2000(L.felt, lit(top, L.felt));
      assert.ok(step >= 4.5, `${theme} at ${when}: a step of ${step.toFixed(2)} (CIEDE2000) on the felt, at least 4.5`);
      assert.ok(step <= 16, `${theme} at ${when}: a step of ${step.toFixed(2)}: soft, no spotlight`);
    }
  });
}

// --- A mark in the felt: the light leaves its art out -------------------------------------------
test('turn light css: a mark\'s art is a hole in the light, in the mark\'s own box and place', () => {
  // The mark's rules (#table[data-mark]::before): the portrait box, then landscape and desktop.
  const MEDIA = ['', '@media (orientation: landscape) and (max-height: 540px) {', '@media (min-width: 1100px) and (min-height: 541px) {'];
  const markAt = (media) => {
    const at = media ? css.indexOf(`${media}\n  #table[data-mark]::before {`) : css.indexOf('\n#table[data-mark]::before {');
    assert.ok(at > 0, `the mark's rule ${media}`);
    return declsOf('#table[data-mark]::before', css.slice(at));
  };
  const holeAt = (media) => {
    const at = media ? SECTION.indexOf(media) : SECTION.indexOf('@supports (mask-composite: exclude)');
    assert.ok(at > 0, `the light's rule ${media}`);
    return declsOf('#table[data-mark] #turnLight', SECTION.slice(at));
  };
  const zero = (v) => (v === '0' ? '0px' : v);
  const mark = new Map();
  const hole = new Map();
  for (const media of MEDIA) {
    for (const [k, v] of markAt(media)) mark.set(k, v);
    for (const [k, v] of holeAt(media)) hole.set(k, v);
    assert.strictEqual(hole.get('--turn-mark-w'), mark.get('width'), `${media || 'portrait'}: the mark's width`);
    assert.strictEqual(hole.get('--turn-mark-h'), mark.get('height'), `${media || 'portrait'}: the mark's height`);
    assert.strictEqual(hole.get('--turn-mark-top'), zero(mark.get('top')), `${media || 'portrait'}: the mark's upper inset`);
    assert.strictEqual(hole.get('--turn-mark-bottom'), zero(mark.get('bottom')), `${media || 'portrait'}: the mark's lower inset`);
    if (media) {
      // The layer takes the mark's grid area, so both are placed in the same box.
      const layer = declsOf('#turnLight', SECTION.slice(SECTION.indexOf(media)));
      assert.strictEqual(layer.get('grid-row'), mark.get('grid-row'), `${media}: the layer in the mark's rows`);
      assert.strictEqual(layer.get('grid-column'), mark.get('grid-column'), `${media}: the layer in the mark's columns`);
    }
  }
  assert.strictEqual(mark.get('left'), '0');
  assert.strictEqual(mark.get('right'), '0');
  assert.strictEqual(mark.get('margin'), 'auto', 'the mark is centred in its insets');
  assert.match(mark.get('mask'), /^var\(--table-mark, linear-gradient\(transparent, transparent\)\) center \/ contain no-repeat$/);
  // The same art, centred between the same insets, in a box of the mark's size; an SVG with a
  // viewBox and no size of its own fits itself into that box like "contain" does.
  const base = holeAt('');
  const art = 'var(--table-mark, linear-gradient(transparent, transparent)) 50% calc(50% + (var(--turn-mark-top) - var(--turn-mark-bottom)) / 2) / var(--turn-mark-w) var(--turn-mark-h) no-repeat, linear-gradient(#000, #000)';
  assert.strictEqual(base.get('mask'), art);
  assert.strictEqual(base.get('-webkit-mask'), art);
  assert.strictEqual(base.get('mask-composite'), 'exclude', 'the art cut out of the full layer');
  assert.strictEqual(base.get('-webkit-mask-composite'), 'xor');
  // Without mask compositing the hole cannot be cut: then there is no light over a mark at all.
  assert.match(SECTION, /\n#table\[data-mark\] #turnLight \{ display: none; \}\n@supports \(mask-composite: exclude\) or \(-webkit-mask-composite: xor\) \{\s*#table\[data-mark\] #turnLight \{\s*display: block;/);
});

// --- The real client in jsdom (harness as in occasion-table.test.js) ---------------------------
const SRC = ['i18n.js', 'turn-light.js', 'client.js'].map((f) => fs.readFileSync(path.join(pub, f), 'utf8'));
const PHONE = LAYOUTS.phone;
const CHIPS = { b1: box(11, 71, 120, 64), b2: box(137, 71, 120, 64) };

function boot({ reducedMotion = false, stored = null } = {}) {
  const { window } = new JSDOM(HTML, { url: 'https://play.example/', runScripts: 'outside-only', pretendToBeVisual: true });
  const errors = [];
  window.matchMedia = (q) => ({ matches: reducedMotion && /prefers-reduced-motion/.test(q), media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
  window.navigator.vibrate = () => true;
  window.scrollTo = () => {};
  window.Element.prototype.scrollIntoView = function scrollIntoView() {};
  const frames = [];
  window.requestAnimationFrame = (f) => frames.push(f);
  // jsdom lays nothing out: the table's boxes as on an iPhone.
  window.Element.prototype.getBoundingClientRect = function getBoundingClientRect() {
    const r = { table: PHONE.table, turnLight: PHONE.layer, opponents: PHONE.seats, handWrapper: PHONE.hand }[this.id]
      || (this.dataset && CHIPS[this.dataset.playerId]) || box(0, 0, 0, 0);
    return { ...r, right: r.left + r.width, bottom: r.top + r.height };
  };
  window.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve({}), text: () => Promise.resolve('') });
  let ws = null;
  window.WebSocket = class {
    constructor() { this._ls = {}; ws = this; this.readyState = 1; setTimeout(() => this._emit('open', {}), 0); }
    addEventListener(t, f) { (this._ls[t] = this._ls[t] || []).push(f); }
    removeEventListener(t, f) { this._ls[t] = (this._ls[t] || []).filter((x) => x !== f); }
    _emit(t, ev) {
      if (typeof this['on' + t] === 'function') this['on' + t](ev);
      for (const f of this._ls[t] || []) f(ev);
    }
    send() {} close() {}
  };
  window.WebSocket.OPEN = 1;
  window.WebSocket.CONNECTING = 0;
  window.onerror = (msg) => errors.push(String(msg));
  window.console.error = (...a) => errors.push(a.map(String).join(' '));
  window.localStorage.setItem('pikdame_tip_seen', '9');
  window.localStorage.setItem('pikdame_opp_moves', 'off'); // no flights: the state alone moves the turn
  if (stored) window.localStorage.setItem('pikdame_turn_light', stored);
  window.sessionStorage.setItem('pikdame_splash_seen', '1');
  for (const src of SRC) window.eval(src);
  window.document.dispatchEvent(new window.Event('DOMContentLoaded', { bubbles: true }));
  const doc = window.document;
  const send = (msg) => ws._emit('message', { data: JSON.stringify(msg) });
  /** The next frame: everything queued with requestAnimationFrame runs once. */
  const frame = () => { for (const f of frames.splice(0)) f(0); };
  const layer = () => doc.getElementById('turnLight');
  const pool = () => layer().querySelector('i');
  return { window, doc, errors, send, frame, frames, layer, pool };
}
const ready = () => new Promise((r) => setTimeout(r, 10));
const card = (id) => ({ id, suit: id[0], rank: id.slice(1, id.indexOf('-')), isJoker: false });
function state(extra = {}) {
  return {
    phase: 'playing', roundNumber: 2, turnIndexInRound: 8, currentPlayerId: 'b2', turnPhase: 'draw', dealerId: 'b1',
    drawPileCount: 40, discardTop: card('D4-0'), discardPileCount: 1, discardCards: [card('D4-0')],
    tableMelds: [], log: [], houseRules: {}, lobbyReady: [], nextRoundReady: [], totals: { p1: 120, b1: 80, b2: 40 }, scoreHistory: [],
    players: [
      { id: 'p1', name: 'Flo', isBot: false, connected: true, handCount: 2, hand: [card('H2-0'), card('C9-0')] },
      { id: 'b1', name: 'Klaus', isBot: true, connected: true, handCount: 9, botDifficulty: 'medium' },
      { id: 'b2', name: 'Uwe', isBot: true, connected: true, handCount: 7, botDifficulty: 'medium' },
    ],
    ...extra,
  };
}
async function atTable(opts, extra) {
  const c = boot(opts);
  await ready();
  c.send({ type: 'joined', playerId: 'p1', playerToken: 't', sessionCode: 'TRN001' });
  c.send({ type: 'state', state: state(extra) });
  return c;
}
const translateOf = (node) => /^translate\(([-\d.]+)px, ([-\d.]+)px\)/.exec(node.style.transform).slice(1).map(Number);

test('turn light client: it lies in front of the opponent on turn and glides to me when the turn passes', async (t) => {
  const c = await atTable();
  t.after(() => c.window.close());
  assert.ok(!c.layer().classList.contains('on'), 'placed in the next frame, from the seats the render built');
  assert.strictEqual(c.frames.filter((f) => f.name === 'applyTurnLight').length, 1, 'one placement queued, however often the table rendered');
  c.frame();
  assert.ok(c.layer().classList.contains('on'), 'a round is played: the light is on');
  const band = c.layer().firstElementChild;
  assert.deepStrictEqual([band.style.left, band.style.top, band.style.width, band.style.height], ['0px', '141px', '393px', '566px'], 'the band: from below the chips to the hand');
  assert.deepStrictEqual(translateOf(c.pool()), [197 - TL.BASE / 2, -TL.BASE / 2], 'under Uwe\'s chip, at the band\'s upper edge');
  assert.ok(!c.pool().classList.contains('glide'), 'the first light just appears');

  c.send({ type: 'state', state: state({ currentPlayerId: 'b1' }) });
  c.frame();
  assert.deepStrictEqual(translateOf(c.pool()), [71 - TL.BASE / 2, -TL.BASE / 2], 'the turn passed to Klaus: under his chip');
  assert.ok(c.pool().classList.contains('glide'), 'a turn passing on glides');

  c.send({ type: 'state', state: state({ currentPlayerId: 'p1' }) });
  c.frame();
  assert.deepStrictEqual(translateOf(c.pool()), [196.5 - TL.BASE / 2, 566 - TL.BASE / 2], 'my turn: it rises from my hand\'s upper edge');
  assert.ok(c.pool().classList.contains('glide'));

  // The same state again (a card selected, a hint): nothing is written.
  const before = c.pool().getAttribute('style');
  c.pool().classList.remove('glide');
  c.send({ type: 'state', state: state({ currentPlayerId: 'p1', turnPhase: 'meld' }) });
  c.frame();
  assert.strictEqual(c.pool().getAttribute('style'), before);
  assert.ok(!c.pool().classList.contains('glide'), 'same seat, same boxes: no style work');

  c.send({ type: 'state', state: state({ phase: 'roundEnd', lastRoundWinnerId: 'b1', roundScores: {} }) });
  c.frame();
  assert.ok(!c.layer().classList.contains('on'), 'the round is over: nobody is on turn, the light goes out');
  c.send({ type: 'state', state: state({ currentPlayerId: 'b1' }) });
  c.frame();
  assert.ok(c.layer().classList.contains('on'));
  assert.ok(!c.pool().classList.contains('glide'), 'a new round: the light appears at the seat, it does not travel there');
  assert.deepStrictEqual(c.errors, []);
});

test('turn light client: "Zuglicht" in "Optionen" switches it off, per device', async (t) => {
  const c = await atTable();
  t.after(() => c.window.close());
  c.frame();
  const boxEl = c.doc.getElementById('turnLightCheckbox');
  assert.ok(boxEl.checked, 'on by default');
  assert.ok(boxEl.closest('.prefRow').querySelector('use[href="#i-sparkle"]'), 'an icon from the sprite');
  boxEl.checked = false;
  boxEl.dispatchEvent(new c.window.Event('change', { bubbles: true }));
  c.frame();
  assert.ok(!c.layer().classList.contains('on'), 'off at once');
  assert.strictEqual(c.window.localStorage.getItem('pikdame_turn_light'), 'off');
  c.send({ type: 'state', state: state({ currentPlayerId: 'p1' }) });
  c.frame();
  assert.ok(!c.layer().classList.contains('on'), 'and stays off when the turn passes');
  boxEl.checked = true;
  boxEl.dispatchEvent(new c.window.Event('change', { bubbles: true }));
  c.frame();
  assert.ok(c.layer().classList.contains('on'), 'on again');
  assert.strictEqual(c.window.localStorage.getItem('pikdame_turn_light'), 'on');

  const off = await atTable({ stored: 'off' });
  t.after(() => off.window.close());
  off.frame();
  assert.ok(!off.doc.getElementById('turnLightCheckbox').checked, 'the stored choice shows in the sheet');
  assert.ok(!off.layer().classList.contains('on'));
  assert.deepStrictEqual([...c.errors, ...off.errors], []);
});

test('turn light client: reduced motion - the light jumps, it never glides', async (t) => {
  const c = await atTable({ reducedMotion: true });
  t.after(() => c.window.close());
  c.frame();
  c.send({ type: 'state', state: state({ currentPlayerId: 'p1' }) });
  c.frame();
  assert.ok(c.layer().classList.contains('on'));
  assert.deepStrictEqual(translateOf(c.pool()), [196.5 - TL.BASE / 2, 566 - TL.BASE / 2], 'at my seat');
  assert.ok(!c.pool().classList.contains('glide'), 'no glide');
  assert.deepStrictEqual(c.errors, []);
});

test('turn light: loaded before client.js, its texts in both languages', () => {
  const order = ['/table-light.js', '/turn-light.js', '/client.js'].map((s) => HTML.indexOf(`<script src="${s}" defer></script>`));
  assert.ok(order.every((i) => i > 0) && order[0] < order[1] && order[1] < order[2], 'index.html loads turn-light.js before client.js');
  const i18n = fs.readFileSync(path.join(pub, 'i18n.js'), 'utf8');
  assert.match(i18n, /'Zuglicht': 'Turn light'/);
  assert.match(i18n, /'Ein Lichtschein zeigt, wer am Zug ist': 'A soft light shows whose turn it is'/);
  assert.match(CLIENT, /const turnLight = window\.PikdameTurnLight \|\| null;/, 'a stale cached page without the module: no light, no error');
});

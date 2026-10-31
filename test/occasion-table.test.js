/** Occasion days at the table: no text over the felt watermark (style.css) drops below the
 *  table's noon minimum, in any theme at any hour of the table light; it takes no tap or space;
 *  the Queen of Spades' announcement wears the occasion's hat (client.js showRaidWarning). */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { phaseWeights } = require('../public/table-light.js');
const { CSS, stripComments, THEMES, over, contrast, light, inks, floorOf } = require('./helpers/table-light-model');

const pub = path.join(__dirname, '..', 'public');
const css = stripComments(CSS);

/** Every top-level and nested rule with a declaration of `prop`: { selectors, value }. */
function declarationsOf(prop) {
  const out = [];
  const re = new RegExp(`([^{};]+)\\{([^{}]*?${prop}\\s*:\\s*([^;}]+))`, 'g');
  for (const m of css.matchAll(re)) out.push({ selectors: m[1].split(',').map((s) => s.trim()), value: m[3].trim() });
  return out;
}

/** The watermark ink per theme: #table's own, then the theme's (later rules win). */
function inkOf(theme) {
  let ink = null;
  for (const { selectors, value } of declarationsOf('--mark-ink')) {
    if (selectors.includes('#table') || selectors.includes(`[data-theme="${theme}"] #table`)) ink = value;
  }
  assert.ok(ink, `${theme}: has a watermark ink`);
  return ink;
}

test('occasion watermark: a mask behind everything, keyed on the occasion, never in the way', () => {
  const rule = css.match(/\nbody\[data-occasion\] #table::before \{([^}]*)\}/);
  assert.ok(rule, 'the watermark is #table::before, only on an occasion day');
  const body = rule[1];
  assert.match(body, /pointer-events:\s*none/, 'no tap lands on it');
  assert.match(body, /z-index:\s*-1/, 'under every card, chip and caption');
  assert.match(body, /position:\s*absolute/, 'takes no space of its own');
  // Without art (birthday, Nikolaus, ...) the fallback mask is fully transparent: nothing is drawn.
  for (const prop of ['-webkit-mask', 'mask']) {
    assert.match(body, new RegExp(`\\n\\s*${prop}:\\s*var\\(--table-mark, linear-gradient\\(transparent, transparent\\)\\)`), `${prop}: transparent without art`);
  }
  // Landscape and desktop: in the melds column, measured from its top (the fixed rows above).
  for (const media of ['@media (orientation: landscape) and (max-height: 540px) {', '@media (min-width: 1100px) and (min-height: 541px) {']) {
    const at = css.indexOf(`${media}\n  body[data-occasion] #table::before {`);
    assert.ok(at > 0, `${media} places it`);
    const placed = css.slice(at, css.indexOf('}', at));
    assert.match(placed, /grid-area:\s*melds/, `${media}: the melds area`);
    assert.match(placed, /bottom:\s*auto/, `${media}: not tied to the area's bottom (the action bar moves it)`);
  }
  assert.match(css, /@media \(prefers-contrast: more\), \(forced-colors: active\) \{\s*body\[data-occasion\] #table::before \{ content: none; \}/,
    'more contrast asked for: no picture under the cards');
});

test('occasion watermark: every --table-mark is a local, self-contained SVG', () => {
  const marks = declarationsOf('--table-mark');
  assert.ok(marks.some((m) => m.selectors.includes('body[data-occasion="halloween"]')), 'Halloween has its art');
  for (const { selectors, value } of marks) {
    const m = /^url\('([a-z0-9/-]+\.svg)'\)$/.exec(value);
    assert.ok(m, `${selectors}: a relative url('….svg'), got ${value}`);
    assert.ok(selectors.every((s) => /^body\[data-occasion="[a-z]+"\]$/.test(s)), `${selectors}: set per occasion id`);
    const svg = fs.readFileSync(path.join(pub, m[1]), 'utf8');
    assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="[\d. ]+">/, `${m[1]}: an SVG with a viewBox`);
    // A mask image may not load anything (CSP: img-src 'self' data:), nor run anything.
    assert.doesNotMatch(svg, /<(image|script|foreignObject|use)\b|href=|url\((?!#)/i, `${m[1]}: no external or nested resources`);
  }
});

test('occasion watermark: the art behind the hat is in the markup', () => {
  const html = fs.readFileSync(path.join(pub, 'index.html'), 'utf8');
  assert.match(html, /<g class="heroWitchHat"/, 'the start screen cat\'s witch hat (the queen borrows it)');
});

// Where text meets the watermark: the felt, the spot, the lamp pool, the vignette and the
// fall-off of the top glow (the mark starts below it: at most a fifth of it, on an iPhone SE);
// bare, under the meld groups' glass and under the own group's stronger glass.
const GLOW_FALLOFF = 0.2;
const BASES = (L) => ({
  felt: L.felt,
  'fall-off of the top glow': over({ ...L.daylight, a: L.daylight.a * GLOW_FALLOFF }, L.felt),
  'lit felt': over(L.spot, L.felt),
  'felt under the lamp': over(L.pool, L.felt),
  'lit felt under the lamp': over(L.spot, over(L.pool, L.felt)),
  'edge (vignette)': over(L.roomInk, L.felt),
});
const MINUTES = Array.from({ length: 96 }, (_, i) => i * 15); // every quarter hour of the table light
const DAY = { m: 0, d: 1, e: 0, n: 0 };
const clock = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

/** A custom property for occasion `id` in `theme`, the most specific rule winning (theme + id, id, theme, any). */
function occasionVar(prop, id, theme) {
  const order = [`[data-theme="${theme}"] body[data-occasion="${id}"]`, `body[data-occasion="${id}"]`,
    `[data-theme="${theme}"] body[data-occasion]`, 'body[data-occasion]'];
  const decls = declarationsOf(prop);
  for (const sel of order) {
    const hit = decls.filter((d) => d.selectors.includes(sel)).pop();
    if (hit) return hit.value;
  }
  return undefined;
}
const ARTS = declarationsOf('--table-mark').flatMap((d) => d.selectors.map((s) => /^body\[data-occasion="([a-z]+)"\]$/.exec(s)[1]));

for (const theme of THEMES) {
  test(`occasion watermark (${theme}): no text over it drops below the table's noon minimum, at any hour`, () => {
    const floor = floorOf(light(theme, DAY)); // the bar of test/table-light-css.test.js
    for (const id of ARTS) {
      const tint = occasionVar('--mark-tint', id, theme);
      assert.ok(tint, `${id}: art brings its --mark-tint`);
      const vars = { '--mark-ink': inkOf(theme), '--mark-tint': tint };
      for (const m of MINUTES) {
        const L = light(theme, phaseWeights(m), vars);
        const mark = L.get('--mark-ink');
        assert.ok(mark.a > 0 && mark.a < 1, `${theme} ${id}: a translucent ink (${vars['--mark-ink']})`);
        const layers = { '': null, 'glass panel on the ': L.glass, 'own meld group on the ': L.get('--glass-strong') };
        for (const [where, base] of Object.entries(BASES(L))) {
          for (const [layerName, layer] of Object.entries(layers)) {
            const marked = layer ? over(layer, over(mark, base)) : over(mark, base);
            for (const [name, c] of Object.entries(inks(L))) {
              assert.ok(contrast(c, marked) >= floor[name].c - 1e-9,
                `${theme} ${id} ${clock(m)}: ${name} text on the ${layerName}${where} with the mark ${contrast(c, marked).toFixed(3)} ` +
                `< the noon minimum ${floor[name].c.toFixed(3)} (${floor[name].where})`);
            }
          }
        }
      }
    }
  });
}

// --- The queen's hat: the real client in jsdom (harness as in queen-turn-client.test.js) ---
const SRC = ['i18n.js', 'client.js'].map((f) => fs.readFileSync(path.join(pub, f), 'utf8'));
const HTML = fs.readFileSync(path.join(pub, 'index.html'), 'utf8');

function boot(occasion) {
  const { window } = new JSDOM(HTML, { url: 'https://play.example/', runScripts: 'outside-only', pretendToBeVisual: true });
  const errors = [];
  window.matchMedia = (q) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
  window.navigator.vibrate = () => true;
  window.scrollTo = () => {};
  window.Element.prototype.scrollIntoView = function scrollIntoView() {};
  window.requestAnimationFrame = () => 0;
  const now = Date.now();
  const statusz = occasion ? { occasions: { windows: [{ id: occasion, from: now - 36e5, until: now + 36e5 }], refreshAt: now + 36e5 } } : {};
  window.fetch = (url) => Promise.resolve({ ok: true, json: () => Promise.resolve(url === '/statusz' ? statusz : {}), text: () => Promise.resolve('') });
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
  window.sessionStorage.setItem('pikdame_splash_seen', '1');
  for (const src of SRC) window.eval(src);
  window.document.dispatchEvent(new window.Event('DOMContentLoaded', { bubbles: true }));
  const send = (msg) => ws._emit('message', { data: JSON.stringify(msg) });
  return { window, doc: window.document, errors, send };
}
const ready = () => new Promise((r) => setTimeout(r, 10));
const card = (id) => ({ id, suit: id[0], rank: id.slice(1, id.indexOf('-')), isJoker: false });
function state(melds) {
  return {
    phase: 'playing', roundNumber: 2, turnIndexInRound: 8, currentPlayerId: 'b1', turnPhase: 'meld', dealerId: 'b1',
    drawPileCount: 40, discardTop: card('D4-0'), discardPileCount: 1, discardCards: [card('D4-0')],
    tableMelds: melds.map(([ownerId, ids], i) => ({ id: `m${i}`, ownerId, type: 'set', slots: ids.map((id) => ({ real: card(id) })) })),
    log: [], houseRules: {}, lobbyReady: [], nextRoundReady: [], totals: { p1: 120, b1: 80 }, scoreHistory: [],
    players: [
      { id: 'p1', name: 'Flo', isBot: false, connected: true, handCount: 2, hand: [card('H2-0'), card('C9-0')] },
      { id: 'b1', name: 'Klaus', isBot: true, connected: true, handCount: 9, botDifficulty: 'medium' },
    ],
  };
}
async function queenLaidOut(occasion) {
  const c = boot(occasion);
  await ready();
  c.send({ type: 'joined', playerId: 'p1', playerToken: 't', sessionCode: 'HAT001' });
  c.send({ type: 'state', state: state([['b1', ['D8-0', 'D9-0', 'D10-0']]]) });
  c.send({ type: 'state', state: state([['b1', ['D8-0', 'D9-0', 'D10-0']], ['b1', ['SQ-0', 'HQ-0', 'CQ-0']]]) });
  return c;
}

test('queen announcement: on Halloween she wears the start screen cat\'s witch hat', async (t) => {
  const c = await queenLaidOut('halloween');
  t.after(() => c.window.close());
  assert.strictEqual(c.doc.body.dataset.occasion, 'halloween');
  const panel = c.doc.querySelector('.raidWarning');
  assert.ok(panel, 'the announcement comes');
  const hat = panel.querySelector('svg.rwHat');
  assert.ok(hat, 'with a hat');
  assert.strictEqual(hat.getAttribute('aria-hidden'), 'true', 'decoration only');
  assert.ok(hat.querySelector('g.heroWitchHat .hatEdge'), 'a copy of the cat\'s hat (the kitchen theme\'s edge rule reaches it)');
  assert.ok(c.doc.querySelector('.lobbyHero .heroWitchHat'), 'the cat keeps its own');
  assert.match(panel.textContent, /PIK DAME/, 'the text is unchanged');
  assert.deepStrictEqual(c.errors, []);
});

test('queen announcement: no hat on other days or on occasions without one', async (t) => {
  for (const occasion of [null, 'christmas']) {
    const c = await queenLaidOut(occasion);
    t.after(() => c.window.close());
    assert.ok(c.doc.querySelector('.raidWarning'), `${occasion}: the announcement comes`);
    assert.strictEqual(c.doc.querySelector('.raidWarning .rwHat'), null, `${occasion}: bare-headed`);
    assert.deepStrictEqual(c.errors, []);
  }
});

/** Occasion days at the table: every holiday and the birthday has its mark in the felt, and so has
 *  every mark the player can unlock (client.js TABLE_MARKS); no text over a mark (style.css) drops
 *  below the table's noon minimum, in any theme at any hour of the table light, and every mark
 *  stays visible; it takes no tap or space; the table shows the right mark (client.js
 *  tableMarkFor: a birthday at the table wins over the holiday, test/table-marks-client.test.js
 *  the player's own); the Queen of Spades' announcement wears the occasion's hat (showRaidWarning). */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { phaseWeights } = require('../public/table-light.js');
const { HOLIDAY_IDS } = require('../game/Holidays');
const { BADGE_IDS } = require('../game/Badges');
const { CSS, stripComments, THEMES, over, contrast, deltaE2000, light, inks, floorOf } = require('./helpers/table-light-model');

const pub = path.join(__dirname, '..', 'public');
const css = stripComments(CSS);

/** client.js TABLE_MARKS: the marks a player unlocks and picks, each with one gate (level or badge). */
const PLAYER_MARKS = (() => {
  const block = fs.readFileSync(path.join(pub, 'client.js'), 'utf8').match(/const TABLE_MARKS = \[([\s\S]*?)\n {2}\];/);
  assert.ok(block, 'TABLE_MARKS literal in client.js');
  const re = /\{ id: '([a-z]+)', label: '([^']+)', labelEn: '([^']+)', gate: (?:null|\{ (?:level: (\d+)|badge: '([a-z0-9_]+)') \}) \}/g;
  const marks = [...block[1].matchAll(re)].map((m) => ({ id: m[1], level: m[4] ? Number(m[4]) : null, badge: m[5] || null }));
  assert.strictEqual(marks.length, (block[1].match(/\{ id: /g) || []).length, 'every TABLE_MARKS entry is read');
  return marks;
})();
const OWN_IDS = PLAYER_MARKS.filter((m) => m.level || m.badge).map((m) => m.id);
const MARK_IDS = [...HOLIDAY_IDS, 'birthday', ...OWN_IDS];

/** Every top-level and nested rule with a declaration of `prop`: { selectors, value }. Scanned once per prop. */
const declared = new Map();
function declarationsOf(prop) {
  if (declared.has(prop)) return declared.get(prop);
  const out = [];
  const re = new RegExp(`([^{};]+)\\{([^{}]*?${prop}\\s*:\\s*([^;}]+))`, 'g');
  for (const m of css.matchAll(re)) out.push({ selectors: m[1].split(',').map((s) => s.trim()), value: m[3].trim() });
  declared.set(prop, out);
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

test('occasion watermark: a mask behind everything, keyed on the table\'s mark, never in the way', () => {
  const rule = css.match(/\n#table\[data-mark\]::before \{([^}]*)\}/);
  assert.ok(rule, 'the watermark is #table::before, only while the table names a mark');
  const body = rule[1];
  assert.match(body, /pointer-events:\s*none/, 'no tap lands on it');
  assert.match(body, /z-index:\s*-1/, 'under every card, chip and caption');
  assert.match(body, /position:\s*absolute/, 'takes no space of its own');
  // A mark without art (a new id before its drawing) gets a fully transparent mask: nothing is drawn.
  for (const prop of ['-webkit-mask', 'mask']) {
    assert.match(body, new RegExp(`\\n\\s*${prop}:\\s*var\\(--table-mark, linear-gradient\\(transparent, transparent\\)\\)`), `${prop}: transparent without art`);
  }
  assert.match(css, /@media \(prefers-contrast: more\), \(forced-colors: active\) \{\s*#table\[data-mark\]::before \{ content: none; \}/,
    'more contrast asked for: no picture under the cards');
  assert.doesNotMatch(css, /body\[data-occasion[^\]]*\][^{,]*#table::before/, 'the device\'s occasion never draws on the table');
});

/** Declarations of a rule body as a Map. */
const declsOf = (body) => new Map([...body.matchAll(/([a-z-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));

test('occasion watermark: every occasion\'s mark is centred in the felt, and stays put', () => {
  // The felt: from below the opponents to the hand bar folded away (its lowest, steady place), the
  // table's full width. Insets on all four sides, a fixed box and margin: auto centre it both ways.
  const base = declsOf(css.match(/\n#table\[data-mark\]::before \{([^}]*)\}/)[1]);
  assert.strictEqual(base.get('top'), 'calc(var(--safe-top) + 144px)', 'portrait: below the top bar and the opponents');
  assert.strictEqual(base.get('bottom'), 'calc(var(--safe-bottom) + 49px)', 'above the folded hand bar, open or not');
  assert.strictEqual(base.get('left'), '0');
  assert.strictEqual(base.get('right'), '0');
  assert.strictEqual(base.get('margin'), 'auto', 'centred in that felt, both ways');
  for (const prop of ['width', 'height']) assert.doesNotMatch(base.get(prop) || 'auto', /auto|%\s*$/, `a fixed ${prop}, not the felt's`);
  for (const prop of ['-webkit-mask', 'mask']) assert.match(base.get(prop), /\) center \/ contain no-repeat$/, `${prop}: the art centred and whole`);
  // Landscape and desktop: the same felt in the grid, from line 3 (below the opponents) across both columns.
  for (const media of ['@media (orientation: landscape) and (max-height: 540px) {', '@media (min-width: 1100px) and (min-height: 541px) {']) {
    const at = css.indexOf(`${media}\n  #table[data-mark]::before {`);
    assert.ok(at > 0, `${media} places it`);
    const placed = declsOf(css.slice(css.indexOf('{', at + media.length) + 1, css.indexOf('}', at)));
    assert.strictEqual(placed.get('grid-row'), '3 / -1', `${media}: from the opponents' row down`);
    assert.strictEqual(placed.get('grid-column'), '1 / -1', `${media}: the full width, piles included`);
    assert.strictEqual(placed.get('top'), '0', `${media}: right below the opponents`);
    assert.ok(!placed.has('margin') && !placed.has('left') && !placed.has('right'), `${media}: still centred by the base rule`);
    assert.match(placed.get('bottom') || base.get('bottom'), /^calc\(var\(--safe-bottom\) \+ \d+px\)$/, `${media}: the folded hand bar`);
  }
  // Nothing else may move or size one mark: art comes only through --table-mark.
  const others = [...css.matchAll(/([^{}]*#table(?:\[[^\]]*\])?::before[^{}]*)\{([^}]*)\}/g)]
    .filter(([, sel]) => /data-mark="/.test(sel) || !/^\s*#table\[data-mark\]::before\s*$/.test(sel));
  for (const [, sel, body] of others) {
    assert.doesNotMatch(body, /(^|[;\s])(top|bottom|left|right|inset|margin|width|height|grid-[a-z-]+|(-webkit-)?mask(-position|-size)?)\s*:/,
      `${sel.trim()}: no rule but the shared ones places the mark`);
  }
});

test('occasion watermark: every holiday, the birthday and every own mark has its own local, self-contained art', () => {
  const marks = declarationsOf('--table-mark');
  for (const { selectors, value } of marks) {
    const ids = selectors.map((s) => /^(?:#table|\.markSwatch)\[data-mark="([a-z]+)"\]$/.exec(s));
    assert.ok(ids.every(Boolean), `${selectors}: set per mark id`);
    const id = ids[0][1];
    assert.ok(ids.every((x) => x[1] === id), `${selectors}: one mark per rule`);
    assert.ok(selectors.includes(`#table[data-mark="${id}"]`), `${id}: drawn on the table`);
    // An own mark's gallery swatch takes the very same art and tint; an occasion is never picked.
    assert.strictEqual(selectors.includes(`.markSwatch[data-mark="${id}"]`), OWN_IDS.includes(id), `${id}: a swatch exactly for the own marks`);
    const m = /^url\('([a-z0-9/-]+\.svg)'\)$/.exec(value);
    assert.ok(m, `${selectors}: a relative url('….svg'), got ${value}`);
    const svg = fs.readFileSync(path.join(pub, m[1]), 'utf8');
    assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="[\d. ]+">/, `${m[1]}: an SVG with a viewBox`);
    // A mask image may not load anything (CSP: img-src 'self' data:), nor run anything.
    assert.doesNotMatch(svg, /<(image|script|foreignObject|use)\b|href=|url\((?!#)/i, `${m[1]}: no external or nested resources`);
    assert.doesNotMatch(svg, /<animate|@keyframes|<set\b/i, `${m[1]}: static (CLAUDE.md 2c)`);
    // Safari renders a filtered SVG image at its own size and scales it up: pixels on the felt.
    assert.doesNotMatch(svg, /<filter\b|filter=/i, `${m[1]}: no SVG filter (pixelates as a mask)`);
  }
  const files = new Set();
  for (const id of MARK_IDS) {
    const art = marks.filter((d) => d.selectors.includes(`#table[data-mark="${id}"]`)).pop();
    assert.ok(art, `${id}: has its art`);
    assert.ok(!files.has(art.value), `${id}: a drawing of its own`);
    files.add(art.value);
    assert.ok(declarationsOf('--mark-tint').some((d) => d.selectors.includes(`#table[data-mark="${id}"]`)), `${id}: brings its tint`);
  }
});

test('own marks: none first, ids no occasion uses, one real gate each, the levels a ladder', () => {
  assert.deepStrictEqual(PLAYER_MARKS[0], { id: 'none', level: null, badge: null }, 'the plain felt first, never locked');
  assert.strictEqual(new Set(PLAYER_MARKS.map((m) => m.id)).size, PLAYER_MARKS.length, 'ids unique');
  assert.ok(OWN_IDS.length >= 5 && OWN_IDS.length <= 7, `a small collection (${OWN_IDS.length})`);
  assert.strictEqual(OWN_IDS.length, PLAYER_MARKS.length - 1, 'every mark but "none" has a gate');
  for (const m of PLAYER_MARKS.slice(1)) {
    // The occasion always wins (client.js tableMarkFor); a shared id would blur which one shows.
    assert.ok(![...HOLIDAY_IDS, 'birthday'].includes(m.id), `${m.id}: not an occasion's id`);
    assert.ok(!!m.level !== !!m.badge, `${m.id}: one gate, a level or a badge`);
    if (m.badge) assert.ok(BADGE_IDS.includes(m.badge), `${m.id}: ${m.badge} is a badge of game/Badges.js`);
  }
  const levels = PLAYER_MARKS.filter((m) => m.level).map((m) => m.level);
  assert.ok(levels.length >= 2 && PLAYER_MARKS.filter((m) => m.badge).length >= 2, 'some by level, some by badge');
  assert.deepStrictEqual(levels, [...levels].sort((a, b) => a - b), 'level marks in the order they unlock');
  assert.ok(levels.every((l) => l > 1 && l <= 50), 'within the level ladder of the other cosmetics');
  // The swatch: the theme's felt, the same tint in a stronger ink (a fifth of the size), the same fallback.
  const swatch = css.match(/\n\.markSwatch \{([^}]*)\}/);
  assert.ok(swatch, 'the gallery has a swatch');
  assert.match(swatch[1], /--mark-ink:\s*color-mix\(in srgb, var\(--mark-tint\) \d+%, transparent\)/, 'its ink mixes the mark\'s tint');
  assert.match(swatch[1], /var\(--bg\)/, 'on the theme\'s own felt');
  assert.match(css, /\[data-theme="kitchen"\] \.markSwatch \{ --mark-ink: rgb\(255 252 244 \/ [\d.]+\); \}/, 'the kitchen\'s pale inlay');
  const before = css.match(/\n\.markSwatch::before \{([^}]*)\}/);
  assert.ok(before && /var\(--table-mark, linear-gradient\(transparent, transparent\)\) center \/ contain no-repeat/.test(before[1]), 'the art centred and whole, nothing without art');
});

test('occasion watermark: the art behind the hat is in the markup', () => {
  const html = fs.readFileSync(path.join(pub, 'index.html'), 'utf8');
  assert.match(html, /<g class="heroWitchHat"/, 'the start screen cat\'s witch hat (the queen borrows it)');
});

// Where text meets the watermark: the felt, the spot, the lamp pool, the vignette and (with room
// to spare: the mark starts below it) a fifth of the top glow; bare, under the meld groups' glass,
// the own group's stronger glass and the piles' pool.
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

/** A custom property for mark `id` in `theme`, the most specific rule winning (theme + id, id, theme, any). */
function markVar(prop, id, theme) {
  const order = [`[data-theme="${theme}"] #table[data-mark="${id}"]`, `#table[data-mark="${id}"]`,
    `[data-theme="${theme}"] #table[data-mark]`, '#table[data-mark]'];
  const decls = declarationsOf(prop);
  for (const sel of order) {
    const hit = decls.filter((d) => d.selectors.includes(sel)).pop();
    if (hit) return hit.value;
  }
  return undefined;
}
const ARTS = declarationsOf('--table-mark').flatMap((d) => d.selectors.map((s) => (/^#table\[data-mark="([a-z]+)"\]$/.exec(s) || [])[1]).filter(Boolean));
/** What a mark paints on the felt of `theme` at phase weights `w`. */
const markLight = (theme, id, w) => {
  const tint = markVar('--mark-tint', id, theme);
  assert.ok(tint, `${id}: art brings its --mark-tint`);
  const vars = { '--mark-ink': inkOf(theme), '--mark-tint': tint };
  const L = light(theme, w, vars);
  return { L, mark: L.get('--mark-ink'), vars };
};

for (const theme of THEMES) {
  test(`occasion watermark (${theme}): no text over any mark drops below the table's noon minimum, at any hour`, () => {
    const floor = floorOf(light(theme, DAY)); // the bar of test/table-light-css.test.js
    for (const id of ARTS) {
      for (const m of MINUTES) {
        const { L, mark, vars } = markLight(theme, id, phaseWeights(m));
        assert.ok(mark.a > 0 && mark.a < 1, `${theme} ${id}: a translucent ink (${vars['--mark-ink']}, ${vars['--mark-tint']})`);
        // + the piles' own pool over it: their captions on short phones with a two-row hand.
        const layers = { '': null, 'glass panel on the ': L.glass, 'own meld group on the ': L.get('--glass-strong'), 'pile pool on the ': L.spot };
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

  // #518: a mark darker than the near-black felt was a step of ~3 and read as barely there.
  test(`occasion watermark (${theme}): every mark stays visible on the felt`, () => {
    for (const id of ARTS) {
      const { L, mark } = markLight(theme, id, DAY);
      const step = deltaE2000(L.felt, over(mark, L.felt));
      assert.ok(step >= 3.8, `${theme} ${id}: a step of ${step.toFixed(2)} (CIEDE2000) on the felt, at least 3.8`);
    }
  });
}

// --- The real client in jsdom (harness as in queen-turn-client.test.js) ---------------------
const SRC = ['i18n.js', 'client.js'].map((f) => fs.readFileSync(path.join(pub, f), 'utf8'));
const HTML = fs.readFileSync(path.join(pub, 'index.html'), 'utf8');

/** `occasion`: today's holiday from /statusz; `greeting`: the signed-in account's own greeting day (/api/me). */
function boot(occasion, { greeting = false } = {}) {
  const { window } = new JSDOM(HTML, { url: 'https://play.example/', runScripts: 'outside-only', pretendToBeVisual: true });
  const errors = [];
  window.matchMedia = (q) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
  window.navigator.vibrate = () => true;
  window.scrollTo = () => {};
  window.Element.prototype.scrollIntoView = function scrollIntoView() {};
  window.requestAnimationFrame = () => 0;
  const now = Date.now();
  const day = { from: now - 36e5, until: now + 36e5 };
  const statusz = {
    ...(occasion ? { occasions: { windows: [{ id: occasion, ...day }], refreshAt: now + 36e5 } } : {}),
    ...(greeting ? { accountsEnabled: true } : {}),
  };
  const me = { ok: true, username: 'Flo', greeting: day };
  window.fetch = (url) => Promise.resolve({ ok: true, json: () => Promise.resolve(url === '/statusz' ? statusz : url === '/api/me' ? me : {}), text: () => Promise.resolve('') });
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
  if (greeting) window.localStorage.setItem('pikdame_account_token', 'tok');
  window.sessionStorage.setItem('pikdame_splash_seen', '1');
  for (const src of SRC) window.eval(src);
  window.document.dispatchEvent(new window.Event('DOMContentLoaded', { bubbles: true }));
  const send = (msg) => ws._emit('message', { data: JSON.stringify(msg) });
  return { window, doc: window.document, errors, send };
}
const ready = () => new Promise((r) => setTimeout(r, 10));
const card = (id) => ({ id, suit: id[0], rank: id.slice(1, id.indexOf('-')), isJoker: false });
function state(melds, extra = {}) {
  return {
    phase: 'playing', roundNumber: 2, turnIndexInRound: 8, currentPlayerId: 'b1', turnPhase: 'meld', dealerId: 'b1',
    drawPileCount: 40, discardTop: card('D4-0'), discardPileCount: 1, discardCards: [card('D4-0')],
    tableMelds: melds.map(([ownerId, ids], i) => ({ id: `m${i}`, ownerId, type: 'set', slots: ids.map((id) => ({ real: card(id) })) })),
    log: [], houseRules: {}, lobbyReady: [], nextRoundReady: [], totals: { p1: 120, b1: 80 }, scoreHistory: [],
    players: [
      { id: 'p1', name: 'Flo', isBot: false, connected: true, handCount: 2, hand: [card('H2-0'), card('C9-0')] },
      { id: 'b1', name: 'Klaus', isBot: true, connected: true, handCount: 9, botDifficulty: 'medium' },
    ],
    ...extra,
  };
}
const mark = (c) => c.doc.getElementById('table').dataset.mark;
async function atTable(occasion, extra, opts) {
  const c = boot(occasion, opts);
  await ready();
  c.send({ type: 'joined', playerId: 'p1', playerToken: 't', sessionCode: 'MRK001' });
  c.send({ type: 'state', state: state([['b1', ['D8-0', 'D9-0', 'D10-0']]], extra) });
  return c;
}

test('table mark: the day\'s holiday, each with its own; none on a plain day', async (t) => {
  for (const id of HOLIDAY_IDS) {
    const c = await atTable(id);
    t.after(() => c.window.close());
    assert.strictEqual(mark(c), id, `${id}: the felt shows its mark`);
    assert.deepStrictEqual(c.errors, []);
  }
  const plain = await atTable(null);
  t.after(() => plain.window.close());
  assert.strictEqual(mark(plain), undefined, 'a plain day: no mark');
});

test('table mark: a birthday at the table wins over the holiday, and goes with the flag', async (t) => {
  const c = await atTable('christmas', { birthdayToday: true });
  t.after(() => c.window.close());
  assert.strictEqual(mark(c), 'birthday', 'the cake, not the tree: the day is personal');
  assert.strictEqual(c.doc.body.dataset.occasion, 'christmas', 'the start screen keeps the holiday');
  c.send({ type: 'state', state: state([['b1', ['D8-0', 'D9-0', 'D10-0']]], { birthdayToday: false }) });
  assert.strictEqual(mark(c), 'christmas', 'the flag gone (midnight, the birthday child left): the holiday again');
  const plain = await atTable(null, { birthdayToday: true });
  t.after(() => plain.window.close());
  assert.strictEqual(mark(plain), 'birthday', 'a birthday on a plain day');
  for (const odd of ['yes', 1, {}]) {
    plain.send({ type: 'state', state: state([], { birthdayToday: odd }) });
    assert.strictEqual(mark(plain), undefined, `only true counts, not ${JSON.stringify(odd)}`);
  }
  assert.deepStrictEqual([...c.errors, ...plain.errors], []);
});

test('table mark: my own greeting day stays on my start screen, the table decides its felt', async (t) => {
  const c = await atTable('halloween', {}, { greeting: true });
  t.after(() => c.window.close());
  for (let i = 0; i < 20 && c.doc.body.dataset.occasion !== 'birthday'; i++) await ready();
  assert.strictEqual(c.doc.body.dataset.occasion, 'birthday', 'the account\'s greeting on the start screen');
  c.send({ type: 'state', state: state([['b1', ['D8-0', 'D9-0', 'D10-0']]]) });
  assert.strictEqual(mark(c), 'halloween', 'no flag from the server (a solo game, a public table): the holiday');
  assert.deepStrictEqual(c.errors, []);
});

// --- The queen's hat ----------------------------------------------------------------------
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

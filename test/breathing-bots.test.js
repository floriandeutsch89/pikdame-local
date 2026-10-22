// Breathing bots: only the bot on turn breathes, in its level's rhythm, with its
// phase anchored to the turn start; humans keep the calm turn frame. Real markup
// and client in jsdom (who breathes, period, phase), the CSS as a contract.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const pub = path.join(__dirname, '..', 'public');
const css = fs.readFileSync(path.join(pub, 'style.css'), 'utf8');
const clientJs = fs.readFileSync(path.join(pub, 'client.js'), 'utf8');

function boot() {
  const html = fs.readFileSync(path.join(pub, 'index.html'), 'utf8');
  const dom = new JSDOM(html, { url: 'https://play.example/', runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;
  const errors = [];
  const clock = { now: 1000 };
  Object.defineProperty(window.performance, 'now', { value: () => clock.now, configurable: true });
  let hidden = false;
  Object.defineProperty(window.document, 'hidden', { get: () => hidden, configurable: true });
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
  window.navigator.vibrate = () => true;
  window.scrollTo = () => {};
  window.Element.prototype.scrollIntoView = () => {};
  let rafDepth = 0;
  window.requestAnimationFrame = (cb) => {
    if (rafDepth > 4) return 0;
    rafDepth += 1;
    try { cb(Date.now()); } finally { rafDepth -= 1; }
    return 0;
  };
  window.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve({ version: '0.0.0-test' }), text: () => Promise.resolve('') });
  let ws = null;
  window.WebSocket = class {
    constructor() { this._ls = {}; ws = this; this.readyState = 1; setTimeout(() => this._emit('open', {}), 0); }
    addEventListener(t, f) { (this._ls[t] = this._ls[t] || []).push(f); }
    removeEventListener(t, f) { this._ls[t] = (this._ls[t] || []).filter((x) => x !== f); }
    _emit(t, ev) {
      if (typeof this['on' + t] === 'function') this['on' + t](ev);
      for (const f of this._ls[t] || []) f(ev);
    }
    send() {}
    close() {}
  };
  window.WebSocket.OPEN = 1;
  window.WebSocket.CONNECTING = 0;
  window.onerror = (msg) => errors.push(String(msg));
  window.addEventListener('error', (e) => errors.push(String(e.message || e.error)));
  for (const src of ['i18n.js', 'client.js']) window.eval(fs.readFileSync(path.join(pub, src), 'utf8'));
  window.document.dispatchEvent(new window.Event('DOMContentLoaded', { bubbles: true }));
  const setHidden = (h) => { hidden = h; window.document.dispatchEvent(new window.Event('visibilitychange')); };
  return { window, errors, clock, setHidden, ws: () => ws };
}

async function setup(t) {
  const ctx = boot();
  t.after(() => ctx.window.close());
  await new Promise((r) => setTimeout(r, 10));
  const sock = ctx.ws();
  sock._emit('message', { data: JSON.stringify({ type: 'joined', playerId: 'p1', playerToken: 't', sessionCode: 'ABCD' }) });
  const feed = (s) => sock._emit('message', { data: JSON.stringify({ type: 'state', state: s }) });
  const click = (node) => node.dispatchEvent(new ctx.window.MouseEvent('click', { bubbles: true }));
  return { ...ctx, feed, click, doc: ctx.window.document };
}

const hand = [{ id: 'h1', suit: 'H', rank: '7' }, { id: 'h2', suit: 'S', rank: '2' }];
function table(extra = {}, seat = {}) {
  const players = [
    { id: 'p1', name: 'Flo', isBot: false, connected: true, handCount: hand.length, hand },
    { id: 'b1', name: 'Gisela', isBot: true, connected: true, handCount: 5, botDifficulty: 'easy' },
    { id: 'b2', name: 'Horst', isBot: true, connected: true, handCount: 6, botDifficulty: 'medium' },
    { id: 'p2', name: 'Oma Gerda', isBot: false, connected: true, handCount: 9 },
  ].map((p) => ({ ...p, ...(seat[p.id] || {}) }));
  return {
    phase: 'playing', roundNumber: 2, turnIndexInRound: 5, currentPlayerId: 'b2', turnPhase: 'draw', dealerId: 'b1',
    paused: false, turnDeadline: null, discardTop: { id: 'dt', suit: 'H', rank: 'Q' }, drawPileCount: 40,
    discardPileCount: 4, log: [], tableMelds: [], lobbyReady: [], nextRoundReady: [], houseRules: {},
    totals: { p1: 120, b1: 640, b2: 30, p2: 0 }, players, ...extra,
  };
}
const chip = (doc, id) => doc.querySelector(`#opponents .opponent[data-player-id="${id}"]`);
const breathing = (doc) => [...doc.querySelectorAll('.opAvatar.breathing')];
const prop = (node, name) => node.style.getPropertyValue(name);

/** Every rule (top level or in a block) whose selector list matches `re`. */
const bare = css.replace(/\/\*[\s\S]*?\*\//g, '');
function rules(re) {
  const out = [];
  const rx = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = rx.exec(bare))) if (re.test(m[1].trim())) out.push({ sel: m[1].trim(), body: m[2] });
  return out;
}
function keyframes(name) {
  const at = css.indexOf(`@keyframes ${name} {`);
  assert.ok(at >= 0, `@keyframes ${name} exists`);
  let depth = 0;
  for (let i = css.indexOf('{', at); i < css.length; i++) {
    if (css[i] === '{') depth += 1;
    if (css[i] === '}' && --depth === 0) return css.slice(at, i + 1);
  }
  throw new Error(`unclosed @keyframes ${name}`);
}
function mediaBlock(head) {
  const out = [];
  let at = css.indexOf(head);
  while (at >= 0) {
    let depth = 0;
    for (let i = css.indexOf('{', at); i < css.length; i++) {
      if (css[i] === '{') depth += 1;
      if (css[i] === '}' && --depth === 0) { out.push(css.slice(at, i + 1)); break; }
    }
    at = css.indexOf(head, at + 1);
  }
  return out.join('\n');
}

test('only the bot on turn breathes: its chip face and the header face, in step', async (t) => {
  const { doc, feed, errors } = await setup(t);
  feed(table());
  const faces = breathing(doc);
  assert.equal(faces.length, 2, 'the chip and the header');
  const inChip = chip(doc, 'b2').querySelector('.opAvatar.breathing');
  const inHead = doc.querySelector('#turnStatus .opAvatar.breathing');
  assert.ok(inChip && inHead, 'both faces of the bot on turn');
  for (const f of [inChip, inHead]) {
    assert.equal(f.dataset.breath, 'medium');
    assert.ok(f.querySelector(':scope > .opFace'), 'the face is its own element');
    assert.match(f.querySelector('.opFace').getAttribute('style'), /background:hsl\(/, 'the face carries the colour');
  }
  assert.equal(prop(inChip, '--br-delay'), prop(inHead, '--br-delay'), 'one breath, one phase');
  assert.equal(prop(inChip, '--br-dur'), prop(inHead, '--br-dur'));
  assert.equal(chip(doc, 'b1').querySelector('.breathing'), null, 'a waiting bot is still');
  assert.ok(chip(doc, 'b2').classList.contains('active'), 'the calm frame stays');
  assert.deepEqual(errors, []);
});

test('humans never breathe: a human on turn, a seat a bot covers, my own turn', async (t) => {
  const { doc, feed } = await setup(t);
  feed(table({ currentPlayerId: 'p2' }));
  assert.equal(breathing(doc).length, 0, 'a human on turn');
  assert.ok(chip(doc, 'p2').classList.contains('active'), 'keeps only the calm turn frame');
  assert.equal(doc.querySelectorAll('.opFace').length, 0, 'no ring either');
  // Disconnected: a bot plays the seat, but it is still a person's seat.
  feed(table({ currentPlayerId: 'p2' }, { p2: { connected: false, controlledByBot: true } }));
  assert.equal(breathing(doc).length, 0, 'a seat a bot covers stays human');
  feed(table({ currentPlayerId: 'p1' }));
  assert.equal(breathing(doc).length, 0, 'my own turn');
});

test('nothing breathes when no bot thinks: paused, cutting, round end, game over; not in the challenge', async (t) => {
  const { doc, feed } = await setup(t);
  feed(table({ paused: true }));
  assert.equal(breathing(doc).length, 0, 'paused');
  feed(table({ phase: 'cutting', cutterId: 'b2' }));
  assert.equal(breathing(doc).length, 0, 'cutting');
  feed(table({ phase: 'roundEnd', lastRoundWinnerId: 'b2' }));
  assert.equal(breathing(doc).length, 0, 'round end');
  feed(table({ phase: 'gameOver', lastRoundWinnerId: 'b2' }));
  assert.equal(breathing(doc).length, 0, 'game over');
  // The daily challenge never shows the bots' level, and the ring is level-styled.
  feed(table({ challengeDate: '2026-10-22' }));
  assert.equal(breathing(doc).length, 0, 'daily challenge');
  assert.ok(chip(doc, 'b2').classList.contains('active'), 'the calm frame says whose turn it is');
  feed(table());
  assert.equal(breathing(doc).length, 2, 'and back in play it breathes again');
});

test('every level has its rhythm and ring; an unknown level breathes as Zen', async (t) => {
  const { doc, feed } = await setup(t);
  const base = { easy: 2300, medium: 1200, hard: 2600, zen: 5000 };
  let turn = 10;
  for (const [level, ms] of Object.entries(base)) {
    feed(table({ turnIndexInRound: turn++ }, { b2: { botDifficulty: level } }));
    const face = chip(doc, 'b2').querySelector('.opAvatar.breathing');
    assert.equal(face.dataset.breath, level);
    assert.equal(prop(face, '--br-dur'), `${ms}ms`, `${level}: ${ms} ms at normal pace`);
  }
  feed(table({ turnIndexInRound: turn++ }, { b2: { botDifficulty: undefined } }));
  assert.equal(chip(doc, 'b2').querySelector('.opAvatar.breathing').dataset.breath, 'zen');

  // CSS: each level names its own keyframes and ring.
  const names = { easy: 'breathEasy', medium: 'breathMedium', hard: 'breathHard', zen: 'breathZen' };
  for (const [level, name] of Object.entries(names)) {
    const r = rules(new RegExp(`^\\.opAvatar\\[data-breath="${level}"\\] > \\.opFace$`));
    assert.ok(r.some((x) => x.body.includes(`animation-name: ${name}`)), `${level} breathes ${name}`);
    keyframes(name);
  }
  const ring = (level) => rules(new RegExp(`^\\.opAvatar\\[data-breath="${level}"\\] > \\.opFace::after$`)).map((x) => x.body).join(' ');
  const baseRing = rules(/^\.opFace::after$/).map((x) => x.body).join(' ');
  assert.match(baseRing, /border:[^;]*solid var\(--accent\)/, 'Mittel: the solid ring');
  assert.match(ring('easy'), /dotted/, 'Leicht: dotted');
  assert.match(ring('hard'), /double/, 'Schwer: double');
  assert.match(ring('hard'), /animation: breathHardRing/, 'Schwer: the ring draws in');
  assert.match(keyframes('breathHardRing'), /scale\(\.9\)/);
  assert.match(ring('zen'), /mask: conic-gradient/, 'Zen: an open circle (ensō)');
  assert.match(keyframes('breathZenRing'), /opacity: \.55[\s\S]*opacity: 1/);
});

test('the period follows the bot pace: fast halves it, slow doubles it', async (t) => {
  const { doc, feed } = await setup(t);
  let turn = 20;
  for (const [pace, factor] of [['fast', 0.5], ['normal', 1], ['slow', 2], [undefined, 1], ['constructor', 1]]) {
    for (const [level, ms] of [['medium', 1200], ['zen', 5000]]) {
      feed(table({ turnIndexInRound: turn++, houseRules: pace ? { botPace: pace } : {} }, { b2: { botDifficulty: level } }));
      const face = chip(doc, 'b2').querySelector('.opAvatar.breathing');
      assert.equal(prop(face, '--br-dur'), `${ms * factor}ms`, `${level} at pace ${pace}`);
    }
  }
  // The client's factors are the server's (a medium breath then spans about one bot turn).
  const server = fs.readFileSync(path.join(__dirname, '..', 'game', 'GameManager.js'), 'utf8')
    .match(/const BOT_PACE_FACTOR = \{([^}]*)\}/)[1];
  const client = clientJs.match(/const BREATH_PACE = new Map\(\[([^\n]*)\]\);/)[1];
  const parse = (s) => Object.fromEntries([...s.matchAll(/'?(\w+)'?\s*[:,]\s*([\d.]+)/g)].map((m) => [m[1], Number(m[2])]));
  assert.deepEqual(parse(client), parse(server));
});

test('the phase is anchored to the turn start: a re-render breathes on', async (t) => {
  const { doc, feed, click, clock } = await setup(t);
  clock.now = 1000;
  feed(table());
  const first = chip(doc, 'b2').querySelector('.opAvatar.breathing');
  assert.equal(prop(first, '--br-delay'), '0ms', 'a new turn starts at the beginning');
  clock.now = 1600;
  feed(table({}, { b2: { handCount: 7 } })); // the same turn, a fresh state
  const second = chip(doc, 'b2').querySelector('.opAvatar.breathing');
  assert.notEqual(second, first, 'renderTable rebuilt the chip');
  assert.equal(prop(second, '--br-delay'), '-600ms', 'the new face picks up 600 ms into the breath');
  assert.equal(prop(doc.querySelector('#turnStatus .opAvatar.breathing'), '--br-delay'), '-600ms');
  clock.now = 1900;
  click(chip(doc, 'b1')); // meld filter: a re-render without a new state
  assert.equal(prop(chip(doc, 'b2').querySelector('.opAvatar.breathing'), '--br-delay'), '-900ms');
  clock.now = 2500;
  feed(table({ turnIndexInRound: 6, currentPlayerId: 'b2' }));
  assert.equal(prop(chip(doc, 'b2').querySelector('.opAvatar.breathing'), '--br-delay'), '0ms', 'the next turn starts afresh');
});

test('Leicht enters its loop elsewhere every turn, the same for every viewer', async (t) => {
  const { doc, feed, clock } = await setup(t);
  clock.now = 5000;
  const delays = [];
  for (const turn of [1, 2, 3, 4]) {
    feed(table({ currentPlayerId: 'b1', turnIndexInRound: turn }));
    const face = chip(doc, 'b1').querySelector('.opAvatar.breathing');
    assert.equal(face.dataset.breath, 'easy');
    assert.equal(prop(face, '--br-delay'), `${-((turn * 7919) % 2300)}ms`, 'from the turn number alone');
    delays.push(prop(face, '--br-delay'));
  }
  assert.equal(new Set(delays).size, delays.length, 'no two turns start alike');
  feed(table({ currentPlayerId: 'b1', turnIndexInRound: 9, houseRules: { botPace: 'slow' } }));
  assert.equal(prop(chip(doc, 'b1').querySelector('.opAvatar.breathing'), '--br-delay'), `${-((9 * 7919) % 2300) * 2}ms`, 'the offset scales with the pace');
});

test('a hidden tab stops the breath; coming back anchors it to its turn again', async (t) => {
  const { doc, feed, clock, setHidden } = await setup(t);
  clock.now = 1000;
  feed(table());
  setHidden(true);
  assert.ok(doc.documentElement.classList.contains('appHidden'));
  clock.now = 4000;
  setHidden(false);
  assert.ok(!doc.documentElement.classList.contains('appHidden'));
  for (const f of breathing(doc)) assert.equal(prop(f, '--br-delay'), '-3000ms', 'restarts where the turn is now');
});

test('reduced motion keeps the ring, still; hidden tabs, sheets and the emote picker stop it', () => {
  const reduced = mediaBlock('@media (prefers-reduced-motion: reduce)');
  assert.match(reduced, /\.opFace, \.opFace::after \{ animation: none !important; will-change: auto; \}/);
  assert.doesNotMatch(reduced, /\.opFace[^{]*\{[^}]*(display: none|content: none|border: 0|border: none)/, 'the ring stays');
  assert.ok(rules(/^\.appHidden \.opFace, \.appHidden \.opFace::after$/).some((r) => /animation: none !important/.test(r.body)));
  // Their backdrop blur would be redone every frame over a breathing face.
  const covered = rules(/^#table:has\(~ \.overlay:not\(\.hidden\), ~ #emoteBar:not\(\.hidden\)\) \.opFace,/);
  assert.ok(covered.some((r) => /animation: none !important/.test(r.body) && /will-change: auto/.test(r.body)));
  // The :has() relies on both being later siblings of #table.
  const doc = new JSDOM(fs.readFileSync(path.join(pub, 'index.html'), 'utf8')).window.document;
  const tableEl = doc.getElementById('table');
  const later = (el) => el && el.parentElement === tableEl.parentElement
    && (tableEl.compareDocumentPosition(el) & 4 /* DOCUMENT_POSITION_FOLLOWING */) !== 0;
  assert.ok(later(doc.getElementById('emoteBar')), '#emoteBar follows #table as a sibling');
  const overlays = [...doc.querySelectorAll('.overlay')];
  assert.ok(overlays.length > 10 && overlays.every(later), 'every sheet follows #table as a sibling');
});

test('battery: only transform and opacity animate, will-change only on the running face', () => {
  for (const name of ['breathEasy', 'breathMedium', 'breathHard', 'breathHardRing', 'breathZen', 'breathZenRing']) {
    const props = [...keyframes(name).matchAll(/([a-z-]+)\s*:/g)].map((m) => m[1]);
    const animated = new Set(props.filter((p) => p !== 'animation-timing-function'));
    for (const p of animated) assert.ok(p === 'transform' || p === 'opacity', `${name} animates ${p}`);
  }
  const willChange = rules(/./).filter((r) => /will-change\s*:\s*(?!auto)/.test(r.body)).map((r) => r.sel);
  assert.ok(willChange.includes('.opFace'), 'the running face');
  assert.ok(!willChange.some((s) => /\.opAvatar(?![\w-])(?!\.breathing)/.test(s) && !/\.opFace/.test(s)), 'never on the avatar itself');
  // No timers: the breath is computed once per render, CSS runs it.
  const fn = clientJs.slice(clientJs.indexOf('function botBreath('), clientJs.indexOf('function avatarFor('));
  assert.doesNotMatch(fn, /setTimeout|setInterval|requestAnimationFrame/);
});

test('the old box-shadow pulse is gone; the calm turn frame stays', () => {
  assert.doesNotMatch(css, /activeChipPulse/);
  for (const r of rules(/\.opponent\.active\b/)) {
    assert.doesNotMatch(r.body, /animation/, `${r.sel} must not animate`);
  }
  const frame = rules(/^\.opponent\.active$/).map((r) => r.body).join(' ');
  assert.match(frame, /border-color: var\(--accent\)/);
  assert.match(frame, /background: var\(--accent-soft\)/);
});

test('a long name ellipsizes on its own: the face and the dealer star stay whole', async (t) => {
  const { doc, feed } = await setup(t);
  feed(table({ dealerId: 'b2' }, { b2: { name: 'Horst-Bärbelhausen von Langname' } }));
  const row = chip(doc, 'b2').querySelector('.opName');
  assert.equal(row.querySelector('.opNameText').textContent, 'Horst-Bärbelhausen von Langname');
  assert.ok(row.querySelector(':scope > .opAvatar.breathing'), 'the face sits beside the name, not in its clip');
  assert.ok(row.querySelector(':scope > .opDealer'), 'the star too');
  const clip = rules(/^#opponents \.opNameText$/).map((r) => r.body).join(' ');
  assert.match(clip, /overflow: hidden/);
  assert.match(clip, /text-overflow: ellipsis/);
  assert.ok(!rules(/^#opponents \.opName$/).some((r) => /overflow/.test(r.body)), 'the row itself never clips');
});

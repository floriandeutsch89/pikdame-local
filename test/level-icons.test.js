// v2.68.0: bot strength as a spade rating (three slots, filled = strength,
// Zen = three with a crown) instead of signal bars, in every place that shows
// a level. Sprite contract + real markup and client in jsdom.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const pub = path.join(__dirname, '..', 'public');
const html = fs.readFileSync(path.join(pub, 'index.html'), 'utf8');
const client = fs.readFileSync(path.join(pub, 'client.js'), 'utf8');
const css = fs.readFileSync(path.join(pub, 'style.css'), 'utf8');
const SYMBOL = { easy: 'i-lvl-1', medium: 'i-lvl-2', hard: 'i-lvl-3', zen: 'i-lvl-zen' };

function symbol(id) {
  const m = html.match(new RegExp(`<symbol id="${id}"[^>]*>([\\s\\S]*?)</symbol>`));
  assert.ok(m, `sprite symbol ${id} missing`);
  return m[1];
}
const pips = (body) => [...body.matchAll(/<path transform="translate\([^)]*\) scale\(\.8\)" ([^>]*?) d="([^"]+)"\/>/g)]
  .map((m) => ({ filled: /fill="currentColor"/.test(m[1]), outline: /fill="none" stroke="currentColor"/.test(m[1]), d: m[2] }));

test('sprite: three spade slots per level, filled = strength, Zen = three filled plus a crown', () => {
  const all = [];
  for (const [n, id] of [[1, 'i-lvl-1'], [2, 'i-lvl-2'], [3, 'i-lvl-3']]) {
    const p = pips(symbol(id));
    assert.equal(p.length, 3, `${id}: three slots`);
    assert.equal(p.filter((x) => x.filled).length, n, `${id}: ${n} filled`);
    assert.equal(p.filter((x) => x.outline).length, 3 - n, `${id}: the rest as outlines (shape, not opacity)`);
    all.push(...p);
  }
  const zen = symbol('i-lvl-zen');
  const zp = pips(zen);
  assert.equal(zp.filter((x) => x.filled).length, 3, 'Zen: three filled spades');
  assert.match(zen, /<path fill="currentColor" stroke="none" d="M15\.4-5\.8/, 'Zen: the crown above the middle spade');
  all.push(...zp);
  assert.equal(new Set(all.map((x) => x.d)).size, 1, 'every slot draws the same spade');
  for (const id of Object.values(SYMBOL)) assert.doesNotMatch(symbol(id), /opacity/, `${id}: shape carries the level, not opacity`);
});

test('no signal bars left: every level place uses the sprite', () => {
  for (const [name, src] of [['index.html', html], ['client.js', client], ['style.css', css]]) {
    assert.doesNotMatch(src, /diffBars|barsOnly|diffBarsHtml/, `${name} still draws bars`);
  }
  for (const [level, id] of Object.entries(SYMBOL)) {
    const btn = html.match(new RegExp(`<button type="button" class="segBtn" data-value="${level}">(.*?)</button>`));
    assert.ok(btn, `house rules segment ${level}`);
    assert.match(btn[1], new RegExp(`<use href="#${id}"/>`), `house rules ${level} -> ${id}`);
    assert.match(client, new RegExp(`${level}: \\{ icon: '${id}'`), `BOT_DIFF.${level} -> ${id}`);
  }
});

function boot() {
  const dom = new JSDOM(html, { url: 'https://play.example/', runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
  window.navigator.vibrate = () => true;
  window.scrollTo = () => {};
  window.Element.prototype.scrollIntoView = () => {};
  window.requestAnimationFrame = () => 0;
  window.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve({}), text: () => Promise.resolve('') });
  let ws = null;
  window.WebSocket = class {
    constructor() { this._ls = {}; ws = this; this.readyState = 1; setTimeout(() => this._emit('open', {}), 0); }
    addEventListener(t, f) { (this._ls[t] = this._ls[t] || []).push(f); }
    removeEventListener() {}
    _emit(t, ev) { if (typeof this['on' + t] === 'function') this['on' + t](ev); for (const f of this._ls[t] || []) f(ev); }
    send() {}
    close() {}
  };
  window.WebSocket.OPEN = 1;
  for (const src of ['i18n.js', 'client.js']) window.eval(fs.readFileSync(path.join(pub, src), 'utf8'));
  window.document.dispatchEvent(new window.Event('DOMContentLoaded', { bubbles: true }));
  return { window, ws: () => ws };
}

async function setup(t) {
  const ctx = boot();
  t.after(() => ctx.window.close());
  await new Promise((r) => setTimeout(r, 10));
  const sock = ctx.ws();
  sock._emit('message', { data: JSON.stringify({ type: 'joined', playerId: 'p1', playerToken: 't', sessionCode: 'ABCD' }) });
  const feed = (s) => sock._emit('message', { data: JSON.stringify({ type: 'state', state: s }) });
  const click = (node) => node.dispatchEvent(new ctx.window.MouseEvent('click', { bubbles: true }));
  return { feed, click, doc: ctx.window.document };
}

const bots = (levels) => levels.map((lv, i) => ({ id: `b${i + 1}`, name: `Bot${i + 1}`, isBot: true, connected: true, handCount: 5, botDifficulty: lv }));
const used = (root) => [...root.querySelectorAll('.lvlIcon use')].map((u) => u.getAttribute('href').slice(1));

test('seat chips and the strength picker show the level symbol next to the name', async (t) => {
  const { doc, feed, click } = await setup(t);
  feed({
    phase: 'lobby', isHost: true, maxSeats: 4, lobbyReady: [], log: [], tableMelds: [], nextRoundReady: [], totals: {},
    botLevel: 'mixed', houseRules: {},
    players: [{ id: 'p1', name: 'Flo', isBot: false, connected: true, handCount: 0 }, ...bots(['easy', 'hard', 'zen'])],
  });
  const chips = [...doc.querySelectorAll('#seatingList .seatDiff')];
  assert.deepEqual(chips.map((c) => used(c)[0]), ['i-lvl-1', 'i-lvl-3', 'i-lvl-zen']);
  assert.deepEqual(chips.map((c) => c.textContent), ['Leicht', 'Schwer', 'Zen'], 'the word stays');
  click(chips[2]);
  const options = doc.getElementById('botDiffOptions');
  assert.deepEqual(used(options), ['i-lvl-1', 'i-lvl-2', 'i-lvl-3', 'i-lvl-zen']);
  assert.ok(options.querySelectorAll('.lvlIcon')[3].classList.contains('lvlZen'), 'Zen gets the taller crown box');
  assert.equal(options.querySelectorAll('.lvlIcon.lvlZen').length, 1);
});

test('opponent badges: the symbol per bot and never the word; the name stays in title and aria-label', async (t) => {
  const { doc, feed } = await setup(t);
  const base = {
    phase: 'playing', roundNumber: 1, currentPlayerId: 'p1', turnPhase: 'draw', dealerId: 'b1', isHost: true,
    turnDeadline: null, discardTop: { id: 'dt', suit: 'H', rank: 'Q' }, drawPileCount: 40, discardPileCount: 4,
    log: [], tableMelds: [], lobbyReady: [], nextRoundReady: [], houseRules: {}, totals: {},
  };
  const me = { id: 'p1', name: 'Flo', isBot: false, connected: true, handCount: 1, hand: [{ id: 'h1', suit: 'H', rank: '7' }] };
  feed({ ...base, players: [me, ...bots(['easy', 'hard', 'zen'])] });
  const badges = () => [...doc.querySelectorAll('#opponents .botDiffBadge')];
  assert.deepEqual(badges().map((b) => used(b)[0]), ['i-lvl-1', 'i-lvl-3', 'i-lvl-zen']);
  assert.ok(badges().every((b) => b.textContent === ''), 'mixed levels: the symbol alone in the game');
  assert.deepEqual(badges().map((b) => b.getAttribute('aria-label')), ['Schwierigkeit ändern (Leicht)', 'Schwierigkeit ändern (Schwer)', 'Schwierigkeit ändern (Zen)']);
  assert.ok(badges().every((b) => b.title === b.getAttribute('aria-label')), 'the tooltip names the level');
  feed({ ...base, players: [me, ...bots(['medium', 'medium', 'medium'])] });
  assert.ok(badges().every((b) => b.textContent === '' && used(b)[0] === 'i-lvl-2'));
  assert.ok(badges().every((b) => /Mittel/.test(b.getAttribute('aria-label'))), 'the icon-only badge keeps its name');
});

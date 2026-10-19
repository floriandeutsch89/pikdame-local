// Table reactions: one list (game/Emotes.js) with levels and iPhone-keyboard
// sections; the server takes ❤ with or without the variation selector; the
// picker shows the most used first and the rest behind a toggle.
const test = require('node:test');
const { freePort } = require('./helpers/free-port');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const WebSocket = require('ws');
const { JSDOM } = require('jsdom');
const { EMOTE_DEFS, EMOTE_IDS, EMOTE_CATEGORIES, KEYBOARD_ORDER, normalizeEmote, isAllowedEmote, emoteLevel } = require('../game/Emotes');
const { xpForLevel } = require('../game/Progression');

const ROOT = path.join(__dirname, '..');
const pub = path.join(ROOT, 'public');
let PORT = 0;
const NEW = ['🃏', '😅', '🤞', '👀', '🙄', '😬', '🙃', '🤝', '😇', '☕', '🐢', '🍻', '❤️'];

function xpAt(level) {
  let xp = 0;
  for (let l = 1; l < level; l++) xp += xpForLevel(l);
  return xp;
}

test('list: the new emotes unlock between level 20 and 40, ids unique', () => {
  assert.equal(new Set(EMOTE_IDS).size, EMOTE_IDS.length);
  for (const id of NEW) {
    assert.ok(EMOTE_IDS.includes(id), id);
    assert.ok(emoteLevel(id) >= 20 && emoteLevel(id) <= 40, `${id} at ${emoteLevel(id)}`);
  }
  const levels = EMOTE_DEFS.map((e) => e.level);
  assert.deepEqual(levels, [...levels].sort((a, b) => a - b), 'ordered by level');
});

test('keyboard order: every emote once, sections in iPhone order', () => {
  assert.deepEqual([...KEYBOARD_ORDER].sort(), [...EMOTE_IDS].sort(), 'a permutation of the list');
  const cat = Object.fromEntries(EMOTE_DEFS.map((e) => [e.id, e.cat]));
  const idx = KEYBOARD_ORDER.map((id) => EMOTE_CATEGORIES.indexOf(cat[id]));
  assert.ok(idx.every((i) => i >= 0), 'every emote has a known section');
  assert.deepEqual(idx, [...idx].sort((a, b) => a - b), 'sections do not interleave');
  assert.ok(KEYBOARD_ORDER.indexOf('😂') < KEYBOARD_ORDER.indexOf('👍'), 'faces before hands');
  assert.equal(KEYBOARD_ORDER[KEYBOARD_ORDER.length - 1], '❤️', 'hearts are symbols, last');

  const client = fs.readFileSync(path.join(pub, 'client.js'), 'utf8');
  const block = client.match(/const EMOTE_KEYBOARD = \[([\s\S]*?)\n {2}\];/);
  assert.ok(block, 'client mirror exists');
  const mirrored = [...block[1].matchAll(/\['([a-z]+)', \[([^\]]*)\]\]/g)]
    .map((m) => [m[1], [...m[2].matchAll(/'([^']+)'/g)].map((x) => x[1])]);
  const grouped = EMOTE_CATEGORIES.map((c) => [c, KEYBOARD_ORDER.filter((id) => cat[id] === c)]).filter(([, l]) => l.length);
  assert.deepEqual(mirrored, grouped, 'client sections = game/Emotes.js');
});

test('normalize: the heart with or without U+FE0F, junk refused', () => {
  assert.equal(normalizeEmote('❤️'), '❤️');
  assert.equal(normalizeEmote('❤'), '❤️', 'bare heart');
  assert.equal(normalizeEmote('☕️'), '☕', 'coffee with a selector');
  assert.equal(normalizeEmote('👍'), '👍');
  assert.equal(emoteLevel('❤'), 40, 'the level follows the listed id');
  for (const bad of ['x', '', null, undefined, 42, {}, ['👍'], '👍👍', '️', 'a'.repeat(40)]) {
    assert.equal(normalizeEmote(bad), null, JSON.stringify(bad));
    assert.equal(isAllowedEmote(bad), false);
  }
});

test('server: a bare heart reaches the table as the listed ❤️', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pikdame-emote-'));
  PORT = await freePort();
  const server = spawn('node', ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), PIKDAME_PUBLIC_MODE: '1', PIKDAME_DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  server.stdout.on('data', (d) => { out += d; });
  server.stderr.on('data', (d) => { out += d; });
  const sockets = [];
  t.after(async () => {
    for (const s of sockets) s.terminate();
    const gone = server.exitCode !== null ? null : new Promise((r) => server.once('exit', r));
    server.kill();
    await gone;
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const http = require('node:http');
  for (let up = false, i = 0; !up; i++) {
    if (i > 150) throw new Error(`server did not come up:\n${out}`);
    up = await new Promise((resolve) => {
      const req = http.get({ host: '127.0.0.1', port: PORT, path: '/healthz', timeout: 500 }, (res) => { res.resume(); resolve(true); });
      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
    });
    if (!up) await new Promise((r) => setTimeout(r, 100));
  }
  const ws = await new Promise((resolve, reject) => {
    const s = new WebSocket(`ws://localhost:${PORT}`);
    sockets.push(s);
    s.inbox = [];
    s.on('message', (raw) => s.inbox.push(JSON.parse(raw)));
    s.once('open', () => resolve(s));
    s.once('error', reject);
  });
  const take = (pred, what) => new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      const i = ws.inbox.findIndex(pred);
      if (i !== -1) return resolve(ws.inbox.splice(i, 1)[0]);
      if (Date.now() - started > 4000) return reject(new Error(`no ${what}; got ${JSON.stringify(ws.inbox.map((m) => m.error || m.type))}`));
      setTimeout(tick, 20);
    };
    tick();
  });
  ws.send(JSON.stringify({ type: 'createSession', name: 'Flo' }));
  await take((m) => m.type === 'joined', 'joined');
  ws.send(JSON.stringify({ type: 'emote', emoji: 'nope' }));
  ws.send(JSON.stringify({ type: 'emote', emoji: '❤' }));
  const got = await take((m) => m.type === 'emote', 'emote');
  assert.equal(got.emoji, '❤️', 'the junk one was dropped, the heart canonicalised');
});

// --- Client (jsdom) -----------------------------------------------------------

function boot(storage = {}) {
  const html = fs.readFileSync(path.join(pub, 'index.html'), 'utf8');
  const { window } = new JSDOM(html, { url: 'https://play.example/', runScripts: 'outside-only', pretendToBeVisual: true });
  const errors = [];
  const sent = [];
  window.matchMedia = (q) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
  window.navigator.vibrate = () => true;
  window.scrollTo = () => {};
  window.Element.prototype.scrollIntoView = function scrollIntoView() {};
  window.requestAnimationFrame = () => 0;
  window.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve({ version: '0.0.0-test' }), text: () => Promise.resolve('') });
  let ws = null;
  window.WebSocket = class {
    constructor() { this._ls = {}; ws = this; this.readyState = 1; setTimeout(() => this._emit('open', {}), 0); }
    addEventListener(type, f) { (this._ls[type] = this._ls[type] || []).push(f); }
    removeEventListener(type, f) { this._ls[type] = (this._ls[type] || []).filter((x) => x !== f); }
    _emit(type, ev) {
      if (typeof this['on' + type] === 'function') this['on' + type](ev);
      for (const f of this._ls[type] || []) f(ev);
    }
    send(data) { try { sent.push(JSON.parse(data)); } catch (e) { /* not JSON */ } }
    close() {}
  };
  window.WebSocket.OPEN = 1;
  window.WebSocket.CONNECTING = 0;
  window.addEventListener('error', (e) => errors.push(String(e.message || e.error)));
  window.sessionStorage.setItem('pikdame_splash_seen', '1');
  window.localStorage.setItem('pikdame_player_name', 'Flo');
  for (const [k, v] of Object.entries(storage)) window.localStorage.setItem(k, v);
  for (const src of ['i18n.js', 'client.js']) window.eval(fs.readFileSync(path.join(pub, src), 'utf8'));
  const emit = (msg) => ws._emit('message', { data: JSON.stringify(msg) });
  const doc = window.document;
  const bar = doc.getElementById('emoteBar');
  const open = () => { if (bar.classList.contains('hidden')) doc.getElementById('emoteBtn').click(); };
  const ids = (sel) => [...bar.querySelectorAll(sel)].map((b) => b.dataset.emote);
  const top = () => ids('.emoteChoice[data-emote]:not(.emoteRest):not(.emoteSpecial)');
  const rest = () => ids('.emoteChoice.emoteRest');
  const specials = () => bar.querySelectorAll('.emoteSpecial').length;
  return { window, doc, bar, errors, sent, emit, open, top, rest, specials };
}

async function atLevel(level, storage) {
  const app = boot(storage);
  await new Promise((r) => setTimeout(r, 10));
  app.emit({ type: 'profiles', players: [{ name: 'Flo', xp: xpAt(level), gamesPlayed: 3 }] });
  await new Promise((r) => setTimeout(r, 0));
  return app;
}

test('picker: before any use the default order, the rest in keyboard sections, collapsed', async () => {
  const app = await atLevel(40);
  app.open();
  const slots = 8 - app.specials();
  assert.deepEqual(app.top(), EMOTE_IDS.slice(0, slots));
  assert.deepEqual(app.rest(), KEYBOARD_ORDER.filter((id) => !app.top().includes(id)), 'rest in iPhone order');
  const toggle = app.bar.querySelector('.emoteMoreBtn');
  assert.ok(toggle, 'toggle exists');
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  assert.equal(toggle.getAttribute('aria-label'), 'Mehr Reaktionen');
  assert.ok(!app.bar.classList.contains('emoteExpanded'), 'collapsed by default');
  const kids = [...app.bar.children];
  assert.ok(kids.indexOf(toggle) < kids.indexOf(app.bar.querySelector('.emoteRest')), 'toggle closes the first row');
  assert.ok(app.bar.querySelectorAll('.emoteSep').length >= 1, 'thin separators between sections');
  assert.deepEqual(app.errors, []);
  app.window.close();
});

test('picker: the most used come first; a locked one never does', async () => {
  const counts = JSON.stringify({ '🙄': 5, '❤️': 3, '😂': 1 });
  const app = await atLevel(40, { pikdame_emote_counts: counts });
  app.open();
  assert.deepEqual(app.top().slice(0, 3), ['🙄', '❤️', '😂'], 'by count');
  assert.deepEqual(app.top().slice(3), EMOTE_IDS.filter((id) => !['🙄', '❤️', '😂'].includes(id)).slice(0, 8 - app.specials() - 3), 'ties in default order');
  app.window.close();

  const low = await atLevel(1, { pikdame_emote_counts: counts });
  low.open();
  assert.ok(!low.top().includes('🙄') && !low.top().includes('❤️'), 'locked emotes stay out of the first row');
  const heart = low.bar.querySelector('.emoteChoice[data-emote="❤️"]');
  assert.ok(heart.classList.contains('emoteRest') && heart.classList.contains('locked'), 'shown dimmed in its section');
  low.window.close();
});

test('picker: a tap counts on this device; the toggle is remembered', async () => {
  const app = await atLevel(40);
  app.open();
  app.bar.querySelector('.emoteChoice[data-emote="⏳"]').click();
  assert.deepEqual(app.sent.filter((m) => m.type === 'emote').map((m) => m.emoji), ['⏳']);
  assert.deepEqual(JSON.parse(app.window.localStorage.getItem('pikdame_emote_counts')), { '⏳': 1 });
  app.open();
  assert.equal(app.top()[0], '⏳', 'the used one moves to the front');
  app.bar.querySelector('.emoteMoreBtn').click();
  assert.ok(app.bar.classList.contains('emoteExpanded'));
  assert.equal(app.bar.querySelector('.emoteMoreBtn').getAttribute('aria-label'), 'Weniger Reaktionen');
  assert.equal(app.window.localStorage.getItem('pikdame_emote_more'), '1');
  assert.ok(!app.bar.classList.contains('hidden'), 'the toggle does not close the picker');
  app.window.close();

  const again = await atLevel(40, { pikdame_emote_more: '1', pikdame_emote_counts: '{broken' });
  again.open();
  assert.ok(again.bar.classList.contains('emoteExpanded'), 'opens expanded next time');
  assert.deepEqual(again.top(), EMOTE_IDS.slice(0, 8 - again.specials()), 'broken counts fall back to the default');
  assert.deepEqual(again.errors, []);
  again.window.close();
});

test('round-end bar: same order and toggle', async () => {
  const app = await atLevel(40, { pikdame_emote_counts: JSON.stringify({ '🍻': 2 }) });
  const bar = app.doc.getElementById('resultEmoteBar');
  app.doc.getElementById('resultEmoteToggle').click();
  const first = bar.querySelector('.emoteChoice[data-emote]:not(.emoteRest)');
  assert.equal(first.dataset.emote, '🍻');
  assert.ok(bar.querySelector('.emoteMoreBtn'), 'own toggle');
  assert.equal(bar.querySelectorAll('.emoteChoice:not(.emoteRest)').length, 8, 'eight in the first row');
  app.window.close();
});

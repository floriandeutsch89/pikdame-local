/** Favourite badges in the trophy cabinet: a favourite stays findable and
 *  removable, also after its family reached a new tier. Boots the REAL
 *  markup and client in jsdom. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM, VirtualConsole } = require('jsdom');

const pub = path.join(__dirname, '..', 'public');
const html = fs.readFileSync(path.join(pub, 'index.html'), 'utf8');

function boot() {
  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (e) => errors.push(e));
  const { window } = new JSDOM(html, {
    url: 'https://play.example/', runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole,
  });
  window.matchMedia = (q) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
  window.navigator.vibrate = () => true;
  window.requestAnimationFrame = () => 0;
  window.scrollTo = () => {};
  window.HTMLElement.prototype.scrollIntoView = () => {};
  const answer = (url) => {
    if (url === '/statusz') return { accountsEnabled: true };
    if (url === '/api/me') return { ok: true, username: 'Testkonto' };
    return { ok: true };
  };
  window.fetch = (url) => Promise.resolve({ ok: true, json: () => Promise.resolve(answer(url)), text: () => Promise.resolve('') });
  const sockets = [];
  const sent = [];
  window.WebSocket = class {
    constructor() { this.readyState = 0; this.listeners = {}; sockets.push(this); }
    addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
    removeEventListener() {}
    send(raw) { sent.push(JSON.parse(raw)); }
    close() {}
    fire(type, payload) {
      if (type === 'open') this.readyState = 1;
      for (const fn of this.listeners[type] || []) fn(payload === undefined ? {} : { data: JSON.stringify(payload) });
    }
  };
  window.WebSocket.OPEN = 1;
  window.sessionStorage.setItem('pikdame_splash_seen', '1');
  window.localStorage.setItem('pikdame_player_name', 'Testkonto');
  window.localStorage.setItem('pikdame_account_token', 'tok');
  for (const src of ['i18n.js', 'client.js']) window.eval(fs.readFileSync(path.join(pub, src), 'utf8'));
  const doc = window.document;
  const settle = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r)); };
  const ws = () => sockets[sockets.length - 1];
  const profiles = (me) => ws().fire('message', { type: 'profiles', players: [{ name: 'Testkonto', gamesPlayed: 60, gamesWon: 20, ...me }] });
  const favSends = () => sent.filter((m) => m.type === 'setFavoriteBadges');
  return { window, doc, ws, settle, profiles, favSends, errors };
}

const T1 = Date.UTC(2026, 8, 1);
const T2 = Date.UTC(2026, 9, 10);

async function openCabinet(t) {
  t.doc.getElementById('statsBtn').click();
  await t.settle();
  const box = t.doc.getElementById('achievementsBox');
  if (!box.querySelector('.achTile[data-ach="games"]')) box.querySelector('.achAllBtn').click();
  return box;
}

test('a favourite family can be removed after it reached a new tier', async () => {
  const t = boot();
  await t.settle();
  t.ws().fire('open');
  await t.settle();
  t.profiles({ badges: { marathon_10: T1 }, favoriteBadges: ['games'] });
  await t.settle();
  let box = await openCabinet(t);
  box.querySelector('.achTile[data-ach="games"]').click();
  let btn = box.querySelector('.achFavBtn');
  assert.ok(btn, 'the detail offers the favourite toggle');
  assert.strictEqual(btn.getAttribute('aria-pressed'), 'true');

  // A game later the family has its second tier: the tile shows the new name and emoji.
  t.profiles({ badges: { marathon_10: T1, marathon_50: T2 }, favoriteBadges: ['games'] });
  await t.settle();
  box = await openCabinet(t);
  if (!box.querySelector('.achFavBtn')) box.querySelector('.achTile[data-ach="games"]').click();
  btn = box.querySelector('.achFavBtn');
  assert.ok(btn, 'still offered after the new tier');
  assert.strictEqual(btn.getAttribute('aria-pressed'), 'true');
  btn.click();
  assert.deepStrictEqual(t.favSends().map((m) => m.badges), [[]], 'removing sends the empty list');
  assert.deepStrictEqual(t.errors, []);
  t.window.close();
});

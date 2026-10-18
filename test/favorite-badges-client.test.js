/** Favourite badges in the trophy cabinet: a star on the tile, a list on top
 *  with a remove button each, findable and removable also after a family
 *  reached a new tier. Boots the REAL markup and client in jsdom. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM, VirtualConsole } = require('jsdom');

const pub = path.join(__dirname, '..', 'public');
const html = fs.readFileSync(path.join(pub, 'index.html'), 'utf8');

function boot({ signedIn = true } = {}) {
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
  if (signedIn) window.localStorage.setItem('pikdame_account_token', 'tok');
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
  assert.ok(box.querySelector('.achDetail'), 'the detail opens');
  assert.strictEqual(box.querySelector('.achFavBtn'), null, 'a favourite is removed in the list on top, not here');
  const name = () => box.querySelector('.achFavChip .achFavName').textContent;
  const before = name();

  // A game later the family has its second tier: the tile shows the new name and emoji.
  t.profiles({ badges: { marathon_10: T1, marathon_50: T2 }, favoriteBadges: ['games'] });
  await t.settle();
  box = await openCabinet(t);
  assert.notStrictEqual(name(), before, 'the list follows the new tier');
  box.querySelector('.achFavRemove[data-fav-remove="games"]').click();
  assert.deepStrictEqual(t.favSends().map((m) => m.badges), [[]], 'removing sends the empty list');
  assert.deepStrictEqual(t.errors, []);
  t.window.close();
});

test('the detail of an earned badge that is no favourite adds it', async () => {
  const t = boot();
  await t.settle();
  t.ws().fire('open');
  await t.settle();
  t.profiles({ badges: { marathon_10: T1, first_win: T1 }, favoriteBadges: ['games'] });
  await t.settle();
  const box = await openCabinet(t);
  box.querySelector('.achTile[data-ach="wins"]').click();
  const btn = box.querySelector('.achFavBtn');
  assert.match(btn.textContent, /Als Lieblingsabzeichen zeigen \(1\/3\)/);
  btn.click();
  assert.deepStrictEqual(t.favSends().map((m) => m.badges), [['games', 'wins']]);
  t.window.close();
});

async function signedInWith(me) {
  const t = boot();
  await t.settle();
  t.ws().fire('open');
  await t.settle();
  t.profiles(me);
  await t.settle();
  t.doc.getElementById('statsBtn').click();
  await t.settle();
  return t;
}

test('folded cabinet: the favourite list on top, a star on the tile, × removes', async () => {
  const t = await signedInWith({ badges: { marathon_10: T1, marathon_50: T2, first_win: T1, wins_10: T2 }, favoriteBadges: ['games', 'wins'] });
  const box = t.doc.getElementById('achievementsBox');
  const strip = box.querySelector('.achFavStrip');
  assert.ok(strip, 'the list is there while the cabinet is folded');
  assert.match(strip.querySelector('.achSection').textContent, /Lieblingsabzeichen \(2\/3\)/);
  const chips = [...strip.querySelectorAll('.achFavChip')];
  assert.strictEqual(chips.length, 2);
  assert.ok(strip.querySelector('.achFavHint'), 'a free slot explains how to add one');
  // The chip shows the family's CURRENT tier, as the tile does.
  assert.ok(chips.every((c) => c.querySelector('.achFavName').textContent.trim()));
  box.querySelector('.achAllBtn').click();
  const tile = box.querySelector('.achTile[data-ach="games"]');
  assert.ok(tile.classList.contains('fav'));
  assert.ok(tile.querySelector('.achFavMark'), 'star on the tile');
  assert.ok(!box.querySelector('.achTile[data-ach="queens"]').classList.contains('fav'));
  box.querySelector('.achFavRemove[data-fav-remove="games"]').click();
  assert.deepStrictEqual(t.favSends().map((m) => m.badges), [['wins']]);
  assert.deepStrictEqual(t.errors, []);
  t.window.close();
});

test('a stored tier id counts as its family: marked, listed, removable', async () => {
  const t = await signedInWith({ badges: { marathon_10: T1, marathon_50: T2 }, favoriteBadges: ['marathon_10'] });
  const box = t.doc.getElementById('achievementsBox');
  assert.strictEqual(box.querySelectorAll('.achFavChip').length, 1);
  box.querySelector('.achAllBtn').click();
  assert.ok(box.querySelector('.achTile[data-ach="games"]').classList.contains('fav'));
  box.querySelector('.achFavRemove').click();
  assert.deepStrictEqual(t.favSends().map((m) => m.badges), [[]], 'the tier id does not linger');
  t.window.close();
});

test('three favourites: no hint; signed out: no list and no stars', async () => {
  const full = await signedInWith({ badges: { marathon_10: T1, first_win: T1, pd_laid: T1 }, favoriteBadges: ['games', 'wins', 'queens'] });
  const strip = full.doc.querySelector('#achievementsBox .achFavStrip');
  assert.strictEqual(strip.querySelectorAll('.achFavChip').length, 3);
  assert.strictEqual(strip.querySelector('.achFavHint'), null);
  full.window.close();

  const t = boot({ signedIn: false });
  await t.settle();
  t.ws().fire('open');
  await t.settle();
  t.profiles({ badges: { marathon_10: T1 }, favoriteBadges: ['games'] });
  await t.settle();
  t.doc.getElementById('statsBtn').click();
  await t.settle();
  const box = t.doc.getElementById('achievementsBox');
  assert.strictEqual(box.querySelector('.achFavStrip'), null);
  assert.strictEqual(box.querySelector('.achFavMark'), null);
  t.window.close();
});

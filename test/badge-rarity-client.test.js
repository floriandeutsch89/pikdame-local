/** Badge rarity in the trophy cabinet: a share on every badge tile (locked ones too), the
 *  rare glint under the server's line, a family tile with its tier's share and every tier
 *  its own line in the detail - and nothing at all while the server sends no shares.
 *  Boots the REAL markup and client in jsdom. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM, VirtualConsole } = require('jsdom');
const { BADGE_IDS } = require('../game/Badges');

const pub = path.join(__dirname, '..', 'public');
const html = fs.readFileSync(path.join(pub, 'index.html'), 'utf8');
const NNBSP = '\u{202F}';
const T1 = Date.UTC(2026, 8, 1);

function boot({ lang = 'de' } = {}) {
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
  window.fetch = (url) => Promise.resolve({ ok: true, json: () => Promise.resolve(url === '/statusz' ? { accountsEnabled: true } : { ok: true }), text: () => Promise.resolve('') });
  const sockets = [];
  window.WebSocket = class {
    constructor() { this.readyState = 0; this.listeners = {}; sockets.push(this); }
    addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
    removeEventListener() {}
    send() {}
    close() {}
    fire(type, payload) {
      if (type === 'open') this.readyState = 1;
      for (const fn of this.listeners[type] || []) fn(payload === undefined ? {} : { data: JSON.stringify(payload) });
    }
  };
  window.WebSocket.OPEN = 1;
  window.sessionStorage.setItem('pikdame_splash_seen', '1');
  window.localStorage.setItem('pikdame_player_name', 'Oma');
  if (lang === 'en') window.localStorage.setItem('pikdame_lang', 'en');
  for (const src of ['i18n.js', 'client.js']) window.eval(fs.readFileSync(path.join(pub, src), 'utf8'));
  const doc = window.document;
  const settle = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r)); };
  const ws = () => sockets[sockets.length - 1];
  return { window, doc, ws, settle, errors };
}

// As the server sends it: a share for every catalogue badge.
const RARITY = {
  rareBelow: 10,
  percent: {
    ...Object.fromEntries(BADGE_IDS.map((id) => [id, 30])),
    first_win: 71, wins_10: 19, wins_50: 3, marathon_10: 41, marathon_50: 12, marathon_100: 6, royal_flush: 4, pik_royal: 0, pd_caught: 88,
  },
};

/** The full cabinet of Oma (royal flush and the first marathon tier earned) after a profiles message. */
async function cabinet(opts = {}) {
  const badgeRarity = 'badgeRarity' in opts ? opts.badgeRarity : RARITY;
  const t = boot({ lang: opts.lang });
  await t.settle();
  t.ws().fire('open');
  await t.settle();
  t.ws().fire('message', {
    type: 'profiles', badgeRarity,
    players: [{ name: 'Oma', gamesPlayed: 12, gamesWon: 0, badges: { royal_flush: T1, marathon_10: T1 } }],
  });
  await t.settle();
  t.doc.getElementById('statsBtn').click();
  await t.settle();
  const box = t.doc.getElementById('achievementsBox');
  box.querySelector('.achAllBtn').click();
  return { t, box, tile: (key) => box.querySelector(`.achTile[data-ach="${key}"]`) };
}
const shown = (tile) => tile.querySelector('.achRarity > span[aria-hidden="true"]').textContent;
const spoken = (tile) => tile.querySelector('.achRarity .visuallyHidden').textContent;

test('every badge tile shows its share, locked ones too; under the line it is marked rare', async () => {
  const { t, box, tile } = await cabinet();
  const tiles = [...box.querySelectorAll('.achTile:not(.achSeason)')];
  assert.ok(tiles.length > 30, 'the full cabinet');
  assert.ok(tiles.every((x) => x.classList.contains('hasRarity') && x.querySelector('.achRarity')), 'a share on every tile');

  const earnedRare = tile('royal_flush');
  assert.ok(earnedRare.classList.contains('earned'));
  assert.strictEqual(shown(earnedRare), `4${NNBSP}%`);
  assert.ok(earnedRare.querySelector('.achRarity').classList.contains('rare'));
  assert.ok(earnedRare.querySelector('.achRarity use[href="#i-rare"]'), 'the glint is a sprite icon, not an emoji');
  assert.strictEqual(spoken(earnedRare), 'Selten: nur 4\u{00A0}% der Spieler haben das');

  const lockedCommon = tile('pd_caught');
  assert.ok(!lockedCommon.classList.contains('earned'));
  assert.strictEqual(shown(lockedCommon), `88${NNBSP}%`);
  assert.ok(!lockedCommon.querySelector('.achRarity').classList.contains('rare'));
  assert.strictEqual(lockedCommon.querySelector('.achRarity use'), null, 'no glint on a common badge');
  assert.strictEqual(lockedCommon.querySelector('.achRarity').title, '88\u{00A0}% der Spieler haben das');

  const lockedFew = tile('pik_royal');
  assert.strictEqual(shown(lockedFew), `<${NNBSP}1${NNBSP}%`, 'held by few or none: "< 1 %", never 0');
  assert.ok(lockedFew.querySelector('.achRarity').classList.contains('rare'));
  assert.strictEqual(spoken(lockedFew), 'Selten: weniger als 1\u{00A0}% der Spieler haben das');
  assert.deepStrictEqual(t.errors, []);
  t.window.close();
});

test('a family tile shows the share of the tier it names; the detail gives every tier its own', async () => {
  const { t, box, tile } = await cabinet();
  assert.strictEqual(shown(tile('games')), `41${NNBSP}%`, 'Marathon (tier 1) reached: its share');
  assert.strictEqual(shown(tile('wins')), `71${NNBSP}%`, 'nothing reached: the first tier, which the tile names');

  tile('games').click();
  const lines = [...box.querySelectorAll('.achDetail .achRarityLine')];
  assert.deepStrictEqual(lines.map((l) => l.textContent), [
    '41\u{00A0}% der Spieler haben das',
    '12\u{00A0}% der Spieler haben das',
    'Selten: nur 6\u{00A0}% der Spieler haben das',
  ]);
  assert.deepStrictEqual(lines.map((l) => l.classList.contains('rare')), [false, false, true]);
  assert.ok(lines[2].querySelector('use[href="#i-rare"]'));
  assert.strictEqual(lines[2].querySelector('use').closest('svg').nextElementSibling.tagName, 'SPAN', 'the text beside the icon has its own span');

  tile('royal_flush').click();
  assert.deepStrictEqual([...box.querySelectorAll('.achDetail .achRarityLine')].map((l) => l.textContent),
    ['Selten: nur 4\u{00A0}% der Spieler haben das'], 'a single badge: one line');
  t.window.close();
});

test('English: "4%" on the tile, "Rare: only 4% of players have this" in the detail', async () => {
  const { t, box, tile } = await cabinet({ lang: 'en' });
  assert.strictEqual(shown(tile('royal_flush')), '4%');
  assert.strictEqual(shown(tile('pik_royal')), '<1%');
  tile('royal_flush').click();
  assert.strictEqual(box.querySelector('.achDetail .achRarityLine').textContent, 'Rare: only 4% of players have this');
  tile('pd_caught').click();
  assert.strictEqual(box.querySelector('.achDetail .achRarityLine').textContent, '88% of players have this');
  t.window.close();
});

test('no shares from the server (too few players, an old server): no number, no glint, no line', async () => {
  for (const badgeRarity of [null, undefined, 'x', { rareBelow: 10 }]) {
    const { t, box, tile } = await cabinet({ badgeRarity });
    assert.strictEqual(box.querySelector('.achRarity, .hasRarity'), null, `nothing on the tiles (${JSON.stringify(badgeRarity)})`);
    tile('games').click();
    assert.ok(box.querySelector('.achDetail'), 'the detail still opens');
    assert.strictEqual(box.querySelector('.achRarityLine'), null);
    assert.deepStrictEqual(t.errors, []);
    t.window.close();
  }
});

test('a broken value is skipped, not shown; without the line nothing is rare', async () => {
  const { t, tile } = await cabinet({ badgeRarity: { rareBelow: 10, percent: { pd_caught: 'x', royal_flush: 150, pik_royal: -1, first_win: 71 } } });
  for (const key of ['pd_caught', 'royal_flush', 'pik_royal']) assert.strictEqual(tile(key).querySelector('.achRarity'), null, key);
  assert.strictEqual(shown(tile('wins')), `71${NNBSP}%`);
  t.window.close();

  const noLine = await cabinet({ badgeRarity: { percent: { royal_flush: 4 } } });
  assert.strictEqual(shown(noLine.tile('royal_flush')), `4${NNBSP}%`);
  assert.ok(!noLine.tile('royal_flush').querySelector('.achRarity').classList.contains('rare'));
  noLine.t.window.close();
});

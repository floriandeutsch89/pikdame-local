/** The player's own mark in the felt (client.js TABLE_MARKS): unlocked by level or badge from the
 *  own profile like the card backs, picked in a gallery under "Optionen", kept on this device and
 *  never sent; an occasion always wins over it. Boots the real markup and client in jsdom.
 *  Art, tints and their contrast: test/occasion-table.test.js. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { xpForLevel } = require('../game/Progression');

const pub = path.join(__dirname, '..', 'public');
const HTML = fs.readFileSync(path.join(pub, 'index.html'), 'utf8');
const SRC = ['i18n.js', 'client.js'].map((f) => fs.readFileSync(path.join(pub, f), 'utf8'));
const KEY = 'pikdame_table_mark';
const ORDER = ['none', 'suits', 'laurel', 'crown', 'owl', 'gem', 'queen', 'cardhouse'];

/** Total XP at the start of a level. */
const xpAt = (level) => { let xp = 0; for (let l = 1; l < level; l++) xp += xpForLevel(l); return xp; };
const ready = () => new Promise((r) => setTimeout(r, 10));
const soft = (s) => s.replace(/­/g, '');

/** `occasion`: today's holiday (/statusz); `storage`: localStorage before the client starts. */
async function boot({ occasion = null, storage = {} } = {}) {
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
  const sent = [];
  window.WebSocket = class {
    constructor() { this._ls = {}; ws = this; this.readyState = 1; setTimeout(() => this._emit('open', {}), 0); }
    addEventListener(t, f) { (this._ls[t] = this._ls[t] || []).push(f); }
    removeEventListener(t, f) { this._ls[t] = (this._ls[t] || []).filter((x) => x !== f); }
    _emit(t, ev) {
      if (typeof this['on' + t] === 'function') this['on' + t](ev);
      for (const f of this._ls[t] || []) f(ev);
    }
    send(data) { sent.push(String(data)); }
    close() {}
  };
  window.WebSocket.OPEN = 1;
  window.WebSocket.CONNECTING = 0;
  window.onerror = (msg) => errors.push(String(msg));
  window.console.error = (...a) => errors.push(a.map(String).join(' '));
  window.localStorage.setItem('pikdame_tip_seen', '9');
  window.localStorage.setItem('pikdame_player_name', 'Flo');
  for (const [k, v] of Object.entries(storage)) window.localStorage.setItem(k, v);
  window.sessionStorage.setItem('pikdame_splash_seen', '1');
  for (const src of SRC) window.eval(src);
  window.document.dispatchEvent(new window.Event('DOMContentLoaded', { bubbles: true }));
  await ready();
  const doc = window.document;
  const send = (msg) => ws._emit('message', { data: JSON.stringify(msg) });
  /** My profile as the server lists it (name-based): level by XP, badges by id. */
  const profile = ({ level = 1, badges = {} } = {}) => send({ type: 'profiles', players: [{ name: 'Flo', gamesPlayed: 9, gamesWon: 3, xp: xpAt(level), badges }], publicMode: false });
  const mark = () => doc.getElementById('table').dataset.mark;
  const open = () => { doc.getElementById('tableMarkBtn').click(); return doc.querySelector('.cardbackGallery.markGallery'); };
  const tile = (id) => doc.querySelector(`.markGallery .markSwatch[data-mark="${id}"]`).closest('.cardbackTile');
  const toast = () => soft(doc.getElementById('toastContainer').textContent);
  return { window, doc, errors, sent, send, profile, mark, open, tile, toast };
}
const card = (id) => ({ id, suit: id[0], rank: id.slice(1, id.indexOf('-')), isJoker: false });
function state(extra = {}) {
  return {
    phase: 'playing', roundNumber: 2, turnIndexInRound: 8, currentPlayerId: 'b1', turnPhase: 'meld', dealerId: 'b1',
    drawPileCount: 40, discardTop: card('D4-0'), discardPileCount: 1, discardCards: [card('D4-0')],
    tableMelds: [], log: [], houseRules: {}, lobbyReady: [], nextRoundReady: [], totals: { p1: 120, b1: 80 }, scoreHistory: [],
    players: [
      { id: 'p1', name: 'Flo', isBot: false, connected: true, handCount: 2, hand: [card('H2-0'), card('C9-0')] },
      { id: 'b1', name: 'Klaus', isBot: true, connected: true, handCount: 9, botDifficulty: 'medium' },
    ],
    ...extra,
  };
}
function atTable(c, extra) {
  c.send({ type: 'joined', playerId: 'p1', playerToken: 't', sessionCode: 'MRK002' });
  c.send({ type: 'state', state: state(extra) });
}

test('gallery: one tile per mark under "Darstellung", the felt with the mark on each, the plain felt active by default', async (t) => {
  const c = await boot();
  t.after(() => c.window.close());
  const row = c.doc.getElementById('tableMarkBtn');
  assert.ok(row.closest('.prefGroup').querySelector('#cardbackBtn'), 'beside the card backs');
  assert.strictEqual(c.doc.getElementById('tableMarkValue').textContent, 'Ohne', 'the row names the choice');
  const gallery = c.open();
  assert.ok(gallery, 'a tap opens the gallery');
  assert.strictEqual(soft(gallery.querySelector('h3').textContent), 'Tischmotive');
  assert.ok(gallery.querySelector('h3 svg use[href="#i-feltmark"]'), 'a sprite icon, no emoji');
  assert.match(gallery.querySelector('.cbNote').textContent, /Feiertagen und Geburtstagen/, 'the occasion rule is said once');
  const tiles = [...gallery.querySelectorAll('.cardbackTile')];
  assert.deepStrictEqual(tiles.map((x) => x.querySelector('.markSwatch').dataset.mark), ORDER);
  assert.ok(tiles.every((x) => x.tagName === 'BUTTON' && x.type === 'button'), 'buttons');
  assert.deepStrictEqual(tiles.map((x) => x.getAttribute('aria-pressed')), ORDER.map((id) => String(id === 'none')));
  assert.ok(c.tile('none').querySelector('.cbGate svg use[href="#i-check"]'), 'the active one is checked');
  assert.ok(c.tile('none').querySelector('.markSwatch .icon') === null, 'no lock on the plain felt');
  c.doc.getElementById('tableMarkBtn').click();
  assert.strictEqual(c.doc.querySelector('.cardbackGallery'), null, 'a second tap closes it');
  assert.deepStrictEqual(c.errors, []);
});

test('unlock: level marks at their level, badge marks with their badge, from my own profile', async (t) => {
  const c = await boot();
  t.after(() => c.window.close());
  // Before the profile: all locked but the plain felt, each with what opens it.
  c.open();
  const locked = (id) => c.tile(id).classList.contains('locked');
  assert.deepStrictEqual(ORDER.filter(locked), ORDER.slice(1));
  const gate = (id) => soft(c.tile(id).querySelector('.cbGate').textContent);
  assert.deepStrictEqual(['suits', 'laurel', 'crown'].map(gate), ['ab Stufe 5', 'ab Stufe 15', 'ab Stufe 25']);
  assert.deepStrictEqual(['owl', 'gem', 'queen', 'cardhouse'].map(gate),
    ['Abzeichen „Nachteule“', 'Abzeichen „Royal Flush“', 'Abzeichen „Damenlegende“', 'Abzeichen „Lehrling“']);
  assert.ok(c.tile('crown').querySelector('.markSwatch svg use[href="#i-lock"]'), 'a lock over the swatch');
  c.doc.querySelector('.cardbackGallery').remove();

  // Level 15 and a royal flush: three open, the rest still locked; exactly at the threshold counts.
  c.profile({ level: 15, badges: { royal_flush: Date.now() } });
  c.open();
  assert.deepStrictEqual(ORDER.filter((id) => !locked(id)), ['none', 'suits', 'laurel', 'gem']);
  c.doc.querySelector('.cardbackGallery').remove();
  c.profile({ level: 14, badges: { night_owl: 1, pd_hunter_50: 1, tower_crowned_1: 1 } });
  c.open();
  assert.deepStrictEqual(ORDER.filter((id) => !locked(id)), ['none', 'suits', 'owl', 'queen', 'cardhouse'], 'level 14: no laurel yet');
  assert.deepStrictEqual(c.errors, []);
});

test('pick: an open mark is stored and on the felt at once; a locked one says how to get it and changes nothing', async (t) => {
  const c = await boot();
  t.after(() => c.window.close());
  c.profile({ level: 6, badges: { royal_flush: 1 } });
  c.open(); // on the start screen: the table's first tip would hold the toast line
  c.tile('queen').click();
  assert.match(c.toast(), /^Pik Dame: Abzeichen „Damenlegende“ – Lege insgesamt 50 Pik Damen aus/, 'the badge and its how-to');
  assert.ok(c.doc.querySelector('.markGallery'), 'the gallery stays open');
  assert.strictEqual(c.window.localStorage.getItem(KEY), null, 'nothing stored');
  c.tile('crown').click();
  assert.match(c.toast(), /^Krone: ab Stufe 25$/);
  c.doc.querySelector('.cardbackGallery').remove();
  atTable(c);
  assert.strictEqual(c.mark(), undefined, 'the plain felt by default');
  c.open(); // the same sheet at the table (the gear)
  c.tile('gem').click();
  assert.strictEqual(c.doc.querySelector('.cardbackGallery'), null, 'a pick closes the gallery');
  assert.strictEqual(c.window.localStorage.getItem(KEY), 'gem', 'kept on this device');
  assert.strictEqual(c.mark(), 'gem', 'the felt shows it right away');
  assert.strictEqual(c.doc.getElementById('tableMarkValue').textContent, 'Brillant');
  c.open();
  assert.strictEqual(c.tile('gem').getAttribute('aria-pressed'), 'true', 'the gallery marks it as chosen');
  c.tile('none').click();
  assert.strictEqual(c.mark(), undefined, '"Ohne": the plain felt again');
  assert.strictEqual(c.window.localStorage.getItem(KEY), 'none');
  // Only this device knows: no message ever names the choice.
  assert.ok(c.sent.every((m) => !/gem|table_?mark|tableMark/i.test(m)), `nothing about it on the wire: ${c.sent.join(' ')}`);
  assert.deepStrictEqual(c.errors, []);
});

test('persistence: the choice survives a reload, waits for the profile and stays stored while locked', async (t) => {
  const c = await boot({ storage: { [KEY]: 'laurel' } });
  t.after(() => c.window.close());
  atTable(c);
  assert.strictEqual(c.mark(), undefined, 'no profile yet: not unlocked, nothing shown');
  assert.strictEqual(c.doc.getElementById('tableMarkValue').textContent, 'Ohne');
  c.profile({ level: 15 });
  assert.strictEqual(c.mark(), 'laurel', 'the profile arrives: the stored mark is back');
  assert.strictEqual(c.doc.getElementById('tableMarkValue').textContent, 'Lorbeerkranz');

  // Another name (a profile without the level): nothing shown, the choice kept for the way back.
  const other = await boot({ storage: { [KEY]: 'crown' } });
  t.after(() => other.window.close());
  other.profile({ level: 15 });
  atTable(other);
  assert.strictEqual(other.mark(), undefined, 'locked: the plain felt');
  assert.strictEqual(other.window.localStorage.getItem(KEY), 'crown', 'never silently overwritten');
  for (const junk of ['birthday', 'halloween', 'nope', '']) {
    const odd = await boot({ storage: { [KEY]: junk } });
    t.after(() => odd.window.close());
    odd.profile({ level: 30, badges: { night_owl: 1 } });
    assert.strictEqual(odd.mark(), undefined, `a stored ${JSON.stringify(junk)} draws nothing`);
  }
  assert.deepStrictEqual([...c.errors, ...other.errors], []);
});

test('precedence: the birthday at the table, then the holiday, then my own mark, else the plain felt', async (t) => {
  const c = await boot({ occasion: 'halloween', storage: { [KEY]: 'owl' } });
  t.after(() => c.window.close());
  c.profile({ level: 3, badges: { night_owl: 1 } });
  atTable(c);
  assert.strictEqual(c.mark(), 'halloween', 'the holiday wins over my owl');
  c.send({ type: 'state', state: state({ birthdayToday: true }) });
  assert.strictEqual(c.mark(), 'birthday', 'and the birthday over both');
  assert.strictEqual(c.doc.getElementById('tableMarkValue').textContent, 'Eule', 'the row still names my choice');

  const plain = await boot({ storage: { [KEY]: 'owl' } });
  t.after(() => plain.window.close());
  plain.profile({ badges: { night_owl: 1 } });
  atTable(plain);
  assert.strictEqual(plain.mark(), 'owl', 'a plain day: my own mark');
  plain.send({ type: 'state', state: state({ birthdayToday: true }) });
  assert.strictEqual(plain.mark(), 'birthday', 'a birthday at the table');
  plain.send({ type: 'state', state: state({ birthdayToday: false }) });
  assert.strictEqual(plain.mark(), 'owl', 'the flag gone: mine again');
  assert.deepStrictEqual([...c.errors, ...plain.errors], []);
});

test('news: a level mark among the level rewards, a badge mark on the badge\'s unlock card; English throughout', async (t) => {
  const c = await boot();
  t.after(() => c.window.close());
  c.profile({ level: 4 });
  c.doc.getElementById('langBtn').click(); // English; the switch re-renders the progress sheet too
  const next = [...c.doc.querySelectorAll('#progressContent .pgNext li')].map((li) => li.textContent);
  assert.ok(next.includes('table motif "Four suits"'), `level 5 brings it: ${next.join(' | ')}`);
  assert.ok(c.doc.querySelector('#progressContent .pgNext use[href="#i-feltmark"]'), 'with its icon');
  assert.strictEqual(c.doc.getElementById('tableMarkValue').textContent, 'None');
  c.open();
  assert.strictEqual(c.doc.querySelector('.markGallery h3').textContent, 'Table motifs');
  assert.deepStrictEqual(['suits', 'gem'].map((id) => soft(c.tile(id).querySelector('.cbGate').textContent)), ['from level 5', 'badge "Royal flush"']);
  assert.strictEqual(soft(c.tile('cardhouse').querySelector('.cbName').textContent), 'House of Cards');
  c.doc.querySelector('.cardbackGallery').remove();
  c.doc.getElementById('langBtn').click();
  c.send({ type: 'badgeUnlocks', name: 'Flo', badges: [{ id: 'pd_hunter_50', earnedAt: Date.now() }] });
  const sub = soft(c.doc.querySelector('#unlockLayer .unlockCard .unlockSub').textContent);
  assert.match(sub, /^Neues Tischmotiv: Pik Dame · Stufe 3 von 3/, `the motif first: ${sub}`);
  assert.deepStrictEqual(c.errors, []);
});

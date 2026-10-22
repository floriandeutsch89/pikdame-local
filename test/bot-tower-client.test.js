/** Kartenhaus, client side: the start-screen tile in "Aufgaben", the entry on
 *  the progress sheet, the floor sheet, starting a floor through the one-game
 *  guard, the verdict on the result sheet and the way back via the reload
 *  intent. Boots the REAL markup and client in jsdom. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM, VirtualConsole } = require('jsdom');
const GameManager = require('../game/GameManager');
const BotTower = require('../game/BotTower');

// Every booted client is closed after the file, also when a test failed half-way
// (its timers would keep the run alive).
const opened = [];
test.after(() => { for (const w of opened) { try { w.close(); } catch (e) { /* closed */ } } });

const pub = path.join(__dirname, '..', 'public');
const html = fs.readFileSync(path.join(pub, 'index.html'), 'utf8');

function boot({ storage = {}, reduceMotion = false } = {}) {
  const errors = [];
  const virtualConsole = new VirtualConsole();
  // jsdom cannot navigate: leaving via location.href is asserted through storage instead.
  virtualConsole.on('jsdomError', (e) => { if (!/navigation/.test(String(e.message))) errors.push(e); });
  const { window } = new JSDOM(html, {
    url: 'https://play.example/', runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole,
  });
  opened.push(window);
  window.matchMedia = (q) => ({ matches: reduceMotion && /reduced-motion/.test(q), media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
  window.navigator.vibrate = () => true;
  window.requestAnimationFrame = () => 0;
  window.scrollTo = () => {};
  const scrolled = [];
  window.Element.prototype.scrollIntoView = function scrollIntoView() { scrolled.push(this); };
  window.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve({}), text: () => Promise.resolve('') });
  const sockets = [];
  class FakeSocket {
    constructor() { this.readyState = 0; this.listeners = {}; this.sent = []; sockets.push(this); }
    addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
    removeEventListener() {}
    send(data) { this.sent.push(JSON.parse(data)); }
    close() {}
    fire(type, payload) {
      if (type === 'open') this.readyState = 1;
      for (const fn of this.listeners[type] || []) fn(payload === undefined ? {} : { data: JSON.stringify(payload) });
    }
  }
  FakeSocket.CONNECTING = 0;
  FakeSocket.OPEN = 1;
  window.WebSocket = FakeSocket;
  window.sessionStorage.setItem('pikdame_splash_seen', '1');
  window.localStorage.setItem('pikdame_player_name', 'Ben');
  for (const [k, v] of Object.entries(storage)) window.localStorage.setItem(k, v);
  for (const src of ['i18n.js', 'client.js']) window.eval(fs.readFileSync(path.join(pub, src), 'utf8'));
  const ws = sockets[sockets.length - 1];
  const doc = window.document;
  const sent = (type) => ws.sent.filter((m) => m.type === type);
  const shown = (id) => !doc.getElementById(id).classList.contains('hidden');
  return { window, doc, ws, sent, shown, errors, scrolled };
}

const PROFILE = { name: 'Ben', gamesPlayed: 3, gamesWon: 1, towerStars: 4, towerCleared: 2, towers: { '2026-10': { 1: 3, 2: 1 } } };
const towerInfo = (over = {}) => ({
  type: 'towerInfo', month: '2026-10', today: '2026-10-19', stages: BotTower.publicStages(), clearMargin: BotTower.CLEAR_MARGIN,
  best: { 1: 3, 2: 1 }, stars: 4, cleared: 2, unlocked: 3, crowned: false, totalStars: 4, archive: [], ...over,
});

/** Start screen with a profile, today's quests and the tower data. */
function startScreen(storage) {
  const t = boot({ storage });
  t.ws.fire('open');
  t.ws.fire('message', { type: 'profiles', players: [PROFILE], publicMode: false, quests: { date: '2026-10-17', ids: ['finish_game'] } });
  return t;
}

/** The Kartenhaus sheet opened from the progress sheet (data already there). */
function openSheet(t) {
  t.doc.getElementById('identityAvatarBtn').click();
  t.doc.querySelector('#progressContent .pgTower').click();
}
const floorEl = (t, n) => t.doc.querySelector(`#towerHouse [data-stage="${n}"]`);

test('progress sheet: the Kartenhaus entry opens the house - 20 floors and the top', () => {
  const t = startScreen();
  const ask = t.sent('getTower');
  assert.strictEqual(ask.length, 1, 'asked once, with the profiles');
  assert.strictEqual(ask[0].name, 'Ben');
  t.ws.fire('message', towerInfo());

  t.doc.getElementById('identityAvatarBtn').click();
  assert.ok(t.shown('progressOverlay'));
  const entry = t.doc.querySelector('#progressContent .pgTower');
  assert.ok(entry, 'Kartenhaus entry on the progress sheet');
  assert.match(entry.textContent, /Oktober: 4\/60 Sterne/);
  assert.match(entry.textContent, /2 von 20 Etagen · insgesamt 4 Sterne/);
  entry.click();
  assert.ok(t.shown('towerOverlay'));
  assert.ok(!t.shown('progressOverlay'), 'one sheet at a time');
  assert.strictEqual(t.sent('getTower').length, 2, 'opening asks for fresh stars');

  assert.strictEqual(t.doc.getElementById('towerMonth').textContent, 'Oktober 2026');
  assert.strictEqual(t.doc.getElementById('towerSummary').textContent, '4 / 60 Sternen diesen Monat · noch 12 Tage');
  const svg = t.doc.querySelector('#towerHouse svg');
  assert.ok(svg, 'the house is an inline SVG');
  assert.strictEqual(svg.getAttribute('viewBox'), '-178 -272 356 278');
  assert.strictEqual(svg.getAttribute('aria-label'), 'Kartenhaus im Oktober: 2 von 20 Etagen geschafft, 4 von 60 Sternen, als Nächstes Etage 3',
    'the house in one sentence: floors, stars, the floor up next');
  const floors = [...t.doc.querySelectorAll('#towerHouse [data-stage]')];
  assert.deepStrictEqual(floors.map((g) => Number(g.dataset.stage)), Array.from({ length: 21 }, (_, i) => i + 1), '20 floors bottom-up, then the top');
  const cls = (n) => floorEl(t, n).classList;
  assert.ok(cls(1).contains('built') && cls(2).contains('built'), 'starred floors stand as cards');
  assert.ok(cls(3).contains('next'), 'the next floor stands out');
  assert.strictEqual(t.doc.querySelectorAll('#towerHouse .khFloor.next').length, 1);
  for (const n of [4, 10, 11, 20]) assert.ok(cls(n).contains('plan'), `floor ${n}: only its number`);
  assert.ok(cls(21).contains('khApex') && cls(21).contains('plan'), 'the top waits for the crown');
  assert.strictEqual(floorEl(t, 1).querySelectorAll('.khStar.on').length, 3);
  assert.strictEqual(floorEl(t, 2).querySelectorAll('.khStar.on').length, 1);
  assert.strictEqual(floorEl(t, 2).querySelector('.khRank').textContent, '2', 'the number on the card');
  assert.strictEqual(floorEl(t, 4).querySelectorAll('.khStar').length, 0, 'no stars on a floor not reached yet');
  // Tap targets: half a tent per card, a whole row high; side by side they tile the row.
  const hits = floors.map((g) => g.querySelector('.khHit'));
  for (const [i, hit] of hits.entries()) {
    const g = floors[i];
    assert.ok(hit, `floor ${g.dataset.stage}: hit area`);
    assert.ok(Number(hit.getAttribute('width')) >= 44 && Number(hit.getAttribute('height')) >= 50, `floor ${g.dataset.stage}: a whole slot`);
    assert.strictEqual(g.getAttribute('role'), 'button');
    assert.strictEqual(g.getAttribute('tabindex'), '0');
  }
  const x = (n) => Number(hits[n - 1].getAttribute('x'));
  for (let n = 1; n < 8; n++) assert.ok(Math.abs(x(n) + Number(hits[n - 1].getAttribute('width')) - x(n + 1)) < 0.2, `floor ${n} ends where ${n + 1} starts`);
  assert.strictEqual(floorEl(t, 2).getAttribute('aria-label'), 'Etage 2: gegen Leicht, Mittel - 1 von 3 Sternen');
  assert.strictEqual(floorEl(t, 3).getAttribute('aria-label'), 'Etage 3: gegen Mittel, Mittel - noch kein Stern');
  assert.strictEqual(floorEl(t, 20).getAttribute('aria-label'),
    'Etage 20: gegen Zen, Zen, Zen, die Bots bekommen 160 Punkte Vorgabe, Risiko: Pik Dame auf der Hand · Erschwernis: Ohne Ablage · Erschwernis: Selbst ausmachen - gesperrt');
  assert.strictEqual(floorEl(t, 3).getAttribute('aria-pressed'), 'true', 'the detail shows the next floor');

  // The detail of the next floor, with the way in.
  const detail = t.doc.getElementById('towerDetail');
  assert.strictEqual(detail.querySelector('.khDTitle').textContent, 'Etage 3');
  assert.match(detail.textContent, /2 Bots: Mittel, Mittel/);
  assert.match(detail.textContent, /als Nächstes/);
  assert.strictEqual(detail.querySelector('.khPlay').textContent.trim(), 'Etage 3 spielen');
  assert.strictEqual(t.doc.querySelectorAll('#towerRules ul')[0].querySelectorAll('li').length, 3);
  assert.match(t.doc.getElementById('towerRules').textContent, /2 Sterne: mindestens 100 Punkte vorn/);
  assert.match(t.doc.getElementById('towerRules').textContent, /erste Stern jeder Etage bringt pro Monat einmal 10 EP/);
  assert.match(t.doc.getElementById('towerRules').textContent, /krönen dein Kartenhaus \(\+50 EP\)/);
  assert.ok(!t.shown('towerArchiveBox'), 'no earlier month, no archive');
  assert.deepStrictEqual(t.errors, []);
  t.window.close();
});

test('a tap shows the floor, the button starts it; a locked floor only explains', () => {
  const t = startScreen();
  t.ws.fire('message', towerInfo());
  openSheet(t);
  const detail = t.doc.getElementById('towerDetail');
  floorEl(t, 14).dispatchEvent(new t.window.MouseEvent('click', { bubbles: true }));
  assert.strictEqual(t.sent('startTower').length, 0, 'a tap never starts');
  assert.strictEqual(detail.querySelector('.khDTitle').textContent, 'Etage 14');
  assert.match(detail.textContent, /gesperrt/);
  assert.match(detail.textContent, /3 Bots: Zen, Zen, Zen · 140 Punkte Vorgabe/);
  assert.deepStrictEqual([...detail.querySelectorAll('.khMod')].map((m) => m.textContent), ['Risiko: Pik Dame auf der Hand']);
  assert.ok(detail.querySelector('.khMod').classList.contains('risk'), 'the risk chip is gold, not a red handicap');
  assert.strictEqual(detail.querySelector('.khDMods').getAttribute('aria-label'), 'Risiko: Pik Dame auf der Hand – ausgelegt +100, auf der Hand −100', 'the queen is a risk, not a handicap');
  assert.match(detail.textContent, /Schaff erst Etage 3\./);
  assert.strictEqual(detail.querySelector('.khPlay'), null, 'no way into a locked floor');
  assert.ok(floorEl(t, 14).classList.contains('sel'), 'the picked floor is ringed');
  assert.strictEqual(floorEl(t, 14).getAttribute('aria-pressed'), 'true');
  assert.strictEqual(floorEl(t, 3).getAttribute('aria-pressed'), 'false');

  // Keyboard: Enter on a floor picks it too.
  floorEl(t, 2).dispatchEvent(new t.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  assert.strictEqual(detail.querySelector('.khDTitle').textContent, 'Etage 2');
  assert.ok(detail.querySelector('.khDStars'), 'its best stars');
  assert.strictEqual(detail.querySelectorAll('.khDStars .icon.on').length, 1);
  const again = detail.querySelector('.khPlay');
  assert.strictEqual(again.textContent.trim(), 'Etage 2 nochmal');
  again.click();
  const start = t.sent('startTower');
  assert.strictEqual(start.length, 1);
  assert.deepStrictEqual({ stage: start[0].stage, name: start[0].name }, { stage: 2, name: 'Ben' });
  assert.ok(!t.shown('towerOverlay'));
  assert.deepStrictEqual(t.errors, []);
  t.window.close();
});

test('crowned: the Queen of Spades on top, the detail names the next stars to collect', () => {
  const t = startScreen();
  const best = Object.fromEntries(BotTower.TOWER_STAGES.map((st) => [st.stage, st.stage === 20 ? 1 : 3]));
  t.ws.fire('message', towerInfo({ best, stars: 58, cleared: 20, unlocked: 20, crowned: true, totalStars: 58 }));
  openSheet(t);
  const apex = floorEl(t, 21);
  assert.ok(apex.classList.contains('built'));
  assert.ok(apex.querySelector('.khQueen'), 'the Queen of Spades card');
  assert.match(apex.querySelector('.khQueen').textContent, /Q♠/);
  assert.strictEqual(t.doc.querySelectorAll('#towerHouse .khFloor.next').length, 0, 'nothing left to unlock');
  const detail = t.doc.getElementById('towerDetail');
  assert.strictEqual(detail.querySelector('.khDTitle').textContent, 'Gekrönt!');
  assert.match(detail.textContent, /Alle 20 Etagen im Oktober geschafft\. Auf Etage 20 fehlen noch 2 Sterne\./);
  assert.strictEqual(detail.querySelector('.khPlay').textContent.trim(), 'Etage 20 nochmal');
  t.ws.fire('message', towerInfo({ best: Object.fromEntries(BotTower.TOWER_STAGES.map((st) => [st.stage, 3])), stars: 60, cleared: 20, unlocked: 20, crowned: true }));
  assert.match(detail.textContent, /Alle 60 Sterne/);
  assert.strictEqual(detail.querySelector('.khPlay'), null);
  t.window.close();
});

test('earlier months stay as a read-only archive', () => {
  const t = startScreen();
  const full = Object.fromEntries(BotTower.TOWER_STAGES.map((st) => [st.stage, 2]));
  t.ws.fire('message', towerInfo({
    month: '2026-11', today: '2026-11-30',
    archive: [{ month: '2026-10', best: full, stars: 40, cleared: 20, unlocked: 20, crowned: true },
      { month: '2026-09', best: { 1: 1 }, stars: 1, cleared: 1, unlocked: 2, crowned: false }],
  }));
  openSheet(t);
  assert.strictEqual(t.doc.getElementById('towerSummary').textContent, '4 / 60 Sternen diesen Monat · noch 0 Tage'.replace('noch 0 Tage', 'heute letzter Tag'));
  assert.ok(t.shown('towerArchiveBox'));
  const rows = [...t.doc.querySelectorAll('#towerArchive .khArchRow')];
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows[0].getAttribute('aria-label'), 'Oktober 2026: 20 von 20 Etagen, 40 von 60 Sternen, gekrönt');
  assert.ok(rows[0].classList.contains('crowned') && rows[0].querySelector('.khArchCrown'));
  assert.strictEqual(rows[1].getAttribute('aria-label'), 'September 2026: 1 von 20 Etagen, 1 von 60 Sternen');
  assert.strictEqual(rows[1].querySelector('.khArchCrown'), null);
  assert.strictEqual(t.doc.querySelectorAll('#towerArchive button, #towerArchive [data-play]').length, 0, 'nothing to start there');
  t.window.close();
});

test('the language switch redraws the sheet and the tile', () => {
  const t = startScreen();
  t.ws.fire('message', towerInfo());
  openSheet(t);
  t.doc.getElementById('langBtn').click();
  assert.strictEqual(t.doc.getElementById('towerSummary').textContent, '4 / 60 stars this month · 12 days left');
  assert.strictEqual(t.doc.getElementById('towerMonth').textContent, 'October 2026');
  assert.match(t.doc.getElementById('towerRules').textContent, /first star of each floor pays 10 XP once a month/);
  assert.strictEqual(t.doc.querySelector('#towerTitle span').textContent, 'House of Cards');
  assert.strictEqual(t.doc.getElementById('towerDetail').querySelector('.khPlay').textContent.trim(), 'Play floor 3');
  assert.strictEqual(floorEl(t, 2).getAttribute('aria-label'), 'Floor 2: against Easy, Medium - 1 of 3 stars');
  assert.strictEqual(t.doc.querySelector('#towerHouse svg').getAttribute('aria-label'),
    'House of Cards in October: 2 of 20 floors cleared, 4 of 60 stars, next up: floor 3');
  assert.strictEqual(t.doc.querySelector('.khLegend span').textContent, 'Dashed edge: a special rule from floor 11');
  assert.strictEqual(t.doc.querySelector('#towerTile .ttTitle').textContent, 'House of Cards');
  assert.strictEqual(t.doc.getElementById('towerTileStatus').textContent, 'Floor 3 · 4/60');
  t.window.close();
});

test('motion: the first visit deals the house, new stars land, a lost try wobbles, a crown lands', () => {
  const seen = (best, extra = {}) => JSON.stringify({ name: 'Ben', month: '2026-10', best, crowned: false, ...extra });
  const animated = (t) => [...t.doc.querySelectorAll('#towerHouse .khDealt')].map((g) => Number(g.dataset.stage));

  // First visit on this device: the floor cards are dealt one after the other.
  let t = startScreen();
  t.ws.fire('message', towerInfo());
  openSheet(t);
  assert.deepStrictEqual(animated(t), [1, 2]);
  assert.match(floorEl(t, 1).getAttribute('style'), /--kh-delay:0\.1s/);
  assert.match(floorEl(t, 2).getAttribute('style'), /--kh-delay:0\.19s/, 'staggered');
  assert.match(floorEl(t, 1).getAttribute('style'), /--kh-dx:-14px/, 'a left card comes from the left');
  assert.deepStrictEqual(JSON.parse(t.window.localStorage.getItem('pikdame_tower_seen')), { name: 'Ben', month: '2026-10', best: { 1: 3, 2: 1 }, crowned: false });
  // A second reply with the same stars keeps the drawing (the animation runs on).
  t.ws.fire('message', towerInfo());
  assert.deepStrictEqual(animated(t), [1, 2]);
  t.window.close();

  // Seen before: nothing moves; a new star since then lands, a better floor pops its stars.
  t = startScreen({ pikdame_tower_seen: seen({ 1: 2 }) });
  t.ws.fire('message', towerInfo());
  openSheet(t);
  assert.deepStrictEqual(animated(t), [2]);
  assert.strictEqual(floorEl(t, 1).querySelectorAll('.khStar.khPop').length, 1, 'the third star of floor 1 pops');
  t.window.close();

  // A lost try (verdict stored before the reload) wobbles that floor once.
  t = startScreen({ pikdame_tower_seen: seen({ 1: 3, 2: 1 }), pikdame_tower_last: JSON.stringify({ name: 'Ben', month: '2026-10', stage: 3, stars: 0 }) });
  t.ws.fire('message', towerInfo());
  openSheet(t);
  assert.deepStrictEqual(animated(t), []);
  assert.ok(floorEl(t, 3).classList.contains('khWobble'));
  assert.strictEqual(t.window.localStorage.getItem('pikdame_tower_last'), null, 'once');
  t.window.close();

  // The crown: all twenty starred since the last visit.
  const all = Object.fromEntries(BotTower.TOWER_STAGES.map((st) => [st.stage, 1]));
  t = startScreen({ pikdame_tower_seen: seen({ ...all, 20: 0 }) });
  t.ws.fire('message', towerInfo({ best: all, stars: 20, cleared: 20, unlocked: 20, crowned: true }));
  openSheet(t);
  assert.deepStrictEqual(animated(t), [20]);
  assert.ok(floorEl(t, 21).classList.contains('khCrowning'), 'the Queen of Spades lands on top');
  t.window.close();

  // prefers-reduced-motion: the house stands still.
  t = boot({ reduceMotion: true });
  t.ws.fire('open');
  t.ws.fire('message', { type: 'profiles', players: [PROFILE], publicMode: false, quests: { date: '2026-10-17', ids: ['finish_game'] } });
  t.ws.fire('message', towerInfo());
  openSheet(t);
  assert.strictEqual(t.doc.querySelectorAll('#towerHouse .khDealt, #towerHouse .khWobble, #towerHouse .khPop, #towerHouse .khCrowning').length, 0);
  t.window.close();
});

// --- The house as floor cards ------------------------------------------------------
const HALF = { 1: 3, 2: 3, 3: 3, 4: 2, 5: 3, 6: 2, 7: 3, 8: 2, 9: 3, 10: 2, 11: 2, 12: 2 }; // 30 stars, 13 next

test('floor cards: cleared floors face up with their stars and rim, the next one dashed, closed ones hatched with their icon', () => {
  const t = startScreen();
  t.ws.fire('message', towerInfo({ best: HALF, stars: 30, cleared: 12, unlocked: 13, closed: { 13: 'building', 17: 'locked' } }));
  openSheet(t);
  const card = (n) => floorEl(t, n);
  // Cleared: the floor card of the table - its number, the house pip, the best stars.
  for (let n = 1; n <= 12; n++) {
    assert.ok(card(n).classList.contains('built'), `floor ${n} stands`);
    assert.ok(card(n).querySelector('.khFace'), `floor ${n}: a face`);
    assert.strictEqual(card(n).querySelector('.khRank').textContent, String(n));
    assert.ok(card(n).querySelector('use.khPip[href="#i-cardhouse"]'), `floor ${n}: the house as its suit`);
    assert.strictEqual(card(n).querySelectorAll('.khStar').length, 3);
    assert.strictEqual(card(n).querySelectorAll('.khStar.on').length, HALF[n], `floor ${n}: its best stars`);
  }
  // The rim of the special rule, as at the table: none up to 10, gold for the queen alone, red for a handicap.
  assert.strictEqual(card(10).querySelector('.khRim'), null);
  assert.ok(card(11).querySelector('.khRim.risk'), 'floor 11 (queen): gold');
  assert.ok(card(12).querySelector('.khRim.mod'), 'floor 12 (go out): red');
  // Two cards lean together; their tent stands on a plate from the second row up.
  const leanOf = (n) => card(n).querySelector('.khFace').parentElement.getAttribute('transform');
  assert.match(leanOf(1), /rotate\(13\)$/);
  assert.match(leanOf(2), /rotate\(-13\)$/);
  assert.strictEqual(t.doc.querySelectorAll('#towerHouse svg > .khPlate').length, 2, 'under the tents 9/10 and 11/12');
  // Next, but still being built: the accent outline, hatched, with the hourglass; no stars, no way in.
  assert.ok(card(13).classList.contains('closed') && card(13).classList.contains('isNext'));
  assert.ok(card(13).querySelector('.khGhost'));
  assert.ok(card(13).querySelector('use.khGlyph[href="#i-hourglass"]'), 'the hourglass says why');
  assert.strictEqual(card(13).querySelectorAll('.khStar').length, 0);
  assert.match(card(13).getAttribute('aria-label'), /^Etage 13: gegen Zen, Zen, Zen, .* - wird noch gebaut$/);
  // Locked for the month: hatched with the lock, also beyond the player's floor.
  assert.ok(card(17).classList.contains('closed') && !card(17).classList.contains('isNext'));
  assert.ok(card(17).querySelector('use.khGlyph[href="#i-lock"]'));
  assert.match(card(17).getAttribute('aria-label'), / - diesen Monat geschlossen$/);
  // Not reached yet: only the number marks the place.
  assert.ok(card(14).classList.contains('plan'));
  assert.strictEqual(card(14).querySelector('.khPlan').textContent, '14');
  assert.strictEqual(card(14).querySelector('.khGhost, .khFace'), null);
  assert.strictEqual(t.doc.querySelector('#towerHouse svg').getAttribute('aria-label'),
    'Kartenhaus im Oktober: 12 von 20 Etagen geschafft, 30 von 60 Sternen, als Nächstes Etage 13 (wird noch gebaut)');

  // The detail explains what the icon shows; a closed floor has no way in.
  const detail = t.doc.getElementById('towerDetail');
  assert.strictEqual(detail.querySelector('.khDTitle').textContent, 'Etage 13');
  assert.match(detail.querySelector('.khDTag').textContent, /als Nächstes/);
  assert.match(detail.textContent, /wird gerade gebaut/);
  assert.strictEqual(detail.querySelector('.khPlay'), null);
  card(17).dispatchEvent(new t.window.MouseEvent('click', { bubbles: true }));
  assert.strictEqual(detail.querySelector('.khDTag').textContent, 'geschlossen');
  assert.ok(detail.querySelector('.khDTag use[href="#i-lock"]'));
  assert.match(detail.textContent, /kein geprüftes Blatt - sie bleibt zu\./);
  card(15).dispatchEvent(new t.window.MouseEvent('click', { bubbles: true }));
  assert.strictEqual(detail.querySelector('.khDTag').textContent, 'gesperrt');
  assert.match(detail.textContent, /Schaff erst Etage 13\./);
  // A floor still being built beyond the player's one: the hourglass in the tag too.
  t.ws.fire('message', towerInfo({ best: HALF, stars: 30, cleared: 12, unlocked: 13, closed: { 16: 'building' } }));
  card(16).dispatchEvent(new t.window.MouseEvent('click', { bubbles: true }));
  assert.ok(card(16).querySelector('use.khGlyph[href="#i-hourglass"]'), 'a newer reply redraws the house');
  assert.strictEqual(detail.querySelector('.khDTag').textContent, 'im Bau');
  assert.ok(detail.querySelector('.khDTag use[href="#i-hourglass"]'));
  assert.ok(card(13).classList.contains('next'), 'floor 13 is ready now: the dashed card');
  assert.ok(card(13).querySelector('.khGhost') && !card(13).querySelector('.khGlyph'));
  assert.deepStrictEqual(t.errors, []);
  t.window.close();
});

test('floor cards: crowned - all twenty stand, the Queen of Spades on top, plates under every upper tent', () => {
  const t = startScreen();
  const best = Object.fromEntries(BotTower.TOWER_STAGES.map((st) => [st.stage, 3]));
  t.ws.fire('message', towerInfo({ best, stars: 60, cleared: 20, unlocked: 20, crowned: true, totalStars: 60 }));
  openSheet(t);
  assert.strictEqual(t.doc.querySelectorAll('#towerHouse .khFloor.built .khFace').length, 20);
  const rims = Object.fromEntries(Array.from({ length: 20 }, (_, i) => {
    const rim = floorEl(t, i + 1).querySelector('.khRim');
    return [i + 1, rim ? rim.classList[1] : ''];
  }));
  for (let n = 1; n <= 20; n++) {
    const want = n <= 10 ? '' : n === 11 || n === 14 ? 'risk' : 'mod';
    assert.strictEqual(rims[n], want, `floor ${n}: rim ${want || 'none'} (as the card at the table)`);
  }
  const apex = floorEl(t, 21);
  assert.ok(apex.classList.contains('built'));
  assert.match(apex.querySelector('.khQueen').textContent, /Q♠/);
  assert.ok(apex.querySelector('.khPlate'), 'the queen stands on a plate');
  assert.strictEqual(t.doc.querySelectorAll('#towerHouse svg > .khPlate').length, 6, 'three, two and one upper tents');
  assert.strictEqual(t.doc.querySelector('#towerHouse svg').getAttribute('aria-label'),
    'Kartenhaus im Oktober: 20 von 20 Etagen geschafft, 60 von 60 Sternen, gekrönt');
  t.window.close();
});

// --- A new month: the old house is collected once ---------------------------------
const SEPTEMBER = JSON.stringify({ name: 'Ben', month: '2026-09', best: { 1: 3, 2: 2, 3: 1 }, crowned: false });
const OCTOBER_EMPTY = { best: {}, stars: 0, cleared: 0, unlocked: 1, totalStars: 6 };

test('a new month: the last house is collected once - the last card first, then the empty month', () => {
  const t = startScreen({ pikdame_tower_seen: SEPTEMBER });
  t.ws.fire('message', towerInfo(OCTOBER_EMPTY));
  openSheet(t);
  const house = t.doc.getElementById('towerHouse');
  const svg = () => house.querySelector('svg');
  assert.ok(svg().classList.contains('kh-collect'), 'September is collected first');
  assert.ok(house.classList.contains('khBusy'));
  const flights = [...house.querySelectorAll('.khOldLayer .khCollect')];
  assert.deepStrictEqual(flights.map((g) => g.querySelector('.khRank').textContent), ['3', '2', '1'], 'the card laid last goes first');
  assert.deepStrictEqual(flights.map((g) => g.style.getPropertyValue('--kh-delay')), ['0.15s', '0.22s', '0.28s'], 'one after the other, 65 ms apart');
  assert.ok(flights.every((g) => g.querySelector('.khBack')), 'each turns to its back on the way');
  assert.strictEqual(house.querySelector('.khOldLayer').getAttribute('aria-hidden'), 'true');
  assert.ok(house.querySelector('.khPile'), 'onto one pile');
  // October waits underneath, already the floor picker.
  assert.ok(house.querySelector('.khNewLayer [data-stage="1"]').classList.contains('next'));
  const caption = house.querySelector('.khCaption');
  assert.ok(caption.classList.contains('moving'));
  assert.strictEqual(caption.getAttribute('role'), 'status');
  assert.strictEqual(caption.textContent, 'September ist vorbei Tippen: überspringen');
  assert.strictEqual(JSON.parse(t.window.localStorage.getItem('pikdame_tower_seen')).month, '2026-10', 'once: October is seen now');
  assert.strictEqual(t.doc.getElementById('towerDetail').querySelector('.khDTitle').textContent, 'Etage 1', 'the detail is October already');

  // The new month has faded in: the show ends, the plain house stays.
  house.querySelector('.khNewLayer').dispatchEvent(new t.window.Event('animationend', { bubbles: true }));
  assert.ok(!svg().classList.contains('kh-collect'));
  assert.ok(!house.classList.contains('khBusy'));
  assert.strictEqual(house.querySelector('.khCaption'), null);
  assert.strictEqual(house.querySelectorAll('.khFloor.built').length, 0);
  assert.ok(floorEl(t, 1).classList.contains('next'));

  // Once per month: the next visit shows October at once.
  t.doc.getElementById('towerCloseBtn').click();
  openSheet(t);
  assert.ok(!svg().classList.contains('kh-collect'));
  assert.strictEqual(house.querySelector('.khCaption'), null);
  assert.deepStrictEqual(t.errors, []);
  t.window.close();
});

test('a new month: a tap skips to the end and never picks a floor', () => {
  const t = startScreen({ pikdame_tower_seen: SEPTEMBER });
  t.ws.fire('message', towerInfo(OCTOBER_EMPTY));
  openSheet(t);
  const house = t.doc.getElementById('towerHouse');
  const tap = (n) => {
    const g = floorEl(t, n);
    g.dispatchEvent(new t.window.PointerEvent('pointerdown', { bubbles: true }));
    // The browser clicks where the finger was: a floor of the new house after the skip.
    (floorEl(t, n) || g).dispatchEvent(new t.window.MouseEvent('click', { bubbles: true }));
  };
  assert.ok(house.classList.contains('khBusy'));
  tap(5);
  assert.ok(!house.classList.contains('khBusy'), 'skipped');
  assert.ok(!house.querySelector('svg').classList.contains('kh-collect'));
  assert.strictEqual(house.querySelector('.khCaption'), null);
  assert.strictEqual(floorEl(t, 5).getAttribute('aria-pressed'), 'false', 'the skipping tap picked nothing');
  assert.strictEqual(t.doc.getElementById('towerDetail').querySelector('.khDTitle').textContent, 'Etage 1');
  tap(5);
  assert.strictEqual(floorEl(t, 5).getAttribute('aria-pressed'), 'true', 'the next tap picks');
  assert.strictEqual(t.doc.getElementById('towerDetail').querySelector('.khDTitle').textContent, 'Etage 5');

  // Keyboard: Enter during the show skips as well.
  t.window.localStorage.setItem('pikdame_tower_seen', SEPTEMBER);
  t.doc.getElementById('towerCloseBtn').click();
  openSheet(t);
  assert.ok(house.classList.contains('khBusy'));
  floorEl(t, 2).dispatchEvent(new t.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  assert.ok(!house.classList.contains('khBusy'));
  assert.strictEqual(t.doc.getElementById('towerDetail').querySelector('.khDTitle').textContent, 'Etage 1', 'Enter skipped, it picked nothing');

  // Closing the sheet mid-show ends it: no stale show on the next visit.
  t.window.localStorage.setItem('pikdame_tower_seen', SEPTEMBER);
  t.doc.getElementById('towerCloseBtn').click();
  openSheet(t);
  t.doc.getElementById('towerCloseBtn').click();
  assert.ok(!house.classList.contains('khBusy'));
  assert.strictEqual(house.querySelector('.khCaption'), null);
  assert.deepStrictEqual(t.errors, []);
  t.window.close();
});

test('a new month: without animation events the show ends by itself', async () => {
  const t = startScreen({ pikdame_tower_seen: SEPTEMBER });
  t.ws.fire('message', towerInfo(OCTOBER_EMPTY));
  openSheet(t);
  const house = t.doc.getElementById('towerHouse');
  assert.ok(house.classList.contains('khBusy'));
  // A second, identical reply keeps the show running.
  t.ws.fire('message', towerInfo(OCTOBER_EMPTY));
  assert.ok(house.classList.contains('khBusy'));
  await new Promise((r) => setTimeout(r, 3400));
  assert.ok(!house.classList.contains('khBusy'));
  assert.strictEqual(house.querySelector('.khCaption'), null);
  assert.ok(floorEl(t, 1).classList.contains('next'));
  t.window.close();
});

test('a new month under reduced motion: the new month at once, a note says where the old one went', () => {
  for (const [lng, text] of [['de', 'September ist vorbei 6 Sterne – jetzt unter „Frühere Monate“'], ['en', 'September is over 6 stars – now under “Earlier months”']]) {
    const t = boot({ reduceMotion: true, storage: { pikdame_tower_seen: SEPTEMBER, pikdame_lang: lng } });
    t.ws.fire('open');
    t.ws.fire('message', { type: 'profiles', players: [PROFILE], publicMode: false, quests: { date: '2026-10-17', ids: ['finish_game'] } });
    t.ws.fire('message', towerInfo(OCTOBER_EMPTY));
    openSheet(t);
    const house = t.doc.getElementById('towerHouse');
    assert.ok(!house.querySelector('svg').classList.contains('kh-collect'), `${lng}: nothing is collected`);
    assert.ok(!house.classList.contains('khBusy'));
    assert.strictEqual(house.querySelectorAll('.khOldLayer, .khCollect').length, 0);
    assert.ok(floorEl(t, 1).classList.contains('next'), `${lng}: October at once`);
    const note = house.querySelector('.khCaption');
    assert.ok(note && !note.classList.contains('moving'), `${lng}: the note stays`);
    assert.strictEqual(note.textContent, text);
    // A tap picks a floor right away; the note stays with the house.
    floorEl(t, 4).dispatchEvent(new t.window.PointerEvent('pointerdown', { bubbles: true }));
    floorEl(t, 4).dispatchEvent(new t.window.MouseEvent('click', { bubbles: true }));
    assert.strictEqual(floorEl(t, 4).getAttribute('aria-pressed'), 'true');
    assert.ok(house.querySelector('.khCaption'));
    assert.strictEqual(JSON.parse(t.window.localStorage.getItem('pikdame_tower_seen')).month, '2026-10', `${lng}: once`);
    if (lng === 'de') {
      // Redrawn in the other language, the note stays; closing the sheet ends it.
      t.doc.getElementById('langBtn').click();
      assert.strictEqual(house.querySelector('.khCaption').textContent, 'September is over 6 stars – now under “Earlier months”');
      t.doc.getElementById('towerCloseBtn').click();
      openSheet(t);
      assert.strictEqual(house.querySelector('.khCaption'), null, 'once per month');
    }
    assert.deepStrictEqual(t.errors, []);
    t.window.close();
  }
});

test('a new month: nothing to collect without stars, another name or an older month', () => {
  for (const seen of [
    { name: 'Ben', month: '2026-09', best: {}, crowned: false },
    { name: 'Ben', month: '2026-09', best: { 1: 0 }, crowned: false },
    { name: 'Anna', month: '2026-09', best: { 1: 3 }, crowned: false },
    { name: 'Ben', month: '2026-11', best: { 1: 3 }, crowned: false },
  ]) {
    const t = startScreen({ pikdame_tower_seen: JSON.stringify(seen) });
    t.ws.fire('message', towerInfo(OCTOBER_EMPTY));
    openSheet(t);
    assert.ok(!t.doc.querySelector('#towerHouse svg').classList.contains('kh-collect'), JSON.stringify(seen));
    assert.strictEqual(t.doc.querySelector('#towerHouse .khCaption'), null);
    t.window.close();
  }
});

test('a new month that arrives while the sheet shows the old one is collected too', () => {
  // The cached data is September's (the sheet opened before midnight); October's reply follows.
  const t = startScreen({ pikdame_tower_seen: SEPTEMBER });
  t.ws.fire('message', towerInfo({ month: '2026-09', today: '2026-09-30', best: { 1: 3, 2: 2, 3: 1 }, stars: 6, cleared: 3, unlocked: 4 }));
  openSheet(t);
  const house = t.doc.getElementById('towerHouse');
  assert.ok(!house.querySelector('svg').classList.contains('kh-collect'));
  t.ws.fire('message', towerInfo({ ...OCTOBER_EMPTY, archive: [{ month: '2026-09', best: { 1: 3, 2: 2, 3: 1 }, stars: 6, cleared: 3, unlocked: 4, crowned: false }] }));
  assert.ok(house.querySelector('svg').classList.contains('kh-collect'), 'October collects September');
  assert.strictEqual(house.querySelector('.khCaption').textContent, 'September ist vorbei Tippen: überspringen');
  t.window.close();
});

const OPEN_TOWER = { pikdame_last_session: 'ABC123', pikdame_player_ABC123: 'p-ben', pikdame_token_ABC123: 'tok-ben' };

test('one game at a time: an open stage resumes as such and is given up only after asking', () => {
  const t = startScreen(OPEN_TOWER);
  t.ws.fire('message', {
    type: 'sessionStatus', code: 'ABC123', exists: true, challenge: false, finished: false,
    seat: { phase: 'playing', round: 1, score: 0, left: false, alone: true, tutorial: false, tower: 4, stammtisch: null },
  });
  assert.strictEqual(t.doc.getElementById('resumeBtn').textContent.trim(), 'Kartenhaus fortsetzen (Etage 4)');
  t.ws.fire('message', towerInfo({ best: { 1: 3, 2: 1, 3: 1, 4: 0 }, unlocked: 4 }));
  openSheet(t);
  floorEl(t, 1).dispatchEvent(new t.window.MouseEvent('click', { bubbles: true }));
  t.doc.querySelector('#towerDetail .khPlay').click();
  assert.strictEqual(t.sent('startTower').length, 0, 'nothing starts behind the sheet');
  assert.ok(t.shown('openGameOverlay'));
  assert.strictEqual(t.doc.getElementById('openGameSummary').textContent, 'Kartenhaus · Etage 4');
  assert.match(t.doc.getElementById('openGameConsequence').textContent, /ohne Sterne/);
  assert.strictEqual(t.doc.getElementById('openGameGiveUpBtn').textContent.trim(), 'Aufgeben & Kartenhaus');
  t.window.close();
});

/** A finished floor 2 as the server would show it, plus the verdict message. */
function finishedStage() {
  let record = null;
  const g = new GameManager(() => {}, { deckSeed: BotTower.stageConfig(2).seed, towerStage: 2, onGameOver: (r, rec) => { record = rec; } });
  g.addOrReconnectPlayer('me', 'Ben');
  g.syncLobbyBots();
  g.startTowerRound();
  let guard = 0;
  while (g.phase === 'playing' && guard++ < 3000) {
    const cp = g.currentPlayer();
    g.runBotTurn(cp.id, { forced: !cp.isBot });
  }
  const state = g.publicState('me');
  const outcome = BotTower.outcomeFromRecord(record, 'me');
  g.destroy();
  return { state, outcome };
}

test('result sheet: stars, the sum behind them and the way on', () => {
  const { state, outcome } = finishedStage();
  const t = boot();
  t.ws.fire('open');
  t.ws.fire('message', { type: 'joined', playerId: 'me', playerToken: 't', sessionCode: 'TOWER1' });
  t.ws.fire('message', { type: 'state', state });
  const verdict = { ...outcome, stars: 1, margin: 25, myScore: 140, bestBot: 115, handicap: 0, wentOut: true };
  t.ws.fire('message', {
    type: 'towerResult', ...verdict, clearMargin: 100, xp: 10, level: { level: 1, into: 10, need: 100, total: 10 },
    progress: { best: { 1: 3, 2: 1 }, improved: true, stars: 4, cleared: 2, unlocked: 3, crowned: false, crownedNow: false },
  });
  assert.ok(t.shown('resultOverlay'));
  assert.strictEqual(t.doc.getElementById('resultTitle').textContent, 'Kartenhaus · Etage 2');
  assert.strictEqual(t.doc.querySelector('#resultBody .twResultXp').textContent, '+10 EP · erster Stern');
  const box = t.doc.querySelector('#resultBody .towerResultBox');
  assert.ok(box, 'verdict box');
  assert.strictEqual(box.querySelectorAll('.twResultStars .icon.on').length, 1);
  assert.match(box.textContent, /Du 140 · bester Bot 115/);
  assert.match(box.textContent, /25 Punkte vorn/);
  assert.match(box.textContent, /Neuer Bestwert/);
  assert.match(box.textContent, /mindestens 100 Punkte vorn/, 'what the next star needs');
  assert.strictEqual(t.doc.getElementById('resultContinueBtn').textContent, 'Zum Kartenhaus');
  assert.strictEqual(box.querySelector('.twNext').textContent.trim(), 'Etage 3');

  // A state re-render keeps the box (the result sheet is rebuilt from scratch).
  t.ws.fire('message', { type: 'state', state });
  assert.strictEqual(t.doc.querySelectorAll('#resultBody .towerResultBox').length, 1);

  box.querySelector('.twNext').click();
  assert.strictEqual(t.window.localStorage.getItem('pikdame_after_tower'), '3', 'the next floor after the reload');
  t.doc.querySelector('#resultBody .twRetry').click();
  assert.strictEqual(t.window.localStorage.getItem('pikdame_after_tower'), '2');
  t.doc.getElementById('resultContinueBtn').click();
  assert.strictEqual(t.window.localStorage.getItem('pikdame_after_tower'), 'open');
  assert.strictEqual(t.sent('rematch').length, 0, 'never a rematch of a floor');
  assert.deepStrictEqual(t.errors, []);
  t.window.close();
});

test('a missed floor says by how much, with the handicap in the sum', () => {
  const { state, outcome } = finishedStage();
  const t = boot();
  t.ws.fire('open');
  t.ws.fire('message', { type: 'joined', playerId: 'me', playerToken: 't', sessionCode: 'TOWER1' });
  t.ws.fire('message', { type: 'towerResult', ...outcome, stars: 0, myScore: 145, bestBot: 140, handicap: 20, margin: -15, clearMargin: 100, progress: { best: {}, improved: false, stars: 0, cleared: 0, unlocked: 2 } });
  t.ws.fire('message', { type: 'state', state });
  const box = t.doc.querySelector('#resultBody .towerResultBox');
  assert.ok(box, 'the verdict that came first is drawn with the sheet');
  assert.match(box.textContent, /bester Bot 140 \+ 20 Vorgabe = 160/);
  assert.match(box.textContent, /15 Punkte hinten/);
  assert.strictEqual(box.querySelectorAll('.twResultStars .icon.on').length, 0);
  assert.ok(!box.querySelector('.twNext'), 'floor 3 is not open yet');
  assert.ok(!box.querySelector('.twResultXp'), 'no star, no XP line');
  t.window.close();
});

test('after the reload: the intent opens the Kartenhaus or starts the floor', () => {
  const open = startScreen({ pikdame_after_tower: 'open' });
  assert.ok(open.shown('towerOverlay'));
  assert.strictEqual(open.window.localStorage.getItem('pikdame_after_tower'), null, 'used once');
  assert.match(open.doc.getElementById('towerSummary').textContent, /Lädt/);
  assert.strictEqual(open.doc.querySelector('#towerHouse svg'), null, 'the box keeps its place while it loads');
  open.ws.fire('message', towerInfo());
  assert.strictEqual(open.doc.querySelectorAll('#towerHouse [data-stage]').length, 21);
  open.window.close();

  const retry = startScreen({ pikdame_after_tower: '3' });
  const start = retry.sent('startTower');
  assert.strictEqual(start.length, 1);
  assert.strictEqual(start[0].stage, 3);
  retry.window.close();
});

test('public servers keep no profiles: no Kartenhaus request, no tile', () => {
  const t = boot();
  t.ws.fire('open');
  t.ws.fire('message', { type: 'profiles', players: [], publicMode: true, quests: { date: '2026-10-17', ids: ['finish_game'] } });
  assert.strictEqual(t.sent('getTower').length, 0);
  t.window.close();
});

test('start screen: the Kartenhaus tile in "Aufgaben" shows this month\'s floor and stars', () => {
  const tables = [{ code: 'ST1', name: 'Eins' }, { code: 'ST2', name: 'Zwei' }, { code: 'ST3', name: 'Drei' }];
  const t = startScreen({ pikdame_stammtische: JSON.stringify(tables) });
  const tile = t.doc.getElementById('towerTile');
  assert.ok(t.doc.getElementById('todayTiles').contains(tile), 'in "Aufgaben", below puzzle and challenge');
  assert.strictEqual(t.doc.getElementById('todayTiles').lastElementChild, tile);
  assert.ok(tile.classList.contains('hidden'), 'hidden until the data is there');
  // The Stammtische show all three again: no tower chip takes a row.
  const rows = [...t.doc.querySelectorAll('#stammtischRecent .stRecentRow')];
  assert.deepStrictEqual(rows.map((b) => b.dataset.code), ['ST1', 'ST2', 'ST3']);
  assert.ok(rows.every((r) => !r.classList.contains('hidden')));

  t.ws.fire('message', towerInfo());
  assert.ok(!tile.classList.contains('hidden'));
  assert.strictEqual(tile.querySelector('.ttTitle').textContent, 'Kartenhaus');
  assert.strictEqual(t.doc.getElementById('towerTileStatus').textContent, 'Etage 3 · 4/60');
  assert.ok(t.doc.querySelector('#towerTileStatus .ttStar'), 'a star after the numbers');
  assert.strictEqual(tile.getAttribute('aria-label'), 'Kartenhaus im Oktober: Etage 3, 4 von 60 Sternen');
  assert.strictEqual(tile.dataset.state, '', 'mid-month: calm');
  assert.strictEqual(t.doc.querySelectorAll('#stammtischRecent .stRecentRow:not(.hidden)').length, 3);
  tile.click();
  assert.ok(t.shown('towerOverlay'), 'a tap opens the Kartenhaus');
  assert.deepStrictEqual(t.errors, []);
  t.window.close();
});

test('start screen: a fresh month calls, a crowned one rests, public mode shows nothing', () => {
  const t = startScreen();
  t.ws.fire('message', towerInfo({ best: {}, stars: 0, cleared: 0, unlocked: 1, totalStars: 0 }));
  assert.strictEqual(t.doc.getElementById('towerTileStatus').textContent, 'Etage 1 · 0/60');
  assert.strictEqual(t.doc.getElementById('towerTile').dataset.state, 'new');
  const all = Object.fromEntries(BotTower.TOWER_STAGES.map((st) => [st.stage, 2]));
  t.ws.fire('message', towerInfo({ best: all, stars: 40, cleared: 20, unlocked: 20, crowned: true, totalStars: 40 }));
  assert.strictEqual(t.doc.getElementById('towerTileStatus').textContent, 'Gekrönt · 40/60');
  assert.strictEqual(t.doc.getElementById('towerTile').dataset.state, 'done');
  assert.match(t.doc.getElementById('towerTile').getAttribute('aria-label'), /^Kartenhaus im Oktober: gekrönt, 40 von 60 Sternen$/);
  t.window.close();

  const p = boot();
  p.ws.fire('open');
  p.ws.fire('message', { type: 'profiles', players: [], publicMode: true });
  p.ws.fire('message', towerInfo());
  assert.ok(!p.shown('towerTile'));
  assert.deepStrictEqual(p.errors, []);
  p.window.close();
});

test('a floor without a proven deal stays closed: being built, or locked for the month', () => {
  const t = startScreen();
  t.ws.fire('message', towerInfo({ closed: { 2: 'locked', 3: 'building' } }));
  openSheet(t);
  const detail = t.doc.getElementById('towerDetail');
  floorEl(t, 3).dispatchEvent(new t.window.MouseEvent('click', { bubbles: true }));
  assert.match(detail.textContent, /Diese Etage wird gerade gebaut - schau bald wieder vorbei\./);
  assert.strictEqual(detail.querySelector('.khPlay'), null, 'no way into a floor without a deal');
  floorEl(t, 2).dispatchEvent(new t.window.MouseEvent('click', { bubbles: true }));
  assert.match(detail.textContent, /kein geprüftes Blatt - sie bleibt zu\./);
  assert.strictEqual(detail.querySelector('.khPlay'), null);
  floorEl(t, 14).dispatchEvent(new t.window.MouseEvent('click', { bubbles: true }));
  assert.match(detail.textContent, /Schaff erst Etage 3\./, 'a floor locked by progress keeps its own hint');
  assert.deepStrictEqual(t.errors, []);
  t.window.close();
});

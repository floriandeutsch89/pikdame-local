// One "Optionen" sheet for the start screen and the table: the gear opens the
// same sheet, "Dieser Tisch" leads it at the table only, the forfeit vote sits
// in the home dialog (two taps), and the rules open at the table. Real markup
// and client in jsdom.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const pub = path.join(__dirname, '..', 'public');
const html = fs.readFileSync(path.join(pub, 'index.html'), 'utf8');

function boot({ storage = {}, fullscreen = false } = {}) {
  const dom = new JSDOM(html, { url: 'https://play.example/', runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;
  const errors = [];
  const sent = [];
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
  const fsCalls = [];
  if (fullscreen) window.document.documentElement.requestFullscreen = () => { fsCalls.push('request'); return Promise.resolve(); };
  let ws = null;
  window.WebSocket = class {
    constructor() { this._ls = {}; ws = this; this.readyState = 1; setTimeout(() => this._emit('open', {}), 0); }
    addEventListener(t, f) { (this._ls[t] = this._ls[t] || []).push(f); }
    removeEventListener(t, f) { this._ls[t] = (this._ls[t] || []).filter((x) => x !== f); }
    _emit(t, ev) {
      if (typeof this['on' + t] === 'function') this['on' + t](ev);
      for (const f of this._ls[t] || []) f(ev);
    }
    send(data) { sent.push(JSON.parse(data)); }
    close() {}
  };
  window.WebSocket.OPEN = 1;
  window.WebSocket.CONNECTING = 0;
  window.onerror = (msg) => errors.push(String(msg));
  window.addEventListener('error', (e) => errors.push(String(e.message || e.error)));
  window.sessionStorage.setItem('pikdame_splash_seen', '1');
  for (const [k, v] of Object.entries(storage)) window.localStorage.setItem(k, v);
  for (const src of ['i18n.js', 'client.js']) window.eval(fs.readFileSync(path.join(pub, src), 'utf8'));
  window.document.dispatchEvent(new window.Event('DOMContentLoaded', { bubbles: true }));
  return { window, errors, sent, fsCalls, ws: () => ws };
}

async function setup(t, opts) {
  const ctx = boot(opts);
  t.after(() => ctx.window.close());
  await new Promise((r) => setTimeout(r, 10));
  const sock = ctx.ws();
  sock._emit('message', { data: JSON.stringify({ type: 'joined', playerId: 'p1', playerToken: 't', sessionCode: 'ABCD' }) });
  const feed = (s) => sock._emit('message', { data: JSON.stringify({ type: 'state', state: s }) });
  const click = (node) => node.dispatchEvent(new ctx.window.MouseEvent('click', { bubbles: true }));
  const doc = ctx.window.document;
  const $ = (id) => doc.getElementById(id);
  const shown = (id) => !$(id).classList.contains('hidden');
  const toast = () => $('toastContainer').textContent;
  // MutationObserver callbacks (an opening sheet drops the current toast) run as microtasks.
  const tick = () => new Promise((r) => setTimeout(r, 0));
  return { ...ctx, feed, click, doc, $, shown, toast, tick };
}

const card = (id, suit, rank) => ({ id, suit, rank });
const hand = [card('h1', 'H', '7'), card('h2', 'S', '2'), card('h3', 'C', '9'), card('h4', 'D', 'K')];
function table(extra = {}) {
  return {
    phase: 'playing', roundNumber: 2, currentPlayerId: 'p1', turnPhase: 'draw', dealerId: 'b1',
    turnDeadline: null, discardTop: { id: 'dt', suit: 'H', rank: 'Q' }, drawPileCount: 40, discardPileCount: 4,
    log: [{ text: 'Runde 2 gestartet. Geber: Gisela.' }], tableMelds: [], lobbyReady: [], nextRoundReady: [],
    houseRules: { handAusDoubles: true, strictThreshold: false, turnTimerSeconds: 60, botPace: 'slow' },
    totals: { p1: 120, b1: 640, b2: 30 }, forfeitVotes: [],
    players: [
      { id: 'p1', name: 'Flo', isBot: false, connected: true, handCount: hand.length, hand },
      { id: 'b1', name: 'Gisela', isBot: true, connected: true, handCount: 1, botDifficulty: 'medium' },
      { id: 'b2', name: 'Horst', isBot: true, connected: true, handCount: 2, botDifficulty: 'medium' },
    ],
    ...extra,
  };
}
const withHuman = (extra = {}) => table({
  players: [
    { id: 'p1', name: 'Flo', isBot: false, connected: true, handCount: hand.length, hand },
    { id: 'p2', name: 'Oma Gerda', isBot: false, connected: true, handCount: 9 },
    { id: 'b1', name: 'Gisela', isBot: true, connected: true, handCount: 1, botDifficulty: 'medium' },
  ],
  totals: { p1: 120, p2: 300, b1: 640 },
  ...extra,
});

test('one sheet: the gear opens "Optionen", the old table sheet is gone', async (t) => {
  const { $, feed, click, shown, doc, errors } = await setup(t);
  feed(table());
  assert.equal($('gameSettingsOverlay'), null, 'no second settings sheet');
  assert.equal(doc.querySelectorAll('.sheetRow').length, 0, 'no cycling rows');
  assert.equal($('settingsBtn').title, 'Optionen');
  assert.equal($('settingsBtn').getAttribute('aria-label'), 'Optionen');
  click($('settingsBtn'));
  assert.ok(shown('settingsOverlay'), 'the gear opens the shared sheet');
  assert.equal(doc.querySelector('#settingsOverlayTitle span').textContent, 'Optionen');
  assert.ok($('langBtn').closest('#settingsOverlay'), 'the language switch comes along');
  click($('settingsOverlayCloseBtn'));
  assert.ok(!shown('settingsOverlay'));
  // One control per setting: every switch id exists exactly once.
  for (const id of ['soundCheckbox', 'aidTipsCheckbox', 'aidDiscardCheckbox', 'aidLayOffCheckbox', 'aidLowCardsCheckbox', 'botQuipsCheckbox', 'debugCheckbox']) {
    assert.equal(doc.querySelectorAll(`#${id}`).length, 1, id);
  }
  assert.deepEqual(errors, []);
});

test('"Dieser Tisch" shows at the table only, on top, with the house rules read-only', async (t) => {
  const { $, feed, click, shown, doc } = await setup(t);
  // Start screen: no table part, the intro row is there.
  click($('settingsBtnLobby'));
  assert.ok(!shown('tableOptions'), 'not on the start screen');
  assert.ok(shown('studioLogoItem'), 'the intro row belongs to the start screen');
  click($('settingsOverlayCloseBtn'));

  feed(table());
  click($('settingsBtn'));
  assert.ok(shown('tableOptions'), 'at the table');
  assert.equal(doc.querySelector('#settingsOverlay .prefGroup:not(.hidden)'), $('tableOptions'), 'it leads the sheet');
  assert.ok(!shown('studioLogoItem'), 'the intro is hidden at the table');
  assert.ok(shown('celebrationItem'), 'the victory cheer can be changed at the table');
  const rules = [...doc.querySelectorAll('#tableRules > div:not(.hidden)')]
    .map((row) => [row.querySelector('dt').textContent, row.querySelector('dd').textContent]);
  assert.deepEqual(rules, [
    ['Hand aus zählt doppelt', 'An'],
    ['Über 1000 Punkte zum Gewinnen', 'Aus'],
    ['Zug-Timer', '60 s'],
    ['Bot-Tempo', 'Gemütlich'],
    ['Bot-Stärke', 'Mittel'],
  ]);
  assert.equal(doc.querySelectorAll('#tableRules input, #tableRules select, #tableRules button').length, 0, 'read-only');
  // Navigation rows carry a chevron.
  for (const id of ['tableRulesBtn', 'tableLogBtn', 'cardbackBtn', 'tableMarkBtn', 'versionBtn']) {
    assert.ok($(id).querySelector('.prefChevron'), `${id} has a chevron`);
  }

  // Live: a changed state re-renders the open sheet; the challenge keeps its bots' level unsaid.
  feed(table({ challengeDate: '2026-10-22', houseRules: {} }));
  assert.equal($('tableRuleTimer').textContent, 'Aus');
  assert.equal($('tableRuleBotPace').textContent, 'Normal');
  assert.ok($('tableRuleBotLevelRow').classList.contains('hidden'));
  const mixed = table();
  mixed.players[2] = { ...mixed.players[2], botDifficulty: 'zen' };
  feed(mixed);
  assert.equal($('tableRuleBotLevel').textContent, 'Gemischt');

  // Back in a lobby (rematch): the table part goes again.
  feed(table({ phase: 'lobby' }));
  assert.ok(!shown('tableOptions'));
  assert.ok(shown('studioLogoItem'));
});

test('the rules open at the table, over the sheet; "Spielverlauf" opens the log', async (t) => {
  const { $, feed, click, shown, doc } = await setup(t);
  feed(table());
  click($('settingsBtn'));
  click($('tableRulesBtn'));
  assert.ok(shown('rulesOverlay'), 'openRules works at the table');
  assert.ok(shown('settingsOverlay'), 'the sheet stays beneath');
  const overlays = [...doc.querySelectorAll('.overlay')].map((o) => o.id);
  assert.ok(overlays.indexOf('rulesOverlay') > overlays.indexOf('settingsOverlay'), 'later in the DOM: stacks above the sheet');
  click($('rulesCloseBtn'));
  assert.ok(!shown('rulesOverlay'));
  assert.ok(shown('settingsOverlay'), 'closing the rules returns to the sheet');

  click($('tableLogBtn'));
  assert.ok(!shown('settingsOverlay'), 'the sheet closes, or the panel would open behind it');
  assert.ok(!$('logPanel').classList.contains('hidden'));
  assert.match($('logEntries').textContent, /Runde 2 gestartet/);
});

test('forfeit lives in the home dialog: two taps, the old server vote', async (t) => {
  const { $, feed, click, shown, doc, sent, toast } = await setup(t);
  feed(table());
  assert.equal(doc.querySelector('#settingsOverlay #forfeitBtn'), null, 'no longer among the preferences');
  click($('homeBtn'));
  assert.ok(shown('homeOverlay'));
  const btn = $('forfeitBtn');
  assert.ok(btn.closest('#homeOverlay') && shown('forfeitBtn'), 'next to "Tisch verlassen"');
  assert.equal(btn.previousElementSibling.id, 'homeConfirmBtn');
  assert.equal(btn.textContent, 'Spiel aufgeben');
  assert.equal($('forfeitHint').textContent, 'Die Partie endet sofort – ohne Sieger und ohne Wertung.', 'alone with bots it ends at once');
  click(btn);
  assert.equal(btn.textContent, 'Wirklich aufgeben?', 'the first tap only asks');
  assert.equal(sent.filter((m) => m.type === 'forfeitRound').length, 0);
  click(btn);
  assert.deepEqual(sent.filter((m) => m.type === 'forfeitRound'), [{ type: 'forfeitRound' }], 'the second tap votes');
  assert.ok(!shown('homeOverlay'), 'the dialog closes');
  assert.doesNotMatch(toast(), /anderen werden gefragt/, 'alone: nobody else to ask');
  // A reopened dialog starts unarmed.
  click($('homeBtn'));
  assert.equal(btn.textContent, 'Spiel aufgeben');
  assert.ok(!btn.classList.contains('armed'));
});

test('forfeit with others: the toast names the real button, withdrawing is one tap', async (t) => {
  const { $, feed, click, sent, toast, tick } = await setup(t);
  const votes = () => sent.filter((m) => m.type === 'forfeitRound').length;
  const btn = $('forfeitBtn');
  // I propose: two taps, and I hear that the others are asked.
  feed(withHuman());
  click($('homeBtn'));
  await tick();
  assert.match($('forfeitHint').textContent, /erst, wenn alle aktiven Spieler zustimmen/);
  click(btn);
  click(btn);
  assert.equal(votes(), 1);
  assert.match(toast(), /Du willst aufgeben – die anderen werden gefragt\./);

  // Someone else proposes: the toast says where the button really is.
  feed(withHuman({ forfeitVotes: ['p2'] }));
  assert.match(toast(), /Spiel aufgeben vorgeschlagen \(1\/2\)\. Zustimmen: Haus oben links › „Spiel aufgeben“\./);
  assert.doesNotMatch(toast(), /🏳/, 'no emoji standing in for a button');
  click($('homeBtn'));
  await tick();
  assert.equal(btn.textContent, 'Spiel aufgeben (1/2)');
  click(btn);
  assert.equal(votes(), 1, 'agreeing takes two taps too');
  click(btn);
  assert.equal(votes(), 2);

  // My vote stands: one tap takes it back.
  feed(withHuman({ forfeitVotes: ['p1'] }));
  click($('homeBtn'));
  assert.equal(btn.textContent, 'Aufgeben zurückziehen (1/2)');
  click(btn);
  assert.equal(votes(), 3, 'withdrawing is one tap');
  assert.ok($('homeOverlay').classList.contains('hidden'));
});

test('forfeit: not in the tutorial, and only while the game runs', async (t) => {
  const { $, feed, click, shown } = await setup(t);
  feed(table({ tutorialMode: true }));
  click($('homeBtn'));
  assert.ok(!shown('forfeitBtn'), 'practice never blocks a new game: nothing to give up');
  click($('homeCancelBtn'));
  feed(table({ phase: 'roundEnd' }));
  assert.ok(!shown('forfeitBtn'), 'round end has its own button on the result sheet');
});

test('a language change at the table re-renders the table and the sheet', async (t) => {
  const { $, feed, click, doc } = await setup(t);
  feed(table());
  click($('settingsBtn'));
  click($('langBtn'));
  assert.equal(doc.querySelector('#settingsOverlayTitle span').textContent, 'Options');
  assert.equal($('settingsBtn').title, 'Options');
  assert.equal(doc.querySelector('#tableOptions .prefGroupTitle').textContent, 'This table');
  assert.equal($('tableRuleHandAus').textContent, 'On');
  assert.equal($('tableRuleBotPace').textContent, 'Relaxed');
  assert.equal($('tableRuleBotLevel').textContent, 'Medium');
  assert.match($('myScore').textContent, /pts/, 'the table itself was rendered again');
  assert.equal(doc.querySelector('#opponents .opponent[data-player-id="b1"]').title, '1 card · 640 points');
  assert.equal($('forfeitBtn').textContent, 'Forfeit game');
  click($('langBtn'));
  assert.match($('myScore').textContent, /Pkt/);
  assert.equal($('tableRuleBotPace').textContent, 'Gemütlich');
});

test('switches replace the old cycling rows: tips toast and fullscreen', async (t) => {
  const { $, click, toast, fsCalls, shown } = await setup(t, { fullscreen: true });
  const tips = $('aidTipsCheckbox');
  assert.equal(tips.checked, true);
  click(tips);
  assert.match(toast(), /Spiel-Tipps sind aus\. Wieder einschalten: in den Optionen\./);
  assert.ok(shown('fullscreenItem'), 'fullscreen where the browser supports it');
  assert.ok($('fullscreenItem').closest('.prefGroup').querySelector('.prefGroupTitle').textContent === 'Darstellung');
  click($('fullscreenCheckbox'));
  assert.deepEqual(fsCalls, ['request']);
});

test('fullscreen stays hidden without the Fullscreen API (iPhone Safari)', async (t) => {
  const { shown } = await setup(t);
  assert.ok(!shown('fullscreenItem'));
});

test('wording: the table says "Optionen"; the game lobby hint names what is locked', () => {
  const client = fs.readFileSync(path.join(pub, 'client.js'), 'utf8');
  for (const m of client.matchAll(/L\(\s*(['`])((?:(?!\1).)*)\1/g)) {
    assert.doesNotMatch(m[2], /Einstellungen/, `"${m[2]}" - the sheet is called "Optionen" everywhere`);
  }
  const doc = new JSDOM(html).window.document;
  const visible = [...doc.querySelectorAll('body *')]
    .filter((n) => !n.closest('script, style, svg, .seoIntro') && !n.children.length)
    .map((n) => n.textContent)
    .concat([...doc.querySelectorAll('[title],[aria-label]')].map((n) => `${n.title} ${n.getAttribute('aria-label') || ''}`));
  assert.deepEqual(visible.filter((txt) => /Einstellungen/.test(txt)), []);
  assert.equal(doc.querySelector('#nonHostHint span').textContent, 'Nur der Organisator kann Spieleranzahl, Sitzordnung und Hausregeln ändern.');
});

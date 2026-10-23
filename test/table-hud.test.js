// v2.62.0: house rules as segment buttons and switches, the turn steps in the
// topbar, opponent chips with icons, the level badge only when levels differ
// and the low-card warning (play aid, default OFF). Real markup + client in jsdom.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const pub = path.join(__dirname, '..', 'public');

function boot(storage = {}) {
  const html = fs.readFileSync(path.join(pub, 'index.html'), 'utf8');
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
  for (const [k, v] of Object.entries(storage)) window.localStorage.setItem(k, v);
  for (const src of ['i18n.js', 'client.js']) window.eval(fs.readFileSync(path.join(pub, src), 'utf8'));
  window.document.dispatchEvent(new window.Event('DOMContentLoaded', { bubbles: true }));
  return { window, errors, sent, ws: () => ws };
}

async function setup(t, storage = {}) {
  const ctx = boot(storage);
  t.after(() => ctx.window.close());
  await new Promise((r) => setTimeout(r, 10));
  const sock = ctx.ws();
  sock._emit('message', { data: JSON.stringify({ type: 'joined', playerId: 'p1', playerToken: 't', sessionCode: 'ABCD' }) });
  const feed = (s) => sock._emit('message', { data: JSON.stringify({ type: 'state', state: s }) });
  const click = (node) => node.dispatchEvent(new ctx.window.MouseEvent('click', { bubbles: true }));
  return { ...ctx, feed, click, doc: ctx.window.document };
}

const card = (id, suit, rank) => ({ id, suit, rank });
const hand = [card('h1', 'H', '7'), card('h2', 'S', '2'), card('h3', 'C', '9'), card('h4', 'D', 'K')];
function table(extra = {}) {
  return {
    phase: 'playing', roundNumber: 2, currentPlayerId: 'p1', turnPhase: 'draw', dealerId: 'b1',
    turnDeadline: null, discardTop: { id: 'dt', suit: 'H', rank: 'Q' }, drawPileCount: 40, discardPileCount: 4,
    log: [], tableMelds: [], lobbyReady: [], nextRoundReady: [], houseRules: {},
    totals: { p1: 120, b1: 640, b2: 30, b3: 0 },
    players: [
      { id: 'p1', name: 'Flo', isBot: false, connected: true, handCount: hand.length, hand },
      { id: 'b1', name: 'Gisela', isBot: true, connected: true, handCount: 1, botDifficulty: 'medium' },
      { id: 'b2', name: 'Horst', isBot: true, connected: true, handCount: 2, botDifficulty: 'medium' },
      { id: 'b3', name: 'Renate', isBot: true, connected: true, handCount: 9, botDifficulty: 'medium' },
    ],
    ...extra,
  };
}
const steps = (doc) => [...doc.querySelectorAll('#turnStatus .turnStep')]
  .map((s) => `${s.className.replace('turnStep ', '')}:${s.textContent.trim()}`);

test('turn status: the steps of my turn, who is on turn otherwise, in both languages', async (t) => {
  const { doc, feed, click, errors } = await setup(t);
  feed(table());
  assert.deepEqual(steps(doc), ['current:Ziehen', 'todo:Legen', 'todo:Abwerfen']);
  assert.match(doc.querySelector('#turnStatus .visuallyHidden').textContent, /Karte ziehen/);
  feed(table({ turnPhase: 'meld' }));
  assert.deepEqual(steps(doc), ['done:Ziehen', 'current:Legen', 'next:Abwerfen'], 'drawn: lay, then discard');
  assert.ok(doc.querySelector('#turnStatus .turnStep.done use'), 'a done step carries its check');
  feed(table({ turnPhase: 'meld', mustLayOffCardId: 'h1' }));
  assert.deepEqual(steps(doc), ['done:Ziehen', 'current:Legen', 'todo:Abwerfen'], 'the taken discard must be laid before any discard');
  feed(table({ currentPlayerId: 'b2' }));
  assert.equal(doc.querySelector('#turnStatus .turnWho').textContent, 'Horst ist dran');
  assert.ok(doc.querySelector('#turnStatus .opAvatar'), 'with the avatar of the chip');
  feed(table({ phase: 'roundEnd' }));
  assert.equal(doc.getElementById('turnStatus').textContent, 'Runde vorbei', 'no stale "X is on turn" behind the result');
  feed(table({ turnPhase: 'meld' }));
  click(doc.getElementById('langBtn'));
  assert.deepEqual(steps(doc), ['done:Draw', 'current:Meld', 'next:Discard']);
  assert.deepEqual(errors, []);
});

test('turn status: the countdown has its own span and leaves the steps intact', async (t) => {
  const { doc, feed } = await setup(t);
  feed(table({ turnDeadline: Date.now() + 30000 }));
  assert.match(doc.getElementById('turnTimer').textContent, /^⏱(29|30)s$/);
  assert.equal(doc.querySelectorAll('#turnStatus .turnStep').length, 3, 'the timer must not overwrite the steps');
  feed(table());
  assert.equal(doc.getElementById('turnTimer').textContent, '', 'no deadline, no countdown');
});

test('opponent chips: cards as icon + number, the total without "Kt · Pkt"', async (t) => {
  const { doc, feed } = await setup(t);
  feed(table());
  const chip = doc.querySelector('#opponents .opponent[data-player-id="b1"]');
  assert.equal(chip.querySelector('.opCards b').textContent, '1');
  assert.ok(chip.querySelector('.opCards use[href="#i-cards"]'));
  assert.equal(chip.querySelector('.opPts').textContent, '640');
  assert.doesNotMatch(chip.querySelector('.opCount').textContent, /Kt|Pkt/);
  assert.equal(chip.title, '1 Karte · 640 Punkte', 'the full words stay in the tooltip');
});

test('low-card warning: default OFF; the switch tags 1 and 2 cards and is stored per device', async (t) => {
  const { doc, feed, click, window } = await setup(t);
  feed(table());
  assert.equal(doc.querySelectorAll('#opponents .lowCards, #opponents .opLowTag').length, 0, 'a fresh device shows no warning');
  assert.equal(doc.getElementById('aidLowCardsCheckbox').checked, false);
  click(doc.getElementById('aidLowCardsCheckbox'));
  assert.equal(window.localStorage.getItem('pikdame_aid_lowcards'), 'on');
  assert.equal(doc.getElementById('aidLowCardsCheckbox').checked, true, 'the switch shows the new state');
  const tag = (id) => doc.querySelector(`#opponents .opponent[data-player-id="${id}"] .opLowTag`);
  assert.equal(tag('b1').textContent, 'Letzte Karte!');
  assert.equal(tag('b2').textContent, 'Noch 2 Karten!');
  assert.equal(tag('b3'), null, 'nine cards: nothing to warn about');
  assert.ok(doc.querySelector('#opponents .opponent[data-player-id="b1"]').classList.contains('lowCards'));
  feed(table({ phase: 'roundEnd' }));
  assert.equal(doc.querySelectorAll('#opponents .opLowTag').length, 0, 'only while the round is played');
});

test('low-card warning: a stored ON is honoured on start, the settings switch turns it off', async (t) => {
  const { doc, feed, window } = await setup(t, { pikdame_aid_lowcards: 'on' });
  feed(table());
  assert.equal(doc.querySelectorAll('#opponents .opLowTag').length, 2);
  const box = doc.getElementById('aidLowCardsCheckbox');
  box.checked = false;
  box.dispatchEvent(new window.Event('change', { bubbles: true }));
  assert.equal(doc.querySelectorAll('#opponents .opLowTag').length, 0);
  assert.equal(window.localStorage.getItem('pikdame_aid_lowcards'), 'off');
});

test('a dropped human: "getrennt" hangs on the bottom edge, the name keeps its row; the low-card warning goes first', async (t) => {
  const { doc, feed, click } = await setup(t);
  const dropped = (handCount = 9) => {
    const s = table();
    s.players[3] = { id: 'p2', name: 'Oma Gerda', isBot: false, connected: false, controlledByBot: true, handCount };
    return s;
  };
  const chip = () => doc.querySelector('#opponents .opponent[data-player-id="p2"]');
  feed(dropped());
  assert.ok(chip().classList.contains('disconnected'));
  assert.deepEqual([...chip().querySelector('.opName').children].map((c) => c.className), ['opSeat', 'opNameText'], 'nothing beside the name');
  assert.equal(chip().querySelector('.opLowTag.reconnectTag').textContent, 'getrennt');
  click(doc.getElementById('aidLowCardsCheckbox'));
  feed(dropped(2));
  assert.equal(chip().querySelectorAll('.opLowTag').length, 1, 'one edge slot');
  assert.equal(chip().querySelector('.opLowTag').textContent, 'Noch 2 Karten!');
  assert.ok(chip().classList.contains('disconnected'), 'the dimmed face still says offline');
  click(doc.getElementById('langBtn'));
  feed(dropped());
  assert.equal(chip().querySelector('.reconnectTag').textContent, 'offline');
});

test('bot level badge: the host always, guests only for mixed levels; in the game never the word, the name in title/aria-label', async (t) => {
  const { doc, feed, click } = await setup(t);
  const badges = () => [...doc.querySelectorAll('#opponents .botDiffBadge')];
  feed(table({ isHost: true }));
  assert.equal(badges().length, 3, 'the host keeps the tap target to change one bot');
  assert.ok(badges().every((b) => b.textContent === ''), 'no "Mittel" three times');
  assert.match(badges()[0].getAttribute('aria-label'), /Schwierigkeit ändern \(Mittel\)/);
  assert.equal(badges()[0].title, badges()[0].getAttribute('aria-label'), 'the tooltip names the level too');
  assert.ok(badges().every((b) => b.classList.contains('tapExpand')), 'the host keeps the 44 px hit area');
  click(badges()[0]);
  assert.ok(!doc.getElementById('botDiffOverlay').classList.contains('hidden'), 'the badge still opens the picker');
  feed(table({ isHost: false }));
  assert.equal(badges().length, 0, 'guests: nothing to tell when all bots are equal');
  const mixed = table({ isHost: false });
  mixed.players[2] = { ...mixed.players[2], botDifficulty: 'hard' };
  feed(mixed);
  assert.ok(badges().every((b) => b.textContent === ''), 'mixed levels: still the symbol alone');
  assert.deepEqual(badges().map((b) => b.getAttribute('aria-label')).sort(), ['Schwierigkeit: Mittel', 'Schwierigkeit: Mittel', 'Schwierigkeit: Schwer']);
  assert.ok(badges().every((b) => b.title === b.getAttribute('aria-label') && b.classList.contains('readonly')));
});

function lobby(extra = {}) {
  return {
    phase: 'lobby', isHost: true, maxSeats: 4, lobbyReady: [], log: [], tableMelds: [], nextRoundReady: [],
    totals: {}, botLevel: 'medium', houseRules: { turnTimerSeconds: 60, botPace: 'slow' },
    players: [
      { id: 'p1', name: 'Flo', isBot: false, connected: true, handCount: 0 },
      { id: 'b1', name: 'Gisela', isBot: true, connected: true, handCount: 0, botDifficulty: 'medium' },
      { id: 'b2', name: 'Horst', isBot: true, connected: true, handCount: 0, botDifficulty: 'medium' },
    ],
    ...extra,
  };
}
const active = (doc, sel) => [...doc.querySelectorAll(`.segmented[data-select="${sel}"] .segBtn.active`)].map((b) => b.dataset.value);

test('house rules: segments mirror the host settings and send changes through the hidden select', async (t) => {
  const { doc, feed, click, sent } = await setup(t);
  feed(lobby());
  assert.deepEqual(active(doc, 'ruleTurnTimer'), ['60']);
  assert.deepEqual(active(doc, 'ruleBotPace'), ['slow']);
  assert.deepEqual(active(doc, 'ruleBotLevel'), ['medium']);
  assert.equal(doc.querySelector('.segmented[data-select="ruleTurnTimer"] .segBtn[data-value="60"]').getAttribute('aria-pressed'), 'true');
  click(doc.querySelector('.segmented[data-select="ruleTurnTimer"] .segBtn[data-value="90"]'));
  const rules = sent.filter((m) => m.type === 'setHouseRules').pop();
  assert.equal(rules.houseRules.turnTimerSeconds, 90);
  assert.equal(rules.houseRules.botPace, 'slow', 'the other rules travel unchanged');
  click(doc.querySelector('.segmented[data-select="ruleBotLevel"] .segBtn[data-value="hard"]'));
  assert.deepEqual(sent.filter((m) => m.type === 'setAllBotDifficulty').pop(), { type: 'setAllBotDifficulty', difficulty: 'hard' });
  const mixed = lobby();
  mixed.players[2] = { ...mixed.players[2], botDifficulty: 'zen' };
  feed(mixed);
  assert.deepEqual(active(doc, 'ruleBotLevel'), [], 'mixed levels: no segment is active');
  assert.ok(!doc.getElementById('ruleBotLevelMixed').classList.contains('hidden'), 'mixed levels get the hint');
});

test('house rules: guests see the choice but cannot change it; the switches are whole-row labels', async (t) => {
  const { doc, feed, click, sent } = await setup(t);
  feed(lobby({ isHost: false }));
  const segs = [...doc.querySelectorAll('#houseRulesSection .segBtn')];
  assert.ok(segs.length >= 11 && segs.every((b) => b.disabled), 'every segment is locked for guests');
  assert.deepEqual(active(doc, 'ruleTurnTimer'), ['60'], 'the chosen value stays visible');
  click(doc.querySelector('.segmented[data-select="ruleTurnTimer"] .segBtn[data-value="0"]'));
  assert.equal(sent.filter((m) => m.type === 'setHouseRules').length, 0);
  const hand = doc.getElementById('ruleHandAus');
  assert.ok(hand.disabled && hand.classList.contains('ruleSwitch'));
  assert.equal(hand.closest('label').querySelector('span').textContent, 'Hand aus zählt doppelt', 'the label is a leaf the i18n can translate');
});

test('sound is a device setting in the settings sheet, no longer a house rule', async (t) => {
  const { doc, window } = await setup(t);
  assert.equal(doc.getElementById('ruleSound'), null);
  assert.equal(doc.querySelector('#houseRulesSection input[type="checkbox"][id*="Sound"]'), null);
  const box = doc.getElementById('soundCheckbox');
  assert.ok(box.closest('#settingsOverlay'), 'the switch lives in the settings sheet');
  assert.equal(box.checked, true, 'on by default, as before');
  box.checked = false;
  box.dispatchEvent(new window.Event('change', { bubbles: true }));
  assert.equal(window.localStorage.getItem('pikdame_sound_enabled'), 'off', 'same storage key as before');
  assert.equal(doc.getElementById('soundToggle'), null, 'one switch, no in-game row to keep in step');
});

test('settings sheet: four groups (plus "Dieser Tisch" at the table), language in the header, segments drive the display size', async (t) => {
  const { doc, window, click } = await setup(t);
  const sheet = doc.getElementById('settingsOverlay');
  assert.ok(doc.getElementById('langBtn').closest('.prefHead'), 'the language switch sits in the sheet header');
  assert.equal(doc.getElementById('langBtn').textContent, 'English', 'it names the other language');
  const groups = [...sheet.querySelectorAll('.prefGroup')].map((g) => [
    g.querySelector('.prefGroupTitle').textContent,
    [...g.querySelectorAll('[id]')].map((n) => n.id).filter((id) => /Checkbox$|Select$|Btn$/.test(id) && id !== 'celebrationPreviewBtn'),
  ]);
  assert.deepEqual(groups, [
    ['Dieser Tisch', ['towerPanelBtn', 'tableRulesBtn', 'tableLogBtn']],
    ['Ton', ['soundCheckbox', 'musicLevelSelect', 'musicTrackSelect']],
    ['Darstellung', ['uiScaleSelect', 'cardbackBtn', 'fullscreenCheckbox', 'celebrationSelect']],
    ['Spielhilfen', ['tutorialHintsCheckbox', 'aidTipsCheckbox', 'aidDiscardCheckbox', 'aidLayOffCheckbox', 'aidLowCardsCheckbox', 'botQuipsCheckbox']],
    ['Allgemein', ['versionBtn', 'studioLogoSelect', 'debugCheckbox']],
  ]);
  assert.ok(doc.getElementById('tableOptions').classList.contains('hidden'), '"Dieser Tisch" only at the table');
  assert.equal(sheet.querySelectorAll('.prefSwatches .themeBtn').length, 6, 'the theme swatches live under Darstellung');
  assert.equal(sheet.querySelectorAll('.prefNote').length, 1, 'the device note is said once');
  assert.equal(doc.getElementById('themeNameValue').textContent, 'Spieltisch', 'the active theme is named');

  const seg = (v) => sheet.querySelector(`.segmented[data-select="uiScaleSelect"] .segBtn[data-value="${v}"]`);
  click(seg('xlarge'));
  assert.equal(doc.getElementById('uiScaleSelect').value, 'xlarge');
  assert.equal(window.localStorage.getItem('pikdame_ui_scale'), 'xlarge', 'same storage key as before');
  assert.equal(doc.documentElement.dataset.uiscale, 'xlarge');
  click(seg('normal')); // Sehr groß -> Normal in one tap (the old row cycled through every size)
  assert.equal(doc.getElementById('uiScaleSelect').value, 'normal');
  assert.equal(seg('xlarge').classList.contains('active'), false);
  assert.equal(doc.getElementById('uiScaleBtn'), null, 'no cycling row');

  click(doc.getElementById('langBtn'));
  assert.equal(doc.getElementById('langBtn').textContent, 'Deutsch');
  assert.ok(doc.querySelector('#langBtn svg use[href="#i-globe"]'), 'the globe icon survives the switch');
  assert.deepEqual([...sheet.querySelectorAll('.prefGroupTitle')].map((n) => n.textContent), ['This table', 'Sound', 'Display', 'Play aids', 'General']);
  assert.deepEqual([...sheet.querySelectorAll('.prefScaleSeg .segBtn')].map((n) => n.textContent), ['Normal', 'Large', 'Extra large']);
  assert.equal(doc.getElementById('themeNameValue').textContent, 'Table');
  assert.equal(doc.querySelector('#studioLogoSelect option[value="auto"]').textContent, 'Once only');
});

test('one name per bot level: the strength picker uses the seat names', async (t) => {
  const { doc, feed, click } = await setup(t);
  feed(lobby());
  click(doc.querySelector('#seatingList .seatDiff'));
  const options = [...doc.querySelectorAll('#botDiffOptions button')].map((b) => b.firstElementChild.nextElementSibling.firstChild.textContent);
  assert.deepEqual(options, ['Leicht', 'Mittel', 'Schwer', 'Zen']);
  assert.doesNotMatch(doc.getElementById('botDiffOptions').textContent, /Fortgeschritten|Profi|Zen-Meister/);
});

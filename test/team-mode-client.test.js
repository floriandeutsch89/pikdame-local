// "2 gegen 2" in the client (jsdom, real index.html + client.js): the one-tap
// start, the lobby's mode choice, team rows and team names, the team marks at the
// table (ring + "Team" tab), the team result sheets and "Meine Partien".
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const pub = path.join(__dirname, '..', 'public');
const html = fs.readFileSync(path.join(pub, 'index.html'), 'utf8');

function boot(storage = {}) {
  const dom = new JSDOM(html, { url: 'https://play.example/', runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;
  const errors = [];
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
  window.navigator.vibrate = () => true;
  window.scrollTo = () => {};
  window.Element.prototype.scrollIntoView = () => {};
  window.requestAnimationFrame = () => 0;
  window.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve({}), text: () => Promise.resolve('') });
  let ws = null;
  const sent = [];
  window.WebSocket = class {
    constructor() { this._ls = {}; ws = this; this.readyState = 1; setTimeout(() => this._emit('open', {}), 0); }
    addEventListener(t, f) { (this._ls[t] = this._ls[t] || []).push(f); }
    removeEventListener() {}
    _emit(t, ev) { if (typeof this['on' + t] === 'function') this['on' + t](ev); for (const f of this._ls[t] || []) f(ev); }
    send(raw) { try { sent.push(JSON.parse(raw)); } catch (e) { /* not JSON */ } }
    close() {}
  };
  window.WebSocket.OPEN = 1;
  window.onerror = (msg) => errors.push(String(msg));
  window.addEventListener('error', (e) => errors.push(String(e.message || e.error)));
  for (const [k, v] of Object.entries(storage)) window.localStorage.setItem(k, v);
  for (const src of ['i18n.js', 'client.js']) window.eval(fs.readFileSync(path.join(pub, src), 'utf8'));
  window.document.dispatchEvent(new window.Event('DOMContentLoaded', { bubbles: true }));
  return { window, errors, sent, ws: () => ws };
}

async function setup(t, { join = true, storage = { pikdame_player_name: 'Flo' } } = {}) {
  const ctx = boot(storage);
  t.after(() => ctx.window.close());
  await new Promise((r) => setTimeout(r, 10));
  const sock = ctx.ws();
  const msg = (m) => sock._emit('message', { data: JSON.stringify(m) });
  if (join) msg({ type: 'joined', playerId: 'p1', playerToken: 't', sessionCode: 'ABCD' });
  const feed = (s) => msg({ type: 'state', state: s });
  const click = (node) => node.dispatchEvent(new ctx.window.MouseEvent('click', { bubbles: true }));
  return { ...ctx, doc: ctx.window.document, feed, msg, click, sentOf: (type) => ctx.sent.filter((m) => m.type === type) };
}

// Flo + Oma Gerda (team A, seats 0+2) against the bots Klaus + Horst (team B, seats 1+3).
const TEAMS = [['p1', 'p2'], ['b1', 'b2']];
const PLAYERS = [
  { id: 'p1', name: 'Flo', isBot: false, connected: true, handCount: 9, hand: [] },
  { id: 'b1', name: 'Klaus', isBot: true, connected: true, handCount: 5, botDifficulty: 'medium' },
  { id: 'p2', name: 'Oma Gerda', isBot: false, connected: true, handCount: 3 },
  { id: 'b2', name: 'Horst', isBot: true, connected: true, handCount: 7, botDifficulty: 'medium' },
];
const BASE = {
  roundNumber: 3, currentPlayerId: 'b1', turnPhase: 'draw', dealerId: 'b2', isHost: true, maxSeats: 4,
  discardTop: { id: 'dt', suit: 'C', rank: '10' }, drawPileCount: 38, discardPileCount: 5, log: [], tableMelds: [],
  lobbyReady: [], nextRoundReady: [], houseRules: {}, players: PLAYERS, teamMode: true, teams: TEAMS,
  totals: { p1: 240, b1: 420, p2: 310, b2: 180 }, teamTotals: [550, 600], teamNames: [null, null], targetScore: 2000,
};
const mk = (s, win) => ({ roundScore: s, breakdown: { isWinner: !!win, multiplier: 1 } });

test('start screen: "2 gegen 2" deals you and a bot against two bots in one tap', async (t) => {
  const { doc, click, sentOf, errors } = await setup(t, { join: false });
  const tiles = [...doc.querySelectorAll('.menuChips button')];
  assert.deepEqual(tiles.map((b) => b.id), ['tutorialBtn', 'teamQuickBtn', 'stammtischBtn']);
  const tile = doc.getElementById('teamQuickBtn');
  assert.equal(tile.querySelector('span').textContent, '2 gegen 2');
  assert.equal(tile.querySelector('use').getAttribute('href'), '#i-teams');
  click(tile);
  const [create] = sentOf('createSession');
  assert.ok(create, 'createSession sent');
  assert.equal(create.teamMode, true);
  assert.equal(create.quickStart, true);
  assert.equal(create.name, 'Flo');
  // The plain "Neues Spiel" stays a normal table.
  click(doc.getElementById('createGameBtn'));
  const plain = sentOf('createSession')[1];
  assert.ok(plain && !plain.teamMode && !plain.quickStart);
  assert.deepEqual(errors, []);
});

test('lobby: "2 gegen 2" is the fourth seat choice, every seat shows its team, the switch and one bot level', async (t) => {
  const { doc, feed, click, sentOf, errors } = await setup(t);
  const lobby = { ...BASE, phase: 'lobby', players: PLAYERS.map((p) => ({ ...p, handCount: 0 })) };
  feed({ ...lobby, teamMode: false, teams: null, teamTotals: null, teamNames: null, targetScore: 1000 });
  assert.equal(doc.getElementById('ruleStrictLabel').textContent, 'Über 1000 Punkte zum Gewinnen (genau 1000 reicht nicht)');
  assert.ok(doc.getElementById('teamNamesBox').classList.contains('hidden'), 'no team names at a normal table');
  const modeBtn = doc.getElementById('teamModeBtn');
  assert.ok(!modeBtn.classList.contains('active') && !modeBtn.classList.contains('hidden'));
  assert.ok(doc.querySelector('.seatCountBtn[data-seat-count="4"]').classList.contains('active'));
  assert.equal(doc.querySelectorAll('#seatingList .teamTag').length, 0, 'no team marks at a normal table');
  assert.ok(doc.getElementById('switchTeamBtn').classList.contains('hidden'));
  click(modeBtn);
  assert.deepEqual(sentOf('setTeamMode').pop(), { type: 'setTeamMode', on: true });

  feed(lobby);
  assert.ok(modeBtn.classList.contains('active'));
  assert.equal(modeBtn.getAttribute('aria-pressed'), 'true');
  assert.ok(!doc.querySelector('.seatCountBtn[data-seat-count="4"]').classList.contains('active'), 'the mode, not the count, is chosen');
  assert.match(doc.getElementById('seatCountHint').textContent, /über Kreuz.*bis 2000/);
  assert.equal(doc.getElementById('ruleStrictLabel').textContent, 'Über 2000 Punkte zum Gewinnen (genau 2000 reicht nicht)');
  const rows = [...doc.querySelectorAll('#seatingList .seatRow')];
  assert.deepEqual(rows.map((r) => r.querySelector('.teamTag').textContent.trim()), ['A', 'B', 'A', 'B'], 'crosswise: A, B, A, B');
  // All bots share one level: the chip shows the symbol, its name moves into title and aria-label.
  const chip = rows[1].querySelector('.seatDiff');
  assert.ok(chip.classList.contains('iconOnly'));
  assert.equal(chip.textContent.trim(), '');
  assert.match(chip.getAttribute('aria-label'), /alle.*Mittel/);
  assert.ok(!doc.getElementById('ruleBotLevelTeam').classList.contains('hidden'), 'the one-level note shows');
  click(chip);
  assert.equal(doc.getElementById('botDiffTitle').textContent, 'Bot-Stärke (alle Bots)');
  const zen = [...doc.querySelectorAll('#botDiffOptions button')].pop();
  assert.match(zen.textContent, /wie Schwer/, 'Zen plays its heuristic at a team table');
  click(zen);
  assert.deepEqual(sentOf('setAllBotDifficulty').pop(), { type: 'setAllBotDifficulty', difficulty: 'zen' });
  assert.equal(sentOf('setBotDifficulty').length, 0, 'never one bot alone');

  // Both humans in team A: no bot seat left there for Oma Gerda, but one in B for me.
  const sw = doc.getElementById('switchTeamBtn');
  assert.ok(!sw.classList.contains('hidden'), 'a bot seat in the other team: the switch shows');
  click(sw);
  assert.deepEqual(sentOf('switchTeam').pop(), { type: 'switchTeam' });
  // Four humans: nobody can switch by himself (the host reorders the seats).
  feed({ ...lobby, players: lobby.players.map((p) => ({ ...p, isBot: false, botDifficulty: undefined })) });
  assert.ok(sw.classList.contains('hidden'));

  // Back to a normal table: the count button turns the mode off first.
  click(doc.querySelector('.seatCountBtn[data-seat-count="4"]'));
  assert.deepEqual(sentOf('setTeamMode').pop(), { type: 'setTeamMode', on: false });
  assert.deepEqual(sentOf('setMaxSeats').pop(), { type: 'setMaxSeats', count: 4 });
  assert.deepEqual(errors, []);
});

test('lobby: a Stammtisch table offers no "2 gegen 2" (its record counts every player alone)', async (t) => {
  const { doc, feed, msg, errors } = await setup(t, { join: false });
  msg({ type: 'joined', playerId: 'p1', playerToken: 't', sessionCode: 'ABCD', stammtisch: { code: 'ST1', name: 'Familie' } });
  feed({ ...BASE, phase: 'lobby', teamMode: false, teams: null, teamTotals: null });
  assert.ok(doc.getElementById('teamModeBtn').classList.contains('hidden'));
  assert.deepEqual(errors, []);
});

test('table: my team ringed with a "Team" tab (partner chip, both own meld blocks), the rivals striped, bars to 2000, "Wir 550:600 Gegner"', async (t) => {
  const { doc, feed, errors } = await setup(t);
  feed({
    ...BASE, phase: 'playing',
    tableMelds: [
      { id: 1, ownerId: 'p2', type: 'set', rank: '7', slots: ['H', 'D', 'S'].map((s) => ({ real: { id: `7${s}`, suit: s, rank: '7' } })) },
      { id: 2, ownerId: 'p1', type: 'set', rank: '9', slots: ['H', 'D', 'S'].map((s) => ({ real: { id: `9${s}`, suit: s, rank: '9' } })) },
      { id: 3, ownerId: 'b1', type: 'set', rank: '5', slots: ['H', 'D', 'S'].map((s) => ({ real: { id: `5${s}`, suit: s, rank: '5' } })) },
    ],
  });
  const chips = [...doc.querySelectorAll('#opponents .opponent')];
  assert.deepEqual(chips.map((c) => c.dataset.playerId), ['b1', 'p2', 'b2'], 'turn order: an opponent, the partner, an opponent');
  assert.ok(chips.every((c) => c.classList.contains('teamChip')));
  assert.deepEqual(chips.map((c) => c.classList.contains('isPartner')), [false, true, false]);
  assert.equal(chips[1].querySelector('.opPartnerTag').textContent, 'Team', 'the partner wears "Team"');
  assert.equal(doc.querySelectorAll('.opPartnerTag').length, 1, 'an unnamed rival team gets no tab (a "Team" there would read as mine)');
  assert.match(chips[1].title, /Dein Team$/, 'the chip title names the team');
  assert.match(chips[0].title, /Gegner$/, 'a rival chip says so in its title');
  assert.equal(chips[1].style.getPropertyValue('--team-c'), '#2a78d6', 'team A: the first seat colour');
  assert.equal(chips[0].style.getPropertyValue('--team-c'), '#eb6834', 'team B: the second seat colour');
  // The number stays the seat's own, the bar is the team's: own share solid, partner lighter.
  assert.equal(chips[0].querySelector('.opPts').textContent, '420');
  const bar = chips[0].querySelector('.teamBar');
  assert.equal(bar.querySelector('.tbOwn').style.width, '21%', '420 of the team target 2000');
  assert.equal(bar.querySelector('.tbMate').style.width, '9%');
  assert.match(bar.title, /Team: 600 von 2000/);
  const score = doc.getElementById('myScore');
  assert.equal(score.textContent.replace(/\s+/g, ' ').trim(), 'Wir 550:600 Gegner', 'both teams named, like a scoreboard');
  assert.match(score.title, /Dein Team 550.*Gegner 600 - 2000 gewinnen/);
  assert.deepEqual([...score.querySelectorAll('b')].map((b) => b.className), ['trail', ''], 'the leader by weight: the trailing number is muted');
  const myBar = doc.getElementById('myScoreBar');
  assert.ok(myBar.classList.contains('teamBar'));
  assert.equal(myBar.querySelector('.tbOwn').style.width, '12%');
  assert.equal(myBar.querySelector('.tbMate').style.width, '15.5%');
  const headerOf = (text) => [...doc.querySelectorAll('.meldOwnerHeader')].find((h) => h.textContent.includes(text));
  const header = headerOf('Oma Gerda');
  assert.equal(header.querySelector('.meldTeamTag').textContent, 'Team', 'the partner\'s melds say so');
  // My team's blocks (mine and the partner's) wear the chip's ring in the team colour.
  const block = header.closest('.meldOwnerGroup');
  assert.ok(block.classList.contains('teamOwn'));
  assert.equal(block.style.getPropertyValue('--team-c'), '#2a78d6');
  const mine = headerOf('Deine Auslagen');
  assert.ok(mine.closest('.meldOwnerGroup').classList.contains('own') && mine.closest('.meldOwnerGroup').classList.contains('teamOwn'));
  assert.equal(mine.querySelector('.meldTeamTag').textContent, 'Team', '"Deine Auslagen" carries the team tab too');
  assert.equal(doc.querySelectorAll('.meldOwnerGroup.teamOwn').length, 2);
  // The rival's block: the quiet stripe in its colour, no tab while the team has no name.
  const rival = headerOf('Klaus').closest('.meldOwnerGroup');
  assert.ok(rival.classList.contains('teamRival') && !rival.classList.contains('teamOwn'));
  assert.equal(rival.style.getPropertyValue('--team-c'), '#eb6834');
  assert.equal(rival.querySelectorAll('.meldTeamTag').length, 0);
  // "Optionen" › "Dieser Tisch" names the mode and the partner.
  assert.ok(!doc.getElementById('tableRuleModeRow').classList.contains('hidden'));
  assert.equal(doc.getElementById('tableRuleMode').textContent, '2 gegen 2, mit Oma Gerda');
  assert.equal(doc.getElementById('tableRuleStrictLabel').textContent, 'Über 2000 Punkte zum Gewinnen');

  // A normal table keeps everything as it was.
  feed({
    ...BASE, phase: 'playing', teamMode: false, teams: null, teamTotals: null, teamNames: null, targetScore: 1000,
    tableMelds: [
      { id: 1, ownerId: 'p2', type: 'set', rank: '7', slots: ['H', 'D', 'S'].map((s) => ({ real: { id: `7${s}`, suit: s, rank: '7' } })) },
      { id: 2, ownerId: 'p1', type: 'set', rank: '9', slots: ['H', 'D', 'S'].map((s) => ({ real: { id: `9${s}`, suit: s, rank: '9' } })) },
      { id: 3, ownerId: 'b1', type: 'set', rank: '5', slots: ['H', 'D', 'S'].map((s) => ({ real: { id: `5${s}`, suit: s, rank: '5' } })) },
    ],
  });
  assert.equal(doc.querySelectorAll('.meldOwnerGroup').length, 3, 'precondition: all three blocks are shown');
  assert.equal(doc.querySelectorAll('#opponents .teamChip, #opponents .isPartner, .opPartnerTag, .meldOwnerGroup.teamOwn, .meldOwnerGroup.teamRival, .meldTeamTag').length, 0);
  assert.ok(doc.querySelector('.meldOwnerGroup.own'), 'my block keeps its accent look');
  assert.equal(doc.getElementById('myScore').textContent.trim(), '240 Pkt');
  assert.ok(!doc.getElementById('myScore').classList.contains('teamScore'));
  assert.ok(!doc.getElementById('myScoreBar').classList.contains('teamBar'));
  assert.equal(doc.getElementById('myScoreBar').querySelector('i').style.width, '24%');
  assert.equal(doc.getElementById('tableRuleStrictLabel').textContent, 'Über 1000 Punkte zum Gewinnen');
  assert.ok(doc.getElementById('tableRuleModeRow').classList.contains('hidden'));
  assert.deepEqual(errors, []);
});

test('round end: one block per team - its total and round first, the seats below, mine with the breakdown', async (t) => {
  const { doc, feed, errors } = await setup(t);
  feed({
    ...BASE, phase: 'roundEnd', lastRoundWinnerId: 'b1',
    totals: { p1: 240, b1: 600, p2: 375, b2: 245 }, teamTotals: [615, 845],
    lastRoundResult: { p1: mk(110), b1: mk(270, true), p2: mk(-45), b2: mk(-25) },
    lastRoundStats: [{ id: 'p1', name: 'Flo', laidOutCount: 3, handCount: 9, laidLines: [{ kind: 'low', count: 3, points: 30 }], handLines: [{ kind: 'face', count: 8, points: 80 }] }],
  });
  const blocks = [...doc.querySelectorAll('#resultBody .teamResult')];
  assert.equal(blocks.length, 2);
  const head = (b) => [...b.querySelectorAll('.teamResultHead .resultRowTop > span')].map((n) => n.textContent.trim());
  assert.deepEqual(head(blocks[0]), ['Gegner', 'gesamt 845', '+245'], 'the better round first');
  assert.deepEqual(head(blocks[1]), ['Dein Team', 'gesamt 615', '+65']);
  assert.ok(blocks[1].classList.contains('isMine'));
  const members = (b) => [...b.querySelectorAll('.teamMember .tmName')].map((n) => n.textContent.replace(/\s.*$/, ''));
  assert.deepEqual(members(blocks[0]), ['Klaus', 'Horst']);
  assert.deepEqual(members(blocks[1]), ['Flo', 'Oma']);
  const me = blocks[1].querySelector('.teamMember.isMe');
  assert.deepEqual([...me.querySelectorAll('.tmTop > span')].map((n) => n.textContent.trim()), ['Flo', 'gesamt 240', '+110']);
  assert.ok(me.querySelector('details.resultBreakdown'), 'my breakdown stays');
  assert.ok(blocks[0].querySelector('.teamMember.winner'), 'whoever went out keeps the weight');
  assert.equal(doc.querySelectorAll('#resultBody .resultSort').length, 0, 'the teams are the order: no sort switch');
  assert.match(doc.querySelector('#resultBody .resultWinner').textContent, /Klaus.*gewinnt die Runde/, 'whoever went out still heads the sheet');
  assert.deepEqual(errors, []);
});

test('game over: the winning team in the headline, team place and gap, two chart lines', async (t) => {
  const { doc, feed, msg, errors } = await setup(t);
  const over = (winnerTeam) => ({
    ...BASE, phase: 'gameOver', roundNumber: 2, lastRoundWinnerId: winnerTeam === 0 ? 'p1' : 'b1',
    totals: winnerTeam === 0 ? { p1: 1145, b1: 980, p2: 900, b2: 900 } : { p1: 980, b1: 1145, p2: 900, b2: 900 },
    teamTotals: winnerTeam === 0 ? [2045, 1880] : [1880, 2045],
    scoreHistory: [
      { round: 1, totals: { p1: 600, b1: 600, p2: 600, b2: 600 }, teamTotals: [1200, 1200] },
      { round: 2, totals: {}, teamTotals: winnerTeam === 0 ? [2045, 1880] : [1880, 2045] },
    ],
    lastRoundResult: { p1: mk(180, winnerTeam === 0), b1: mk(225, winnerTeam === 1), p2: mk(60), b2: mk(110) },
    gameOverInfo: { winnerId: null, teamMode: true, teams: TEAMS, winnerTeam, winnerIds: TEAMS[winnerTeam], teamTotals: winnerTeam === 0 ? [2045, 1880] : [1880, 2045], targetScore: 2000, totalTurns: 236, totalRounds: 2, highlights: [] },
  });
  feed(over(1));
  msg({ type: 'progress', gainedXp: 98, xp: 5440, level: { level: 14 }, record: { played: 43, won: 17 } });
  const hero = doc.querySelector('#resultBody .resultWinnerGame');
  assert.ok(!hero.classList.contains('isMe'));
  assert.equal(hero.querySelector('.resultWinnerName').textContent, 'Klaus & Horst');
  assert.equal(hero.querySelector('.resultWinnerSub').textContent, 'gewinnen die Partie');
  const blocks = [...doc.querySelectorAll('#resultBody .teamResult')];
  assert.match(blocks[0].textContent, /1\.\s*Gegner/);
  assert.ok(blocks[0].classList.contains('won'));
  assert.equal(doc.querySelector('#resultMe .rmPlace').textContent, 'Platz 2');
  assert.match(doc.querySelector('#resultMe .rmGap').textContent, /165 hinter Klaus & Horst/);
  const labels = [...doc.querySelectorAll('.scoreChart .endLabel')].map((l) => l.textContent.replace(/\s+/g, ' ').trim());
  assert.deepEqual(labels.sort(), ['● Gegner 2.045', '● Wir 1.880']);
  assert.ok([...doc.querySelectorAll('.scoreChart .goalLine')].length === 1 && [...doc.querySelectorAll('.scoreChart .axisLabel.goal')].pop().textContent === '2.000', 'the goal line sits at 2000');

  feed(over(0));
  const won = doc.querySelector('#resultBody .resultWinnerGame');
  assert.ok(won.classList.contains('isMe'), 'my team\'s win gets the gold banner');
  assert.equal(won.textContent.trim(), 'Dein Team gewinnt die Partie!');
  assert.equal(doc.querySelector('#resultMe .rmPlace').textContent, 'Platz 1');
  assert.match(doc.querySelector('#resultMe .rmGap').textContent, /165 vor Klaus & Horst/);
  assert.deepEqual(errors, []);
});

test('"Meine Partien": a team game shows the team place, the partner and the team bars', async (t) => {
  const { doc, msg, click, errors } = await setup(t, { join: false });
  const g = {
    id: 'g1', finishedAt: Date.now() - 3600e3, startedAt: Date.now() - 3600e3 - 30 * 60e3, rounds: 4, won: true, myScore: 400, myId: 'p2',
    teamMode: true, teams: TEAMS, winnerIds: TEAMS[0], winnerTeam: 0, teamTotals: [2045, 1880], targetScore: 2000, teamNames: [null, null],
    players: [{ id: 'p1', name: 'Oma Gerda' }, { id: 'b1', name: 'Klaus', isBot: true, botDifficulty: 'medium' }, { id: 'p2', name: 'Flo' }, { id: 'b2', name: 'Horst', isBot: true, botDifficulty: 'medium' }],
    finalTotals: { p1: 1145, b1: 980, p2: 900, b2: 900 },
    roundTotals: [{ p1: 300, b1: 200, p2: 100, b2: 150 }, { p1: 1145, b1: 980, p2: 900, b2: 900 }],
  };
  click(doc.getElementById('statsBtn'));
  click(doc.getElementById('statsTabHistoryBtn'));
  msg({ type: 'gameHistory', games: [g] });
  const card = doc.querySelector('.histCard');
  assert.ok(card, 'the card renders');
  assert.equal(card.querySelector('.histPlace').textContent, '1.', 'the team won: first place, my own 400 notwithstanding');
  assert.match(card.querySelector('.histMeta').textContent, /2 gegen 2/);
  assert.equal(card.querySelector('.histOpp').textContent, 'mit Oma Gerda gegen Klaus, Horst', 'one level for all bots: in the standings');
  assert.equal(card.querySelectorAll('.histBars i').length, 2, 'one bar per team');
  assert.match(card.querySelector('.histBars').getAttribute('aria-label'), /Wir 2045, Gegner 1880/);
  click(card);
  const labels = [...doc.querySelectorAll('.histDetail .scoreChart .endLabel')].map((l) => l.textContent.replace(/\s+/g, ' ').trim());
  assert.deepEqual(labels.sort(), ['● Gegner 1.880', '● Wir 2.045']);
  assert.equal([...doc.querySelectorAll('.histDetail .scoreChart .axisLabel.goal')].pop().textContent, '2.000', 'a team game\'s chart has its own goal');
  assert.deepEqual(errors, []);
});

test('English: the same team marks in the other language', async (t) => {
  const { doc, feed, errors } = await setup(t, { storage: { pikdame_player_name: 'Flo', pikdame_lang: 'en' } });
  feed({ ...BASE, phase: 'playing' });
  assert.equal(doc.getElementById('myScore').textContent.replace(/\s+/g, ' ').trim(), 'Us 550:600 Them');
  assert.equal(doc.querySelector('.opPartnerTag').textContent, 'Team');
  feed({ ...BASE, phase: 'lobby' });
  assert.equal(doc.getElementById('teamModeBtn').querySelector('span').textContent, '2 vs 2');
  assert.equal(doc.getElementById('switchTeamBtn').querySelector('span').textContent, 'Switch team');
  assert.match(doc.getElementById('seatCountHint').textContent, /crosswise/);
  assert.deepEqual(errors, []);
});

test('lobby: each team may name itself - my team a field (sent on Enter or leaving it), the other team as text', async (t) => {
  const { doc, feed, click, sentOf, window, errors } = await setup(t);
  const lobby = { ...BASE, phase: 'lobby', players: PLAYERS.map((p) => ({ ...p, handCount: 0 })) };
  feed(lobby);
  const box = doc.getElementById('teamNamesBox');
  assert.ok(!box.classList.contains('hidden'));
  const rows = [...box.querySelectorAll('.teamNameRow')];
  assert.deepEqual(rows.map((r) => r.querySelector('.teamTag').textContent.trim()), ['A', 'B']);
  assert.ok(rows.every((r) => r.querySelector('.teamNameWord').textContent === 'Team'), '"Team [name]": the wording of the table');
  const input = rows[0].querySelector('.teamNameInput');
  assert.ok(input, 'my team: a field');
  assert.equal(input.getAttribute('maxlength'), '16', 'the player-name limit');
  assert.equal(rows[1].querySelector('.teamNameInput'), null, 'the other team: text only');
  assert.equal(rows[1].querySelector('.teamNameText').textContent, 'B');
  const save = rows[0].querySelector('.teamNameSave');
  assert.ok(save.classList.contains('hidden'), 'nothing to save yet');
  input.focus();
  input.value = '  Die Löwen ';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  assert.ok(!save.classList.contains('hidden'), 'an unsent name shows the check');
  click(save);
  assert.deepEqual(sentOf('setTeamName').pop(), { type: 'setTeamName', teamName: 'Die Löwen' });
  // Leaving the field unchanged sends nothing more.
  input.dispatchEvent(new window.Event('change', { bubbles: true }));
  assert.equal(sentOf('setTeamName').length, 1);

  // The server's names arrive for everyone; a name is text, never markup.
  feed({ ...lobby, teamNames: ['Die Löwen', '<img src=x onerror=alert(1)>'] });
  assert.equal(box.querySelector('.teamNameRow[data-team="1"] .teamNameText').textContent, '<img src=x onerror=alert(1)>');
  assert.equal(box.querySelectorAll('img').length, 0);
  assert.equal(box.querySelector('.teamNameInput').value, 'Die Löwen');
  // While I type, a broadcast never overwrites the field.
  const field = box.querySelector('.teamNameInput');
  field.focus();
  field.value = 'Die Tig';
  feed({ ...lobby, teamNames: ['Die Löwen', null] });
  assert.equal(field.value, 'Die Tig');
  field.blur();
  field.dispatchEvent(new window.Event('change', { bubbles: true }));
  assert.deepEqual(sentOf('setTeamName').pop(), { type: 'setTeamName', teamName: 'Die Tig' });
  // Enter commits by leaving the field (no native dialog anywhere).
  field.focus();
  field.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  assert.notEqual(doc.activeElement, field);
  assert.deepEqual(errors, []);
});

test('table: a named team reads "Team <Name>" on the tab, the melds, the score and the options; names are text', async (t) => {
  const { doc, feed, errors } = await setup(t);
  feed({
    ...BASE, phase: 'playing', teamNames: ['Die Löwen', 'Tiger'],
    tableMelds: [{ id: 1, ownerId: 'p2', type: 'set', rank: '7', slots: ['H', 'D', 'S'].map((s) => ({ real: { id: `7${s}`, suit: s, rank: '7' } })) }],
  });
  const partner = doc.querySelector('#opponents .opponent.isPartner');
  assert.equal(partner.querySelector('.opPartnerTag').textContent, 'Team Die Löwen', 'the whole name stays in the text (the ellipsis is CSS only)');
  assert.match(partner.title, /Team Die Löwen$/);
  const tag = [...doc.querySelectorAll('.meldOwnerHeader')].find((h) => h.textContent.includes('Oma Gerda')).querySelector('.meldTeamTag');
  assert.deepEqual([...tag.children].map((n) => n.textContent), ['Team', 'Die Löwen']);
  const score = doc.getElementById('myScore');
  assert.ok(score.classList.contains('teamScore'));
  assert.equal(score.querySelector('.tsWe .tsLong').textContent, 'Team Die Löwen');
  assert.equal(score.querySelector('.tsThey .tsLong').textContent, 'Team Tiger', 'the score names both teams');
  assert.deepEqual([...score.querySelectorAll('.tsShort')].map((n) => n.textContent), ['Wir', 'Gegner'], 'a narrow toolbar keeps the short words');
  // The rival team's name at the table: an outlined tab on its chips (and its meld header below).
  const rivalTabs = [...doc.querySelectorAll('#opponents .opponent:not(.isPartner) .opRivalTag')];
  assert.deepEqual(rivalTabs.map((n) => n.textContent), ['Team Tiger', 'Team Tiger']);
  assert.ok(rivalTabs.every((n) => !n.closest('.opponent').classList.contains('isPartner')));
  assert.match(score.title, /^Team Die Löwen 550 Punkte, Team Tiger 600 - 2000 gewinnen$/);
  assert.match(doc.querySelector('#opponents .opponent:not(.isPartner) .teamBar').title, /^Team Tiger: 600 von 2000/);
  assert.equal(doc.getElementById('tableRuleMode').textContent, '2 gegen 2: Team Die Löwen mit Oma Gerda');

  // Whatever a name holds, it renders as text.
  feed({ ...BASE, phase: 'playing', teamNames: ['<b>x</b>', null] });
  const evil = doc.querySelector('#opponents .opPartnerTag');
  assert.equal(evil.textContent, 'Team <b>x</b>');
  assert.equal(evil.querySelectorAll('b').length, 0);
  assert.equal(doc.getElementById('myScore').querySelector('.tsWe .tsLong').textContent, 'Team <b>x</b>');
  assert.equal(doc.getElementById('myScore').querySelectorAll('.tsWe b').length, 0);
  assert.deepEqual(errors, []);
});

test('results: named teams head their blocks, the headline and the gap; the chart uses the names', async (t) => {
  const { doc, feed, msg, errors } = await setup(t);
  const over = (winnerTeam, names) => ({
    ...BASE, phase: 'gameOver', roundNumber: 2, lastRoundWinnerId: winnerTeam === 0 ? 'p1' : 'b1', teamNames: names,
    totals: winnerTeam === 0 ? { p1: 1145, b1: 980, p2: 900, b2: 900 } : { p1: 980, b1: 1145, p2: 900, b2: 900 },
    teamTotals: winnerTeam === 0 ? [2045, 1880] : [1880, 2045],
    scoreHistory: [
      { round: 1, totals: {}, teamTotals: [1200, 1200] },
      { round: 2, totals: {}, teamTotals: winnerTeam === 0 ? [2045, 1880] : [1880, 2045] },
    ],
    lastRoundResult: { p1: mk(180, winnerTeam === 0), b1: mk(225, winnerTeam === 1), p2: mk(60), b2: mk(110) },
    gameOverInfo: { winnerId: null, teamMode: true, teams: TEAMS, winnerTeam, winnerIds: TEAMS[winnerTeam], teamTotals: winnerTeam === 0 ? [2045, 1880] : [1880, 2045], teamNames: names, targetScore: 2000, totalTurns: 236, totalRounds: 2, highlights: [] },
  });
  feed(over(0, ['Die Löwen', null]));
  msg({ type: 'progress', gainedXp: 120, xp: 5440, level: { level: 14 }, record: { played: 43, won: 17 } });
  const won = doc.querySelector('#resultBody .resultWinnerGame');
  assert.ok(won.classList.contains('isMe'));
  assert.equal(won.textContent.trim(), 'Team Die Löwen gewinnt die Partie!');
  const heads = [...doc.querySelectorAll('#resultBody .teamResultName > span')].map((n) => n.textContent);
  assert.deepEqual(heads, ['Team Die Löwen', 'Gegner'], 'a named team by its name, the other as before');
  const labels = [...doc.querySelectorAll('.scoreChart .endLabel')].map((l) => l.textContent.replace(/\s+/g, ' ').trim());
  assert.deepEqual(labels.sort(), ['● Die Löw… 2.045', '● Gegner 1.880'], 'the chart keeps its short labels');

  feed(over(1, ['Die Löwen', 'Kaffeeklatsch']));
  assert.deepEqual([...doc.querySelectorAll('#resultBody .teamResultName > span')].map((n) => n.textContent),
    ['Team Kaffeeklatsch', 'Team Die Löwen'], 'both teams by name');
  const lost = doc.querySelector('#resultBody .resultWinnerGame');
  assert.equal(lost.querySelector('.resultWinnerName').textContent, 'Team Kaffeeklatsch');
  assert.equal(lost.querySelector('.resultWinnerSub').textContent, 'gewinnt die Partie', 'one team: singular');
  assert.match(doc.querySelector('#resultMe .rmGap').textContent, /165 hinter Team Kaffeeklatsch/);

  // Round end: the blocks by name, and the goal tick at 2000 (845 = 42.25 % of the way).
  feed({
    ...BASE, phase: 'roundEnd', lastRoundWinnerId: 'b1', teamNames: [null, '<i>Tiger</i>'],
    totals: { p1: 240, b1: 600, p2: 375, b2: 245 }, teamTotals: [615, 845],
    lastRoundResult: { p1: mk(110), b1: mk(270, true), p2: mk(-45), b2: mk(-25) },
  });
  const blocks = [...doc.querySelectorAll('#resultBody .teamResult')];
  assert.equal(blocks[0].querySelector('.teamResultName > span').textContent, 'Team <i>Tiger</i>');
  assert.equal(blocks[0].querySelectorAll('.teamResultName i:not(.teamDot)').length, 0, 'a name is text');
  assert.equal(blocks[1].querySelector('.teamResultName > span').textContent, 'Dein Team');
  assert.equal(blocks[0].querySelector('.barGoal').style.left, '100%');
  assert.equal(blocks[0].querySelector('.barSolid').style.width, '30%', 'the round started at 600 of 2000');
  assert.deepEqual(errors, []);
});

test('css: no lone "Team" tab on a rival column, short score words on a narrow toolbar', () => {
  const css = fs.readFileSync(path.join(pub, 'style.css'), 'utf8');
  // Landscape drops the names from the meld tabs: a rival's tab would then say "Team" like mine.
  const land = css.slice(css.lastIndexOf('@media (orientation: landscape) and (max-height: 540px) {'));
  assert.match(land, /\.meldTeamTag \.mptName, \.meldTeamTag\.rival \{ display: none; \}/);
  // The landscape header clips: the tab's negative margins (no taller header line) must go there.
  assert.match(land, /\.meldTeamTag \{[^}]*margin-block: 0;/);
  assert.match(css, /@container \(max-width: 35rem\) \{\s*\.handScore \.tsLong \{ display: none; \}/);
  assert.match(css, /@container \(max-width: 22rem\) \{\s*\.handScore\.teamScore \.tsThey \{ display: none; \}/, 'large type on a phone: "Wir 550:600"');
});

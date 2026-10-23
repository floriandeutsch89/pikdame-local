// "2 gegen 2": seating, scoring, game end, lobby flows, snapshot, progression
// facts, bots, logs and the MCP view - engine level (the server: team-mode-server).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const GameManager = require('../game/GameManager');
const Teams = require('../game/Teams');
const Bot = require('../game/Bot');
const MoveLogger = require('../game/MoveLogger');
const { checkTeamGameOver } = require('../game/ScoreBoard');
const { makeStandardCard: card, makeJoker } = require('../game/Card');
const { xpForGame, evaluateQuests, XP_BASE, XP_WIN } = require('../game/Progression');
const { computeEarnedBadges } = require('../game/Badges');
const { historyForPlayer } = require('../game/GameHistoryStore');
const { createYearStatsStore } = require('../game/YearStatsStore');
const { createDeck } = require('../game/Deck');
const { legalActions } = require('../mcp/LegalActions');
const { renderState } = require('../mcp/StateView');

/** A team table without timers; humans p1..pN join in order, bots fill up. */
function teamTable(humans = 4, opts = {}) {
  const g = new GameManager(() => {}, { teamMode: true, ...opts });
  g.maybeRunBotTurn = () => {};
  for (let i = 1; i <= humans; i++) g.addOrReconnectPlayer(`p${i}`, `P${i}`);
  g.syncLobbyBots();
  return g;
}

function deal(g) {
  g.startNewRound();
  if (g.phase === 'cutting') g.performCut(g.cutterId, 0.5);
}

/** Ends the running round with fixed laid/hand cards per seat id. */
function endRound(g, seats, winnerId) {
  for (const p of g.players) {
    const s = seats[p.id] || { laid: [], hand: [card('C', '2', 1)] };
    p.laidOutCards = s.laid;
    p.hand = s.hand;
    p._laidAtTurnStart = s.handAus ? false : true;
  }
  g.finishRound(winnerId);
}

/** Drives every seat with the bot logic (humans forced) for one step. */
function step(g) {
  if (g.phase === 'roundEnd') return g.startNewRound();
  if (g.phase === 'cutting') return g.performCut(g.cutterId, 0.5);
  if (g.phase !== 'playing') return undefined;
  const cp = g.currentPlayer();
  return g.runBotTurn(cp.id, { forced: !g.isBotControlled(cp) });
}

function playToEnd(g, limit = 20000) {
  for (let i = 0; i < limit && g.phase !== 'gameOver'; i++) step(g);
  assert.equal(g.phase, 'gameOver', 'the match ends');
}

const seatOf = (g, id) => g.players.findIndex((p) => p.id === id);

test('Teams: seats alternate teams, partners sit opposite, records name both winners', () => {
  assert.deepEqual([0, 1, 2, 3].map(Teams.teamOfSeat), [0, 1, 0, 1]);
  assert.deepEqual([0, 1, 2, 3].map(Teams.partnerSeat), [2, 3, 0, 1]);
  const players = ['a', 'b', 'c', 'd'].map((id) => ({ id }));
  assert.deepEqual(Teams.teamsOf(players), [['a', 'c'], ['b', 'd']]);
  assert.deepEqual(Teams.teamSums([['a', 'c'], ['b', 'd']], { a: 10, b: -5, c: 30, d: 1 }), [40, -4]);
  const teamRecord = { teamMode: true, teams: [['a', 'c'], ['b', 'd']], winnerId: null, winnerIds: ['a', 'c'], players };
  assert.ok(Teams.isRecordWinner(teamRecord, 'a') && Teams.isRecordWinner(teamRecord, 'c'));
  assert.ok(!Teams.isRecordWinner(teamRecord, 'b'));
  assert.deepEqual(Teams.recordOpponentIds(teamRecord, 'c'), ['b', 'd'], 'the partner is no opponent');
  const single = { winnerId: 'b', players };
  assert.ok(Teams.isRecordWinner(single, 'b') && !Teams.isRecordWinner(single, 'a'));
  assert.deepEqual(Teams.recordOpponentIds(single, 'a'), ['b', 'c', 'd']);
  assert.equal(Teams.isRecordWinner(null, 'a'), false);
});

test('checkTeamGameOver: threshold, strict rule, both teams past 1000, ties play on', () => {
  assert.deepEqual(checkTeamGameOver([990, 400]), { gameOver: false });
  assert.deepEqual(checkTeamGameOver([1000, 400]), { gameOver: true, winnerTeam: 0 });
  assert.deepEqual(checkTeamGameOver([1000, 400], { strictThreshold: true }), { gameOver: false });
  assert.deepEqual(checkTeamGameOver([400, 1005], { strictThreshold: true }), { gameOver: true, winnerTeam: 1 });
  assert.deepEqual(checkTeamGameOver([1020, 1100]), { gameOver: true, winnerTeam: 1 }, 'both over: the higher total wins');
  assert.deepEqual(checkTeamGameOver([1050, 1050]), { gameOver: false, tieBreak: true, tiedScore: 1050 });
  assert.deepEqual(checkTeamGameOver([500, 500]), { gameOver: false }, 'a tie below the line is no tie-break');
});

test('a team table has four seats crosswise, and the teams take turns alternately', () => {
  const g = teamTable(4);
  assert.equal(g.maxSeats, 4);
  assert.deepEqual(g.teams(), [['p1', 'p3'], ['p2', 'p4']], 'joiners alternate between the teams');
  assert.equal(g.teamOf('p2'), 1);
  assert.equal(g.teamOf(2), 0);
  assert.equal(g.partnerOf('p1').id, 'p3');
  assert.equal(g.partnerOf('p4').id, 'p2');
  deal(g);
  let last = g.teamOf(g.currentPlayer().id);
  let turns = 0;
  for (let i = 0; i < 400 && g.phase === 'playing' && turns < 24; i++) {
    const before = g.currentPlayer().id;
    step(g);
    if (g.phase === 'playing' && g.currentPlayer().id !== before) {
      const now = g.teamOf(g.currentPlayer().id);
      assert.notEqual(now, last, 'the turn always passes to the other team');
      last = now;
      turns += 1;
    }
  }
  assert.ok(turns >= 8, 'enough turns observed');
  g.destroy();
});

test('team scoring: every seat is scored as always, each team gets the sum', () => {
  const g = teamTable(4);
  deal(g);
  endRound(g, {
    p1: { laid: [card('H', '7', 0), card('D', '7', 0), card('S', '7', 0)], hand: [] }, // goes out: +15
    p2: { laid: [card('H', 'K', 0), card('D', 'K', 0), card('S', 'K', 0)], hand: [card('S', 'Q', 0)] }, // 30 - 100
    p3: { laid: [], hand: [card('C', '5', 0)] }, // -5
    p4: { laid: [card('H', 'A', 0), card('D', 'A', 0), card('S', 'A', 0)], hand: [card('C', '2', 0)] }, // 60 - 5
  }, 'p1');
  const r = g.lastRoundResult;
  assert.deepEqual(['p1', 'p2', 'p3', 'p4'].map((id) => r[id].roundScore), [15, -70, -5, 55], 'per-player scoring unchanged');
  const round = g.roundHistory[0];
  assert.deepEqual(round.teamScores, [10, -15]);
  assert.deepEqual(round.teamTotalsAfter, [10, -15]);
  assert.deepEqual(g.teamTotals(), [10, -15]);
  const st = g.publicState('p1');
  assert.equal(st.teamMode, true);
  assert.deepEqual(st.teams, [['p1', 'p3'], ['p2', 'p4']]);
  assert.deepEqual(st.teamTotals, [10, -15]);
  assert.deepEqual(st.scoreHistory[0].teamTotals, [10, -15]);
  assert.ok(g.log.some((e) => e.text === 'Rundenwertung: P1=15, P2=-70, P3=-5, P4=55 (Team P1 & P3=10, Team P2 & P4=-15)'));
  g.destroy();
});

test('"Hand aus" with its house rule doubles every seat as always - both team sums double', () => {
  const g = teamTable(4);
  g.setHouseRules({ handAusDoubles: true });
  deal(g);
  endRound(g, {
    p2: { laid: [card('H', '9', 0), card('D', '9', 0), card('S', '9', 0)], hand: [], handAus: true }, // +15 x2
    p1: { laid: [], hand: [card('C', '5', 0)] }, // -5 x2
    p3: { laid: [], hand: [card('C', 'K', 0)] }, // -10 x2
    p4: { laid: [], hand: [card('C', '3', 0)] }, // -5 x2
  }, 'p2');
  assert.equal(g.lastRoundWasHandAus, true);
  assert.deepEqual(g.roundHistory[0].teamScores, [-30, 20]);
  g.destroy();
});

test('game end: the first team past 1000 wins with both players; strict needs more; a tie plays on', () => {
  const finish = (totals, houseRules = {}) => {
    const g = teamTable(4);
    g.setHouseRules(houseRules);
    deal(g);
    Object.assign(g.totals, totals);
    // Round: P1 out with +10, everyone else exactly 0.
    endRound(g, {
      p1: { laid: [card('H', '2', 0), card('D', '2', 0)], hand: [] },
      p2: { laid: [], hand: [] }, p3: { laid: [], hand: [] }, p4: { laid: [], hand: [] },
    }, 'p1');
    return g;
  };
  const won = finish({ p1: 600, p3: 390, p2: 300, p4: 300 }); // A 990 + 10 = 1000
  assert.equal(won.phase, 'gameOver');
  const gi = won.gameOverInfo;
  assert.equal(gi.teamMode, true);
  assert.equal(gi.winnerTeam, 0);
  assert.deepEqual(gi.winnerIds, ['p1', 'p3']);
  assert.equal(gi.winnerId, null, 'no single winner');
  assert.deepEqual(gi.teamTotals, [1000, 600]);
  assert.deepEqual(gi.teams, [['p1', 'p3'], ['p2', 'p4']]);
  assert.ok(won.log.some((e) => e.text === 'Spiel beendet! Gewinner: Team P1 & P3'));
  won.destroy();

  const strict = finish({ p1: 600, p3: 390, p2: 300, p4: 300 }, { strictThreshold: true });
  assert.equal(strict.phase, 'roundEnd', 'exactly 1000 is not enough under the strict rule');
  strict.destroy();

  const tie = finish({ p1: 600, p3: 440, p2: 500, p4: 550 }); // A 1040 + 10 = 1050 = B 1050
  assert.equal(tie.phase, 'roundEnd', 'equal team totals: one more round');
  assert.ok(tie.log.some((e) => e.text === 'Gleichstand bei 1050 Punkten (Team P1 & P3 und Team P2 & P4) - es wird eine weitere Runde gespielt.'));
  tie.destroy();

  const both = finish({ p1: 600, p3: 400, p2: 600, p4: 500 }); // A 1010, B 1100: both over, B higher
  assert.equal(both.phase, 'gameOver');
  assert.equal(both.gameOverInfo.winnerTeam, 1, 'both teams past the line: the higher total wins');
  both.destroy();
});

test('onGameOver: a team win counts for both teammates, the score stays each player\'s own', () => {
  let results = null;
  let record = null;
  const g = teamTable(4, { onGameOver: (r, rec) => { results = r; record = rec; } });
  deal(g);
  Object.assign(g.totals, { p1: 700, p3: 290, p2: 100, p4: 100 });
  endRound(g, { p1: { laid: [card('H', '2', 0), card('D', '2', 0)], hand: [] }, p2: { laid: [], hand: [] }, p3: { laid: [], hand: [] }, p4: { laid: [], hand: [] } }, 'p1');
  const byId = Object.fromEntries(results.map((r) => [r.id, r]));
  assert.equal(byId.p1.won, true);
  assert.equal(byId.p3.won, true, 'the partner wins too');
  assert.equal(byId.p2.won, false);
  assert.equal(byId.p3.score, 290, 'own total, not the team sum');
  assert.equal(byId.p2.facts.lastPlace, true, 'the losing team is last');
  assert.equal(byId.p3.facts.lastPlace, false);
  assert.equal(record.teamMode, true);
  assert.equal(record.winnerId, null);
  assert.deepEqual(record.winnerIds, ['p1', 'p3']);
  assert.deepEqual(record.teamTotals, [1000, 200]);
  assert.deepEqual(record.teams, [['p1', 'p3'], ['p2', 'p4']]);
  g.destroy();
});

/** A finished team record: A = a + c, B = b + d (d a Zen bot unless overridden). */
function teamRecord(overrides = {}) {
  return {
    teamMode: true,
    teams: [['a', 'c'], ['b', 'd']],
    winnerId: null,
    winnerIds: ['a', 'c'],
    winnerTeam: 0,
    teamTotals: [1100, 560],
    finalTotals: { a: 600, c: 500, b: 300, d: 260 },
    players: [
      { id: 'a', name: 'Anna', isBot: false },
      { id: 'b', name: 'Ben', isBot: false },
      { id: 'c', name: 'Cleo', isBot: false },
      { id: 'd', name: 'Uwe', isBot: true, botDifficulty: 'zen' },
    ],
    rounds: [
      { roundNumber: 1, winnerId: 'b', results: {}, totalsAfter: { a: 10, b: 120, c: 30, d: 60 }, teamTotalsAfter: [40, 180] },
      { roundNumber: 2, winnerId: 'a', results: {}, totalsAfter: { a: 600, b: 300, c: 500, d: 260 }, teamTotalsAfter: [1100, 560] },
    ],
    finishedAt: Date.UTC(2026, 9, 23, 12),
    ...overrides,
  };
}

test('XP and quests: both winners get the win bonus on their own score; a Zen partner is no Zen win', () => {
  const rec = teamRecord();
  assert.equal(xpForGame(rec, 'a'), XP_BASE + XP_WIN + 60);
  assert.equal(xpForGame(rec, 'c'), XP_BASE + XP_WIN + 50, 'the partner gets the win bonus');
  assert.equal(xpForGame(rec, 'b'), XP_BASE + 30, 'the losers keep base + own score');
  assert.deepEqual(evaluateQuests(rec, 'c', ['win_game', 'beat_zen']), { win_game: 1, beat_zen: 1 }, 'beat the Zen opponent');
  const zenPartner = teamRecord({
    winnerIds: ['b', 'd'], winnerTeam: 1, teamTotals: [560, 1100],
    players: [
      { id: 'a', name: 'Anna', isBot: false }, { id: 'b', name: 'Ben', isBot: false },
      { id: 'c', name: 'Cleo', isBot: false }, { id: 'd', name: 'Uwe', isBot: true, botDifficulty: 'zen' },
    ],
  });
  assert.deepEqual(evaluateQuests(zenPartner, 'b', ['win_game', 'beat_zen']), { win_game: 1 }, 'a Zen partner does not count');
  // The single-winner records stay as they were.
  assert.equal(xpForGame({ winnerId: 'me', finalTotals: { me: 1000 } }, 'me'), XP_BASE + XP_WIN + 100);
  assert.deepEqual(evaluateQuests({ winnerId: 'me', players: [{ id: 'z', isBot: true, botDifficulty: 'zen' }] }, 'me', ['win_game', 'beat_zen']), { win_game: 1, beat_zen: 1 });
});

test('badges: team win tiers for both, Zen badges only against Zen, comeback and margins by team totals', () => {
  const rec = teamRecord();
  const a = computeEarnedBadges(rec, 'a', { gamesWon: 1 });
  const c = computeEarnedBadges(rec, 'c', { gamesWon: 1 });
  for (const earned of [a, c]) {
    assert.ok(earned.includes('first_win'), 'a team win is a win');
    assert.ok(earned.includes('comeback'), 'the team was behind after round 1');
    assert.ok(earned.includes('landslide'), 'won by 540 team points');
    assert.ok(earned.includes('zen_slayer'), 'beat a Zen opponent');
    assert.ok(!earned.includes('zen_trio'));
  }
  const b = computeEarnedBadges(rec, 'b', {});
  assert.ok(!b.includes('first_win') && !b.includes('near_miss'), 'lost by 540: no near miss');

  const close = teamRecord({ teamTotals: [1005, 990] });
  assert.ok(computeEarnedBadges(close, 'b', {}).includes('near_miss'), 'lost by 15 team points');
  assert.ok(!computeEarnedBadges(close, 'a', { gamesWon: 1 }).includes('landslide'));

  // Team B wins with its Zen bot: Ben beat no Zen.
  const zenPartner = teamRecord({ winnerIds: ['b', 'd'], winnerTeam: 1, teamTotals: [560, 1100] });
  const ben = computeEarnedBadges(zenPartner, 'b', { gamesWon: 1 });
  assert.ok(ben.includes('first_win'));
  assert.ok(!ben.includes('zen_slayer'), 'a Zen partner is no Zen win');
  assert.ok(!ben.includes('comeback'), 'team B led after round 1');
});

test('lobby: joiners spread over the teams, switchTeam takes a free bot seat, the dealer stays', () => {
  const g = teamTable(1);
  assert.equal(seatOf(g, 'p1'), 0);
  g.addOrReconnectPlayer('p2', 'P2');
  assert.equal(g.teamOf('p2'), 1, 'the second human plays against the first');
  g.setExplicitDealer('p1');
  assert.deepEqual(g.switchTeam('p2'), { ok: true });
  assert.equal(g.teamOf('p2'), 0, 'now partners');
  assert.equal(seatOf(g, 'p2'), 2);
  assert.equal(g.players[g.dealerIndex].id, 'p1', 'the dealer is the same person');
  g.addOrReconnectPlayer('p3', 'P3');
  assert.equal(g.teamOf('p3'), 1, 'the newcomer joins the team with fewer humans');
  assert.match(g.switchTeam('p3').error, /kein Platz frei/, 'no bot seat left in team A');
  assert.match(g.switchTeam('bot-1').error || '', /nicht an diesem Tisch/, 'bots do not switch');
  assert.equal(g.addOrReconnectPlayer('p4', 'P4') && g.teamOf('p4'), 1);
  assert.equal(g.addOrReconnectPlayer('p5', 'P5'), null, 'four humans: full');
  deal(g);
  assert.match(g.switchTeam('p1').error, /vor Spielbeginn/);
  g.destroy();
  const plain = new GameManager(() => {});
  plain.addOrReconnectPlayer('p1', 'P1');
  assert.match(plain.switchTeam('p1').error, /2 gegen 2/);
  plain.destroy();
});

test('setTeamMode: lobby only and never solo; spreads the humans, one bot level, four seats', () => {
  const g = new GameManager(() => {});
  g.maybeRunBotTurn = () => {};
  g.addOrReconnectPlayer('p1', 'P1');
  g.setMaxSeats(2);
  g.syncLobbyBots();
  g.setMaxSeats(4);
  g.addOrReconnectPlayer('p2', 'P2');
  g.syncLobbyBots();
  assert.equal(seatOf(g, 'p2') % 2, 0, 'precondition: the normal spread seats both on even seats');
  const bot = g.players.find((p) => p.isBot);
  g.setBotDifficulty('p1', bot.id, 'zen');
  assert.deepEqual(g.setTeamMode(true), { ok: true });
  assert.equal(g.teamMode, true);
  assert.equal(g.maxSeats, 4);
  assert.equal(seatOf(g, 'p1'), 0, 'the host keeps the seat');
  assert.notEqual(g.teamOf('p1'), g.teamOf('p2'), 'the two humans play against each other');
  assert.equal(new Set(g.players.filter((p) => p.isBot).map((p) => p.botDifficulty)).size, 1, 'one level for every bot');
  assert.match(g.setMaxSeats(3).error, /vier Plätze/);
  assert.deepEqual(g.setMaxSeats(4), { ok: true });
  assert.match(g.setBotDifficulty('p1', g.players.find((p) => p.isBot).id, 'hard').error, /derselben Stufe/);
  assert.deepEqual(g.setAllBotsDifficultyBy('p1', 'hard'), { ok: true });
  assert.deepEqual([...new Set(g.players.filter((p) => p.isBot).map((p) => p.botDifficulty))], ['hard']);
  assert.deepEqual(g.setTeamMode(false), { ok: true });
  assert.equal(g.publicState('p1').teams, null);
  assert.equal(g.publicState('p1').teamTotals, null);
  g.setTeamMode(true);
  deal(g);
  assert.match(g.setTeamMode(false).error, /vor Spielbeginn/);
  g.destroy();

  // A two-seat table grows to four.
  const small = new GameManager(() => {});
  small.addOrReconnectPlayer('p1', 'P1');
  small.setMaxSeats(2);
  small.setTeamMode(true);
  assert.equal(small.players.length, 4);
  small.destroy();

  // Never in the daily challenge, the tutorial or the Kartenhaus.
  for (const opts of [{ challengeDate: '2026-10-23' }, { tutorialMode: true }, { towerStage: 1 }]) {
    const solo = new GameManager(() => {}, { ...opts, teamMode: true });
    assert.equal(solo.teamMode, false, `${Object.keys(opts)[0]} ignores the option`);
    assert.match(solo.setTeamMode(true).error, /freien Tischen/);
    assert.equal(solo.teamMode, false);
    solo.destroy();
  }
});

test('leaving the lobby keeps everyone else\'s team: a bot takes the very seat', async () => {
  const g = teamTable(3);
  assert.deepEqual(g.teams(), [['p1', 'p3'], ['p2', 'bot-1']]);
  assert.deepEqual(g.leaveLobby('p3'), { ok: true });
  assert.equal(g.players.length, 4);
  assert.ok(g.players[2].isBot, 'a bot sits on the freed seat');
  assert.equal(seatOf(g, 'p2'), 1, 'the others keep their seats');
  // A lobby seat whose player never comes back goes the same way.
  const grace = GameManager.TAKEOVER_GRACE_MS;
  GameManager.TAKEOVER_GRACE_MS = 5;
  try {
    g.markDisconnected('p2');
    await new Promise((r) => setTimeout(r, 40));
  } finally {
    GameManager.TAKEOVER_GRACE_MS = grace;
  }
  assert.ok(g.players[1].isBot, 'the seat went to a bot in place');
  assert.equal(seatOf(g, 'p1'), 0);
  assert.equal(g.players.length, 4);
  g.destroy();
});

test('reconnect, leaving mid-game and the rematch keep every seat on its team', () => {
  const g = teamTable(2);
  deal(g);
  const teamsBefore = g.teams();
  g.markDisconnected('p2');
  g.addOrReconnectPlayer('p2', 'P2');
  assert.deepEqual(g.teams(), teamsBefore, 'a reconnect returns to the same seat');
  assert.equal(g.abandonSeat('p2').outcome, 'left');
  assert.deepEqual(g.teams(), teamsBefore, 'a seat given up stays where it is');
  playToEnd(g);
  const gi = g.gameOverInfo;
  const winnerTop = gi.winnerIds.slice().sort((a, b) => gi.finalTotals[b] - gi.finalTotals[a])[0];
  g.prepareRematch();
  assert.equal(g.teamMode, true, 'the rematch is a team game again');
  assert.equal(g.players.length, 4);
  assert.equal(seatOf(g, 'p1'), 0);
  assert.ok(g.players[1].isBot && g.players[1].id !== 'p2', 'the leaver\'s seat holds a fresh bot');
  assert.deepEqual(g.teams()[0].slice(0, 1), ['p1']);
  const dealer = g.players[g.dealerIndex];
  if (g.players.some((p) => p.id === winnerTop)) assert.equal(dealer.id, winnerTop, 'the winning team\'s top scorer deals');
  g.destroy();
});

test('snapshot roundtrip keeps team mode, seats and shared totals; the restored game plays to its end', () => {
  const g = teamTable(2);
  deal(g);
  for (let i = 0; i < 4000 && !(g.roundNumber >= 2 && g.phase === 'playing'); i++) step(g);
  assert.ok(g.roundNumber >= 2 || g.phase === 'gameOver');
  const snap = JSON.parse(JSON.stringify(g.serialize()));
  const back = new GameManager(() => {});
  back.deserialize(snap);
  back.maybeRunBotTurn = () => {};
  assert.equal(back.teamMode, true);
  assert.equal(back.maxSeats, 4);
  assert.deepEqual(back.teams(), g.teams());
  assert.deepEqual(back.teamTotals(), g.teamTotals());
  assert.deepEqual(back.roundHistory.map((r) => r.teamTotalsAfter), g.roundHistory.map((r) => r.teamTotalsAfter));
  playToEnd(back);
  assert.equal(back.gameOverInfo.teamMode, true);
  assert.equal(back.gameOverInfo.winnerIds.length, 2);
  g.destroy();
  back.destroy();
});

test('Zen plays its heuristic in team mode, and a human seat\'s stand-in plays at the table level', () => {
  const g = teamTable(1);
  assert.equal(g._botTurnUsesOnnx({ id: 'x', isBot: true, botDifficulty: 'zen' }), false, 'no net in team mode');
  g.setAllBotsDifficulty('easy');
  deal(g);
  const seen = [];
  const orig = Bot.chooseDiscard;
  Bot.chooseDiscard = (hand, melds, opts) => { seen.push(opts.difficulty); return orig(hand, melds, opts); };
  try {
    while (g.phase === 'playing' && g.currentPlayer().id !== 'p1') step(g);
    seen.length = 0;
    if (g.phase === 'playing') g.runBotTurn('p1', { forced: true });
  } finally {
    Bot.chooseDiscard = orig;
  }
  if (seen.length) assert.deepEqual([...new Set(seen)], ['easy'], 'the stand-in is no Zen at an easy team table');
  g.destroy();
});

test('teamAware seam (measured, not shipped): team lead and opponents-only danger when on, never by default', () => {
  const g = teamTable(0);
  g.setAllBotsDifficulty('hard');
  deal(g);
  const cp = g.currentPlayer();
  for (const p of g.players) g.totals[p.id] = 0;
  g.totals[cp.id] = 100; // own lead over the best opponent: 100
  g.totals[g.partnerOf(cp.id).id] = 300; // team lead: (400 - 0) / 2 = 200
  const partner = g.partnerOf(cp.id);
  g.publicKnownHands = { [partner.id]: [card('H', '4', 0)] };
  const seen = [];
  const orig = Bot.chooseDiscard;
  Bot.chooseDiscard = (hand, melds, opts) => { seen.push(opts); return orig(hand, melds, opts); };
  const snap = JSON.parse(JSON.stringify(g.serialize()));
  try {
    g.runBotTurn(cp.id);
    const naive = seen.pop();
    assert.equal(naive.scoreLead, 100 - 300, 'default: the individual lead (the partner counts as a rival)');
    assert.equal(naive.opponentKnownCards.length, 1);

    const again = new GameManager(() => {});
    again.maybeRunBotTurn = () => {};
    again.deserialize(snap);
    again.maybeRunBotTurn = () => {};
    again.players.find((p) => p.id === cp.id).teamAware = true;
    again.runBotTurn(cp.id);
    const aware = seen.pop();
    assert.equal(aware.scoreLead, 200, 'the team lead per seat');
    assert.deepEqual(aware.opponentKnownCards, [], 'the partner\'s known cards are no danger');
    again.destroy();
  } finally {
    Bot.chooseDiscard = orig;
  }
  g.destroy();
});

test('the teamAware seam never survives a snapshot or a human taking the seat over', () => {
  const g = teamTable(1);
  deal(g);
  const bot = g.players.find((p) => p.isBot);
  bot.teamAware = true;
  const snap = g.serialize();
  assert.ok(snap.players.every((p) => !('teamAware' in p)), 'never persisted');
  const tampered = JSON.parse(JSON.stringify(snap));
  tampered.players[1].teamAware = true;
  const back = new GameManager(() => {});
  back.deserialize(tampered);
  assert.ok(back.players.every((p) => p.teamAware === undefined), 'stripped on restore');
  back.destroy();
  const seat = g.addOrReconnectPlayer('p-new', 'Neu');
  assert.equal(seat.id, bot.id);
  assert.equal(seat.teamAware, undefined, 'gone when a human takes the seat');
  g.destroy();
});

// --- E2E: full bot games in team mode at every level --------------------------

const REFERENCE = (() => {
  const counts = new Map();
  for (const c of createDeck()) counts.set(c.id, (counts.get(c.id) || 0) + 1);
  return counts;
})();

function deckErrors(g) {
  const found = new Map();
  const add = (c) => { if (c && c.id) found.set(c.id, (found.get(c.id) || 0) + 1); };
  for (const p of g.players) (p.hand || []).forEach(add);
  for (const m of g.tableMelds || []) for (const s of m.slots || []) { add(s.real); add(s.joker); }
  [...(g.drawPile || []), ...(g.discardPile || []), ...(g.retiredJokers || []), ...(g._pendingDeck || [])].forEach(add);
  const errors = [];
  for (const [id, n] of REFERENCE) if ((found.get(id) || 0) !== n) errors.push(`${id}: ${found.get(id) || 0}x`);
  for (const id of found.keys()) if (!REFERENCE.has(id)) errors.push(`unknown ${id}`);
  return errors;
}

for (const level of ['easy', 'medium', 'hard', 'zen']) {
  test(`E2E team game, all bots ${level}: no deadlock, no joker discard, no double set, all 110 cards after every turn`, () => {
    const g = new GameManager(() => {}, { teamMode: true });
    g.maybeRunBotTurn = () => {};
    g.players = [0, 1, 2, 3].map((i) => ({ id: `bot-${i}`, name: `B${i}`, isBot: true, hand: [], connected: true, laidOutCards: [], botDifficulty: level }));
    for (const p of g.players) g.totals[p.id] = 0;
    const jokerDiscards = [];
    const origDiscard = g.discard.bind(g);
    g.discard = (pid, cardId) => {
      const p = g.players.find((x) => x.id === pid);
      const c = p && p.hand.find((x) => x.id === cardId);
      if (c && c.isJoker && p.hand.length > 1) jokerDiscards.push(cardId);
      return origDiscard(pid, cardId);
    };
    g.startNewRound();
    let steps = 0;
    while (g.phase !== 'gameOver' && steps++ < 20000) {
      step(g);
      const errors = deckErrors(g);
      assert.deepEqual(errors, [], `card conservation broken after step ${steps}`);
      for (const p of g.players) {
        const byRank = new Map();
        for (const m of g.tableMelds.filter((x) => x.ownerId === p.id && x.type === 'set')) byRank.set(m.rank, (byRank.get(m.rank) || []).concat(m));
        for (const [rank, sets] of byRank) {
          if (sets.length > 1) {
            const size = sets.reduce((n, m) => n + m.slots.length, 0);
            assert.ok(size > 8, `${p.id} holds two ${rank} sets that would fit into one`);
          }
        }
      }
    }
    assert.equal(g.phase, 'gameOver', 'the match ends (no deadlock)');
    assert.deepEqual(jokerDiscards, [], 'bots never throw a joker away');
    assert.equal(g.gameOverInfo.teamMode, true);
    assert.equal(g.gameOverInfo.winnerIds.length, 2);
    const tt = g.gameOverInfo.teamTotals;
    assert.ok(Math.max(...tt) >= 1000 && tt[g.gameOverInfo.winnerTeam] > tt[1 - g.gameOverInfo.winnerTeam]);
    g.destroy();
  });
}

// --- Logs, history, year review, MCP -----------------------------------------

test('move log: a team game\'s rows carry the team outcome for both teammates', () => {
  const g = teamTable(2);
  deal(g);
  // Team A (p1 + partner) 1100, team B (p2 + its partner) 100.
  for (const p of g.players) g.totals[p.id] = 0;
  g.totals.p1 = 600;
  g.totals[g.partnerOf('p1').id] = 500;
  g.totals.p2 = 100;
  g._moveLog = [
    { playerId: 'p1', seat: 0, phase: 'discard', round: 1, turn: 1, pileTakeLegal: false, move: {}, state: {}, action: 0, obs: [0], mask: [true] },
    { playerId: 'p2', seat: 1, phase: 'discard', round: 1, turn: 2, pileTakeLegal: false, move: {}, state: {}, action: 0, obs: [0], mask: [true] },
  ];
  const before = fs.existsSync(MoveLogger.LOG_PATH) ? fs.readFileSync(MoveLogger.LOG_PATH, 'utf8').split('\n').filter(Boolean).length : 0;
  MoveLogger.flush(g);
  const rows = fs.readFileSync(MoveLogger.LOG_PATH, 'utf8').split('\n').filter(Boolean).slice(before).map((l) => JSON.parse(l));
  const p1 = rows.find((r) => r.seat === 0);
  const p2 = rows.find((r) => r.seat === 1);
  assert.equal(p1.teamMode, 1);
  assert.equal(p1.team, 0);
  assert.equal(p1.won, true, 'team A leads 1100 to the rest');
  assert.equal(p1.rank, 1);
  assert.equal(p2.won, false);
  assert.equal(p2.rank, 2);
  assert.deepEqual(p1.teamTotals, g.teamTotals());
  g.destroy();
});

test('"Meine Partien" and the year review: both teammates won, the partner is no opponent', () => {
  const rec = teamRecord();
  const [cleo] = historyForPlayer([{ id: 'g1', ...rec }], 'Cleo');
  assert.equal(cleo.won, true);
  assert.equal(cleo.teamMode, true);
  assert.deepEqual(cleo.winnerIds, ['a', 'c']);
  assert.deepEqual(cleo.teamTotals, [1100, 560]);
  const [ben] = historyForPlayer([{ id: 'g1', ...rec }], 'Ben');
  assert.equal(ben.won, false);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pikdame-team-years-'));
  try {
    const years = createYearStatsStore(path.join(dir, 'years.json'));
    const results = [
      { id: 'a', name: 'Anna', won: true, score: 600 },
      { id: 'b', name: 'Ben', won: false, score: 300 },
      { id: 'c', name: 'Cleo', won: true, score: 500 },
    ];
    years.recordFinishedGame(results, rec.players, '2026-10-23', { teams: rec.teams });
    years.flushSync();
    assert.deepEqual(Object.keys(years.yearFor('Anna', 2026).opponents), ['ben'], 'Cleo is Anna\'s partner, not her opponent');
    assert.deepEqual(Object.keys(years.yearFor('Ben', 2026).opponents).sort(), ['anna', 'cleo']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('MCP: a team table reads its teams, legal moves come from the same engine, the lobby offers a switch', () => {
  const g = teamTable(2);
  const lobby = g.publicState('p1');
  assert.ok(legalActions(lobby, 'p1').some((a) => a.key === 'switchTeam' && a.msg.type === 'switchTeam'));
  deal(g);
  while (g.phase === 'playing' && g.currentPlayer().id !== 'p1') step(g);
  const st = g.publicState('p1');
  const text = renderState(st, 'p1');
  assert.match(text, /Team game \(2 vs 2\): team A YOU \+ /);
  assert.match(text, /\[team B, opponent/);
  const partner = g.partnerOf('p1');
  assert.ok(text.includes(`${partner.name} [team A, your partner`), 'the partner is named as such');
  const actions = legalActions(st, 'p1');
  assert.ok(actions.length > 0, 'moves are offered on a team table');
  assert.ok(actions.every((a) => a.msg && typeof a.msg.type === 'string'));
  g.destroy();
});

test('a normal table carries no team fields and keeps its single winner', () => {
  let rec = null;
  const g = new GameManager(() => {}, { onGameOver: (r, record) => { rec = record; } });
  g.maybeRunBotTurn = () => {};
  g.addOrReconnectPlayer('p1', 'P1');
  g.fillWithBots();
  assert.equal(g.teamOf('p1'), null);
  assert.equal(g.partnerOf('p1'), null);
  const st = g.publicState('p1');
  assert.equal(st.teamMode, false);
  assert.equal(st.teams, null);
  deal(g);
  playToEnd(g);
  assert.equal(g.gameOverInfo.teamMode, undefined);
  assert.ok(g.gameOverInfo.winnerId);
  assert.equal(rec.teamMode, undefined);
  assert.equal(rec.winnerIds, undefined);
  g.destroy();
});

test('i18n: every team-mode refusal and log line has an English pattern', () => {
  const vm = require('node:vm');
  const ctx = { window: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'i18n.js'), 'utf8'), ctx);
  const translated = (text) => ctx.window.I18N_SERVER_PATTERNS.some(([re]) => re.test(text));
  const texts = [];
  const g = teamTable(1);
  g.addOrReconnectPlayer('p2', 'P2');
  g.addOrReconnectPlayer('p3', 'P3');
  assert.deepEqual(g.teams(), [['p1', 'p3'], ['p2', 'bot-3']]);
  texts.push(g.switchTeam('p2').error, g.setMaxSeats(3).error, g.setBotDifficulty('p1', g.players.find((p) => p.isBot).id, 'zen').error);
  deal(g);
  texts.push(g.setTeamMode(false).error, g.switchTeam('p1').error);
  endRound(g, { p1: { laid: [card('H', '2', 0), card('D', '2', 0)], hand: [] } }, 'p1');
  Object.assign(g.totals, { p1: 1040, p2: 990, p3: 0 });
  g.totals[g.players[3].id] = 50;
  texts.push(...g.log.slice(-2).map((e) => e.text));
  g.startNewRound();
  if (g.phase === 'cutting') g.performCut(g.cutterId, 0.5);
  texts.push(...g.log.filter((e) => e.text.startsWith('⚠️ Endspurt')).map((e) => e.text));
  endRound(g, { p1: { laid: [card('H', '2', 0), card('D', '2', 0)], hand: [] }, p2: { laid: [], hand: [] }, p3: { laid: [], hand: [] } }, 'p1');
  texts.push(...g.log.slice(-2).map((e) => e.text));
  g.destroy();
  const plain = new GameManager(() => {});
  plain.addOrReconnectPlayer('p1', 'P1');
  texts.push(plain.switchTeam('p1').error);
  plain.destroy();
  const solo = new GameManager(() => {}, { tutorialMode: true });
  texts.push(solo.setTeamMode(true).error);
  solo.destroy();
  texts.push('Am Stammtisch gibt es „2 gegen 2“ noch nicht - die Bilanz zählt dort jeden für sich.'); // server.js
  assert.ok(texts.some((t) => /^Spiel beendet! Gewinner: Team /.test(t)), 'the game-over line was collected');
  assert.ok(texts.some((t) => /^⚠️ Endspurt! Team /.test(t)), 'the final-stretch line was collected');
  for (const text of texts) assert.ok(text && translated(text), `no English pattern for: ${text}`);
});

test('jokers still never leave a bot hand by discard (team table, joker-heavy hand)', () => {
  const hand = [makeJoker(0), makeJoker(1), card('H', '5', 0), card('S', '9', 1)];
  for (const difficulty of ['easy', 'medium', 'hard', 'zen']) {
    for (let i = 0; i < 20; i++) {
      const d = Bot.chooseDiscard(hand, [], { difficulty, scoreLead: i * 40 - 400, opponentKnownCards: [] });
      assert.ok(d && !d.isJoker, `${difficulty}`);
    }
  }
});

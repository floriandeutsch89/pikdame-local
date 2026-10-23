#!/usr/bin/env node
// Screenshots of the real client with mock data, in every layout.
// Starts its own server on a temp data dir (never touches data/), routes the
// WebSocket through Playwright and rewrites/injects messages per scene.
//
//   node .claude/skills/ui-shots/scripts/ui-shots.js [--out DIR] [--views a,b] [--scenes a,b] [--port N] [--audit] [--signed-in] [--reduced-motion]
//
// --signed-in mocks a signed-in account (the /api/* answers below), season
// finale included: the start-up hint shows on the first start-screen shot.
// --stammtische N (0-3, default 1): remembered Stammtische on the start screen.
//
// --audit also checks every shot for truncated or off-screen text, tap targets < 44 px,
// icon buttons without a name and (start screen) content below the fold;
// the report goes to <out>/audit.md.
//
// Views: phone (393x852), land (874x402), desk (1440x900), se (375x667), max (440x956), lap (1366x657), nar (1100x680).
// Scenes: lobby, lobby-open, progress, stats, stats-badges (trophy cabinet + a favourite's
// detail; favourites show with --signed-in), history, roundend, roundend-stats, gameover,
// gameover-stats (its Statistik tab: game totals open, new achievements),
// table (needs --state <file>: a GameManager.publicState('p1') JSON in the playing phase),
// puzzle / puzzle-turn / puzzle-out (one meld laid), puzzle-refused (two melds laid at once: refused), puzzle-solved (3 stars + the tile),
// challenge (intro, attempt used),
// gamelobby (seats + house rules), botdiff (the strength picker), gameover-challenge,
// settings / settings-aids / settings-music (the start screen's "Optionen" sheet: top / play aids / music),
// game-settings (the gear at a live engine table: the sheet on top, then scrolled to its end),
// game-settings-debug (that sheet with the debug view on), home (the home dialog at the table, then
// its forfeit button armed by a first tap),
// sheet-reopen (settings sheet scrolled, closed, reopened), cardback (the card-back gallery), music-hint (first click: music starts, one-time hint),
// account (the account sheet: level, season ladder; needs --signed-in),
// account-mail (its year-review mail switch; needs --signed-in),
// tower (the Kartenhaus sheet via its tile in "Aufgaben"), tower-detail (a tapped
// locked floor 14), tower-motion (frames: month change, a dealt card and a
// wobble), tower-film (the month change frozen at --film ms, then its end),
// tower-skip (a real tap during the month change), gameover-tower (a floor verdict).
// --tower mid|new|half|high|crowned|full picks the month in the mock (default mid:
// floors 1-8 built, 9 next); --closed '{"13":"building"}' closes floors; --tag names the shot.
// tower-start / tower-play / tower-sheet / tower-lock: a live Kartenhaus floor from the
// engine (its deal, bots, head start): the start card before the first move, the floor
// card mid-game, its rules sheet, a tap on the locked discard pile. --floor queen|goOut|
// noDiscard|all (the floor with exactly that handicap, looked up in BotTower.js) or a number;
// --take stock|pile: tower-play in my meld phase (action bar; after a pile take the undo chip).
// --fold full|compact: the floor card as the player chose it (stored); without it the automatic
// fold (in full for the first own turn, folded from the second); hidden: taken off the table by its ✕.
// --plain: the same deal and turns as a normal table (no Kartenhaus fields), to --measure against.
// --tap <selector>: tapped before the shot ('a;b' taps in order); --tag names the variant in the file name;
// --tap-freeze <ms> holds every animation at that moment (a frame of a fold mid-glide).
// --measure writes <out>/measure.json: the table regions (melds, hand, piles ...) per shot.
// gameover-win (I win the match, a new badge), stats-empty (a brand-new name: statistics
// empty state, then "Meine Partien" empty).
// --lang en: the English client (text length). SHOTS_ROOT=<checkout>: shoot another
// checkout with this script (before/after pictures from one set of scenes).
// --light morning|noon|evening|night|HH:MM|now: the table light at that Berlin time
// (default noon = the table without the light; now = the real clock).
// --december: the client clock stands on 28 December and the server's year review
// is mocked - adds the "Aufgaben" chip and the scenes year / year-mid / year-bots /
// year-end (story cards), year-image (the share PNG, via the download fallback)
// and mail (the review mail's HTML). --settle <ms> waits before the lobby shot
// (the December snow starts at load and needs a few seconds to fall into view).
// Start-screen scenes may follow table or result scenes in any order: the page
// is reloaded to the start screen first.
'use strict';
// The tower scenes play engine games with a human seat: those are no human moves for training.
process.env.PIKDAME_LOG_GAMES = '0';
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

function loadPlaywright() {
  const tries = [process.env.PLAYWRIGHT_MODULE, 'playwright', '/opt/node-tools/node_modules/playwright'].filter(Boolean);
  for (const t of tries) { try { return require(t); } catch (e) { /* next */ } }
  throw new Error('playwright not found - set PLAYWRIGHT_MODULE to its path');
}

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : def;
};
const ROOT = path.resolve(process.env.SHOTS_ROOT || path.resolve(__dirname, '../../../..'));
const OUT = path.resolve(arg('out', path.join(os.tmpdir(), 'pikdame-shots')));
const PORT = Number(arg('port', 3477));
const VIEWS = {
  phone: { width: 393, height: 852, mobile: true },
  land: { width: 874, height: 402, mobile: true },
  desk: { width: 1440, height: 900, mobile: false },
  se: { width: 375, height: 667, mobile: true },
  max: { width: 440, height: 956, mobile: true }, // iPhone Pro Max: 15 cards still fit one row
  lap: { width: 1366, height: 657, mobile: false }, // 1366x768 laptop minus browser chrome
  nar: { width: 1100, height: 680, mobile: false }, // the narrowest desktop layout
};
const views = arg('views', 'phone,land,desk').split(',');
const scenes = arg('scenes', 'lobby,stats,history,roundend,gameover').split(',');
const AUDIT = process.argv.includes('--audit');
const SIGNED_IN = process.argv.includes('--signed-in');
const STILL = process.argv.includes('--reduced-motion'); // prefers-reduced-motion: reduce
const DECEMBER = process.argv.includes('--december');
const MEASURE = process.argv.includes('--measure');
const TOWER_MOCK = arg('tower', 'mid');
const TAP_MIN = 44; // CLAUDE.md --tap-min
// --light: the table light follows the Berlin clock (public/table-light.js). Pinned to
// noon by default, so table shots compare across the day; morning|evening|night|HH:MM|now.
function lightCss(which) {
  if (which === 'now') return '';
  const hhmm = { morning: '08:30', noon: '13:00', evening: '20:00', night: '00:30' }[which] || which;
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  if (!m) throw new Error(`--light ${which}: morning|noon|evening|night|HH:MM|now`);
  let w = { m: 0, d: 1, e: 0, n: 0 };
  try { w = require(path.join(ROOT, 'public', 'table-light.js')).phaseWeights(Number(m[1]) * 60 + Number(m[2])); } catch (e) { /* checkout without the light */ }
  return `#table { ${['m', 'd', 'e', 'n'].map((k) => `--tod-${k}: ${w[k].toFixed(4)} !important;`).join(' ')} }`;
}
const LIGHT_CSS = lightCss(arg('light', 'noon'));
// A normal UA: the server treats headless defaults as a crawler (no WebSocket).
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

// --- mock data ---------------------------------------------------------------
// "Today" is the server's game day (Europe/Berlin), not UTC.
const TODAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin' }).format(new Date());
const NOW = Date.now();
const ME = 'Flo';
const PROFILES = [
  { name: ME, gamesPlayed: 43, gamesWon: 17, totalScore: 31000, bestGameScore: 1385, xp: 5320, dailyStreak: 6,
    daily: { streak: 6, best: 11, last: '2000-01-01', graceAt: null },
    badges: { first_win: NOW - 9e8, pd_laid: NOW - 5e8, marathon_10: NOW - 2e8 }, favoriteBadges: ['games', 'wins'],
    puzzles: { [TODAY]: { tries: 1, solved: false } },
    towerStars: 17, towerCleared: 8 },
  { name: 'Oma Gerda', gamesPlayed: 120, gamesWon: 61, totalScore: 99000, bestGameScore: 1610, xp: 18000, badges: { first_win: 1 } },
  { name: 'Klaus', gamesPlayed: 15, gamesWon: 3, totalScore: 8000, bestGameScore: 1040, xp: 1200, badges: {} },
];
// The start-screen Stammtisch chip and its sheet (answered by the script, see below).
const STAMMTISCH = {
  name: 'Familie Deutsch', gamesPlayed: 7,
  series: { no: 3, games: 2, wins: { 'oma gerda': 1, flo: 1 }, bestOf: 3, needed: 2 },
  goals: { level: 3, into: 40, need: 100, xp: 165, week: { start: '2026-10-12', games: 3, goal: 5, reached: false }, streak: 2, weeksReached: 4 },
  members: [
    { name: 'Oma Gerda', wins: 4, games: 7, avg: 612 }, { name: ME, wins: 2, games: 7, avg: 540 },
    { name: 'Klaus', wins: 1, games: 6, avg: 455 },
  ],
  pairwise: {
    'oma gerda': { flo: { ahead: 5, behind: 2 }, klaus: { ahead: 4, behind: 2 } },
    flo: { 'oma gerda': { ahead: 2, behind: 5 }, klaus: { ahead: 3, behind: 3 } },
    klaus: { 'oma gerda': { ahead: 2, behind: 4 }, flo: { ahead: 3, behind: 3 } },
  },
};
// --signed-in: account answers by path. Seasons are months counted back from today.
const monthsBack = (n) => {
  const d = new Date(`${TODAY.slice(0, 7)}-15T12:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() - n);
  return d.toISOString().slice(0, 7);
};
const SEASON_RESULT = { season: monthsBack(1), place: 2, award: 'silver', seasonXp: 640, ranked: 14 };
const SEASON_AWARDS = [SEASON_RESULT,
  { season: monthsBack(2), place: 7, award: 'top10', seasonXp: 310, ranked: 12 },
  { season: monthsBack(3), place: 11, award: 'participant', seasonXp: 95, ranked: 12 }];
const ACCOUNT_API = {
  '/api/me': { ok: true, username: ME, seasonResult: SEASON_RESULT, lastSeason: SEASON_RESULT, seasonAwards: SEASON_AWARDS },
  '/api/ladder': { ok: true, season: TODAY.slice(0, 7), lastSeason: SEASON_RESULT, seasonAwards: SEASON_AWARDS,
    me: { username: ME, xp: 5320, seasonXp: 410, season: TODAY.slice(0, 7), games: 43, wins: 17, rank: 2 },
    board: [{ username: 'Oma Gerda', seasonXp: 520 }, { username: ME, seasonXp: 410 }, { username: 'Klaus', seasonXp: 150 }] },
  '/api/account/methods': { ok: true, hasPassword: false, passkeys: [{ id: 'pk1', name: 'iPhone', createdAt: NOW - 9e8, lastUsedAt: NOW - 3e6 }], reviewMail: false },
};
const GLOBAL_STATS = { games: 8123, rounds: 61234, pikDamesLaidOut: 9001, pikDamesCaught: 4521, handAusRounds: 777 };
const HISTORY = [
  { id: 'g1', finishedAt: NOW - 3600e3, startedAt: NOW - 3600e3 - 41 * 60e3, rounds: 3, won: true, myScore: 1040, myId: 'p1', stammtisch: true,
    players: [{ id: 'p1', name: ME }, { id: 'p2', name: 'Oma Gerda' }, { id: 'b1', name: 'Klaus', isBot: true, botDifficulty: 'zen' }],
    finalTotals: { p1: 1040, p2: 760, b1: 905 },
    roundTotals: [{ p1: 300, p2: 250, b1: 330 }, { p1: 700, p2: 500, b1: 720 }, { p1: 1040, p2: 760, b1: 905 }] },
  { id: 'g2', finishedAt: NOW - 30 * 3600e3, startedAt: NOW - 30 * 3600e3 - 55 * 60e3, rounds: 8, won: false, myScore: 880, myId: 'p1', challengeDate: TODAY,
    players: [{ id: 'p1', name: ME }, { id: 'b1', name: 'Horst', isBot: true, botDifficulty: 'medium' }],
    finalTotals: { p1: 880, b1: 1010 }, roundTotals: [] },
  // Older games, so "Letzte Partien" on the statistics sheet has ten to show.
  ...[[2, true, 1120, 905, 760], [3, false, 760, 1030, 610], [5, true, 1015, 880, 940], [9, true, 1050, 700, 985],
    [12, false, 640, 1005, 820], [15, false, 905, 990, 1040], [18, true, 1210, 980, 400], [21, false, 455, 1000, 870]].map(([days, won, me, a, b], i) => ({
    id: `gx${i}`, finishedAt: NOW - days * 86400e3, startedAt: NOW - days * 86400e3 - 48 * 60e3, rounds: 6, won, myScore: me, myId: 'p1',
    players: [{ id: 'p1', name: ME }, { id: 'p2', name: 'Oma Gerda' }, { id: 'b1', name: 'Klaus', isBot: true, botDifficulty: 'medium' }],
    finalTotals: { p1: me, p2: a, b1: b }, roundTotals: [] })),
];
const mk = (s, win) => ({ roundScore: s, breakdown: { isWinner: !!win, multiplier: 1 } });
const PLAYERS = [
  { id: 'p1', name: ME, isBot: false, connected: true, handCount: 9, hand: [] },
  { id: 'b1', name: 'Klaus', isBot: true, connected: true, handCount: 0, botDifficulty: 'zen' },
  { id: 'b2', name: 'Horst', isBot: true, connected: true, handCount: 4, botDifficulty: 'zen' },
  { id: 'b3', name: 'Maria', isBot: true, connected: true, handCount: 6, botDifficulty: 'zen' },
];
const SCORE_HISTORY = [
  { round: 1, totals: { p1: 120, b1: 60, b2: -20, b3: 40 } },
  { round: 2, totals: { p1: 250, b1: 330, b2: 90, b3: 75 } },
  { round: 3, totals: { p1: 205, b1: 600, b2: 200, b3: 40 } },
];
const BASE_STATE = {
  roundNumber: 3, currentPlayerId: 'p1', turnPhase: 'draw', dealerId: 'b1', discardTop: null, drawPileCount: 30,
  discardPileCount: 3, log: [], tableMelds: [], lobbyReady: [], nextRoundReady: [], houseRules: {}, players: PLAYERS,
  lastRoundWinnerId: 'b1', scoreHistory: SCORE_HISTORY,
  lastRoundStats: [
    { id: 'p1', name: ME, laidOutCount: 3, handCount: 9, pikDameLaidOut: 0, jokersLaidOut: 1,
      laidLines: [{ kind: 'joker', count: 1, points: 20 }, { kind: 'low', count: 2, points: 10 }],
      handLines: [{ kind: 'face', count: 3, points: 30 }, { kind: 'low', count: 6, points: 30 }, { kind: 'ace', count: 1, points: 20 }] },
    { id: 'b1', name: 'Klaus', laidOutCount: 15, handCount: 0, pikDameLaidOut: 1, jokersLaidOut: 2 },
    { id: 'b2', name: 'Horst', laidOutCount: 11, handCount: 4, pikDameLaidOut: 0, jokersLaidOut: 0 },
    { id: 'b3', name: 'Maria', laidOutCount: 9, handCount: 6, pikDameLaidOut: 0, jokersLaidOut: 1 },
  ],
};
const ROUND_END = { ...BASE_STATE, phase: 'roundEnd', totals: SCORE_HISTORY[2].totals,
  lastRoundResult: { p1: mk(-45), b1: mk(270, true), b2: mk(110), b3: mk(-35) } };
const GAME_OVER = { ...BASE_STATE, phase: 'gameOver', roundNumber: 6, totals: { p1: 880, b1: 1045, b2: 610, b3: 320 },
  scoreHistory: [...SCORE_HISTORY, { round: 4, totals: { p1: 480, b1: 700, b2: 380, b3: 190 } },
    { round: 5, totals: { p1: 700, b1: 820, b2: 500, b3: 260 } }, { round: 6, totals: { p1: 880, b1: 1045, b2: 610, b3: 320 } }],
  lastRoundResult: { p1: mk(180), b1: mk(225, true), b2: mk(110), b3: mk(60) },
  gameStatsTotals: { p1: { pikDames: 1, jokers: 4 }, b1: { pikDames: 2, jokers: 7 } }, hasExportableGame: true,
  gameOverInfo: { winnerId: 'b1', finalTotals: {}, totalTurns: 214, totalRounds: 6,
    highlights: [{ type: 'queenCaught', round: 2, name: 'Horst' }, { type: 'bestRound', round: 3, name: 'Klaus', score: 270 }],
    funTitle: { type: 'queenMagnet', name: 'Horst', count: 2 } } };

// gameover-win: I win the match (and earn a badge, injected in the scene).
const GAME_OVER_WIN = { ...GAME_OVER, totals: { p1: 1045, b1: 880, b2: 610, b3: 320 },
  scoreHistory: GAME_OVER.scoreHistory.map((h, i, a) => (i === a.length - 1 ? { round: h.round, totals: { p1: 1045, b1: 880, b2: 610, b3: 320 } }
    : i === a.length - 2 ? { round: h.round, totals: { p1: 820, b1: 700, b2: 500, b3: 260 } } : h)),
  lastRoundResult: { p1: mk(225, true), b1: mk(180), b2: mk(110), b3: mk(60) },
  gameOverInfo: { ...GAME_OVER.gameOverInfo, winnerId: 'p1' } };

// Kartenhaus months for --tower (best stars per floor), and the archive behind them.
const TOWER_BEST = {
  mid: { 1: 3, 2: 3, 3: 3, 4: 2, 5: 2, 6: 2, 7: 1, 8: 1 },
  new: {},
  half: { 1: 3, 2: 3, 3: 3, 4: 2, 5: 3, 6: 2, 7: 3, 8: 2, 9: 3, 10: 2, 11: 2, 12: 2 }, // 30 of 60 stars, 13 next
  high: { 1: 3, 2: 3, 3: 3, 4: 3, 5: 2, 6: 2, 7: 2, 8: 1, 9: 1, 10: 1, 11: 2, 12: 1, 13: 1 },
  crowned: { 1: 3, 2: 3, 3: 3, 4: 3, 5: 3, 6: 2, 7: 3, 8: 2, 9: 2, 10: 2, 11: 1, 12: 2, 13: 1, 14: 1, 15: 2, 16: 1, 17: 1, 18: 1, 19: 1, 20: 1 },
  full: Object.fromEntries(Array.from({ length: 20 }, (_, i) => [i + 1, 3])), // all 60 stars
};
// --closed '{"13":"building","17":"locked"}': floors the server has no proven deal for yet.
const TOWER_CLOSED = JSON.parse(arg('closed', '{}'));
const TOWER_ARCHIVE = [
  { month: monthsBack(1), best: Object.fromEntries(Array.from({ length: 20 }, (_, i) => [i + 1, i < 6 ? 3 : i < 14 ? 2 : 1])) },
  { month: monthsBack(2), best: { 1: 3, 2: 2, 3: 2, 4: 1, 5: 1, 6: 1, 7: 1 } },
];
// Kartenhaus: a floor-6 verdict (handicap 20) on a one-round game over.
const TOWER_STATE = { ...BASE_STATE, phase: 'gameOver', roundNumber: 1, towerStage: 6, scoreHistory: [],
  players: [PLAYERS[0], { ...PLAYERS[1], botDifficulty: 'hard' }, { ...PLAYERS[2], botDifficulty: 'hard' }, { ...PLAYERS[3], botDifficulty: 'medium' }],
  totals: { p1: 235, b1: 150, b2: 90, b3: -20 }, lastRoundWinnerId: 'p1',
  lastRoundResult: { p1: mk(235, true), b1: mk(150), b2: mk(90), b3: mk(-20) },
  gameOverInfo: { winnerId: 'p1', finalTotals: {}, totalTurns: 41, totalRounds: 1, highlights: [], funTitle: null } };
const TOWER_RESULT = { type: 'towerResult', month: TODAY.slice(0, 7), stage: 6, stars: 1, myScore: 235, bestBot: 150, handicap: 20, margin: 65, wentOut: true,
  clearMargin: 100, progress: { best: { 1: 3, 2: 3, 3: 3, 4: 2, 5: 2, 6: 1 }, improved: true, stars: 14, cleared: 6, unlocked: 7, crowned: false, crownedNow: false },
  xp: 10, level: { level: 14, into: 145, need: 750, total: PROFILES[0].xp + 10 } }; // the floor's first star
// --december: the admin preview's example numbers, under the mock name.
const DEC_NOW = Date.parse('2026-12-28T10:00:00Z');
const YEAR_REVIEW = { ...require(path.join(ROOT, 'game', 'YearReviewMail')).sampleReview('2026'), name: ME };

// Rewrite server -> client messages so the lobby shows the mock profile.
// --puzzle-kind turn|out: today's puzzle message carries a puzzle of that kind.
let puzzleKind = null;
let mockToday = null; // the server's day, to answer a re-dated meld check as 'today'
let puzzleSolved = false; // scene puzzle-solved: today solved first try, a perfect run of 4
function kindPuzzle(kind) {
  const DP = require(path.join(ROOT, 'game', 'DailyPuzzle'));
  const { addDays } = require(path.join(ROOT, 'game', 'GameDay'));
  let date = DP.ROTATION_START;
  while (DP.kindForDate(date).kind !== kind) date = addDays(date, 1);
  return DP.puzzleForDate(date);
}
// stammtisch-lobby: the next join is shown as a seat at the mock Stammtisch.
let bindStammtisch = false;
let emptyMe = false; // scene stats-empty: a brand-new name (no games, no history)
let towerSceneBest = null; // tower-* scenes: one star already on the floor being played
function rewrite(msg) {
  if (msg.type === 'joined' && bindStammtisch) msg.stammtisch = { code: 'STMOCK1', name: STAMMTISCH.name };
  if (msg.type === 'profiles') { msg.players = emptyMe ? PROFILES.slice(1) : PROFILES; msg.globalStats = GLOBAL_STATS; }
  if (msg.type === 'gameHistory') msg.games = emptyMe ? [] : HISTORY;
  if (msg.type === 'towerInfo') {
    const BT = require(path.join(ROOT, 'game', 'BotTower'));
    const best = { ...(TOWER_BEST[TOWER_MOCK] || TOWER_BEST.mid), ...(towerSceneBest || {}) };
    const archive = TOWER_ARCHIVE.map((m) => ({ month: m.month, best: m.best, ...BT.summarize(m.best) }));
    Object.assign(msg, { best }, BT.summarize(best), { archive, totalStars: BT.summarize(best).stars + archive.reduce((n, m) => n + m.stars, 0) });
    if (Object.keys(TOWER_CLOSED).length) msg.closed = TOWER_CLOSED;
  }
  // Like the server: favourite opponent and Stammtisch only for the signed-in owner.
  if (msg.type === 'yearReview' && DECEMBER) {
    Object.assign(msg, { available: true, season: true, review: SIGNED_IN ? YEAR_REVIEW : { ...YEAR_REVIEW, favorite: null, table: null } });
  }
  if (msg.type === 'puzzle') mockToday = msg.today;
  if (msg.type === 'puzzleMeldCheck' && puzzleKind) msg.date = mockToday;
  if (msg.type === 'puzzle' && puzzleKind) {
    const DP = require(path.join(ROOT, 'game', 'DailyPuzzle'));
    Object.assign(msg, DP.publicPuzzle(kindPuzzle(puzzleKind)), { date: msg.today, archive: false });
  }
  if (msg.type === 'puzzle' && puzzleSolved) {
    Object.assign(msg, { status: { tries: 1, solved: true, revealed: false, stars: 3 }, dayStars: 3, perfectStreak: { current: 4, best: 6 } });
  }
  return msg;
}

// --- Kartenhaus floors from the engine (tower-* scenes) ------------------------
// The floor is looked up by its handicaps, so new deals or head starts in
// BotTower.js never break the scenes. turns = how many of my turns are played.
function towerStageFor(want) {
  const BT = require(path.join(ROOT, 'game', 'BotTower'));
  if (/^\d+$/.test(want)) return Number(want);
  const hit = BT.TOWER_STAGES.find((s) => {
    const mods = s.mods || [];
    return want === 'all' ? mods.length === BT.MODS.length : mods.length === 1 && mods[0] === want;
  });
  if (!hit) throw new Error(`no Kartenhaus floor with --floor ${want}`);
  return hit.stage;
}
function towerState(stage, turns, take = '') {
  const BT = require(path.join(ROOT, 'game', 'BotTower'));
  const GM = require(path.join(ROOT, 'game', 'GameManager'));
  const month = BT.monthOf(TODAY);
  const cfg = BT.stageConfig(stage, month);
  const g = new GM(() => {}, { deckSeed: cfg.seed, towerStage: stage, towerMonth: month });
  g.addOrReconnectPlayer('p1', ME);
  g.syncLobbyBots();
  g.startTowerRound();
  let st = g.publicState('p1');
  for (let mine = 0, guard = 0; mine < turns && g.phase === 'playing' && guard < 600; guard++) {
    const cp = g.currentPlayer();
    g.runBotTurn(cp.id, { forced: !cp.isBot });
    const next = g.currentPlayer();
    if (g.phase === 'playing' && next && next.id === 'p1' && g.turnPhase === 'draw') { mine += 1; st = g.publicState('p1'); }
  }
  // --take stock|pile: my draw is done, the meld phase shows the action bar (and the undo chip).
  if (take && g.phase === 'playing' && g.currentPlayer().id === 'p1') {
    if (take === 'pile' && g.canTakeDiscardTop(g.currentPlayer(), g.discardPile[0])) g.drawFromDiscard('p1');
    else g.drawFromPile('p1');
    st = g.publicState('p1');
  }
  g.destroy();
  return st;
}
// A live table from the engine (game-settings, home): my draw turn after a few turns, melds laid.
function tableState() {
  const GM = require(path.join(ROOT, 'game', 'GameManager'));
  const g = new GM(() => {}, { deckSeed: 7 });
  g.maybeRunBotTurn = () => {}; // the turns are driven here (CLAUDE.md: bot timer off)
  g.addOrReconnectPlayer('p1', ME);
  g.fillWithBots();
  g.startNewRound();
  let st = g.publicState('p1');
  for (let mine = 0, guard = 0; mine < 4 && g.phase === 'playing' && guard < 800; guard++) {
    const cp = g.currentPlayer();
    g.runBotTurn(cp.id, { forced: !cp.isBot });
    const next = g.currentPlayer();
    if (g.phase === 'playing' && next && next.id === 'p1' && g.turnPhase === 'draw') { mine += 1; st = g.publicState('p1'); }
  }
  g.destroy();
  return st;
}
// Where the table's regions sit (--measure): the floor card must not cost the melds or the hand.
function measurePage() {
  const box = (sel) => {
    const n = document.querySelector(sel);
    if (!n || n.classList.contains('hidden')) return null;
    const r = n.getBoundingClientRect();
    return r.width || r.height ? { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } : null;
  };
  const out = {};
  for (const sel of ['#topBar', '#opponents', '#melds', '#centerPiles', '#drawPile', '#discardPile', '#towerBar', '#towerBar .tbCard', '#towerBar .tbFold', '#towerBar .tbHide', '#towerStart', '#actionBar', '#handWrapper', '#hand']) out[sel] = box(sel);
  // The Kartenhaus sheet: the house, its play button, what scrolls and the smallest floor hit area.
  const sheet = document.querySelector('#towerOverlay:not(.hidden) .overlay-card');
  if (sheet) {
    for (const sel of ['#towerHouse', '#towerDetail', '#towerDetail .khPlay', '#towerCloseBtn']) out[sel] = box(sel);
    const side = sheet.querySelector('.khSide');
    const hits = [...document.querySelectorAll('#towerHouse .khNewLayer .khHit, #towerHouse > svg > .khFloor .khHit')]
      .map((h) => h.getBoundingClientRect()).map((r) => Math.round(Math.min(r.width, r.height) * 10) / 10);
    // A floor card's own size (unrotated): its SVG size times the house's scale.
    const svg = document.querySelector('#towerHouse svg');
    const face = document.querySelector('#towerHouse .khFace');
    const k = svg ? svg.getBoundingClientRect().width / svg.viewBox.baseVal.width : 0;
    out.tower = { sheetScroll: sheet.scrollHeight - sheet.clientHeight, sideScroll: side ? side.scrollHeight - side.clientHeight : null,
      minHit: hits.length ? Math.min(...hits) : null,
      card: face && k ? `${(face.width.baseVal.value * k).toFixed(1)}x${(face.height.baseVal.value * k).toFixed(1)}` : null };
  }
  // Any other open sheet: how many screens it scrolls, where "Schließen" and the sound switch end
  // (px from the sheet's top) and whether "Schließen" shows without scrolling.
  const ov = [...document.querySelectorAll('.overlay:not(.hidden)')].pop();
  const card = ov && !sheet && ov.querySelector('.overlay-card');
  if (card) {
    const cr = card.getBoundingClientRect();
    const close = (ov.dataset.sheetClose && document.getElementById(ov.dataset.sheetClose)) || card.querySelector(':scope > .btn-secondary');
    const sound = card.querySelector('label[for="soundCheckbox"], #soundToggle');
    const end = (n) => Math.round(n.getBoundingClientRect().bottom - cr.top + card.scrollTop);
    out.sheet = { id: ov.id, w: Math.round(cr.width), h: Math.round(cr.height), scrollH: card.scrollHeight, clientH: card.clientHeight,
      screens: Math.round((card.scrollHeight / card.clientHeight) * 100) / 100,
      closeEnd: close ? end(close) : null,
      closeVisible: close ? close.getBoundingClientRect().bottom <= Math.min(cr.bottom, innerHeight) + 1 : null,
      soundEnd: sound ? end(sound) : null };
  }
  return out;
}

// --- layout audit (runs in the page) ------------------------------------------
// Only the topmost open overlay counts when one is open: the blurred page
// behind it is not what the player can touch.
function auditPage(tapMin) {
  const overlays = [...document.querySelectorAll('.overlay:not(.hidden)')]
    .filter((o) => getComputedStyle(o).display !== 'none');
  const root = overlays.length ? overlays[overlays.length - 1] : document.body;
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return false;
    for (let n = el; n && n !== document.body; n = n.parentElement) {
      const cs = getComputedStyle(n);
      if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return false;
      if (n.tagName === 'DETAILS' && !n.open && n !== el && !n.querySelector('summary').contains(el)) return false;
    }
    return true;
  };
  const label = (el) => {
    const id = el.id ? `#${el.id}` : '';
    const cls = !id && typeof el.className === 'string' && el.className.trim() ? `.${el.className.trim().split(/\s+/)[0]}` : '';
    const text = (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40);
    return `${el.tagName.toLowerCase()}${id}${cls}${text ? ` "${text}"` : ''}`;
  };
  const out = { truncated: [], offscreen: [], smallTargets: [], unnamed: [], fold: null };
  const vw = document.documentElement.clientWidth;
  const inScroller = (el) => {
    for (let n = el.parentElement; n && n !== document.body; n = n.parentElement) {
      if (/auto|scroll/.test(getComputedStyle(n).overflowX)) return true;
    }
    return false;
  };
  for (const el of root.querySelectorAll('*')) {
    if (!visible(el) || el.closest('.seoIntro, .visuallyHidden')) continue;
    const cs = getComputedStyle(el);
    // Text clipped by its own box. Measure the text itself (a Range), not
    // scrollWidth: decorative pseudo-elements inflate scrollWidth.
    if ((cs.textOverflow === 'ellipsis' || cs.overflowX === 'hidden' || cs.overflowX === 'clip') &&
        (el.textContent || '').trim() && !el.querySelector('svg, canvas, img')) {
      const range = document.createRange();
      range.selectNodeContents(el);
      const textW = range.getBoundingClientRect().width;
      const box = el.getBoundingClientRect().width - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
      if (textW > box + 1) out.truncated.push(label(el));
    }
    // Text the screen edge cuts off: no box of its own clips it, the viewport does
    // (English "Head start 160" ran past a landscape edge). Scrollers and pieces in flight are fine.
    const own = [...el.childNodes].filter((n) => n.nodeType === 3 && n.textContent.trim());
    if (own.length && !el.getAnimations().some((a) => a.playState === 'running')) {
      const range = document.createRange();
      range.setStartBefore(own[0]);
      range.setEndAfter(own[own.length - 1]);
      const tr = range.getBoundingClientRect();
      if (tr.width && (tr.right > vw + 1 || tr.left < -1) && !inScroller(el)) out.offscreen.push(label(el));
    }
    const interactive = el.matches('button, a[href], input:not([type=hidden]), select, summary, [role=button]');
    if (interactive) {
      const r = el.getBoundingClientRect();
      // Inline links in running text are exempt (WCAG 2.5.8 inline exception).
      const inline = el.tagName === 'A' && cs.display === 'inline';
      // A hit area stretched by an absolute ::after (e.g. .resultSortBtn) counts.
      const after = getComputedStyle(el, '::after');
      const stretched = after.content !== 'none' && after.position === 'absolute' && parseFloat(after.height) >= tapMin;
      // So does the <label> around (or for) an input: a switch row is the target.
      const lab = el.matches('input') && (el.closest('label') || (el.id && document.querySelector(`label[for="${el.id}"]`)));
      const lr = lab ? lab.getBoundingClientRect() : null;
      const labelled = !!lr && Math.min(lr.width, lr.height) >= tapMin;
      if (!inline && !stretched && !labelled && Math.min(r.width, r.height) < tapMin) out.smallTargets.push(`${label(el)} ${Math.round(r.width)}x${Math.round(r.height)}`);
      if (el.matches('button, [role=button]') && !(el.textContent || '').trim() &&
          !el.getAttribute('aria-label') && !el.getAttribute('aria-labelledby') && !el.getAttribute('title')) {
        out.unnamed.push(label(el));
      }
    }
  }
  // Start screen must fit a portrait phone without scrolling (landscape may
  // scroll): where do the tools end?
  const tools = document.querySelector('.lobbyTools');
  const portrait = window.innerHeight > window.innerWidth;
  // Only the start screen must fit; a game lobby (seats, house rules) scrolls.
  const start = document.getElementById('createGameBtn');
  if (portrait && !overlays.length && tools && visible(tools) && start && visible(start)) {
    const bottom = tools.getBoundingClientRect().bottom + window.scrollY;
    if (bottom > window.innerHeight) out.fold = `.lobbyTools ends at ${Math.round(bottom)} px, viewport ${window.innerHeight} px`;
  }
  return out;
}

// --- server ------------------------------------------------------------------
function waitForHttp(port, ms = 20000) {
  const until = Date.now() + ms;
  return new Promise((resolve, reject) => {
    const tick = () => http.get(`http://localhost:${port}/healthz`, (r) => { r.resume(); resolve(); })
      .on('error', () => (Date.now() > until ? reject(new Error(`server on ${port} did not start`)) : setTimeout(tick, 250)));
    tick();
  });
}

(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pikdame-shots-data-'));
  // Postgres is mandatory: a fresh schema of the test database, like the tests use.
  const databaseUrl = process.env.PIKDAME_TEST_PG_URL
    ? require(path.join(ROOT, 'test/helpers/test-db.js')).testDatabaseUrl('uishots')
    : process.env.PIKDAME_DATABASE_URL;
  if (!databaseUrl) throw new Error('set PIKDAME_TEST_PG_URL (or PIKDAME_DATABASE_URL): the server needs PostgreSQL');
  const server = spawn('node', ['server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), PIKDAME_DATA_DIR: dataDir, PIKDAME_DATABASE_URL: databaseUrl }, stdio: 'ignore' });
  // The server flushes its snapshot on SIGTERM: wait for it before deleting.
  const exited = new Promise((r) => server.once('exit', r));
  const cleanup = async () => {
    if (server.exitCode === null) { server.kill(); await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]); }
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  };
  fs.mkdirSync(OUT, { recursive: true });
  const { chromium } = loadPlaywright();
  const written = [];
  const audits = [];
  const measures = {};
  try {
    await waitForHttp(PORT);
    const browser = await chromium.launch();
    for (const vn of views) {
      const vp = VIEWS[vn];
      if (!vp) throw new Error(`unknown view ${vn}`);
      const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, userAgent: UA, deviceScaleFactor: 2, isMobile: vp.mobile, hasTouch: vp.mobile,
        ...(STILL ? { reducedMotion: 'reduce' } : {}) });
      await ctx.addInitScript(([me, theme, musicHint, stammtische, uiLang]) => {
        try {
          localStorage.setItem('pikdame_player_name', me);
          if (uiLang) localStorage.setItem('pikdame_lang', uiLang); // --lang en
          if (theme) localStorage.setItem('pikdame_theme', theme); // --theme table|night|felt|love|bordeaux|kitchen
          localStorage.setItem('pikdame_splash_device', '1'); // skip the studio intro
          sessionStorage.setItem('pikdame_splash_seen', '1');
          // --stammtische 3: the most the start screen lists (its tallest form).
          const tables = [{ code: 'STMOCK1', name: 'Familie Deutsch' }, { code: 'STMOCK2', name: 'Skatrunde Mittwoch' }, { code: 'STMOCK3', name: 'Nachbarn' }];
          localStorage.setItem('pikdame_stammtische', JSON.stringify(tables.slice(0, stammtische)));
          // The first click starts the music; its one-time hint would sit on every later shot.
          if (!musicHint) localStorage.setItem('pikdame_music_hint', '1');
        } catch (e) { /* storage blocked */ }
      }, [ME, arg('theme', ''), scenes.includes('music-hint'), Math.max(0, Math.min(3, Number(arg('stammtische', 1)))), arg('lang', '')]);
      if (LIGHT_CSS) {
        await ctx.addInitScript((cssText) => {
          document.addEventListener('DOMContentLoaded', () => {
            const s = document.createElement('style');
            s.textContent = cssText;
            document.head.appendChild(s);
          });
        }, LIGHT_CSS);
      }
      // Phone views are iPhones: Safari has no Fullscreen API for pages, so no "Vollbild" row.
      if (vp.mobile) await ctx.addInitScript(() => { delete Element.prototype.requestFullscreen; });
      if (SIGNED_IN) {
        await ctx.addInitScript(() => { try { localStorage.setItem('pikdame_account_token', 'mock-token'); } catch (e) { /* blocked */ } });
        await ctx.route('**/api/**', (route) => route.fulfill({ contentType: 'application/json',
          body: JSON.stringify(ACCOUNT_API[new URL(route.request().url()).pathname] || { ok: true }) }));
        await ctx.route('**/statusz', async (route) => {
          const res = await route.fetch();
          route.fulfill({ response: res, body: JSON.stringify({ ...(await res.json()), accountsEnabled: true }) });
        });
      }
      const page = await ctx.newPage();
      if (DECEMBER) await page.clock.setFixedTime(new Date(DEC_NOW));
      let sock = null;
      await page.routeWebSocket(/.*/, (ws) => {
        sock = ws;
        const srv = ws.connectToServer();
        srv.onMessage((m) => { try { m = JSON.stringify(rewrite(JSON.parse(m))); } catch (e) { /* binary */ } ws.send(m); });
        // Answer Stammtisch probes here: the server counts an unknown code as a
        // failed join and blocks the IP after a few (it looked like throttling).
        ws.onMessage((m) => {
          let msg = null;
          try { msg = JSON.parse(m); } catch (e) { /* binary */ }
          if (msg && msg.type === 'getStammtisch') {
            ws.send(JSON.stringify({ type: 'stammtischInfo', code: msg.code, exists: true, ...STAMMTISCH }));
            return;
          }
          // The injected puzzle is another day's hand: ask the server about that day.
          if (msg && msg.type === 'checkPuzzleMeld' && puzzleKind) { srv.send(JSON.stringify({ ...msg, date: kindPuzzle(puzzleKind).date })); return; }
          srv.send(m);
        });
      });
      await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'networkidle' });
      await page.waitForTimeout(1200);
      const shot = async (name) => {
        const file = path.join(OUT, `${vn}-${name}.png`);
        await page.screenshot({ path: file });
        written.push(file);
        if (AUDIT) audits.push({ view: vn, scene: name, ...(await page.evaluate(auditPage, TAP_MIN)) });
        if (MEASURE) measures[`${vn}-${name}`] = await page.evaluate(measurePage);
      };
      const inject = (obj) => sock.send(JSON.stringify(obj));
      const toTable = async (st) => {
        inject({ type: 'joined', playerId: 'p1', playerToken: 't', sessionCode: 'MOCK01' });
        inject({ type: 'state', state: st });
        await page.waitForTimeout(1500); // the deal-in
      };
      // A table/result scene leaves the start screen, and its buttons are then
      // invisible (clicks time out). Reload without the mock session, so the
      // client neither rejoins nor probes an unknown code (that blocks the IP).
      const toStart = async () => {
        if (await page.isVisible('#createGameBtn')) return;
        await page.evaluate(() => { try { localStorage.removeItem('pikdame_last_session'); } catch (e) { /* blocked */ } });
        await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'networkidle' });
        await page.waitForTimeout(1200);
      };
      const LOBBY_SCENES = /^(lobby|lobby-open|progress|tower|tower-detail|tower-rules|tower-motion|tower-film|tower-skip|stats|stats-badges|stats-empty|history|settings|settings-aids|settings-music|sheet-reopen|cardback|music-hint|challenge|challenge-open|stammtisch|account|account-mail|puzzle.*|year.*)$/;
      for (const sc of scenes) {
        if (LOBBY_SCENES.test(sc)) await toStart();
        if (sc === 'lobby') { await page.waitForTimeout(Number(arg('settle', 0))); await shot('lobby'); }
        if (/^year(-mid|-bots|-end)?$/.test(sc)) {
          await page.click('#yearReviewBtn'); await page.waitForTimeout(400);
          const steps = { year: 0, 'year-mid': 2, 'year-bots': 5, 'year-end': 99 }[sc];
          for (let i = 0; i < steps && !(await page.isDisabled('#yearReviewNextBtn')); i++) await page.click('#yearReviewNextBtn');
          await page.waitForTimeout(500); // slide-in
          await shot(sc);
          await page.click('#yearReviewCloseBtn');
        }
        if (sc === 'year-image') {
          await page.click('#yearReviewBtn'); await page.waitForTimeout(1500); // drawn in the background
          const download = page.waitForEvent('download', { timeout: 8000 });
          await page.click('#yearReviewShareBtn');
          const file = path.join(OUT, `${vn}-year-image.png`);
          await (await download).saveAs(file);
          written.push(file);
          await page.click('#yearReviewCloseBtn');
        }
        if (sc === 'account-mail') {
          await page.click('#accountBtn'); await page.waitForTimeout(700);
          await page.evaluate(() => document.getElementById('accountMailPrefs').scrollIntoView({ block: 'center' }));
          await page.waitForTimeout(200);
          await shot('account-mail');
          await page.click('#accountCloseBtn');
        }
        if (sc === 'mail') {
          const { composeReviewMail } = require(path.join(ROOT, 'game', 'YearReviewMail'));
          const m = composeReviewMail({ review: YEAR_REVIEW, name: ME, lang: 'de', appUrl: 'https://play.pikdame.online/?jahr=2026', unsubscribeUrl: 'https://play.pikdame.online/unsubscribe?t=…' });
          const mp = await ctx.newPage();
          await mp.setContent(m.html, { waitUntil: 'load' });
          const file = path.join(OUT, `${vn}-mail.png`);
          await mp.screenshot({ path: file, fullPage: true });
          written.push(file);
          await mp.close();
        }
        if (sc === 'stammtisch') {
          await page.click('#stammtischRecent button[data-code]'); await page.waitForTimeout(500);
          await shot('stammtisch');
          await page.click('#stammtischSheetCloseBtn');
        }
        if (sc === 'puzzle-solved') {
          // Solved with three stars; then the "Aufgaben" tile shows them on the start screen.
          puzzleSolved = true;
          await page.click('#puzzleBtn'); await page.waitForTimeout(600);
          await shot(sc);
          await page.click('#puzzleCloseBtn'); await page.waitForTimeout(200);
          await shot('lobby-solved');
          puzzleSolved = false;
        } else if (sc.startsWith('puzzle')) {
          const refused = sc === 'puzzle-refused'; // two melds selected at once, "Auslegen" is refused
          puzzleKind = sc === 'puzzle' ? null : refused ? 'out' : sc.slice('puzzle-'.length);
          await page.click('#puzzleBtn'); await page.waitForTimeout(600);
          if (puzzleKind) {
            // Lay the first meld of the solution so the meld row shows.
            const p = kindPuzzle(puzzleKind);
            for (const id of refused ? p.best.melds[0].concat(p.best.melds[1]) : p.best.melds[0]) {
              await page.evaluate((cid) => {
                const card = [...document.querySelectorAll('#puzzleHand .card')].find((c) => c.dataset.cardId === cid);
                if (card) card.click();
              }, id);
            }
            await page.click('#puzzleLayBtn'); await page.waitForTimeout(refused ? 500 : 200);
          }
          await shot(sc);
          await page.click('#puzzleCloseBtn');
          puzzleKind = null;
        }
        if (sc === 'challenge') {
          await page.route('**/challengeboardz*', (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify({
            date: TODAY, you: { rank: 3, score: 1120, queens: 1, players: 12 }, attempted: true, magnet: { name: 'Klaus', queens: 3 },
            board: [{ rank: 1, name: 'Oma Gerda', score: 1380 }, { rank: 2, name: 'Klaus', score: 1205 }, { rank: 3, name: ME, score: 1120 }],
            weekly: { week: TODAY, players: 3, top: [{ rank: 1, name: 'Oma Gerda', weekScore: 5400, days: 5 }] }, trend: { dates: [], me: null, top: [] },
          }) }));
          await page.click('#challengeBtn'); await page.waitForTimeout(700);
          await shot('challenge');
          await page.click('#challengeCancelBtn');
        }
        if (sc === 'challenge-open') {
          // Before the own game the server sends only the count (week without today).
          await page.route('**/challengeboardz*', (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify({
            date: TODAY, revealed: false, players: 12, you: null, attempted: false, magnet: null, board: [],
            weekly: { week: TODAY, players: 3, top: [{ rank: 1, name: 'Oma Gerda', weekScore: 4100, days: 4 }] }, trend: { dates: [], me: null, top: [] },
          }) }));
          await page.click('#challengeBtn'); await page.waitForTimeout(700);
          await shot('challenge-open');
          await page.click('#challengeCancelBtn');
        }
        if (sc === 'stammtisch-lobby') {
          // A real game lobby whose join is rewritten to the mock Stammtisch:
          // the record panel (goals, series, standings) with mock numbers.
          await toStart();
          bindStammtisch = true;
          await page.click('#createGameBtn'); await page.waitForTimeout(900);
          inject({ type: 'stammtisch', summary: { code: 'STMOCK1', ...STAMMTISCH }, seriesEvent: null });
          await page.waitForTimeout(300);
          await page.evaluate(() => document.getElementById('stammtischSection').scrollIntoView({ block: 'start' }));
          await shot('stammtisch-lobby');
          bindStammtisch = false;
        }
        if (sc === 'gamelobby' || sc === 'botdiff') {
          if (!(await page.isVisible('#houseRulesSection'))) { await toStart(); await page.click('#createGameBtn'); await page.waitForTimeout(900); }
          if (sc === 'gamelobby') {
            await page.evaluate(() => document.getElementById('houseRulesSection').scrollIntoView({ block: 'center' }));
            await shot('gamelobby');
          }
          else {
            await page.click('.seatDiff'); await page.waitForTimeout(300);
            await shot('botdiff');
            await page.click('#botDiffCloseBtn');
          }
        }
        if (sc === 'lobby-open') {
          await page.evaluate(() => { const d = document.getElementById('questsSection'); if (d) d.open = true; });
          await shot('lobby-open');
        }
        if (sc === 'progress') {
          await page.click('#identityAvatarBtn'); await page.waitForTimeout(300);
          await shot('progress');
          await page.click('#progressCloseBtn');
        }
        if (sc === 'tower' || sc === 'tower-detail' || sc === 'tower-rules') {
          // After the first-visit deal (--tower-wait: another moment of it).
          await page.click('#towerTile'); await page.waitForTimeout(Number(arg('tower-wait', 2800)));
          if (sc === 'tower-detail') { await page.click(`#towerHouse [data-stage="${arg('stage', '14')}"]`); await page.waitForTimeout(400); }
          if (sc === 'tower-rules') {
            await page.evaluate(() => { const d = document.getElementById('towerRulesBox'); d.open = true; d.scrollIntoView({ block: 'center' }); });
            await page.waitForTimeout(400);
          }
          if (arg('eval', '')) console.log(`${vn}-${sc}:`, JSON.stringify(await page.evaluate(fs.readFileSync(arg('eval', ''), 'utf8'))));
          await shot(arg('tag', '') ? `${sc}-${arg('tag', '')}` : sc); // --tag half: one name per mock month
          await page.click('#towerCloseBtn');
        }
        // The month change frozen at --film times (ms; every house animation paused there),
        // then its end: last month's crowned house (the archive) is collected, the new one appears.
        if (sc === 'tower-film') {
          const from = TOWER_ARCHIVE[0];
          const lastMonth = JSON.stringify({ name: ME, month: from.month, best: from.best, crowned: Object.keys(from.best).length >= 20 });
          // A fresh show per frame: the client ends a show by a timer, too, should it never finish.
          for (const t of [...arg('film', '0,400,800,1200,1700,2300').split(',').map(Number), 'end']) {
            await page.evaluate(([v]) => localStorage.setItem('pikdame_tower_seen', v), [lastMonth]);
            await page.click('#towerTile'); await page.waitForTimeout(t === 'end' ? 3200 : 60);
            if (t !== 'end') {
              await page.evaluate((ms) => document.getElementById('towerHouse').getAnimations({ subtree: true })
                .forEach((a) => { a.pause(); a.currentTime = ms; }), t);
              await page.waitForTimeout(80);
            }
            await shot(`tower-film-${t === 'end' ? 'end' : String(t).padStart(4, '0')}`);
            await page.click('#towerCloseBtn'); await page.waitForTimeout(300);
          }
        }
        // A tap (touch on phones) on floor 5 during the month change: it skips to the end and
        // picks nothing (printed: running show, picked floor, detail title).
        if (sc === 'tower-skip') {
          const from = TOWER_ARCHIVE[0];
          await page.evaluate(([v]) => localStorage.setItem('pikdame_tower_seen', v),
            [JSON.stringify({ name: ME, month: from.month, best: from.best, crowned: true })]);
          await page.click('#towerTile'); await page.waitForTimeout(600);
          const hit = await page.$('#towerHouse .khNewLayer [data-stage="5"] .khHit');
          const b = await hit.boundingBox();
          if (VIEWS[vn].mobile) await page.touchscreen.tap(b.x + b.width / 2, b.y + b.height / 2);
          else await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
          await page.waitForTimeout(300);
          console.log(`${vn}-tower-skip:`, JSON.stringify(await page.evaluate(() => ({
            busy: document.getElementById('towerHouse').classList.contains('khBusy'),
            picked: [...document.querySelectorAll('#towerHouse [aria-pressed="true"]')].map((g) => g.dataset.stage),
            detail: document.querySelector('#towerDetail .khDTitle').textContent,
          }))));
          await shot('tower-skip');
          await page.click('#towerCloseBtn'); await page.waitForTimeout(300);
        }
        // Motion frames: a new month is collected (frozen at 800 ms) and has appeared, a new
        // card is dealt next to a lost try's wobble, and (--tower crowned) the Queen of Spades lands.
        if (sc === 'tower-motion') {
          const best = TOWER_BEST[TOWER_MOCK] || TOWER_BEST.mid;
          const seen = (month, b, crowned = false) => page.evaluate(([v]) => localStorage.setItem('pikdame_tower_seen', v),
            [JSON.stringify({ name: ME, month, best: b, crowned })]);
          await seen(monthsBack(1), TOWER_ARCHIVE[1].best);
          await page.click('#towerTile'); await page.waitForTimeout(150);
          await page.evaluate(() => document.getElementById('towerHouse').getAnimations({ subtree: true }).forEach((a) => { a.pause(); a.currentTime = 800; }));
          await page.waitForTimeout(80);
          await shot('tower-motion-1-collect');
          await page.evaluate(() => document.getElementById('towerHouse').getAnimations({ subtree: true }).forEach((a) => a.play()));
          await page.waitForTimeout(2600);
          await shot('tower-motion-2-new');
          await page.click('#towerCloseBtn'); await page.waitForTimeout(300);
          const top = Math.max(...Object.keys(best).map(Number));
          const before = { ...best }; delete before[top];
          await seen(TODAY.slice(0, 7), before, false);
          await page.evaluate(([v]) => localStorage.setItem('pikdame_tower_last', v),
            [JSON.stringify({ name: ME, month: TODAY.slice(0, 7), stage: top + 1, stars: 0 })]);
          await page.click('#towerTile'); await page.waitForTimeout(TOWER_MOCK === 'crowned' ? 650 : 420);
          await shot('tower-motion-3-land');
          await page.click('#towerCloseBtn');
        }
        if (sc === 'settings' || sc === 'settings-aids' || sc === 'settings-music') {
          await page.click('#settingsBtnLobby'); await page.waitForTimeout(400);
          // settings-aids: scrolled to the play aids at the end of the sheet.
          if (sc === 'settings-aids') await page.evaluate(() => document.getElementById('aidLowCardsCheckbox').scrollIntoView({ block: 'center' }));
          if (sc === 'settings-music') await page.evaluate(() => document.getElementById('musicItem').scrollIntoView({ block: 'center' }));
          await shot(sc);
          await page.click('#settingsOverlayCloseBtn');
        }
        if (sc === 'music-hint') {
          // The first gesture on a fresh start screen: music starts, the hint shows once.
          await page.click('#lobby h1'); await page.waitForTimeout(1800);
          await shot('music-hint');
        }
        if (sc === 'game-settings' || sc === 'game-settings-debug' || sc === 'home') {
          // A live engine table (or --state), then the gear's sheet / the home dialog. Whatever
          // overlay opens is shot and measured, so SHOTS_ROOT=<older checkout> shoots its sheet.
          await toTable(arg('state', '') ? JSON.parse(fs.readFileSync(arg('state', ''), 'utf8')) : tableState());
          const card = () => page.evaluate(() => {
            const o = [...document.querySelectorAll('.overlay:not(.hidden)')].pop();
            return o ? `#${o.id} .overlay-card` : null;
          });
          if (sc === 'home') {
            await page.click('#homeBtn'); await page.waitForTimeout(500);
            await shot('home');
            if (await page.isVisible('#homeOverlay #forfeitBtn')) {
              await page.click('#forfeitBtn'); await page.waitForTimeout(200);
              await shot('home-armed');
            }
            await page.click('#homeCancelBtn'); await page.waitForTimeout(300);
          } else {
            await page.click('#settingsBtn'); await page.waitForTimeout(600);
            const sel = await card();
            if (arg('eval', '')) console.log(`${vn}-${sc}:`, JSON.stringify(await page.evaluate(fs.readFileSync(arg('eval', ''), 'utf8'))));
            if (sc === 'game-settings-debug') {
              await page.evaluate(() => {
                const box = document.getElementById('debugCheckbox') || document.getElementById('debugBtn');
                box.click(); box.scrollIntoView({ block: 'center' });
              });
              await page.waitForTimeout(300);
              await shot(sc);
              await page.evaluate(() => (document.getElementById('debugCheckbox') || document.getElementById('debugBtn')).click());
            } else {
              await shot('game-settings');
              await page.evaluate((s) => { const c = document.querySelector(s); c.scrollTop = c.scrollHeight; }, sel);
              await page.waitForTimeout(250);
              await shot('game-settings-end');
            }
            await page.evaluate((s) => { const o = document.querySelector(s).closest('.overlay'); o.classList.add('hidden'); }, sel);
            await page.waitForTimeout(200);
          }
        }
        if (sc === 'sheet-reopen') {
          // Scroll the settings sheet down, close, reopen: it must be at the top again.
          await page.click('#settingsBtnLobby'); await page.waitForTimeout(400);
          await page.evaluate(() => { const c = document.querySelector('#settingsOverlay .overlay-card'); c.scrollTop = c.scrollHeight; });
          await page.waitForTimeout(200);
          await page.click('#settingsOverlayCloseBtn'); await page.waitForTimeout(300);
          await page.click('#settingsBtnLobby'); await page.waitForTimeout(500);
          await shot('sheet-reopen');
          await page.click('#settingsOverlayCloseBtn');
        }
        if (sc === 'cardback') {
          await page.click('#settingsBtnLobby'); await page.waitForTimeout(400);
          await page.evaluate(() => document.getElementById('cardbackBtn').click());
          await page.waitForTimeout(400);
          await shot('cardback');
          await page.evaluate(() => document.querySelector('.cardbackGallery').remove());
          await page.click('#settingsOverlayCloseBtn');
        }
        if (sc === 'account') {
          await page.click('#accountBtn'); await page.waitForTimeout(700);
          await page.evaluate(() => document.getElementById('ladderBox').scrollIntoView({ block: 'center' }));
          await page.waitForTimeout(200);
          await shot('account');
          await page.click('#accountCloseBtn');
        }
        if (sc === 'stats' || sc === 'history') {
          await page.click('#statsBtn'); await page.waitForTimeout(500);
          if (sc === 'history') { await page.click('#statsTabHistoryBtn'); await page.waitForTimeout(600); }
          await shot(sc);
          await page.click('#statsCloseBtn');
        }
        if (sc === 'stats-empty') {
          // A new name: the statistics empty state, then "Meine Partien" empty.
          emptyMe = true;
          await page.click('#statsBtn'); await page.waitForTimeout(700);
          await shot(sc);
          await page.click('#statsTabHistoryBtn'); await page.waitForTimeout(600);
          await shot('history-empty');
          await page.click('#statsTabBoardBtn'); await page.waitForTimeout(200);
          await page.click('#statsCloseBtn');
          emptyMe = false;
        }
        if (sc === 'stats-badges') {
          // Trophy cabinet: folded with the favourites on top, then a favourite's detail.
          await page.click('#statsBtn'); await page.waitForTimeout(500);
          await page.evaluate(() => document.getElementById('achievementsBox').scrollIntoView({ block: 'start' }));
          await page.waitForTimeout(200);
          await shot('stats-badges');
          await page.click('#achievementsBox .achAllBtn'); await page.waitForTimeout(200);
          await page.click('#achievementsBox .achTile[data-ach="games"]'); await page.waitForTimeout(300);
          await page.evaluate(() => document.querySelector('#achievementsBox .achTile[data-ach="games"]').scrollIntoView({ block: 'start' }));
          await page.waitForTimeout(200);
          await shot('stats-badges-open');
          await page.click('#statsCloseBtn');
        }
        if (sc === 'table') {
          // Live table: needs --state <file> with a publicState('p1') JSON (playing phase).
          const st = JSON.parse(fs.readFileSync(arg('state', ''), 'utf8'));
          inject({ type: 'joined', playerId: 'p1', playerToken: 't', sessionCode: 'MOCK01' });
          inject({ type: 'state', state: st });
          await page.waitForTimeout(1200);
          // --css <file>: extra CSS for quick layout mockups (never shipped).
          if (arg('css', '')) await page.addStyleTag({ content: fs.readFileSync(arg('css', ''), 'utf8') });
          if (arg('js', '')) await page.evaluate(fs.readFileSync(arg('js', ''), 'utf8')); // --js <file>: DOM mockups
          await page.waitForTimeout(200);
          await shot('table');
        }
        if (/^tower-(start|play|sheet|lock)$/.test(sc)) {
          // A live Kartenhaus floor: a fresh page each time, so the start card is
          // shown once per scene (the client remembers it per game code).
          const want = arg('floor', 'goOut');
          const stage = towerStageFor(want);
          const live = towerState(stage, sc === 'tower-start' ? 0 : Number(arg('turns', 3)), sc === 'tower-play' ? arg('take', '') : '');
          // --plain: the same deal and turns without the Kartenhaus fields - a normal table to --measure against.
          const st = process.argv.includes('--plain') ? Object.fromEntries(Object.entries(live).filter(([k]) => !k.startsWith('tower'))) : live;
          towerSceneBest = { [stage]: 1 };
          // --fold full|compact: the player's fold; hidden: the card taken off the table by its ✕.
          await page.evaluate(([fold]) => {
            try {
              localStorage.removeItem('pikdame_tower_intro'); localStorage.removeItem('pikdame_last_session');
              if (['full', 'compact'].includes(fold)) localStorage.setItem('pikdame_tower_fold', fold); else localStorage.removeItem('pikdame_tower_fold');
              if (fold === 'hidden') localStorage.setItem('pikdame_tower_hidden', '1'); else localStorage.removeItem('pikdame_tower_hidden');
            } catch (e) { /* blocked */ }
          }, [arg('fold', '')]);
          await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'networkidle' });
          await page.waitForTimeout(1200);
          inject({ type: 'joined', playerId: 'p1', playerToken: 't', sessionCode: 'MOCK01' });
          inject({ type: 'state', state: st });
          await page.waitForTimeout(1800); // deal-in and the start card
          // Not the start scene: "Los" was tapped long ago (as in a real game).
          if (sc !== 'tower-start' && await page.isVisible('#towerStartBtn')) { await page.click('#towerStartBtn'); await page.waitForTimeout(800); }
          if (sc === 'tower-sheet') { await page.click('#towerBar .tbCard'); await page.waitForTimeout(500); }
          // --tap 'a;b': taps in order (e.g. '#settingsBtn;#towerPanelBtn': the gear's way back to a hidden card).
          const taps = arg('tap', '').split(';').filter(Boolean);
          for (const [i, sel] of taps.entries()) {
            await page.click(sel);
            if (i < taps.length - 1) await page.waitForTimeout(400);
          }
          if (taps.length) {
            if (arg('tap-freeze', '')) await page.evaluate((ms) => document.getAnimations().forEach((a) => { a.pause(); a.currentTime = ms; }), Number(arg('tap-freeze', 0)));
            else await page.waitForTimeout(700);
          }
          if (sc === 'tower-lock') { await page.click('#discardTopCard'); await page.waitForTimeout(500); }
          if (arg('css', '')) await page.addStyleTag({ content: fs.readFileSync(arg('css', ''), 'utf8') });
          // --eval <file>: an expression evaluated in the page, printed (layout debugging).
          if (arg('eval', '')) console.log(`${vn}-${sc}:`, JSON.stringify(await page.evaluate(fs.readFileSync(arg('eval', ''), 'utf8'))));
          await shot(`${sc}-${want}${arg('tag', '') ? `-${arg('tag', '')}` : ''}`); // --tag: one name per variant
          towerSceneBest = null;
        }
        if (sc === 'gameover-tower') {
          inject({ type: 'joined', playerId: 'p1', playerToken: 't', sessionCode: 'MOCK01' });
          inject({ type: 'state', state: TOWER_STATE });
          inject(TOWER_RESULT);
          await page.waitForTimeout(1600);
          await shot(sc);
        } else if (sc.startsWith('roundend') || sc.startsWith('gameover')) {
          inject({ type: 'joined', playerId: 'p1', playerToken: 't', sessionCode: 'MOCK01' });
          const challenge = sc === 'gameover-challenge';
          const over = sc === 'gameover-win' ? GAME_OVER_WIN : GAME_OVER;
          inject({ type: 'state', state: sc.startsWith('gameover') ? { ...over, challengeDate: challenge ? TODAY : null } : ROUND_END });
          if (challenge) {
            inject({ type: 'challengeBoard', date: TODAY, yourScore: 880, yourRank: 2, yourQueens: 1, players: 9,
              board: [{ rank: 1, name: 'Oma Gerda', score: 1210 }, { rank: 2, name: ME, score: 880 }], history: [], weekly: null });
          }
          if (sc === 'gameover-stats') inject({ type: 'badges', earned: [{ name: ME, badges: ['marathon_10', 'queen_magnet_day'] }] });
          if (sc.startsWith('gameover')) inject({ type: 'progress', gainedXp: 120, xp: 5440, level: { level: 14 }, record: { played: 43, won: 17 } });
          if (sc === 'gameover-win') inject({ type: 'badges', earned: [{ name: ME, badges: ['score_500'] }] });
          await page.waitForTimeout(1600); // count-up + winner animation
          // A re-render keeps the body's scroll position: start every result shot at the top.
          await page.evaluate(() => { const b = document.getElementById('resultBody'); if (b) b.scrollTop = 0; });
          await page.waitForTimeout(100);
          if (sc === 'gameover-stats') {
            await page.click('#resultBody .resultTabBtn:nth-child(2)');
            await page.click('.gameTotalsBox button');
            await page.waitForTimeout(300);
          }
          if (sc === 'roundend-stats') { await page.click('#resultBody .resultTabBtn:nth-child(2)'); await page.waitForTimeout(300); }
          if (sc === 'gameover-challenge') {
            await page.evaluate(() => { const b = document.querySelector('.challengeBoardBox'); if (b) b.scrollIntoView({ block: 'center' }); });
            await page.waitForTimeout(200);
          }
          await shot(sc);
        }
      }
      await ctx.close();
    }
    await browser.close();
  } finally {
    await cleanup();
  }
  console.log(written.join('\n'));
  if (MEASURE) {
    fs.writeFileSync(path.join(OUT, 'measure.json'), JSON.stringify(measures, null, 1));
    console.log(`measure: ${path.join(OUT, 'measure.json')}`);
  }
  if (AUDIT) {
    const lines = ['# UI audit', ''];
    let findings = 0;
    for (const a of audits) {
      const items = [
        ...a.truncated.map((t) => `- **truncated** ${t}`),
        ...a.offscreen.map((t) => `- **off screen** ${t}`),
        ...a.smallTargets.map((t) => `- **tap target < ${TAP_MIN}px** ${t}`),
        ...a.unnamed.map((t) => `- **icon button without a name** ${t}`),
        ...(a.fold ? [`- **below the fold** ${a.fold}`] : []),
      ];
      findings += items.length;
      lines.push(`## ${a.view} / ${a.scene}`, '', ...(items.length ? items : ['- nothing found']), '');
    }
    fs.writeFileSync(path.join(OUT, 'audit.md'), lines.join('\n'));
    console.log(`audit: ${findings} finding(s) -> ${path.join(OUT, 'audit.md')}`);
  }
})().catch((e) => { console.error(e.message || e); process.exit(1); });

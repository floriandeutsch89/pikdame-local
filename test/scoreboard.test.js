const test = require('node:test');
const assert = require('node:assert/strict');
const { scoreRound, applyRoundScores, checkGameOver, GAME_END_THRESHOLD } = require('../game/ScoreBoard');
const { makeStandardCard, makeJoker, cardValue } = require('../game/Card');

const H = (rank, idx = 0) => makeStandardCard('H', rank, idx);
const S = (rank, idx = 0) => makeStandardCard('S', rank, idx);

test('Kartenwerte: Ass=20, 10=10, Bildkarten=10, 2-9=5, Joker=20, Pik Dame=100', () => {
  assert.equal(cardValue(H('A')), 20);
  assert.equal(cardValue(H('10')), 10);
  assert.equal(cardValue(H('K')), 10);
  assert.equal(cardValue(H('Q')), 10);
  assert.equal(cardValue(H('J')), 10);
  assert.equal(cardValue(H('7')), 5);
  assert.equal(cardValue(makeJoker(0)), 20);
  assert.equal(cardValue(S('Q')), 100);
});

test('Gewinner bekommt nur Pluspunkte seiner ausgelegten Karten', () => {
  const result = scoreRound('p1', {
    p1: { laidOutCards: [H('5'), H('K')], handCards: [] }, // 5 + 10 = 15
    p2: { laidOutCards: [], handCards: [H('2')] },
  });
  assert.equal(result.p1.roundScore, 15);
});

test('Mitspieler: Pluspunkte minus Minuspunkte der Handkarten', () => {
  const result = scoreRound('p1', {
    p1: { laidOutCards: [H('A')], handCards: [] },
    p2: { laidOutCards: [H('7')], handCards: [H('K'), H('2')] }, // 5 - (10+5) = -10
  });
  assert.equal(result.p2.roundScore, -10);
});

test('Eine Pik-Dame auf der Hand: -100 (keine zusätzliche Sonderstrafe)', () => {
  const result = scoreRound('p1', {
    p1: { laidOutCards: [H('A')], handCards: [] },
    p2: { laidOutCards: [], handCards: [S('Q')] },
  });
  assert.equal(result.p2.roundScore, -100);
});

test('Zwei Pik-Damen auf der Hand: -200 insgesamt, keine Sonderregelung', () => {
  const result = scoreRound('p1', {
    p1: { laidOutCards: [H('A')], handCards: [] },
    p2: { laidOutCards: [], handCards: [S('Q', 0), S('Q', 1)] },
  });
  assert.equal(result.p2.roundScore, -200);
  assert.equal(result.p2.breakdown.pikDameCount, 2);
});

test('Joker zählt 20 Punkte', () => {
  const result = scoreRound('p1', {
    p1: { laidOutCards: [makeJoker(0)], handCards: [] },
  });
  assert.equal(result.p1.roundScore, 20);
});

test('Hausregel "Hand aus zählt doppelt": verdoppelt die GESAMTE Rundenwertung aller Spieler', () => {
  const result = scoreRound(
    'p1',
    {
      p1: { laidOutCards: [H('A')], handCards: [] }, // 20
      p2: { laidOutCards: [], handCards: [H('K'), H('2')] }, // 0 - 15 = -15
    },
    { isHandAus: true, houseRules: { handAusDoubles: true } }
  );
  assert.equal(result.p1.roundScore, 40);
  assert.equal(result.p2.roundScore, -30);
});

test('Hausregel "Hand aus" ohne Aktivierung hat keinen Effekt', () => {
  const result = scoreRound(
    'p1',
    { p1: { laidOutCards: [H('A')], handCards: [] } },
    { isHandAus: true, houseRules: { handAusDoubles: false } }
  );
  assert.equal(result.p1.roundScore, 20);
});

test('applyRoundScores addiert Rundenergebnis zu Gesamtpunkten', () => {
  const totals = { p1: 50, p2: 10 };
  const roundResult = { p1: { roundScore: 15 }, p2: { roundScore: -10 } };
  const updated = applyRoundScores(totals, roundResult);
  assert.equal(updated.p1, 65);
  assert.equal(updated.p2, 0);
});

test('checkGameOver Standard: Spiel endet, sobald 1000 Punkte ERREICHT sind (>=)', () => {
  assert.equal(checkGameOver({ p1: 999, p2: 500 }).gameOver, false);
  const reached = checkGameOver({ p1: 1000, p2: 500 });
  assert.equal(reached.gameOver, true);
  assert.equal(reached.winnerId, 'p1');
});

test('Hausregel "über 1000 Punkte": genau 1000 reicht NICHT, erst >1000', () => {
  assert.equal(checkGameOver({ p1: 1000 }, { strictThreshold: true }).gameOver, false);
  const over = checkGameOver({ p1: 1001 }, { strictThreshold: true });
  assert.equal(over.gameOver, true);
});

test('checkGameOver: Gewinner ist der Spieler mit den meisten Punkten, nicht nur über der Schwelle', () => {
  const over = checkGameOver({ p1: 1001, p2: 1200, p3: 300 });
  assert.equal(over.gameOver, true);
  assert.equal(over.winnerId, 'p2');
});

test('GAME_END_THRESHOLD ist 1000', () => {
  assert.equal(GAME_END_THRESHOLD, 1000);
});


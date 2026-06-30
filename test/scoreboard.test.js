const test = require('node:test');
const assert = require('node:assert/strict');
const { scoreRound, applyRoundScores, checkGameOver, GAME_END_THRESHOLD } = require('../game/ScoreBoard');
const { makeStandardCard, makeJoker } = require('../game/Card');

const H = (rank, idx = 0) => makeStandardCard('H', rank, idx);
const S = (rank, idx = 0) => makeStandardCard('S', rank, idx);

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

test('Pik-Dame auf der Hand: 100 Minuspunkte aus Handwert + zusätzliche 100 Sonderstrafe', () => {
  const result = scoreRound('p1', {
    p1: { laidOutCards: [H('A')], handCards: [] },
    p2: { laidOutCards: [], handCards: [S('Q')] }, // Pik Dame: handValue 100, plus -100 Strafe
  });
  // roundScore = 0 (laidOut) - 100 (handValue) - 100 (Sonderstrafe) = -200
  assert.equal(result.p2.roundScore, -200);
  assert.equal(result.p2.breakdown.pikDamePenalty, 100);
});

test('Joker zählt 20 Punkte', () => {
  const result = scoreRound('p1', {
    p1: { laidOutCards: [makeJoker(0)], handCards: [] },
  });
  assert.equal(result.p1.roundScore, 20);
});

test('applyRoundScores addiert Rundenergebnis zu Gesamtpunkten', () => {
  const totals = { p1: 50, p2: 10 };
  const roundResult = { p1: { roundScore: 15 }, p2: { roundScore: -10 } };
  const updated = applyRoundScores(totals, roundResult);
  assert.equal(updated.p1, 65);
  assert.equal(updated.p2, 0);
});

test('checkGameOver: Spiel endet erst, wenn jemand > 1000 Punkte hat', () => {
  assert.equal(checkGameOver({ p1: 1000, p2: 500 }).gameOver, false);
  const over = checkGameOver({ p1: 1001, p2: 500 });
  assert.equal(over.gameOver, true);
  assert.equal(over.winnerId, 'p1');
});

test('checkGameOver: Gewinner ist der Spieler mit den meisten Punkten, nicht nur über der Schwelle', () => {
  const over = checkGameOver({ p1: 1001, p2: 1200, p3: 300 });
  assert.equal(over.gameOver, true);
  assert.equal(over.winnerId, 'p2');
});

test('GAME_END_THRESHOLD ist 1000', () => {
  assert.equal(GAME_END_THRESHOLD, 1000);
});

const test = require('node:test');
const assert = require('node:assert/strict');
const { canFormMeldWithCard } = require('../game/Rules');
const { makeStandardCard, makeJoker } = require('../game/Card');

const H = (rank, idx = 0) => makeStandardCard('H', rank, idx);
const S = (rank, idx = 0) => makeStandardCard('S', rank, idx);
const D = (rank, idx = 0) => makeStandardCard('D', rank, idx);
const C = (rank, idx = 0) => makeStandardCard('C', rank, idx);

test('canFormMeldWithCard: 1 reale Karte + 2 Joker ergibt einen Satz (Regression)', () => {
  // Konkret gemeldeter Fall: Pik-Ass liegt auf dem Stapel, Hand hat 2 Joker.
  const pikAss = S('A');
  const hand = [makeJoker(0), makeJoker(1)];
  assert.equal(canFormMeldWithCard(pikAss, hand), true);
});

test('canFormMeldWithCard: Satz erkannt mit genug gleichrangigen Karten', () => {
  const card = H('7');
  const hand = [D('7'), C('7')];
  assert.equal(canFormMeldWithCard(card, hand), true);
});

test('canFormMeldWithCard: Folge erkannt, auch wenn Joker die Folge nach außen erweitern muss', () => {
  // Hand hat nur eine Karte derselben Farbe -> Joker muss "verlängern", nicht nur Lücke füllen
  const card = H('Q');
  const hand = [H('K'), makeJoker(0)]; // Dame + König + 1 Joker -> Bube-Dame-König ODER Dame-König-Ass
  assert.equal(canFormMeldWithCard(card, hand), true);
});

test('canFormMeldWithCard: Ass zählt auch niedrig - Ass+2+3 IST eine gültige Folge (Ring)', () => {
  const ass = S('A');
  const hand = [S('2'), S('3')];
  assert.equal(canFormMeldWithCard(ass, hand), true);
});

test('canFormMeldWithCard: Ring-Folge K-A-2 wird erkannt', () => {
  const ass = S('A');
  const hand = [S('K'), S('2')];
  assert.equal(canFormMeldWithCard(ass, hand), true);
});

test('canFormMeldWithCard: keine Kombination möglich liefert false', () => {
  const card = H('7');
  const hand = [S('2'), D('K'), C('9')];
  assert.equal(canFormMeldWithCard(card, hand), false);
});

test('canFormMeldWithCard: Joker auf dem Stapel kann mit 2 gleichrangigen Karten einen Satz bilden', () => {
  const joker = makeJoker(0);
  const hand = [H('9'), D('9')];
  assert.equal(canFormMeldWithCard(joker, hand), true);
});

test('canFormMeldWithCard: Joker auf dem Stapel kann mit 1 Karte + 1 anderem Joker einen Satz bilden', () => {
  const joker = makeJoker(0);
  const hand = [H('9'), makeJoker(1)];
  assert.equal(canFormMeldWithCard(joker, hand), true);
});

test('canFormMeldWithCard: Joker auf dem Stapel kann mit 1 Karte + 1 anderem Joker eine Folge bilden', () => {
  const joker = makeJoker(0);
  const hand = [H('Q'), makeJoker(1)]; // entspricht Beispiel "1 Dame + 2 Joker"
  assert.equal(canFormMeldWithCard(joker, hand), true);
});

test('canFormMeldWithCard: Joker auf dem Stapel ohne jede Anschlussmöglichkeit liefert false', () => {
  const joker = makeJoker(0);
  const hand = [S('2'), D('7'), C('K')]; // alles isoliert, kein zweiter Joker
  assert.equal(canFormMeldWithCard(joker, hand), false);
});

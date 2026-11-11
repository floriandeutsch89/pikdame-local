// game/BossFight.js - the Kartenhaus boss floors: a duel in life points instead of scores.
// Pure rules on a plain state object (GameManager owns it, it rides in the snapshot).
// The card rules stay untouched: every boss ability is a damage rule. Numbers measured
// with 300 simulated fights per pairing (docs/developer/boss-fight.md).
'use strict';

const PLAYER_HP = 600;
// Two new melds in one turn count x1.5, three or more x2: the reason to collect.
const COMBO = [1.5, 2];
// A round that starts with the boss below half hits 25 % harder (its bot level barely matters in a duel).
const ENRAGE = 1.25;
const MAX_ROUNDS = 5; // then the higher share of life wins; never reached in 4500 simulated fights
const QUEEN_POINTS = 100;
// Stars: a win, a win with a third of the life left, with two thirds.
const STAR_SHARES = [0, 1 / 3, 2 / 3];

/**
 * hp/bot: the boss. ambush: its first hit of a round counts xN. armor: each of the player's
 * hits loses N. curse: every own turn that ends with a Queen of Spades in hand costs N.
 * crit: a melded Queen of Spades counts xN. adds: lives of the guards that stand in front
 * (hits go to the first one alive, the rest carries on); scratch: N per own turn per guard alive.
 * name: the seat's name at the table (log, turn line, result); the panel's wording is the client's.
 */
const BOSSES = {
  10: { id: 'jack', name: 'Karo-Bube', hp: 500, bot: 'hard', ambush: 1.5 },
  15: { id: 'king', name: 'Kreuz-König', hp: 500, bot: 'zen', armor: 10 },
  20: { id: 'queen', name: 'Pik Dame', hp: 550, bot: 'zen', curse: 10, crit: 2, adds: [100, 100], scratch: 3 },
};

const bossOf = (stage) => BOSSES[Number(stage)] || null;
const comboOf = (newMelds) => (newMelds >= 3 ? COMBO[1] : newMelds === 2 ? COMBO[0] : 1);

/** A fresh fight against `boss` (bossOf). */
function start(boss) {
  return {
    round: 1,
    me: PLAYER_HP,
    boss: boss.hp,
    adds: (boss.adds || []).slice(),
    enraged: false,
    ambush: true, // the boss's first hit of this round is still to come
    over: false,
    won: null,
    seq: 0,
    // What the last turn did, for the table: { seq, to, amount, kind, combo?, add?, ambush?, rage?, armor?, crit? }
    events: [],
  };
}

function note(state, event) {
  state.seq += 1;
  state.events.push({ seq: state.seq, ...event });
}

/** Damage to the boss's side: the guards first, the rest carries on to the boss. */
function hitBoss(state, amount, kind, combo, why) {
  let left = Math.round(amount);
  if (left <= 0) return;
  for (let i = 0; i < state.adds.length && left > 0; i++) {
    if (state.adds[i] <= 0) continue;
    const taken = Math.min(state.adds[i], left);
    state.adds[i] -= taken;
    left -= taken;
    note(state, { to: 'add', add: i, amount: taken, kind, ...(combo > 1 ? { combo } : {}), ...why });
  }
  if (left > 0) {
    state.boss -= left;
    note(state, { to: 'boss', amount: left, kind, ...(combo > 1 ? { combo } : {}), ...why });
  }
}

function hitMe(state, amount, kind, combo, why) {
  const dmg = Math.round(amount);
  if (dmg <= 0) return;
  state.me -= dmg;
  note(state, { to: 'me', amount: dmg, kind, ...(combo > 1 ? { combo } : {}), ...why });
}

/** Ends the fight as soon as one side is down (both: the higher share of life). */
function settle(state, boss) {
  if (state.over) return state;
  const meDown = state.me <= 0;
  const bossDown = state.boss <= 0;
  if (!meDown && !bossDown) return state;
  state.over = true;
  state.won = meDown && bossDown ? state.me / PLAYER_HP > state.boss / boss.hp : bossDown;
  return state;
}

/**
 * The player's turn is over. points: the value of what was laid this turn; newMelds: melds
 * newly laid; queensLaid: Queens of Spades among them; holdsQueen: one is still in hand.
 */
function playerTurn(state, boss, { points = 0, newMelds = 0, queensLaid = 0, holdsQueen = false } = {}) {
  if (state.over) return state;
  state.events = [];
  if (points > 0) {
    const combo = comboOf(newMelds);
    let dmg = points * combo;
    const crit = !!(boss.crit && queensLaid > 0);
    if (crit) dmg += QUEEN_POINTS * queensLaid * (boss.crit - 1);
    if (boss.armor) dmg = Math.max(0, dmg - boss.armor);
    // The reasons ride along, so the table names them instead of guessing.
    hitBoss(state, dmg, 'hit', combo, { ...(crit ? { crit: boss.crit } : {}), ...(boss.armor ? { armor: boss.armor } : {}) });
    if (settle(state, boss).over) return state;
  }
  // Only what is still standing strikes back.
  const guards = state.adds.filter((hp) => hp > 0).length;
  if (boss.scratch && guards) hitMe(state, boss.scratch * guards, 'scratch');
  if (boss.curse && holdsQueen) hitMe(state, boss.curse, 'curse');
  return settle(state, boss);
}

/** The boss's turn is over. */
function bossTurn(state, boss, { points = 0, newMelds = 0 } = {}) {
  if (state.over) return state;
  state.events = [];
  if (points <= 0) return state;
  const combo = comboOf(newMelds);
  let dmg = points * combo;
  const ambush = !!(boss.ambush && state.ambush);
  if (ambush) dmg *= boss.ambush;
  state.ambush = false;
  if (state.enraged) dmg *= ENRAGE;
  hitMe(state, dmg, 'hit', combo, { ...(ambush ? { ambush: boss.ambush } : {}), ...(state.enraged ? { rage: true } : {}) });
  return settle(state, boss);
}

/** The round is scored: cards left in hand hurt their holder; then the next round, or the verdict. */
function roundEnd(state, boss, { myHand = 0, bossHand = 0 } = {}) {
  if (state.over) return state;
  state.events = [];
  hitMe(state, myHand, 'hand');
  hitBoss(state, bossHand, 'hand', 1);
  if (settle(state, boss).over) return state;
  if (state.round >= MAX_ROUNDS) {
    const guardsMax = (boss.adds || []).reduce((s, hp) => s + hp, 0);
    const guards = state.adds.reduce((s, hp) => s + Math.max(0, hp), 0);
    state.over = true;
    state.won = state.me / PLAYER_HP > (state.boss + guards) / (boss.hp + guardsMax);
    return state;
  }
  state.round += 1;
  state.ambush = true;
  state.enraged = state.boss < boss.hp / 2;
  return state;
}

/** 0-3 stars of a finished fight. */
function starsFor(state) {
  if (!state || !state.over || !state.won) return 0;
  const share = Math.max(0, state.me) / PLAYER_HP;
  return STAR_SHARES.filter((min) => share >= min).length;
}

/** What the table shows: the boss's numbers next to the state (never anything hidden). */
function publicView(state, boss) {
  return {
    id: boss.id,
    hp: Math.max(0, state.boss),
    maxHp: boss.hp,
    adds: state.adds.map((hp, i) => ({ hp: Math.max(0, hp), maxHp: boss.adds[i] })),
    me: Math.max(0, state.me),
    myMaxHp: PLAYER_HP,
    starLife: STAR_SHARES.slice(1).map((share) => Math.ceil(PLAYER_HP * share)), // life left for 2 and 3 stars
    round: state.round,
    maxRounds: MAX_ROUNDS,
    enraged: state.enraged,
    ambushReady: !!(boss.ambush && state.ambush && !state.over),
    over: state.over,
    won: state.won,
    events: state.events,
    // The rules as numbers; the client owns the wording (DE/EN).
    traits: {
      ...(boss.ambush ? { ambush: boss.ambush } : {}),
      ...(boss.armor ? { armor: boss.armor } : {}),
      ...(boss.curse ? { curse: boss.curse } : {}),
      ...(boss.crit ? { crit: boss.crit } : {}),
      ...(boss.scratch ? { scratch: boss.scratch } : {}),
      combo: COMBO,
      enrage: ENRAGE,
    },
  };
}

module.exports = {
  PLAYER_HP, COMBO, ENRAGE, MAX_ROUNDS, BOSSES,
  bossOf, comboOf, start, playerTurn, bossTurn, roundEnd, starsFor, publicView,
};

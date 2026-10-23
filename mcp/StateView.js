'use strict';

// Renders a seat's view of the table as compact text for a language model.

const { cardText, meldText, handOrder } = require('./LegalActions');
const { cardValue } = require('../game/Card');

function playerName(state, id) {
  const p = state.players.find((x) => x.id === id);
  return p ? p.name : '?';
}

function renderState(state, myId) {
  if (!state) return 'Not seated at a table yet.';
  const me = state.players.find((p) => p.id === myId);
  const lines = [];
  const turnOf = state.currentPlayerId === myId ? 'YOU' : playerName(state, state.currentPlayerId);
  lines.push(`Phase: ${state.phase}${state.paused ? ' (paused)' : ''} | round ${state.roundNumber}${state.phase === 'playing' ? ` | turn: ${turnOf} (${state.turnPhase} phase)` : ''}`);

  // "2 gegen 2": teams by seat; the shared total decides, the rules at the table do not change.
  const teams = state.teamMode && Array.isArray(state.teams) ? state.teams : null;
  const teamOf = (id) => (teams ? teams.findIndex((ids) => ids.includes(id)) : -1);
  const myTeam = teamOf(myId);
  const teamName = (t) => `team ${t === 0 ? 'A' : 'B'}`;
  lines.push('Players (total score, cards in hand):');
  for (const p of state.players) {
    const team = teamOf(p.id);
    const teamTag = team < 0 ? null : `${teamName(team)}${p.id !== myId && myTeam >= 0 ? (team === myTeam ? ', your partner' : ', opponent') : ''}`;
    const tags = [p.id === myId ? 'you' : null, teamTag, p.isBot ? `bot ${p.botDifficulty || ''}`.trim() : null, p.id === state.dealerId ? 'dealer' : null, p.connected ? null : 'offline'].filter(Boolean);
    lines.push(`- ${p.name}${tags.length ? ` [${tags.join(', ')}]` : ''}: ${(state.totals && state.totals[p.id]) || 0} pts, ${p.handCount} cards`);
  }
  if (teams) {
    const tt = state.teamTotals || [0, 0];
    lines.push(`Team game (2 vs 2): ${teams.map((ids, t) => `${teamName(t)} ${ids.map((id) => (id === myId ? 'YOU' : playerName(state, id))).join(' + ')} = ${tt[t] || 0} pts`).join(' | ')}. A team wins at 1000 shared points; everyone still lays off and swaps jokers only on their OWN melds.`);
  }

  if (me && me.hand) {
    const hand = me.hand.slice().sort(handOrder);
    const value = hand.reduce((s, c) => s + cardValue(c), 0);
    lines.push(`Your hand (${hand.length} cards, ${value} pts if caught): ${hand.map(cardText).join(' ')}`);
  }
  if (state.mustLayOffCardId) {
    const c = me && me.hand.find((x) => x.id === state.mustLayOffCardId);
    lines.push(`DUTY: you took ${cardText(c)} from the discard pile - lay it in a NEW meld with hand cards now.`);
  }

  if (state.phase === 'playing' || state.phase === 'roundEnd') {
    lines.push(`Draw pile: ${state.drawPileCount} cards | discard pile: ${state.discardPileCount} cards, top ${cardText(state.discardTop)}`);
    const visible = (state.discardCards || []).slice(0, 12).map(cardText).join(' ');
    if (visible) lines.push(`Discard pile from the top: ${visible}${state.discardPileCount > 12 ? ' ...' : ''}`);
    const melds = state.tableMelds || [];
    if (melds.length === 0) lines.push('Table: no melds yet.');
    for (const p of state.players) {
      const own = melds.filter((m) => m.ownerId === p.id);
      if (own.length) lines.push(`Melds of ${p.id === myId ? 'YOU' : p.name}: ${own.map((m) => `[${meldText(m)}]`).join(' ')}`);
    }
  }

  if (state.phase === 'roundEnd' && state.lastRoundResult) {
    const parts = Object.entries(state.lastRoundResult).map(([id, r]) => `${playerName(state, id)} ${r && r.roundScore > 0 ? '+' : ''}${r ? r.roundScore : '?'}`);
    lines.push(`Round result: ${parts.join(', ')}`);
  }
  if (state.phase === 'gameOver') {
    lines.push(`GAME OVER: ${JSON.stringify(state.gameOverInfo || state.totals).slice(0, 600)}`);
  }
  if (state.phase === 'lobby') {
    lines.push(`Lobby: ${state.isHost ? 'you are the host and can start' : 'waiting for the host to start'}; seats ${state.maxSeats}.`);
  }
  return lines.join('\n');
}

/** Log lines (German, from the server) not yet in `seen`; marks them seen. */
function newLogLines(state, seen) {
  const fresh = [];
  for (const e of (state && state.log) || []) {
    const key = `${e.t}|${e.text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    fresh.push(e.text);
  }
  if (seen.size > 500) for (const k of [...seen].slice(0, 250)) seen.delete(k);
  return fresh;
}

module.exports = { renderState, newLogLines };

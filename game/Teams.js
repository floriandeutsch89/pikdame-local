// game/Teams.js
// "2 gegen 2": two teams at four seats, seated crosswise - team A holds seats
// 0 and 2, team B seats 1 and 3 - so the teams alternate turns and both
// neighbours of every seat are opponents. Pure helpers for the engine, the
// stores and the bots; a team is always derived from the seat order.

const TEAM_SEATS = 4;

/** Team index of a seat: 0 = A, 1 = B. */
function teamOfSeat(seat) {
  return ((Number(seat) % 2) + 2) % 2;
}

/** The partner's seat at a four-seat team table. */
function partnerSeat(seat) {
  return (Number(seat) + 2) % TEAM_SEATS;
}

/** [[ids of A], [ids of B]] in seat order. */
function teamsOf(players) {
  const teams = [[], []];
  (players || []).forEach((p, i) => teams[teamOfSeat(i)].push(p.id));
  return teams;
}

/** Per-team sums [a, b] of per-player numbers keyed by id (totals, round scores). */
function teamSums(teams, byId) {
  return (teams || [[], []]).map((ids) => ids.reduce((s, id) => s + ((byId && byId[id]) || 0), 0));
}

/** Team index of a player id in a [[...],[...]] list, -1 when not seated there. */
function teamIndexOf(teams, playerId) {
  return (teams || []).findIndex((ids) => ids.includes(playerId));
}

/** The winners of a finished match record: both teammates in team mode. */
function recordWinnerIds(record) {
  if (!record) return [];
  if (Array.isArray(record.winnerIds)) return record.winnerIds;
  return record.winnerId ? [record.winnerId] : [];
}

function isRecordWinner(record, playerId) {
  return !!playerId && recordWinnerIds(record).includes(playerId);
}

/** Who a player played AGAINST: the other team in team mode, everyone else otherwise. */
function recordOpponentIds(record, playerId) {
  const players = (record && record.players) || [];
  if (record && record.teamMode && Array.isArray(record.teams)) {
    const mine = teamIndexOf(record.teams, playerId);
    if (mine >= 0) return (record.teams[1 - mine] || []).slice();
  }
  return players.filter((p) => p.id !== playerId).map((p) => p.id);
}

module.exports = {
  TEAM_SEATS,
  teamOfSeat,
  partnerSeat,
  teamsOf,
  teamSums,
  teamIndexOf,
  recordWinnerIds,
  isRecordWinner,
  recordOpponentIds,
};

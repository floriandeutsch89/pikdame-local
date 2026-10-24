# "2 gegen 2" (team mode)

Two teams of two at a four-seat table. The rules at the table do not change;
only the points are shared. `game/Teams.js` holds the pure helpers, the
engine lives in `GameManager` (flag `teamMode`).

## Rules

- **Seating crosswise:** team A holds seats 0 and 2, team B seats 1 and 3. The
  teams take turns alternately and both neighbours of every seat are
  opponents, so a discard always goes to an opponent.
- **At the table nothing changes:** everyone keeps their own melds; laying off
  and joker swaps only on one's own melds; going out only by discarding the
  last card.
- **Scoring:** every seat is scored exactly as in a normal game (melds plus,
  hand minus, ♠Q 100, a swapped joker 20, no minus for whoever goes out). A
  team's round result is the sum of its two seats. The house rule "Hand aus
  zählt doppelt" doubles every seat's round score as always, so both team sums
  double (decided: stays so). The other round ends (empty draw pile, 160 turns
  without a meld, a deadlock) score per seat as always, then sum.
- **Game end at 2000:** a team reaches 2000 shared points, twice the solo
  target (`ScoreBoard.TEAM_GAME_END_THRESHOLD = 2 * GAME_END_THRESHOLD`, the
  only place; `gameEndThreshold(teamMode)`, `game.targetScore()` and
  `publicState.targetScore` derive from it). Two seats feed one total, so each
  seat's own total stays on the solo scale (about 1000 for a winner). House
  rule "streng": more than 2000. If both teams cross the line in the same
  round, the higher total wins. Equal totals play one more round - the tie
  rule for two players, applied to the two teams
  (`ScoreBoard.checkTeamGameOver`). The "Endspurt" call comes at 80 % of the
  target (1600).
- **Rematch:** the winning team's top scorer deals the first round.

## Who plays

- **Free tables only.** Humans join, bots fill the empty seats, and every bot
  plays the same level (a single bot's level is refused). A human seat's
  stand-in (disconnect, turn timer, a seat given up mid-game) plays at that
  level too, not as Zen, and follows when the host changes it.
- **Joining:** in the lobby a newcomer takes a bot seat of the team with fewer
  humans (team A on a tie), so two humans start as opponents. `switchTeam`
  moves to a free bot seat of the other team; the host can still arrange the
  seats freely. Leaving the lobby puts a bot on that very seat, so nobody
  else changes team. During a match a newcomer takes over a bot seat as it is,
  team included; a reconnect returns to the same seat.
- **"Du + Bot gegen 2 Bots":** `createSession` with `teamMode` and
  `quickStart` deals right away with the remembered bot level.
- **Team names (optional):** in the lobby any human of a team may name it
  (`setTeamName` with `teamName`). The name is cleaned like a player name
  (`sanitizeName`: letters, digits, blank and `._-!?`, 16 characters,
  whitespace collapsed, trimmed); empty clears it. At most five changes per
  team and minute (`TEAM_NAME_CHANGES`, `TEAM_NAME_WINDOW_MS`, transient). A
  team without a human keeps no name, switching the mode off clears both. The
  names hold through reconnects, the match and the rematch, survive a restart
  (a restored name passes the cleaner again) and reach every seat
  (`publicState.teamNames`, game over, the record, "Meine Partien", the MCP
  view); the log calls a named team "Team <Name>".
- **Never** in the daily challenge, the Kartenhaus, the tutorial or the daily
  puzzle (no table there). The constructor ignores the option for solo games
  and `setTeamMode` refuses them.
- **At a Stammtisch** the host switches it on in the lobby like anywhere else;
  a new Stammtisch table opens as a normal table. The match counts as played,
  never as a win (below).

## At a Stammtisch

A Stammtisch's record says who beat whom, and a team match says that about
nobody: two partners beat two others together. So a team match counts as a
played match and stays out of everything that compares players
(`StammtischStore.recordGame`, decided with the user):

| What | A team match |
| --- | --- |
| The match list (`stammtisch_games`, the sheet's "Letzte Partien") | counts: `team_mode`, both team names, each seat's `team_no`, `won` for both winners |
| The table's "N Partien", the weekly goal, the streak, the group points and level | counts (`bookGame` with the number of humans, as for any match) |
| A member's games, own points (the standings' "Ø") and last visit | counts: neutral, the own total is on the solo scale (see the target) |
| A member's wins (the standings' order, the chip's "Flo führt") | no: a team win would rank both partners above the other two |
| The pairwise head-to-head | no: `summarize` skips team matches |
| The best-of-3 series | no: neither a game of it nor a restart. A finished series stays visible until the next solo match starts a new one; the team match keeps the running series' number |
| The next evening's first dealer (`lastWinner`) | the winning team's top-scoring human, like a rematch |
| Profile, XP, badges ("10 Partien am Stammtisch") and "Meine Partien" | as at any team table; the history keeps a `stammtisch` flag, never the code |

The client says it where the numbers are: the record (lobby panel and the
start-screen sheet) carries one line on what a team match counts for once the
table has one or plays "2 gegen 2"; the sheet lists the newest three matches
(a team match with the "2 gegen 2" tag, both pairs and both totals); a team
result shows that line instead of the series, and its rematch button promises
no game of the series.

## Progress

XP and statistics work as in a normal match and take the same async booking
chain (`bookFinishedGame` in `server.js`: profile, streak, XP and quests, the
ladder, badges); a team win is a win for both teammates. A seat given up
mid-game is booked for nobody, as in a normal match. Per badge and quest:

| What | In team mode |
| --- | --- |
| XP | 10 + 50 for a team win (both teammates) + the player's **own** final total / 10. The team sum would pay every point twice. |
| Wins, streaks, losses (purple heart), quest `win_game`, the ladder's `won` | the team result, for both |
| `comeback` | the own team was behind after round 1 and won |
| `landslide`, `near_miss` | team totals, the margins scaled to the target: won by 1000 or more / lost by less than 40 (solo: 500 / 20) |
| `zen_slayer`, `zen_trio`, quest `beat_zen` | only Zen bots of the other team count; a Zen partner is no Zen win (`zen_trio` needs three Zen opponents, so never at a team table) |
| `red_lantern` (last place) | the losing team is last, as at a two-player table |
| `score_500`, quest `score_400`, `rock_bottom` | the player's own total (on the solo scale, see the target) |
| Everything per round (hand aus, queens, jokers, runs, pile glutton, round 300, ...) | unchanged: the player's own facts |
| Year review | the partner is no opponent |

### Is it farmable?

Match length in self-play (600 games per mode, all bots medium,
`node scripts/sim-bots.js --lengths`; XP: the mean a seat books per match):

| Mode | Rounds | Turns (all seats) | XP per seat |
| --- | --- | --- | --- |
| 1 vs 1 | 6.66 ± 0.05 | 134.5 ± 1.1 | 129.7 ± 0.4 |
| 4 players | 7.07 ± 0.05 | 202.2 ± 1.5 | 104.2 ± 0.5 |
| 2 vs 2 (to 2000) | 8.22 ± 0.05 | 236.2 ± 1.4 | 131.1 ± 0.4 |

A player alone with three bots wins half the team matches at equal strength,
like a 1-vs-1 table, and plays about 59 own turns per match (1 vs 1: 67).
Estimated with 10 s per own turn and 1 s per bot turn: 12.8 min per team
match against 12.3 min at 1 vs 1, so 2.3 against 2.4 wins and about 615
against 630 XP per hour. A team table pays like a 1-vs-1 table. (At the
first target of 1000 a team match took 4.2 rounds and paid about twice the
wins per hour; the 2000 target removed that.) Decided: no damping in v1.

## Bots

- **Zen plays the net only with a v2 model.** `OnnxPolicy` reads the model's
  input size: the shipped v1 model (377 observations) never sees a team
  table, so Zen plays its heuristic there; a v2 model (385: v1 plus 8 team
  features, {ref}`training-v2`) plays team tables too. A human's stand-in
  plays the table's level on the net path as well (`GameManager._seatLevel`).
- **The v1 net would already be strong here:** zero-padded to v2 (it ignores
  the team features, plays exactly like v1), a Zen team won 82.1 % ± 1.5 of
  its matches against a Schwer team (2026-10-24, 10 × 100 games,
  `node scripts/sim-bots.js --team-ladder hard,zen`). Not shipped: the team
  features come with a trained v2 model.
- **The heuristic already fits:** with crosswise seats the next player is
  always an opponent (discard safety holds), the endgame damage control
  already counts the partner's small hand (the round ends whoever goes out),
  and bots never hold back going out.
- **Investigated, not shipped:** a team-aware context for the counting levels
  (the team's lead instead of the own one, the partner's publicly known cards
  no reason to keep a discard). Self-play, team-aware against naive at one
  level, sides alternating, 20 batches × 500 games
  (`node scripts/sim-bots.js --team hard zen --batches 20 --games 500`):

  | Level | Team target 1000 | Team target 2000 |
  | --- | --- | --- |
  | Hard | 49.8 % ± 0.4 | 49.4 % ± 0.4 |
  | Zen (heuristic) | 49.9 % ± 0.5 | 49.6 % ± 0.3 |

  No effect at either target; the seat flag `teamAware` stays off (an A/B
  seam in `SEAT_CONTROL_FIELDS`). Easy and medium do not read these inputs at
  all.

## For drivers and the encoder

- `new GameManager(send, { teamMode: true })` opens a four-seat team table
  (ignored together with `challengeDate`, `tutorialMode` or `towerStage`), so
  a self-play driver needs no lobby.
- `game.teamMode`, `game.teamOf(seatOrId)` (0 or 1), `game.partnerOf(id)`
  (the seat object), `game.teams()` (`[[A ids], [B ids]]`) and
  `game.teamTotals()` (`[A, B]`); all `null` outside team mode. Pure helpers in
  `game/Teams.js` (`teamOfSeat`, `partnerSeat`, `teamsOf`, `teamSums`,
  `isRecordWinner`, ...). `game.targetScore()`: 2000 at a team table, else 1000.
- `publicState`: `teamMode`, `teams`, `teamTotals`, `teamNames`
  (`[A, B]`, `null` for none), `targetScore`, and `teamTotals` per entry of
  `scoreHistory`.
- Round history: `teamScores` and `teamTotalsAfter` per round. Game over and
  the match record: `teamMode`, `teams`, `winnerTeam`, `winnerIds`,
  `teamTotals`, `teamNames`, `targetScore`, and `winnerId: null` - nothing
  credits one teammate alone.
- Move log rows: `teamMode: 1`, `team`, `teamTotals`, and `won`/`rank` by
  team; the row's `state` names `team` and `teamTotals`, every entry of
  `state.opponents` its `team` (the partner shares the decider's). `obs`
  stays v1; `obsTeam` holds the 8 v2 team features (`obs + obsTeam` = v2).
- Encoder v2 (`StateEncoder.encode(game, id, { version: 2 })`): v1 unchanged,
  then team mode, partner flag per opponent slot, both team totals / 2000,
  the partner's hand and the other team's smallest hand / 15. The training
  bridge (`scripts/rl-env-server.js`, `teamMode` on `reset`) rewards the
  team: (own team − other team) / 200 per round, ±1 for the match.

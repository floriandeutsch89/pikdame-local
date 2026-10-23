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
  double. The other round ends (empty draw pile, 160 turns without a meld, a
  deadlock) score per seat as always, then sum.
- **Game end:** a team reaches 1000 shared points (house rule "streng": more
  than 1000). If both teams cross the line in the same round, the higher total
  wins. Equal totals play one more round - the tie rule for two players,
  applied to the two teams (`ScoreBoard.checkTeamGameOver`).
- **Rematch:** the winning team's top scorer deals the first round.

## Who plays

- **Free tables only.** Humans join, bots fill the empty seats, and every bot
  plays the same level (a single bot's level is refused). A human seat's
  stand-in (disconnect, turn timer) plays at that level too, not as Zen.
- **Joining:** in the lobby a newcomer takes a bot seat of the team with fewer
  humans (team A on a tie), so two humans start as opponents. `switchTeam`
  moves to a free bot seat of the other team; the host can still arrange the
  seats freely. Leaving the lobby puts a bot on that very seat, so nobody
  else changes team. During a match a newcomer takes over a bot seat as it is,
  team included; a reconnect returns to the same seat.
- **"Du + Bot gegen 2 Bots":** `createSession` with `teamMode` and
  `quickStart` deals right away with the remembered bot level.
- **Never** in the daily challenge, the Kartenhaus, the tutorial or the daily
  puzzle (no table there). The constructor ignores the option for solo games
  and `setTeamMode` refuses them.
- **Stammtisch: not in v1.** Its record, the pairwise tally and the best-of-3
  series count every player alone; team records there need their own design.
  The server refuses `setTeamMode` at a Stammtisch table.

## Progress

XP and statistics work as in a normal match; a team win is a win for both
teammates. Per badge and quest:

| What | In team mode |
| --- | --- |
| XP | 10 + 50 for a team win (both teammates) + the player's **own** final total / 10. The team sum would pay every point twice. |
| Wins, streaks, losses (purple heart), quest `win_game`, the ladder's `won` | the team result, for both |
| `comeback` | the own team was behind after round 1 and won |
| `landslide`, `near_miss` | team totals: won by 500 or more / lost by less than 20 |
| `zen_slayer`, `zen_trio`, quest `beat_zen` | only Zen bots of the other team count; a Zen partner is no Zen win (`zen_trio` needs three Zen opponents, so never at a team table) |
| `red_lantern` (last place) | the losing team is last, as at a two-player table |
| `score_500`, quest `score_400`, `rock_bottom` | the player's own total |
| Everything per round (hand aus, queens, jokers, runs, pile glutton, round 300, ...) | unchanged: the player's own facts |
| Year review | the partner is no opponent |

### Is it farmable?

Match length in self-play (600 games per mode, all bots medium,
`node scripts/sim-bots.js --lengths`):

| Mode | Rounds | Turns (all seats) |
| --- | --- | --- |
| 1 vs 1 | 6.66 ± 0.05 | 133 ± 1 |
| 4 players | 7.04 ± 0.05 | 204 ± 2 |
| 2 vs 2 | 4.24 ± 0.03 | 121 ± 1 |

A team match is short: two seats feed one total. A player alone with three
bots wins half the matches at equal strength, like a 1-vs-1 table, but plays
about 30 own turns per match instead of about 66. Estimated with 10 s per own
turn and 1 s per bot turn, that is roughly twice the wins per hour of 1 vs 1
and about a quarter more XP per hour (the score part is the own total, about
half of a 1-vs-1 total). No damping in v1: win tiers and streaks are earned
once, and the XP per hour stays in the range that the choice of table size
already spans.

## Bots

- **Zen plays its heuristic** at a team table: the ONNX net was trained on
  single scoring, and `StateEncoder` (377 observations, 54 actions) stays as
  it is.
- **The heuristic already fits:** with crosswise seats the next player is
  always an opponent (discard safety holds), the endgame damage control
  already counts the partner's small hand (the round ends whoever goes out),
  and bots never hold back going out.
- **Investigated, not shipped:** a team-aware context for the counting levels
  (the team's lead instead of the own one, the partner's publicly known cards
  no reason to keep a discard). Self-play, team-aware against naive at one
  level, sides alternating, 20 batches × 500 games
  (`node scripts/sim-bots.js --team hard zen`):

  | Level | Team-aware win share |
  | --- | --- |
  | Hard | 49.8 % ± 0.4 |
  | Zen (heuristic) | 49.9 % ± 0.5 |

  No effect; the seat flag `teamAware` stays off (an A/B seam in
  `SEAT_CONTROL_FIELDS`). Easy and medium do not read these inputs at all.

## For drivers and a future encoder

- `new GameManager(send, { teamMode: true })` opens a four-seat team table
  (ignored together with `challengeDate`, `tutorialMode` or `towerStage`), so
  a self-play driver needs no lobby.
- `game.teamMode`, `game.teamOf(seatOrId)` (0 or 1), `game.partnerOf(id)`
  (the seat object), `game.teams()` (`[[A ids], [B ids]]`) and
  `game.teamTotals()` (`[A, B]`); all `null` outside team mode. Pure helpers in
  `game/Teams.js` (`teamOfSeat`, `partnerSeat`, `teamsOf`, `teamSums`,
  `isRecordWinner`, ...).
- `publicState`: `teamMode`, `teams`, `teamTotals`, and `teamTotals` per
  entry of `scoreHistory`.
- Round history: `teamScores` and `teamTotalsAfter` per round. Game over and
  the match record: `teamMode`, `teams`, `winnerTeam`, `winnerIds`,
  `teamTotals`, and `winnerId: null` - nothing credits one teammate alone.
- Move log rows: `teamMode: 1`, `team`, `teamTotals`, and `won`/`rank` by
  team; the row's `state` names `team` and `teamTotals`, every entry of
  `state.opponents` its `team` (the partner shares the decider's).

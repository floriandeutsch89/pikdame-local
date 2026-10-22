# Overview

## The game

Pik Dame is the German family variant of **Rommé**. Everyone gets 15 cards from
a 110-card deck (two standard decks plus jokers) and tries to get rid of them by
laying out **sets** (same rank) and **runs** (same suit, consecutive). The round
ends when someone goes out; play continues over several rounds until a player
crosses 1000 points. If two or more players are level at the top, another
round is played - with everyone - until one of them is ahead alone.

What gives the game its name — and its bite — is the **Queen of Spades**: she is
worth **100 points**. Laid out on the table she is a fortune; caught in your hand
at the end of a round she costs you 100. Much of the tactics revolve around her.

For the exact numbers the engine plays with, see {doc}`developer/game-constants`.

### At the table

A table has 2 to 4 seats; in the lobby every free seat already shows a bot, so
the order can be dragged into shape before the game starts and the star picks
the first dealer. A friend who joins by code or link takes the bot seat that is
**farthest from the other humans** around the table, never the one right behind
the host: two people at four seats sit human, bot, human, bot, at three seats
human, bot, human. The organizer can still move everyone afterwards.

The bots come in four levels, each measurably stronger than the one below:
Leicht, Mittel, Schwer (counts cards) and Zen (a trained network where the
server has it, otherwise as strong as Schwer). New tables start on Mittel.
"Bot-Stärke" in the lobby sets every bot at once; a single bot is changed by
tapping its level. Details and measurements: {doc}`developer/bots`.

### A round starts

The dealer rotates each round; a rematch (and the next evening at a
Stammtisch) starts with the last game's winner as dealer. Before dealing, the player to the dealer's
right **cuts the deck** — picking the spot themselves. **Dealing starts at
the cut spot;** the lifted packet then returns to the draw pile, so no card
ever leaves the game and the opening draw pile has a constant size. Nothing
is ever refilled once play begins: when the draw pile runs dry, a player who
cannot pick up the discard top ends the round (normal scoring, no winner
bonus; the discard pile is never reshuffled). If the Queen of Spades or jokers sit at
the cut, the cutter keeps them (**lucky cut**, announced to the whole table)
and looks at the next card, until an ordinary card ends the run — that card
is shown to the cutter only and stays in play as the first card dealt. Dealing skips the cutter accordingly, so everyone starts with exactly
15 cards. (Bots and the daily challenge cut automatically — the challenge
must stay deterministic so the whole world plays the identical deck.)

### A turn

1. **Draw** — either the top card of the face-down pile, or the discard pile. The
   discard may only be taken if its top card *immediately* forms a new
   combination with your hand — and that card must then be laid this turn.
   It is refused when melding it would use up your entire hand, because a card
   must always remain for the discard (see step 3).
2. **Meld** (optional) — lay out new sets/runs, add cards to your own melds, or
   swap a joker on the table for the card it represents.
3. **Discard** exactly one card. To go out you must still have a card left to
   discard; the final one is placed face down.

### Every day

Everything daily is seeded from the game date (the day flips at midnight German
time), so the whole world plays the same thing and can talk about it:

- **Daily challenge** — one game on the same deck against the same three Mittel
  bots. Only the first started game of the day counts for the leaderboard.
- **Daily puzzle** — one hand, one question, the rules engine grades the answer.
  The kind rotates by weekday, easier early in the week: *Beste Auslage*
  (Monday, Thursday: the most valuable single meld), *Ausmachen* (Tuesday,
  Friday, Sunday: lay out every card but the one you discard) and *Bester Zug*
  (Wednesday, Saturday: as many points as possible in one turn, several melds
  allowed, one card stays for the discard). Solving pays 30 experience once a
  day; signed in, it also counts for the account and its season, without
  counting as a game. Stars grade how directly: 3 for a solve on the first check, 2 on the
  second (*Beste Auslage*) or by the third (the other kinds), 1 after that; a
  shown solution earns none. Three stars on consecutive days build a perfect
  run, and 10/30/100 perfect solves are a badge family. The arrows browse
  every earlier puzzle as practice, without experience and without storing
  anything; they show the stars earned on the day itself.
- **Sharing** — after the challenge and the puzzle, "Ergebnis teilen" hands a
  short text to the phone's share sheet (or the clipboard), e.g.
  "Platz 3 von 12 · 1120 Punkte · ♠Q nie erwischt" or "Gelöst im 2. Versuch 🟥🟩 ★★☆".

### Kartenhaus (monthly house of cards)

A house of 20 floors against the bots, rebuilt every month (Europe/Berlin
month, `game/GameDay.js`); `game/BotTower.js` is the only definition of
floors, modifiers, stars and months. Each floor is one round on its own seeded
deal (deck and cut) against fixed bots. Floors 1-10 are the old bot tower's
ladder, from two Leicht bots up to three Zen bots with a 100-point head start.
Floors 11-20 play three Zen bots with 100-160 points head start plus
modifiers against the human seat, enforced by `GameManager`:

- `queen`: a Queen of Spades is swapped into the hand (1:1 with the hand's
  last plain card, so the 110-card deck stays complete and every try deals the
  same). It risks -100 on the hand but pays +100 when melded, so it comes with
  a bigger head start. Players see it as a risk ("Risiko"), the other two as
  handicaps ("Erschwernis"); the wording lives only in `TOWER_MODS` /
  `TOWER_MOD_RULES` in `public/client.js`.
- `noDiscard`: the human never takes the discard pile (`canTakeDiscardTop`
  says no, the table shows the pile blocked); an empty stock with an untakeable
  pile ends the round as usual. The bots play by the normal rules; their
  discard safety still assumes the human could take the pile, which only makes
  them a little more careful (the deals are calibrated with exactly that).
- `goOut`: stars only when you go out yourself.

One star for more points than every bot plus the head start, two for at least
100 points ahead, three for that and going out yourself: at most 60 stars a
month. One star unlocks the next floor (floor 11 after floor 10, within the
month); tries are unlimited and the best per floor counts (name-based, like the
badges). The first star of a floor pays 10 experience once per month; a
crowned month (all 20 floors with a star) pays 50 once. With an account both
go into its lifetime and season XP without counting as a game; tower rounds
count for no match statistics. Badges: 3/6/10 floors and 30 stars in the best
month, and 1/3/12 crowned months (Lehrling, Polier/in, Baumeister/in).

The deals live in `game/TowerSeeds.js` (generated data, 2026-10 to 2027-12);
months past the list cycle through it deterministically (`monthSeeds`), so
regenerate it before it runs out or after a new Zen model. A floor is
deterministic per deal and line of play: Zen and Schwer play no dice, and the
easy bots on floors 1-2 draw their randomness from the deal
(`GameManager._botRandom`, Kartenhaus only). So one game is a proof:
`scripts/tower-seeds.js` (onnxruntime-node outside the repo, see CLAUDE.md)
takes a deal only when BOTH Schwer and Zen in the human seat earn a star on it.
Floors 1-10 must also stay tight (Schwer's margin under a cap). Floors 11-20
aim at a medium player: Mittel with 10 % random moves earns a star in 100
games at a rate inside a band around a target falling from 45 % (floor 11) to
13 % (floor 20), window [T-6, T+10], at least 8 %; after 3000 candidates the
deal closest to the band is taken. Each month draws from its own seed block,
so months run in parallel (`--jobs`) and a rerun picks the same deals.
`test/fixtures/tower-proofs.json` holds stars, margin and a move hash of every
proof game; `test/tower-proofs.test.js` replays them (without onnxruntime only
the floors without a Zen bot, all of them in the CI job `tower-proofs`). After
an intended bot change, `--prove` refreshes the hashes and fails if a floor
lost its star. `--rate N` measures Schwer's star rate per floor over N random deals.

**The old bot tower is October 2026.** Its ten fixed deals are October's
floors 1-10, and a profile's pre-monthly `tower` stars count there
(`BotTower.monthBest` merges them on read, idempotent, nothing is rewritten):
whoever had floor 10 starred continues at floor 11. Those stars pay no XP
again; the 25 XP they paid back then stay, and badges are never taken away.
A tower snapshot from before the update (no `towerMonth`) plays and books as
October.

The way in is the "Aufgaben" box on the start screen (below the daily puzzle
and challenge, with this month's floor and stars) and the progress sheet. The
sheet draws the house as a pyramid of card tents (6-5-4-3-2 plus the apex);
tapping a floor shows its bots, head start, modifiers and best stars with the
play button. Earlier months stay as a read-only archive.

### Progress between matches

Three layers, all optional and all degrading quietly where they cannot work:

| | Where it lives | Works without an account |
| --- | --- | --- |
| **Daily tasks** | Three tasks seeded from the game date (the day flips at midnight German time) — identical for every player worldwide, like the daily challenge deck. Progress counts on the name-based profile. | yes |
| **Achievements** | 48 badges, shown as a cabinet in the statistics panel with locked entries and their progress ("Damenjägerin 4/10"). | yes |
| **Level & season ladder** | Experience per finished match, a level, and a monthly ladder — bound to the **account**, so it follows the player across devices. | no (needs a login) |

Experience is awarded for *finishing* a match, not only for winning: a base
amount for every completed game, a bonus for the win, and a slope from the
final score. A negative final total never costs experience.

Everything is computed from the finished game record in `game/Progression.js`
(pure functions, no I/O) — the engine has no progression hooks in the game
loop, so none of this can affect play. On a server in `PIKDAME_PUBLIC_MODE`
no profiles are stored, and the tasks and cabinet stay hidden accordingly.

## The software

| | |
| --- | --- |
| **Server** | Node.js, no framework. One WebSocket per player, the server is the single source of truth and validates every move. |
| **Client** | Plain HTML/CSS/JS — no build step, no framework, no bundler. |
| **Storage** | JSON files on a volume (profiles, statistics, history, daily-task progress) plus SQLite or PostgreSQL for optional accounts and the season ladder. |
| **Bots** | Four levels: three heuristic, Zen plays a trained ONNX policy where the runtime is installed. |
| **Deployment** | One container. Optionally the full stack with Caddy (automatic TLS) and PostgreSQL. |

### Design decisions worth knowing

**No framework, no build step.** The client is served as-is. This keeps the thing
debuggable years from now and makes the container tiny.

**The server never trusts the client.** Every move is validated server-side, and
a player's state never contains another player's hand. Client-supplied control
fields are stripped.

**Bot changes are measured, not guessed.** Any change to how bots *choose* moves
is A/B-tested in self-play (thousands of games, win rate ± standard error) before
it ships. Several plausible-sounding ideas were measured and *rejected* — see
{doc}`developer/bots`.

**Games survive deployments.** On shutdown every running table is snapshotted to
the data volume and restored on the next start; clients reconnect on their own.
A nightly auto-update therefore does not kill an evening's game.

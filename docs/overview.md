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
  day. Stars grade how directly: 3 for a solve on the first check, 2 on the
  second (*Beste Auslage*) or by the third (the other kinds), 1 after that; a
  shown solution earns none. Three stars on consecutive days build a perfect
  run, and 10/30/100 perfect solves are a badge family. The arrows browse
  every earlier puzzle as practice, without experience and without storing
  anything; they show the stars earned on the day itself.
- **Sharing** — after the challenge and the puzzle, "Ergebnis teilen" hands a
  short text to the phone's share sheet (or the clipboard), e.g.
  "Platz 3 von 12 · 1120 Punkte · ♠Q nie erwischt" or "Gelöst im 2. Versuch 🟥🟩 ★★☆".

### Bot tower

Ten fixed stages, defined only in `game/BotTower.js`: each stage is one round
on its own seeded deal (deck and cut) against fixed bots, from two Leicht bots
up to three Zen bots with a 100-point head start. One star for more points than
every bot plus the head start, two for at least 100 points ahead, three for
that and going out yourself. One star unlocks the next stage; tries are
unlimited and the best per stage counts (name-based, like the badges). Tower
rounds earn no experience and no match statistics, so retries cannot farm
them. The seeds were picked by simulation (the Schwer heuristic in the human
seat, the Zen net at stages 7-10): every stage is winnable, and the winning
margin shrinks from about 200 to 15 points. The way in is the progress sheet
(tap your avatar).

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

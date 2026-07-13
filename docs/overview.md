# Overview

## The game

Pik Dame is the German family variant of **Rommé**. Everyone gets 15 cards from
a 110-card deck (two standard decks plus jokers) and tries to get rid of them by
laying out **sets** (same rank) and **runs** (same suit, consecutive). The round
ends when someone goes out; play continues over several rounds until a player
crosses 1000 points.

What gives the game its name — and its bite — is the **Queen of Spades**: she is
worth **100 points**. Laid out on the table she is a fortune; caught in your hand
at the end of a round she costs you 100. Much of the tactics revolve around her.

For the exact numbers the engine plays with, see {doc}`developer/game-constants`.

### A round starts

The dealer rotates each round. Before dealing, the player to the dealer's
right **cuts the deck** — picking the spot themselves; everyone briefly sees
what the cut revealed. If the Queen of Spades or jokers sit at the cut, the
cutter keeps them (**lucky cut**) and looks at the next card, until an
ordinary card ends the run. Dealing then skips the cutter accordingly, so
everyone starts with exactly 15 cards. (Bots and the daily challenge cut
automatically — the challenge must stay deterministic so the whole world
plays the identical deck.)

### A turn

1. **Draw** — either the top card of the face-down pile, or the discard pile. The
   discard may only be taken if its top card *immediately* forms a new
   combination with your hand — and that card must then be laid this turn.
2. **Meld** (optional) — lay out new sets/runs, add cards to your own melds, or
   swap a joker on the table for the card it represents.
3. **Discard** exactly one card. To go out you must still have a card left to
   discard; the final one is placed face down.

## The software

| | |
| --- | --- |
| **Server** | Node.js, no framework. One WebSocket per player, the server is the single source of truth and validates every move. |
| **Client** | Plain HTML/CSS/JS — no build step, no framework, no bundler. |
| **Storage** | JSON files on a volume (profiles, statistics, history) plus SQLite or PostgreSQL for optional accounts. |
| **Bots** | A heuristic engine by default; optionally a trained ONNX policy. |
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

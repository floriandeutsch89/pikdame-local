# FAQ

## Is the shuffle fair? How do you stop one player getting all the good cards?

**We don't — deliberately.** Before every round a brand-new 110-card deck is
shuffled with **Fisher-Yates** (the standard unbiased shuffle) and dealt
round-robin, one card at a time, exactly like dealing by hand.

There is **no hand-balancing**. "Fixing" hands to make them look fair would in
fact be *rigging*, and no serious card game does it. The fairness lies in the
**uniform distribution**: every possible card order is equally likely, so every
player has exactly the same chance at the Queen of Spades, jokers and everything
else, in every round. A single round can be lucky — that is the game — but over
many rounds it evens out and nobody has a systematic edge.

The randomness source is the runtime's `Math.random`, which is ample for a card
game (this is about fairness, not cryptography). The **daily challenge** is the
exception: it uses a seeded deterministic generator so that *everyone worldwide
gets the identical deck* — fairness there through identical conditions.

## Can I run more than one replica?

**No — not as-is.** Game state lives in the process's memory. A second replica
would hold different tables, and players would be routed to a process that has
never heard of their game.

A single process is measured to handle **200 concurrent games** with a median
event-loop lag of **0 ms** (~88 MB RAM), and 500 still run cleanly. If you ever
outgrow that, the honest path is session affinity plus an external state store —
not a quick hack. See {doc}`developer/architecture`.

## What data is stored about players?

On a default (family) server: display name, statistics, achievements and game
history, in JSON files on your volume. Accounts are optional.

On a public server, set `PIKDAME_PUBLIC_MODE=1`: **no player profiles are
persisted at all** and the lobby shows no player list. Anonymous aggregate
statistics (games played, rounds, cards) are still counted.

There is no telemetry, no ads, and no third-party service in the game path.

## Why did my statistics disappear after a restart?

Almost certainly the data volume is not writable. The container runs as a
**non-root user (UID 10001)**; if the volume is owned by `root`, writes fail
silently. Since v1.54.4 the server checks at startup — look for
`Datenverzeichnis beschreibbar` (good) or a loud `NICHT BESCHREIBBAR` warning
(that's your problem). Fix and drill in {doc}`admin/backup-restore`.

## Are the bots cheating? They seem to know things.

They don't. Bots receive exactly the same information a human player would: the
table, the discard pile, card counts. They do not see anyone's hand.

What they *do* have is patience and consistency — plus one behaviour that
surprises people: a bot takes the discard pile whenever its top card forms a
combination, which is often stronger than it looks. That rule was
[A/B-measured](developer/bots.md); two attempts to make bots "smarter" by being
choosier both made them **worse** by ~30 points.

## Can I change the rules?

Some, via house rules in the lobby: turn timer (30/60/90 s), whether going out in
one turn doubles the score, and whether the 1000-point threshold is strict. The
core rules are fixed — they are the rules the family plays by.

## Do games survive a server restart or update?

Yes. On shutdown every running table is snapshotted to the data volume and
restored on the next start; clients reconnect on their own. A nightly auto-update
therefore doesn't kill an evening's game. A *crash* of the host mid-round,
however, does lose that round — the snapshot is for graceful restarts.

## Which browsers work?

Anything current: Safari (iOS included), Chrome, Firefox, Edge. It's a plain
web page with a WebSocket — no build step, no framework, no app store. On iOS you
can add it to the home screen and it runs full-screen.

## Is there an API?

Not a REST one. The client talks to the server over a single WebSocket; the
message types are documented in {doc}`developer/protocol` (generated from the
source). It is not a stable public API — it changes with the game.

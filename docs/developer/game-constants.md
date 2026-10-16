# Game constants

```{include} ../_generated/game-constants.md
:start-line: 3
```

## Try the rules

The three engine modules that decide what a meld is (`game/Card.js`,
`game/Deck.js`, `game/Rules.js`) have no I/O and no dependencies, so this page
loads them **unchanged** and lets you ask them directly. Build a set or a run,
add a joker, try `K-A-2`, try nine cards of one rank. "Deal me 15" shuffles a
fresh 110-card deck with the game's Fisher-Yates and deals a four-player table;
with a seed the hand is reproducible, which is exactly how the daily challenge
gives everyone the same cards.

<div id="pd-lab" class="pd-lab">The rules lab needs JavaScript.</div>

:::{tip}
Open the browser console: `(await pdEngine()).Rules.validateMeld(cards)` is the
same function, and `Deck.shuffle(Deck.createDeck(), 42)` is the challenge
shuffle. Up, up, down, down, left, right, left, right, B, A deals you a hand
on any page.
:::

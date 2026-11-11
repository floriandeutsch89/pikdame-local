# Boss floors (Kartenhaus)

Floors 10, 15 and 20 of a Kartenhaus month can be **boss floors**: a duel against
one bot in life points instead of scores. The card rules stay exactly as they
are; everything a boss does is a damage rule. `game/BossFight.js` holds the
rules as pure functions on a plain state object, `GameManager` owns that object
(`bossFight`, part of the snapshot).

:::{note}
Boss floors are **off** until a month is switched on with
`BotTower.setBossFrom('YYYY-MM')`. A month's deals have to be picked and proven
under the boss rule first; floors of a running month never change (players hold
stars on them).
:::

## Rules

- The player starts every fight with **600** life (`PLAYER_HP`).
- **A hit is the value of what a turn laid** (new melds, lay-offs, a swapped
  joker), read as the difference of the cards on the table when the turn ends -
  so an undo inside the turn cannot count twice. What the player lays hits the
  boss, what the boss lays hits the player.
- **Combo:** two new melds in one turn count ×1.5, three or more ×2 (`COMBO`).
  This is the decision an ordinary round does not have: collect for one big hit,
  or lay early before the boss goes out.
- **Round end:** the cards left in a hand hurt their holder.
- **Knockout:** life at 0 ends the fight at once, also in the middle of a round
  (`finishRound(null, { bossKo: true })`). Otherwise the next round is dealt and
  the life points stay. Both down at a round's end: the higher share of life wins.
- **Enraged:** a round that starts with the boss below half its life: its hits
  count +25 % (`ENRAGE`).
- **Round 5 is the last** (`MAX_ROUNDS`): then the higher share of life wins.
- **Stars:** a win; a win with at least a third of the life left; with two thirds.

## The bosses

| Floor | Id | Life | Rule | Bot |
| --- | --- | --- | --- | --- |
| 10 | `jack` | 500 | `ambush` 1.5: its first hit of every round counts ×1.5 | Schwer |
| 15 | `king` | 500 | `armor` 10: every hit of the player loses 10 (after the combo) | Zen |
| 20 | `queen` | 550 | `curse` 10: every own turn that ends with a Queen of Spades in hand costs 10. `crit` 2: melded, she counts double. `adds` [100, 100] with `scratch` 3: two guards (her cats) stand in front - hits go to the first one alive and the rest carries on; each guard alive costs 3 per own turn | Zen |

Within the player's turn the hit comes first: a guard that falls does not
scratch any more. On a boss floor the old modifiers of that floor (`queen`,
`noDiscard`, `goOut`) and the head start do not apply.

## In the engine

- `BotTower.stageConfig(stage, month)` returns `{ boss, bots: [boss.bot], handicap: 0 }`
  for a boss floor; `publicStages(month)` marks it with `boss: <id>`.
- `GameManager.discard()` ends a turn: `_bossTurnEnd(player)` applies the hit.
  `finishRound` applies the round end and decides: over, or a further round
  (the human confirms it with the ordinary round-end "Weiter").
- `publicState().bossFight` is `BossFight.publicView`: life points, guards,
  round, `enraged`, the rules as numbers (`traits`; the client owns the wording)
  `ambushReady`, `starLife` (the life left for two and three stars) and `events`,
  what the last turn did (`{ seq, to: 'boss'|'add'|'me', amount,
  kind: 'hit'|'scratch'|'curse'|'hand', combo?, add?, ambush?, rage?, armor?, crit? }`;
  the reasons ride along, so the table names them instead of guessing).
- The boss's seat carries the boss's name (`BOSSES[n].name`): log, turn line and
  result sheet name it. The rename comes after the bot's name draw, so the
  deal's random stream is untouched.
- The game record carries `boss` (life left, round, `won`);
  `BotTower.outcomeFromRecord` turns it into the floor's outcome and stars.
- `TowerPlay.playFloor` plays the rounds one after another, so one game by Zen
  proves a boss deal like any other.

## At the table

`public/boss-fight.js` draws a boss floor from `state.bossFight` and decides no
rule. `client.js` calls it from `renderTable` (`bossView()` is null on every
other table and on a stale cached page without the module).

- **Panel** instead of the opponents' chips (`renderPanel`): portrait, name,
  the rules as chips, the life bar with the half mark, round and hand count; on
  floor 20 the two cats (a fallen one stays, struck through). It stays in the DOM
  between renders, so the bars can move and a popover stays open. Every chip and
  the life bar are buttons: a tap opens what the number means (`traits`,
  `lifeRule`). Landscape beside the cats: icons only, the tap still explains.
- **My life** sits where the score sits (`renderMyLife` into `#myScore`); the
  floor card and its start card are not shown on a boss floor.
- **Entrance** (`playIntro`): before the first card, under two seconds
  (`INTRO_MS` plus the fade), a tap skips it. It is the one deliberate exception
  to "never stop the game for a show" (#513) and lies before the first move; the
  cut reveal waits for it (`bossIntroAhead`).
- **Hits** (`playEffects`): the events after the last seen `seq`, once. My
  strike is one blade over the portrait (two on a combo), the boss's hit a blade
  over my hand, a scratch three claws, the curse a wisp from the queen's card;
  each with its number and reason. Under 0.4 s (`FX_MS`), never over a dialog
  (`--z-table-fx`), the first state after a load is only a baseline. The boss's
  hit waits for its cards to land (table-moves).
- **"Boss-Effekte"** in "Optionen" (per device, default on) switches entrance
  and hits off; then only the bars move. `prefers-reduced-motion`: no vortex, no
  blade, no pulse - the number still shows and fades.
- **Result sheet:** both lives instead of the points list (`.bossPane` hides
  it), what the hand cards cost, the next round, "enraged". The floor's verdict
  names the life left and the life the next star needs.
- Screenshots: `ui-shots` scenes `boss-*` (the skill lists them).

## Picking the deals

A boss deal is picked like a deal of floors 11-20 (`TowerGen.js`), on floor 10 too:
Zen's proof first, then Hard with 10 % slips must win 50-80 / 40-70 / 30-60 % of
100 fights (`TowerRule.bossHardMin`/`bossHardMax`, floors 10 / 15 / 20; the
ceiling matters: a deal decides most of a fight, and without it the first picks
were deals Hard wins in 9 of 10 fights) and Mittel 30-80 /
20-70 / 10-60 % (`bossMediumWindow`: around Hard's gate, since both score alike in
a duel). The entry carries `boss: 1`. An entry without it on a boss floor (a month
stored before the floors became boss floors) never fits and is picked again, in
`rule` and in `missing` mode; its old deal is a candidate again, so a replica that
picks afresh and one that re-picks agree.

For a static month: `node scripts/tower-seeds.js 2026-12 2026-12 --floors 10,15,20
--boss-from 2026-12` (the flag switches the boss floors on for that run until
`BotTower` does it itself).

## Where the numbers come from

Measured on the real engine with the real bots: 300 fights of up to five rounds
per pairing (a human proxy with 10 % slips against the boss's bot).

- In a duel both sides deal almost the same damage per round (160-190), and the
  bot level hardly changes it (Mittel 164, Schwer 163, Zen 188 as the boss). So
  difficulty comes from life points and rules, and "enraged" is a damage bonus.
- Wins of Schwer with slips: jack 47 %, king 42 %, queen 30 %; 2.1-2.4 rounds on
  average; three stars in 3-8 % of the fights. Mittel and Schwer score alike
  because the bots do not play for combos - a human who collects on purpose
  should do better; that is not measured.
- These are starting values. The deals of a month are still picked one by one
  (Zen must win, as on every floor).

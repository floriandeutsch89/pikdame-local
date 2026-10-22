---
name: ui-shots
description: Screenshot the real Pik Dame client with mock data in every layout (iPhone portrait, landscape, desktop, iPhone SE) - lobby, "Aufgaben", progress sheet, statistics, "Meine Partien", round end, game over. Use it whenever a change touches anything visible in public/ (HTML, CSS, client.js rendering), when CLAUDE.md asks to check the UI in the browser, before a PR that needs before/after screenshots, or when the user asks how a screen looks - even if they only say "schau dir mal X an" or "mach einen Screenshot".
---

# UI screenshots with mock data

`npm test` cannot see layout bugs (truncated labels, overlap, a block pushed
below the fold). CLAUDE.md requires a browser check in all three layouts;
this skill makes that one command.

## Run it

```bash
node .claude/skills/ui-shots/scripts/ui-shots.js --out <dir> \
  --views phone,land,desk \
  --scenes lobby,stats,history,roundend,gameover
```

- **Views:** `phone` 393×852 (the yardstick), `land` 874×402 (only ~400 px
  high), `desk` 1440×900, `se` 375×667 (small phones), `max` 440×956
  (Pro Max: 15 cards fit ONE fanned row there, at 393 they split into two;
  a layout bug at the hand can show on one and not the other), `lap`
  1366×657 (laptop browser: desktop width, little height), `nar` 1100×680
  (the narrowest desktop layout: least room beside the opponents).
- **Table scene:** `--scenes table --state <file>` injects a live game. Build
  the state from the real engine (`GameManager` + `fillWithBots` +
  `runBotTurn`, then `publicState('p1')`), not by hand.
- **Themes:** `--theme table|night|felt|love|bordeaux|kitchen`. `kitchen` is
  the light one; check it whenever a colour or a translucent white changes.
- **Mockups:** `--css <file>` / `--js <file>` patch the table scene before the
  shot, to show options before building them.
- **Signed in:** `--signed-in` answers `/api/*` with a mock account (mock
  objects `ACCOUNT_API` at the top of the script): the season-finale hint
  shows on the first start-screen shot, `stats` gets the season badges, and
  the scene `account` opens the account sheet (level, season ladder).
  The mock result is a podium place, so the first start-screen shot also
  catches the fireworks band behind the header.
- **English:** `--lang en` shoots the English client; check it whenever a
  new label could outgrow its box.
- **Before/after from one script:** `SHOTS_ROOT=<checkout>` shoots another
  checkout (e.g. a detached `origin/main` worktree) with this script, so
  new scenes exist for the "before" pictures too.
- **Reduced motion:** `--reduced-motion` emulates `prefers-reduced-motion:
  reduce` - the still pictures instead of the animations.
- **Scenes:** `lobby`, `lobby-open` (daily goals unfolded), `progress`
  ("Dein Fortschritt"), `stats`, `stats-empty` (a brand-new name: the
  statistics empty state, then "Meine Partien" empty), `stats-badges` (trophy cabinet folded, then a favourite's detail; favourites need `--signed-in`), `history` ("Meine Partien"), `roundend`,
  `roundend-stats`, `gameover`, `gameover-win` (I win the match and earn a
  badge: the gold banner and the badge chip), `gameover-challenge` (board + share),
  `puzzle`, `puzzle-turn` / `puzzle-out` (that kind injected, one meld
  laid), `puzzle-refused` (two melds selected at once: "Auslegen" refused with the rule's reason), `puzzle-solved` (three stars, then the "Aufgaben" tile), `challenge` (intro after the day's attempt), `challenge-open` (intro before it: only the count), `gamelobby` (house
  rules), `botdiff` (the strength picker), `stammtisch` (the record
  sheet behind the start-screen chip), `stammtisch-lobby` (a game lobby
  shown as a seat at the mock Stammtisch: its record panel), `settings` / `settings-aids` /
  `settings-music` (the "Optionen" sheet: top / play aids / music), `game-settings`
  (the in-game gear sheet), `music-hint` (the first click starts the music and
  its one-time hint shows; every other run marks the hint as seen), `tower`
  (the Kartenhaus sheet, opened from its tile in "Aufgaben"), `tower-detail`
  (the same with the locked floor 14 tapped), `tower-rules` (the "So funktioniert"
  fold opened), `tower-motion` (animation
  frames: a month change collapsing, a landing star next to a wobble; with
  `--tower crowned` the crown landing), `gameover-tower` (a floor verdict on
  the result sheet). `--tower mid|new|high|crowned` picks the month in the
  mock (default `mid`: floors 1-8 built, 9 next). A live Kartenhaus floor
  from the engine (its deal, bots and head start): `tower-start` (the start
  card before the first move), `tower-play` (the floor card mid-game,
  `--turns N` of my turns, default 3), `tower-sheet` (its rules after a tap),
  `tower-lock` (a tap on the locked discard pile). `--floor queen|goOut|
  noDiscard|all` takes the floor with exactly that handicap from BotTower.js
  (new deals or head starts never break the scene), or a floor number.
  `--stammtische 0-3` sets
  the remembered Stammtische (default 1; 3 is the start screen's tallest
  form). Any order works:
  a start-screen scene after `table` or a result reloads the start screen
  first (its buttons are hidden there and the clicks used to time out).
- **December:** `--december` stands the client clock on 28 December and
  mocks the server's year review (the server keeps its real date; like the
  server, favourite opponent and Stammtisch only with `--signed-in`). Then
  `lobby` shows the "Aufgaben" chip, and `year`, `year-mid`, `year-bots`,
  `year-end` (story cards), `year-image` (the share PNG, saved through the
  download fallback), `account-mail` (opt-in switch, simulated sign-in) and
  `mail` (the review mail's HTML, full page) are available.
- Prints the written PNG paths. Look at them with the Read tool; don't
  just trust that they exist.
- `--audit` also checks every shot and writes `<out>/audit.md`: truncated
  text (measured on the text itself), tap targets under 44 px (a hit area
  stretched by an absolute `::after` or the `<label>` row around a switch
  counts), icon buttons without a name, and a portrait start screen that
  needs scrolling. Findings are evidence to judge, not automatic failures;
  the `ui-review` skill explains how.
- `--measure` writes `<out>/measure.json`: the rectangles of the table's
  regions (melds, piles, hand, action bar, the Kartenhaus floor and start
  card) per shot. Run the same scenes with `SHOTS_ROOT=<origin/main
  worktree>` for the "before" numbers: a new table element must not shrink
  `#melds` or `#handWrapper`. `--eval <file>` prints a page expression per
  tower scene (computed styles, grid tracks) when a layout puzzles you.

The script starts its own server on a **temp `PIKDAME_DATA_DIR`** and kills it
afterwards. That matters: a dev server on `data/` keeps `users.db` open, and
the next `npm test` then fails in `reconnect-race.test.js` with a SQLite
"disk I/O error". Never leave a server of your own running on `data/`.

## How the mocks work

Playwright routes the WebSocket to the real server and rewrites messages on
the way to the page (`profiles`, `gameHistory`). `getStammtisch` is answered
by the script itself: the server counts an unknown code as a failed join and
blocks the IP after a few, which looks like the server "throttling". Result
screens get `joined` + `state` (+ `progress`) injected. Edit the mock
objects at the top of the script when a scene needs other data, e.g. a
4-player game, a long name or a solved puzzle.

Traps that cost time before:
- **"Today" is Europe/Berlin** (the server's game day). Mock per-day data
  keyed by the UTC date silently shows as "not today" late in the evening.
- **Use the bundled iPhone user agent.** The server treats the headless
  default as a crawler and never opens the WebSocket.
- **Splash and name come from storage:** the script sets
  `pikdame_splash_device`, `pikdame_splash_seen` and `pikdame_player_name`.
- **Signed-in look:** there is no real account in the mock. Use
  `--signed-in` (routes the account API) and say in the PR that it was
  simulated.

## What to check in the images

- Labels cut off with "…" (four tiles in a row at 393 px, long statuses).
- Landscape: does the important content stay above the fold?
- The start screen on the iPhone must fit without scrolling (CLAUDE.md).
- Emoji used as icons (not allowed), colours that collide with `--accent`.

## PR screenshots

They live on the `pr-screenshots` branch. Add them through a worktree so
your feature branch stays clean:

```bash
git fetch origin pr-screenshots
git worktree add /tmp/prshots origin/pr-screenshots
cd /tmp/prshots && git checkout -B pr-screenshots origin/pr-screenshots
mkdir -p <topic> && cp <dir>/*.png <topic>/
git add <topic> && git -c user.email=… -c user.name=… commit -m "screenshots: <topic>"
git push origin pr-screenshots && git rev-parse HEAD
cd - && git worktree remove --force /tmp/prshots
```

In the PR, link images by **commit SHA**, not by branch name
(`raw.githubusercontent.com/<owner>/<repo>/<sha>/<topic>/x.png`). GitHub
caches branch URLs, so a refreshed image would keep showing the old one.
Before = main, after = the branch. Say when the data is mocked.

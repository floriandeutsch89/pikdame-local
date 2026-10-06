---
name: ui-shots
description: Screenshot the real Pik Dame client with mock data in every layout (iPhone portrait, landscape, desktop, iPhone SE) - lobby, "Heute", progress sheet, statistics, "Meine Partien", round end, game over. Use it whenever a change touches anything visible in public/ (HTML, CSS, client.js rendering), when CLAUDE.md asks to check the UI in the browser, before a PR that needs before/after screenshots, or when the user asks how a screen looks - even if they only say "schau dir mal X an" or "mach einen Screenshot".
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
  high), `desk` 1440×900, `se` 375×667 (small phones).
- **Scenes:** `lobby`, `lobby-open` (daily tasks unfolded), `progress`
  ("Dein Fortschritt"), `stats`, `history` ("Meine Partien"), `roundend`,
  `roundend-stats`, `gameover`.
- Prints the written PNG paths. Look at them with the Read tool; don't
  just trust that they exist.

The script starts its own server on a **temp `PIKDAME_DATA_DIR`** and kills it
afterwards. That matters: a dev server on `data/` keeps `users.db` open, and
the next `npm test` then fails in `reconnect-race.test.js` with a SQLite
"disk I/O error". Never leave a server of your own running on `data/`.

## How the mocks work

Playwright routes the WebSocket to the real server and rewrites messages on
the way to the page (`profiles`, `gameHistory`, `stammtischInfo`). Result
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
- **Signed-in look:** there is no real account in the mock. Add the classes
  the client sets (`#accountBtn.signedIn`, `#identityChip.locked`) via
  `page.evaluate` and say in the PR that it was simulated.

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

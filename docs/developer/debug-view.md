# Debug view

"Optionen" → "Debug-Ansicht" switches on a measuring overlay for remote
diagnosis: a 10/50 px grid, outlines around the key containers and a small
panel with live values. It is stored per device (`pikdame_debug`) and off by
default. Numbers and pages live in `public/debug-view.js` (no DOM, the tests
`require()` it); `client.js` feeds it and draws the panel.

## The panel

| Control | What it does |
| --- | --- |
| Page button | Turns to the next page (stored) |
| Copy | Puts the whole report on the clipboard |
| Bug | Folds the panel down to this one button and back (stored) |
| Tap on the values | Moves the panel to the next corner (stored), so it never has to cover the spot in question |

| Page | Values |
| --- | --- |
| Layout | Layout mode (portrait / landscape ≤ 540 px / desktop ≥ 1100 px), every viewport source (`innerHeight`, `visualViewport`, `100dvh`, `--appvh`, `#app`), safe areas, UI scale, theme, language |
| Netz | Socket state, round trip (last / mean / max), age of the last message and state, state size, messages and bytes in and out, connects and drops, the reconnect step |
| Render | Frames per second and the worst frame, duration of `render()` (last / mean / max), DOM nodes, long tasks and JS heap (Chromium only, else `n/a`), caught JS errors |
| Spiel | Screen, session code, open sheets, phase, round, turn, who is on turn, piles, melds and every seat (`*` me, `b` bot, `x` disconnected) with cards and total |

Values repaint every 250 ms and within 80 ms of a state, a render or a resize.
A line is at most `WIDTH` (33) characters; the panel has that fixed width so
live values never make it jump.

## What runs when

- **Always:** message and byte counters, `render()` timing and the last ten
  JS errors. They cost a few additions, and a report is useful without the
  view having been on before the problem showed.
- **Only while the view is on:** the frame loop (fps), the long-task observer
  and a round-trip ping every 5 s. The ping is the watchdog's own
  `{"type":"ping"}`; it never arms the watchdog, which keeps judging the
  socket by its own rules.

## The report

The copy button and `window.pikdameDebug` produce the same object: everything
on the four pages plus the user agent, message counts by type, the last twelve
message types, the own hand as short codes (`♠Q`, `JK`) and the caught errors.
It never contains a seat token, an account token, a player id or a Stammtisch
code (a test asserts this). The session code is included.

```js
window.pikdameDebug.report()   // the object
window.pikdameDebug.text()     // what the copy button copies: a heading line, then JSON
window.pikdameDebug.page('net') // show a page
```

The hook exists whether the view is on or not, so a Playwright check can read
it without touching the UI. The `ui-shots` skill uses it: `--report` writes
`<shot>.debug.json` beside every screenshot, and the scene `table-debug` shoots
each page at a live engine table.

## Rules

- The debug view is optional: every entry point is null-safe and caught. A
  cached start page without the panel's markup or without `debug-view.js` must
  still reach `connect()` (`scripts/client-boot-smoke.js`).
- A new value goes into the report object first; a page line only formats it.
  A new line must fit `WIDTH` with realistic values (`test/debug-view.test.js`).

# Developer guide

```{toctree}
:hidden:

architecture
migrations
schema
protocol
game-constants
progression
team-mode
boss-fight
bots
rl-training
rl-setup
mcp
music
table-light
debug-view
contributing
```

## Getting the code running

```bash
git clone https://github.com/floriandeutsch89/pikdame-local.git
cd pikdame-local
npm install
# PostgreSQL is required, for the server and for the tests:
export PIKDAME_DATABASE_URL=postgres://pikdame@localhost:5432/pikdame
export PIKDAME_TEST_PG_URL=postgres://pikdame@localhost:5432/pikdame_test
npm start                 # → http://localhost:8080
npm test                  # full suite (~1,080 tests)
node scripts/client-boot-smoke.js   # renders the client headlessly
```

There is **no build step**. The client is plain HTML/CSS/JS served as-is: edit
`public/client.js`, reload the browser.

## Where things live

| Path | What |
| --- | --- |
| `server.js` | HTTP + WebSocket server, session registry, message handling, persistence wiring |
| `game/GameManager.js` | One instance per table: the whole game loop, turn handling, bot driving, broadcast |
| `game/Rules.js` | Pure rules: what is a valid set/run, lay-off, joker swap |
| `game/Bot.js` | Bot decision-making (draw, meld, discard) |
| `game/ScoreBoard.js` | Scoring and game-over logic |
| `game/BossFight.js` | Kartenhaus boss floors: a duel in life points, the bosses' rules (see {doc}`boss-fight`) |
| `game/Teams.js` | "2 gegen 2": teams by seat, team sums, team records (see {doc}`team-mode`) |
| `game/Deck.js` | Deck creation, the (Fisher-Yates) shuffle, dealing |
| `game/*Store.js` | Persistence (profiles, stats, history, challenges, accounts) |
| `game/Progression.js`, `game/Badges.js` | XP, quests, badges — pure functions over a finished game (see {doc}`progression`) |
| `public/` | The entire client |
| `public/music/`, `scripts/render-music.js` | Background music, composed as code and rendered to MP3 (see {doc}`music`) |
| `public/table-light.js` | The table's light by the time of day; colours in `style.css` (see {doc}`table-light`) |
| `public/turn-light.js` | Where the turn light's pool lies for the seat on turn, from the seats' real boxes; `client.js` places it (see {doc}`table-light`) |
| `public/table-moves.js` | What another player just did, and which of my own cards I laid, read from two states by where the cards are; `client.js` flies it |
| `public/debug-view.js` | The debug view's counters, pages and report; `client.js` draws the panel (see {doc}`debug-view`) |
| `public/boss-fight.js` | The Kartenhaus boss floors at the table: panel, life bars, entrance, hit effects (see {doc}`boss-fight`) |
| `public/score-chart.js` | The game-over score chart drawing itself: lead changes from the plotted totals, the reveal's keyframes; `client.js` builds the chart |
| `public/pet.js` | Table pets: the drawing and what the pet is doing (mood from the state); the list is `game/Pets.js` |
| `scripts/` | Tooling: A/B bot simulation, load test, docs generator |
| `mcp/` | MCP server: an LLM agent plays a seat (see {doc}`mcp`) |
| `test/` | The test suite (`node --test`) |

## Generated, not written

Four pages of this guide are produced by `scripts/gen-docs.js` straight from
the source and verified in CI, so they cannot go stale:
{bdg-primary-line}`configuration` {bdg-primary-line}`protocol`
{bdg-primary-line}`game-constants` {bdg-primary-line}`progression`.
See {doc}`contributing` for how that works.

## Useful tooling

```bash
node scripts/sim-ab.js 5000 queenDumpMaxHand 5   # A/B a bot change in self-play
node scripts/load-test.js 200                    # 200 concurrent games; event-loop lag, memory
npm run docs:gen                                 # regenerate the generated doc pages
```

# Developer guide

```{toctree}
:hidden:

architecture
protocol
game-constants
bots
rl-training
contributing
```

## Getting the code running

```bash
git clone https://github.com/floriandeutsch89/pikdame-local.git
cd pikdame-local
npm install
npm start                 # → http://localhost:8080
npm test                  # full suite (~240 tests)
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
| `game/Deck.js` | Deck creation, the (Fisher-Yates) shuffle, dealing |
| `game/*Store.js` | Persistence (profiles, stats, history, challenges, accounts) |
| `public/` | The entire client |
| `scripts/` | Tooling: A/B bot simulation, load test, docs generator |
| `test/` | The test suite (`node --test`) |

## Useful tooling

```bash
node scripts/sim-ab.js 5000 queenDumpMaxHand 5   # A/B a bot change in self-play
node scripts/load-test.js 200                    # 200 concurrent games; event-loop lag, memory
npm run docs:gen                                 # regenerate the generated doc pages
```

# LLM players (MCP)

`mcp/` holds an [MCP](https://modelcontextprotocol.io) server that gives an
LLM agent (Claude Code, Claude Desktop or any other MCP client) one seat at a
Pik Dame table. You can play against the model the same way you play against
a friend: open a table, share the code, and the agent sits down.

## How it fits together

```text
MCP client (Claude Code / Desktop)
   │  stdio, JSON-RPC (MCP)
   ▼
mcp/server.js  ── tools: join_game, wait_for_turn, play, …
   │  WebSocket, the normal client protocol (see {doc}`protocol`)
   ▼
server.js on play.pikdame.online or localhost
```

The MCP server runs **on the player's machine**, next to the agent. Towards
the game server it is an ordinary player client:

- **No server changes.** It uses the same messages as the browser
  (`createSession`, `joinSession`, `drawFromPile`, `layoutMeld`, …).
  `server.js`, `game/` and the reverse proxy stay untouched.
- **No hidden information.** It receives the same per-seat `state` as a
  browser, so it sees its own hand and nobody else's. Cheating is impossible
  by construction.
- **Not in the image.** `mcp/` has its own `package.json`
  (`@modelcontextprotocol/sdk`, `zod`, `ws`). The Dockerfile never copies it.

## Setup

```bash
cd mcp
npm ci
claude mcp add pikdame -e PIKDAME_PLAYER_NAME=Claude -- node /absolute/path/to/pikdame-local/mcp/server.js
```

| Variable | Default | Purpose |
| --- | --- | --- |
| `PIKDAME_URL` | `wss://play.pikdame.online` | Game server; `ws://localhost:8080` for a local one |
| `PIKDAME_PLAYER_NAME` | `Claude` | Name at the table |
| `PIKDAME_ACCOUNT_TOKEN` | - | Only needed when the name belongs to a registered account |

Claude Desktop and other clients take the same command and environment in
their own config (see `mcp/README.md`).

## What the agent gets

| Tool | Purpose |
| --- | --- |
| `create_game` / `join_game` | Open a table as host, or sit down at one (game or Stammtisch code) |
| `wait_for_turn` | Blocks until the seat has something to do: its turn, the cut, the next round, a player joining the lobby |
| `play` | Performs option N from the last listing |
| `get_state` | The table and the options, without waiting |
| `emote` | A reaction from the level-1 emotes (never locked, see `game/Emotes.js`) |
| `get_rules` | The rules for the model (`mcp/rules.md`) |
| `leave_game` | Disconnects. Mid-game a bot takes over after the usual grace period |

The server also exposes the rules as the resource `pikdame://rules` and a
`play_pikdame` prompt that runs the whole loop: join, wait, choose, play.

Each tool answer is plain text: new server log lines (German), table talk
(emotes, bot lines), the table as the seat sees it, and the numbered options.

```text
Your hand (16 cards, 125 pts if caught): 2♥ 3♥ 6♦ 7♦ 8♦ 8♦ J♦ A♦ 5♣ Q♣ Q♣ 6♠ 8♠ 10♠ J♠ K♠
Draw pile: 47 cards | discard pile: 1 cards, top 8♥
Melds of Kurt: [5♠ 5♥ 5♦] [10♠ JK(=J♠) Q♠]

Your options - call play with the number:
1. Lay out set: 8♦ 8♦ 8♠ (+15)
2. Lay out run: 6♦ 7♦ 8♦ (+15)
3. Discard 2♥ (ends your turn)
…
```

## Legal moves: the engine decides

Free-text moves do not work for Rommé: models reliably build invalid melds
(ring runs, joker roles, the two-phase pickup). So the model never types a
move. It picks a number from a list of moves that are known to be legal.

`mcp/LegalActions.js` builds that list in two steps:

1. **Candidates** from the seat's hand:
   - sets per rank (each suit at most twice, plus jokers),
   - every ring window of 3-13 cards per suit, with jokers filling the gaps
     (`Rules.enumerateMeldOptions` gives the joker roles),
   - lay-offs and joker swaps on the seat's own melds,
   - discards, draw or take, the cut, next round, and lobby start or ready.
2. **Replay.** Each meld, lay-off, swap and discard is applied to a throwaway
   `GameManager` built from the seat's view (`buildShadow`). Other hands and
   the draw pile are filler cards, because no meld-phase rule reads them. A
   candidate is listed only if the real method returns `ok`.

All the special cases therefore come from the engine itself, not from a
second copy of the rules: the pickup duty, "keep one card to discard", merging
a second set and `_sparingMeldExists`. A rule change in `game/` reaches the
MCP seat without touching `mcp/`.

A "2 gegen 2" table ({doc}`team-mode`) plays by the same rules, so the same
list applies. The table text names both teams with their shared totals and
marks the partner; the lobby lists "switch to the other team".

To keep the list readable, the generator leaves out some legal moves:

- melds with more jokers than real cards. The exception is the pickup duty,
  so the seat can never get stuck.
- a joker standing in for a card the hand also holds.

Each card set also gets only one joker placement. In practice that leaves at
most about 50 options per decision.

## Tests

| Test | What it proves |
| --- | --- |
| `test/mcp-legal-actions.test.js` | 6 whole games with one seat playing random listed moves against three zen bots. Every listed move (> 1000) is applied to a serialize/deserialize clone of the real game and must be accepted. A taken discard card always has a listed meld that lays it. |
| `test/mcp-client.test.js` | `PikdameClient` against a real `server.js` process (temp data dir): open a table, start it, play listed moves until the round ends. Any refusal fails the test. |

Neither test needs the MCP SDK; both run in the normal `npm test` and CI.

## Limitations

- **Turn timer.** A slow model loses its turn to the bot logic when the table
  uses a turn timer. Play without one.
- **Long waits.** `wait_for_turn` returns after 60 s by default (max 600 s),
  so MCP client tool timeouts never cut it off. The agent calls it again.
- **No authentication.** The seat joins like a guest. A registered name needs
  `PIKDAME_ACCOUNT_TOKEN`. Requiring an account for agents, or marking agent
  seats at the table, would need changes in `server.js` and is not
  implemented.
- **Strength unmeasured.** No `sim-bots.js` numbers exist for LLM seats; they
  would cost real API money. Expect them to be weaker than the zen bot.
- **Dependencies.** The packages in `mcp/` are not covered by Dependabot
  (`dependabot-auto.yml` would turn every update there into a game release). Update them
  with `npm update` in `mcp/` from time to time.

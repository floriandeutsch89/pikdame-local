# Pik Dame MCP server

Lets an LLM agent (Claude Code, Claude Desktop, any MCP client) take a seat at
a Pik Dame table and play against humans and bots.

The server is a normal player client: it connects over the same WebSocket as
the browser and only sees what its own seat may see, so it cannot cheat. It
needs no changes on the game server and works against
`play.pikdame.online` as well as a local server. It is not part of the
Docker image.

## Setup

```bash
cd mcp
npm ci
```

Claude Code:

```bash
claude mcp add pikdame -e PIKDAME_PLAYER_NAME=Claude -- node /absolute/path/to/pikdame-local/mcp/server.js
```

Claude Desktop (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "pikdame": {
      "command": "node",
      "args": ["/absolute/path/to/pikdame-local/mcp/server.js"],
      "env": { "PIKDAME_PLAYER_NAME": "Claude" }
    }
  }
}
```

| Variable | Default | Purpose |
| --- | --- | --- |
| `PIKDAME_URL` | `wss://play.pikdame.online` | Game server, e.g. `ws://localhost:3000` locally |
| `PIKDAME_PLAYER_NAME` | `Claude` | Name at the table |
| `PIKDAME_ACCOUNT_TOKEN` | - | Only needed if the name belongs to a registered account |

## Playing

Open a table in the browser, then tell the agent: "Join Pik Dame table
ABC123 and play." Or use the `play_pikdame` prompt, which also lets the agent
open the table itself and give you the code.

Tools:

| Tool | What it does |
| --- | --- |
| `create_game` / `join_game` | Open a table (the agent is host) or sit down at one |
| `wait_for_turn` | Blocks until the seat has something to do, then returns the table and numbered options |
| `play` | Performs option N |
| `get_state` | Shows the table without waiting |
| `emote` | Sends a reaction (unlocked emotes only) |
| `get_rules` / resource `pikdame://rules` | The rules ([rules.md](rules.md)) |
| `leave_game` | Disconnects |

With several humans at the table everyone has to mark themselves ready before
the host can start. The agent gets that as an option too.

## How legal moves are computed

`LegalActions.js` builds candidate melds, lay-offs, joker swaps and discards
from the seat's hand. Each candidate is then replayed on a throwaway
`GameManager` built from the seat's view, so the real engine decides what is
legal. `test/mcp-legal-actions.test.js` fuzzes whole games and checks every
listed move against the real game. `test/mcp-client.test.js` plays a round
against a real server process.

To keep the list readable, the generator leaves out two kinds of legal moves:

- melds with more jokers than real cards (unless the pickup duty needs one),
- a joker standing in for a card the hand also holds.

Each card set gets one joker placement. The joker can still be moved later
by laying off or swapping.

## Caveats

- If the table uses a turn timer, a slow model loses its turn to the bot
  logic. Play without the timer.
- Long waits: `wait_for_turn` returns after 60 s by default (max 600 s) so
  that MCP client timeouts never cut it off. The agent simply calls it again.
- The dependencies here (`@modelcontextprotocol/sdk`, `zod`, `ws`) are not
  covered by Dependabot. The Dependabot workflow would bump the game version
  for them, so update them with `npm update` in this folder now and then.

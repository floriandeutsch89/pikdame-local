#!/usr/bin/env node
'use strict';

// MCP server (stdio): gives an LLM agent one seat at a Pik Dame table.
// stdout carries the MCP protocol - diagnostics must go to stderr.

const fs = require('node:fs');
const path = require('node:path');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');
const { PikdameClient, DEFAULT_URL } = require('./PikdameClient');
const { renderState, newLogLines } = require('./StateView');
const { EMOTE_DEFS } = require('../game/Emotes');

console.log = console.error;

const RULES = fs.readFileSync(path.join(__dirname, 'rules.md'), 'utf8');
// Level-1 emotes are unlocked for everyone, so the server never refuses them.
const EMOTES = EMOTE_DEFS.filter((e) => e.level === 1).map((e) => e.id);

const client = new PikdameClient({
  url: process.env.PIKDAME_URL || DEFAULT_URL,
  name: process.env.PIKDAME_PLAYER_NAME || 'Claude',
  accountToken: process.env.PIKDAME_ACCOUNT_TOKEN,
});
const seenLog = new Set();
let listing = []; // action keys in the numbering the model last saw

const text = (s) => ({ content: [{ type: 'text', text: s }] });
const fail = (s) => ({ content: [{ type: 'text', text: s }], isError: true });

function report({ withLog = true } = {}) {
  const parts = [];
  if (withLog) {
    const fresh = newLogLines(client.state, seenLog);
    if (fresh.length) parts.push(`Since last look (server log, German):\n${fresh.map((l) => `  ${l}`).join('\n')}`);
    const talk = client.drainEvents().map((e) => {
      const who = (client.state && client.state.players.find((p) => p.id === e.playerId)) || { name: '?' };
      return e.type === 'quip' ? `${who.name}: (bot line "${e.moment}")` : `${who.name}: ${e.emoji}`;
    });
    if (talk.length) parts.push(`Table talk: ${talk.join(' | ')}`);
  }
  parts.push(renderState(client.state, client.playerId));
  const actions = client.actions();
  listing = actions.map((a) => a.key);
  if (actions.length) {
    parts.push(`Your options - call play with the number:\n${actions.map((a, i) => `${i + 1}. ${a.label}`).join('\n')}`);
  } else if (client.state && client.state.phase !== 'gameOver') {
    parts.push('Nothing to do right now - call wait_for_turn.');
  }
  return parts.join('\n\n');
}

function requireSeat() {
  return client.playerId ? null : fail('You are not seated yet - call create_game or join_game first.');
}

const server = new McpServer({ name: 'pikdame', version: require('./package.json').version });

server.registerResource('rules', 'pikdame://rules', { title: 'Pik Dame rules', mimeType: 'text/markdown' }, async (uri) => ({
  contents: [{ uri: uri.href, mimeType: 'text/markdown', text: RULES }],
}));

server.registerPrompt(
  'play_pikdame',
  {
    title: 'Play Pik Dame',
    description: 'Join a table and play a whole match of Pik Dame.',
    argsSchema: { code: z.string().optional().describe('Table code to join; empty = open a new table') },
  },
  ({ code }) => ({
    messages: [{
      role: 'user',
      content: {
        type: 'text',
        text: `${RULES}\n\n---\n${code ? `Join the table ${code} with join_game.` : 'Open a new table with create_game and tell me the code so I can join.'} ` +
          'Then loop: wait_for_turn, pick the best option, play it, until the game is over. ' +
          'Think briefly about each move; a short remark or an emote now and then is welcome.',
      },
    }],
  })
);

server.registerTool('get_rules', { description: 'The full Pik Dame rules and card values.' }, async () => text(RULES));

server.registerTool(
  'create_game',
  { description: 'Open a new table and sit down as its host. Share the returned code with the human players.' },
  async () => {
    try {
      const code = await client.createGame();
      return text(`Table ${code} is open. You are the host; start the game (play "Start") once everyone has joined.\n\n${report()}`);
    } catch (e) {
      return fail(`Could not open a table: ${e.message}`);
    }
  }
);

server.registerTool(
  'join_game',
  { description: 'Sit down at an existing table (game code or Stammtisch code).', inputSchema: { code: z.string().min(1) } },
  async ({ code }) => {
    try {
      const joined = await client.joinGame(code);
      return text(`Seated at table ${joined}.\n\n${report()}`);
    } catch (e) {
      return fail(`Could not join ${code}: ${e.message}`);
    }
  }
);

server.registerTool(
  'wait_for_turn',
  {
    description: 'Block until you have something to do (your turn, the cut, the next round) or the game ends. Returns the table and your numbered options. If it times out, just call it again.',
    inputSchema: { timeout_seconds: z.number().int().min(1).max(600).optional() },
  },
  async ({ timeout_seconds }) => {
    const missing = requireSeat();
    if (missing) return missing;
    const lobbyPlayers = () => (client.state ? client.state.players.filter((p) => !p.isBot).length : 0);
    const startHumans = lobbyPlayers();
    const r = await client.waitFor(() => {
      const s = client.state;
      if (s && s.phase === 'lobby') return lobbyPlayers() !== startHumans ? 'lobby' : null;
      return client.attention();
    }, (timeout_seconds || 60) * 1000);
    if (!r) return text(`Still waiting (nothing for you to do yet). Call wait_for_turn again.\n\n${report()}`);
    return text(report());
  }
);

server.registerTool(
  'get_state',
  { description: 'Show the table as you see it and your numbered options, without waiting.' },
  async () => requireSeat() || text(report())
);

server.registerTool(
  'play',
  {
    description: 'Perform one of the numbered options from the last wait_for_turn/get_state/play output. A turn usually takes several plays: draw, optional melds, then a discard.',
    inputSchema: { option: z.number().int().min(1) },
  },
  async ({ option }) => {
    const missing = requireSeat();
    if (missing) return missing;
    const key = listing[option - 1];
    const action = key && client.actions().find((a) => a.key === key);
    if (!action) return fail(`Option ${option} is not available (anymore). Current situation:\n\n${report()}`);
    const r = await client.perform(action);
    if (r.error) return fail(`The server refused "${action.label}": ${r.error}\n\n${report()}`);
    return text(`Done: ${action.label}\n\n${report()}`);
  }
);

server.registerTool(
  'emote',
  { description: `Send a quick reaction to the table. Allowed: ${EMOTES.join(' ')}`, inputSchema: { emoji: z.enum(EMOTES) } },
  async ({ emoji }) => {
    const missing = requireSeat();
    if (missing) return missing;
    try { client.emote(emoji); return text(`Sent ${emoji}.`); } catch (e) { return fail(e.message); }
  }
);

server.registerTool('leave_game', { description: 'Close the connection to the table. Mid-game a bot takes over your seat after a grace period.' }, async () => {
  client.close();
  return text('Left the table.');
});

async function main() {
  await server.connect(new StdioServerTransport());
  console.error(`pikdame-mcp ready (server ${client.url})`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

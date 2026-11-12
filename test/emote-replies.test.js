// Bot answers to human emotes (game/EmoteReplies.js): every allowed emote gets
// one, replies stay on the whitelist, table context picks the right bot.
const test = require('node:test');
const assert = require('node:assert');
const { EMOTE_IDS, SEASONAL_EMOTES, GREETING_EMOTE, HOLIDAY_EMOTES, isAllowedEmote } = require('../game/Emotes');
const { BASE, POOLS, planReply, pushEvent } = require('../game/EmoteReplies');

const ALL = [...new Set([...EMOTE_IDS, ...SEASONAL_EMOTES, GREETING_EMOTE, ...Object.values(HOLIDAY_EMOTES)])];
const NOW = 1_000_000;
const ctx = (over) => ({ senderId: 'h', bots: ['b1', 'b2', 'b3'], currentBotId: null, events: [], now: NOW, random: () => 0, ...over });
const ev = (kind, actorId, victimIds = [], age = 1000) => ({ kind, actorId, victimIds, at: NOW - age });

test('every allowed emote has a reply pool; every reply is allowed and weights sum to 1', () => {
  for (const id of ALL) assert.ok(BASE[id], `no bot reply for ${id}`);
  for (const [id, pool] of [...Object.entries(BASE), ...Object.entries(POOLS)]) {
    const sum = pool.reduce((s, [, w]) => s + w, 0);
    assert.ok(Math.abs(sum - 1) < 1e-9, `weights of ${id} sum to ${sum}`);
    for (const [e] of pool) assert.ok(isAllowedEmote(e), `${id} answers with ${e}, not on the whitelist`);
  }
});

test('no context: a random bot answers from the base pool; greetings answered warmly', () => {
  const r = planReply(ctx({ emoji: '🍻' }));
  assert.deepStrictEqual(r, { botId: 'b1', emoji: '🍻', chance: 0.45 });
  assert.strictEqual(planReply(ctx({ emoji: '🎂' })).chance, 0.8);
  assert.strictEqual(planReply(ctx({ emoji: '🍻', bots: [] })), null);
  assert.strictEqual(planReply(ctx({ emoji: 'nope' })), null);
});

test('human gloats after winning the round: the bot who lost most grumbles', () => {
  const r = planReply(ctx({ emoji: '😂', events: [ev('round_won', 'h', ['b3'])] }));
  assert.strictEqual(r.botId, 'b3');
  assert.ok(POOLS.sore.some(([e]) => e === r.emoji));
  assert.strictEqual(r.chance, 0.75);
});

test('a bot laid the Pik Dame: the human\'s dismay gets that bot\'s smug answer, praise its thanks', () => {
  const smug = planReply(ctx({ emoji: '😱', events: [ev('queen_laid', 'b2')] }));
  assert.strictEqual(smug.botId, 'b2');
  assert.ok(POOLS.smug.some(([e]) => e === smug.emoji));
  const thanks = planReply(ctx({ emoji: '👏', events: [ev('queen_laid', 'b2')] }));
  assert.strictEqual(thanks.botId, 'b2');
  assert.ok(POOLS.thanks.some(([e]) => e === thanks.emoji));
});

test('human caught with the Queen: the winning bot teases; a bot caught blushes at a laugh', () => {
  const tease = planReply(ctx({ emoji: '😤', events: [ev('queen_caught', 'h'), ev('round_won', 'b2', ['h'])] }));
  // round_won is newer, but a bot's win + dismay = smug from the winner: same bot either way.
  assert.strictEqual(tease.botId, 'b2');
  const caught = planReply(ctx({ emoji: '😂', events: [ev('queen_caught', 'b3')] }));
  assert.strictEqual(caught.botId, 'b3');
  assert.ok(POOLS.caught.some(([e]) => e === caught.emoji));
});

test('old events are ignored; the bot at turn takes ⏳ and 👀 personally', () => {
  const stale = planReply(ctx({ emoji: '😂', events: [ev('queen_caught', 'b3', [], 60_000)] }));
  assert.strictEqual(stale.chance, 0.45);
  const rushed = planReply(ctx({ emoji: '⏳', currentBotId: 'b2' }));
  assert.strictEqual(rushed.botId, 'b2');
  assert.strictEqual(rushed.chance, 0.6);
  assert.strictEqual(planReply(ctx({ emoji: '👀', currentBotId: 'b3' })).botId, 'b3');
});

test('2 gegen 2: the partner bot cheers or comforts, opponents grumble', () => {
  const sameTeam = (a, b) => ['h', 'b2'].includes(a) === ['h', 'b2'].includes(b);
  const cheer = planReply(ctx({ emoji: '🎉', sameTeam, events: [ev('round_won', 'h', ['b2'])] }));
  assert.strictEqual(cheer.botId, 'b2', 'partner cheers along');
  assert.ok(POOLS.cheer.some(([e]) => e === cheer.emoji));
  const sore = planReply(ctx({ emoji: '🎉', sameTeam, random: () => 0.6, events: [ev('round_won', 'h', ['b2'])] }));
  assert.ok(['b1', 'b3'].includes(sore.botId), 'a partner is never the sore loser');
  const comfort = planReply(ctx({ emoji: '😱', sameTeam, events: [ev('queen_caught', 'h')] }));
  assert.strictEqual(comfort.botId, 'b2');
  assert.ok(POOLS.comfort.some(([e]) => e === comfort.emoji));
});

test('pushEvent keeps the newest four', () => {
  let list = [];
  for (let i = 0; i < 6; i++) list = pushEvent(list, ev('big_meld', `p${i}`));
  assert.deepStrictEqual(list.map((e) => e.actorId), ['p2', 'p3', 'p4', 'p5']);
});

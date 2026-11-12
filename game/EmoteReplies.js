// game/EmoteReplies.js
// How a bot answers a HUMAN emote: who answers, with what, how likely.
// Pure decision, no timers or I/O (GameManager sends). Every emote in
// Emotes.js has a base pool here (contract test), recent table events
// (Pik Dame laid, round won, Queen caught, big pile) steer it.

/** Pools are [[emoji, weight], ...]; weights sum to 1. */
const BASE = {
  '👍': [['👍', 0.6], ['🎉', 0.4]],
  '👎': [['😤', 0.6], ['😂', 0.4]],
  '😂': [['😂', 0.7], ['😤', 0.3]],
  '😱': [['😱', 0.5], ['😂', 0.5]],
  '😤': [['😂', 0.6], ['👍', 0.4]],
  '🎉': [['🎉', 0.6], ['👍', 0.4]],
  '⏳': [['😤', 0.5], ['⏳', 0.5]],
  pikdame: [['😱', 0.7], ['😂', 0.3]],
  '👏': [['👏', 0.5], ['👍', 0.5]],
  '🙈': [['😂', 0.7], ['🙈', 0.3]],
  '🤔': [['⏳', 0.5], ['🤔', 0.5]],
  '🍀': [['🍀', 0.5], ['😤', 0.5]],
  '😎': [['😤', 0.6], ['😂', 0.4]],
  '😲': [['😎', 0.5], ['😲', 0.5]],
  '🔥': [['🔥', 0.5], ['😱', 0.5]],
  '😴': [['⏳', 0.6], ['😴', 0.4]],
  '🙏': [['👍', 0.6], ['🙏', 0.4]],
  '🤩': [['🤩', 0.5], ['🎉', 0.5]],
  '🥳': [['🥳', 0.6], ['🎉', 0.4]],
  '💪': [['💪', 0.5], ['😤', 0.5]],
  '🃏': [['😱', 0.5], ['👀', 0.5]],
  '😅': [['😅', 0.5], ['😂', 0.5]],
  '🤞': [['🤞', 0.5], ['🍀', 0.5]],
  '👀': [['👀', 0.5], ['🙈', 0.5]],
  '🙄': [['🙃', 0.5], ['😇', 0.5]],
  '😬': [['😬', 0.5], ['😅', 0.5]],
  '🙃': [['🙃', 0.5], ['😂', 0.5]],
  '🤝': [['🤝', 0.7], ['👍', 0.3]],
  '😇': [['🙄', 0.5], ['😇', 0.5]],
  '☕': [['☕', 0.6], ['😴', 0.4]],
  '🐢': [['😤', 0.5], ['⏳', 0.5]],
  '🍻': [['🍻', 0.8], ['🎉', 0.2]],
  '❤️': [['❤️', 0.6], ['🤝', 0.4]],
  // Seasonal, holiday and greeting-day emotes: answered in kind, warmly.
  '🎃': [['🎃', 0.6], ['😱', 0.4]],
  '🎆': [['🎆', 0.7], ['🎉', 0.3]],
  '🎅': [['🎅', 0.6], ['🎉', 0.4]],
  '🎄': [['🎄', 0.7], ['❤️', 0.3]],
  '🐣': [['🐣', 0.7], ['🍀', 0.3]],
  '🎂': [['🥳', 0.5], ['🎉', 0.3], ['❤️', 0.2]],
};
const BASE_CHANCE = 0.45;
// A greeting day or a holiday wish is rarely left hanging.
const WARM = new Set(['🎂', '🎅', '🎄', '🐣', '🎆']);
const WARM_CHANCE = 0.8;

// What the emote says about the sender's mood.
const GLOAT = new Set(['😂', '😎', '🎉', '🥳', '🤩', '💪', '🔥', '🙃', '😇', '👀', '🃏', 'pikdame']);
const DISMAY = new Set(['👎', '😱', '😲', '😤', '😬', '🙄', '🙈', '😅']);
const PRAISE = new Set(['👏', '👍', '🤝', '🙏', '❤️', '🍻']);

// Events good / bad for their actor. Older than the window = no context.
const GOOD = new Set(['queen_laid', 'round_won', 'big_meld']);
const BAD = new Set(['queen_caught', 'big_pile']);
const CONTEXT_WINDOW_MS = 10000;
const MAX_EVENTS = 4;

const POOLS = {
  sore: [['😤', 0.45], ['🙄', 0.35], ['😬', 0.2]],
  cheer: [['🎉', 0.5], ['🥳', 0.3], ['💪', 0.2]],
  applaud: [['👏', 0.6], ['👍', 0.4]],
  smug: [['😎', 0.4], ['🙃', 0.35], ['😇', 0.25]],
  thanks: [['🙏', 0.4], ['😇', 0.3], ['😎', 0.3]],
  tease: [['😂', 0.5], ['😅', 0.3], ['🙈', 0.2]],
  comfort: [['🤝', 0.6], ['🙏', 0.4]],
  caught: [['😤', 0.4], ['🙈', 0.35], ['😬', 0.25]],
  rushed: [['😤', 0.5], ['⏳', 0.5]],
  watched: [['🤔', 0.5], ['😇', 0.5]],
};

// Aimed at whoever is to move: only a bot at turn takes it personally.
const AT_TURN = { '⏳': 'rushed', '🐢': 'rushed', '👀': 'watched', '🤔': 'watched' };

function pickFrom(pool, roll) {
  let r = roll;
  for (const [e, p] of pool) {
    if (r < p) return e;
    r -= p;
  }
  return pool[pool.length - 1][0];
}

/**
 * The reply plan for a human emote, or null when nobody should answer.
 * ctx: { emoji, senderId, bots: [ids], currentBotId, events: [{kind, actorId,
 * victimIds, at}] newest last, now, sameTeam(a, b), random() }.
 * Returns { botId, emoji, chance }.
 */
function planReply(ctx) {
  const { emoji, senderId, now } = ctx;
  const rnd = ctx.random || Math.random;
  const sameTeam = ctx.sameTeam || (() => false);
  const bots = (ctx.bots || []).filter((id) => id !== senderId);
  if (!BASE[emoji] || bots.length === 0) return null;
  const anyBot = (ids) => {
    const list = (ids || bots).filter((id) => bots.includes(id));
    return list.length ? list[Math.floor(rnd() * list.length)] : null;
  };
  const plan = (botId, poolName, chance) => (botId ? { botId, emoji: pickFrom(POOLS[poolName], rnd()), chance } : null);

  const events = (ctx.events || []).filter((e) => e && now - e.at <= CONTEXT_WINDOW_MS);
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    const senderActs = ev.actorId === senderId;
    const botActs = bots.includes(ev.actorId);
    if (GOOD.has(ev.kind) && senderActs) {
      if (GLOAT.has(emoji)) {
        // The beaten bot grumbles; in "2 gegen 2" the partner cheers along.
        const partner = bots.find((id) => sameTeam(id, senderId));
        if (partner && rnd() < 0.5) return plan(partner, 'cheer', 0.75);
        const victims = (ev.victimIds || []).filter((id) => !sameTeam(id, senderId));
        return plan(anyBot(victims.length ? victims : bots.filter((id) => !sameTeam(id, senderId))) || anyBot(), 'sore', 0.75);
      }
      if (DISMAY.has(emoji) || PRAISE.has(emoji)) return plan(anyBot(), 'applaud', 0.6);
    }
    if (GOOD.has(ev.kind) && botActs) {
      if (sameTeam(ev.actorId, senderId) && (GLOAT.has(emoji) || PRAISE.has(emoji))) return plan(ev.actorId, 'comfort', 0.75);
      if (PRAISE.has(emoji)) return plan(ev.actorId, 'thanks', 0.75);
      if (DISMAY.has(emoji)) return plan(ev.actorId, 'smug', 0.75);
    }
    if (BAD.has(ev.kind) && senderActs && (DISMAY.has(emoji) || emoji === '🙏')) {
      const partner = bots.find((id) => sameTeam(id, senderId));
      if (partner) return plan(partner, 'comfort', 0.7);
      // The round's winner, if a bot, enjoys it most.
      const winner = events.find((e) => e.kind === 'round_won' && bots.includes(e.actorId));
      return plan(winner ? winner.actorId : anyBot(), 'tease', 0.7);
    }
    if (BAD.has(ev.kind) && botActs && GLOAT.has(emoji)) return plan(ev.actorId, 'caught', 0.8);
  }

  if (AT_TURN[emoji] && ctx.currentBotId && bots.includes(ctx.currentBotId)) {
    return plan(ctx.currentBotId, AT_TURN[emoji], 0.6);
  }
  return { botId: anyBot(), emoji: pickFrom(BASE[emoji], rnd()), chance: WARM.has(emoji) ? WARM_CHANCE : BASE_CHANCE };
}

/** Appends an event and keeps the newest MAX_EVENTS. */
function pushEvent(list, ev) {
  const out = Array.isArray(list) ? list.slice(-(MAX_EVENTS - 1)) : [];
  out.push(ev);
  return out;
}

module.exports = { BASE, POOLS, AT_TURN, CONTEXT_WINDOW_MS, planReply, pushEvent, pickFrom };

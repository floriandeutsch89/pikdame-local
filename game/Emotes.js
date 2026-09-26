// game/Emotes.js
// The ONE list of table reactions. The server validates against it (a
// whitelist is a safety filter, never a season filter), the client renders
// its bars from the same ids (index.html carries them statically - the
// contract test keeps both in sync), and Unlocks.js hands out the ones that
// are earned by level.
//
// 'pikdame' is a styled mini card on the client (there is no ♠Q emoji).

const EMOTE_DEFS = [
  // The classic seven: always available.
  { id: '👍', level: 1 },
  { id: '😂', level: 1 },
  { id: '😱', level: 1 },
  { id: '😤', level: 1 },
  { id: '🎉', level: 1 },
  { id: '⏳', level: 1 },
  { id: 'pikdame', level: 1 },
  // Second row: earned by level, so the XP bar has something visible to
  // hand out. Without a profile (public server) every emote is available -
  // there is nothing to unlock against.
  { id: '👏', level: 2 },
  { id: '🙈', level: 3 },
  { id: '🤔', level: 4 },
  { id: '🍀', level: 5 },
  { id: '😎', level: 6 },
  { id: '🔥', level: 8 },
  { id: '😴', level: 10 },
  { id: '🙏', level: 12 },
];

// Seasonal offers the client adds in October / December-January. Allowed
// year-round server-side.
const SEASONAL_EMOTES = ['🎃', '🎆'];

const EMOTE_IDS = EMOTE_DEFS.map((e) => e.id);
const ALL_ALLOWED = new Set([...EMOTE_IDS, ...SEASONAL_EMOTES]);

function isAllowedEmote(id) {
  return ALL_ALLOWED.has(id);
}

/** Level needed for an emote (1 = always). Unknown ids need level 1 too:
 *  the whitelist above decides what exists, this only decides when. */
function emoteLevel(id) {
  const def = EMOTE_DEFS.find((e) => e.id === id);
  return def ? def.level : 1;
}

module.exports = { EMOTE_DEFS, EMOTE_IDS, SEASONAL_EMOTES, isAllowedEmote, emoteLevel };

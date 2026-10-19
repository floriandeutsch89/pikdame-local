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
  { id: '👍', level: 1, cat: 'smileys' },
  { id: '😂', level: 1, cat: 'smileys' },
  { id: '😱', level: 1, cat: 'smileys' },
  { id: '😤', level: 1, cat: 'smileys' },
  { id: '🎉', level: 1, cat: 'activity' },
  { id: '⏳', level: 1, cat: 'objects' },
  { id: 'pikdame', level: 1, cat: 'activity' },
  // Second row: earned by level, so the XP bar has something visible to
  // hand out. Without a profile (public server) every emote is available -
  // there is nothing to unlock against.
  { id: '👏', level: 2, cat: 'smileys' },
  { id: '🙈', level: 3, cat: 'smileys' },
  { id: '🤔', level: 4, cat: 'smileys' },
  { id: '🍀', level: 5, cat: 'nature' },
  { id: '😎', level: 6, cat: 'smileys' },
  { id: '🔥', level: 8, cat: 'nature' },
  { id: '😴', level: 10, cat: 'smileys' },
  { id: '🙏', level: 12, cat: 'smileys' },
  { id: '🤩', level: 14, cat: 'smileys' },
  { id: '🥳', level: 16, cat: 'smileys' },
  { id: '💪', level: 18, cat: 'smileys' },
  // Third wave, levels 20-40. All Unicode <= 12 so older phones draw them.
  { id: '🃏', level: 20, cat: 'activity' },
  { id: '😅', level: 21, cat: 'smileys' },
  { id: '🤞', level: 22, cat: 'smileys' },
  { id: '👀', level: 23, cat: 'smileys' },
  { id: '🙄', level: 24, cat: 'smileys' },
  { id: '😬', level: 26, cat: 'smileys' },
  { id: '🙃', level: 28, cat: 'smileys' },
  { id: '🤝', level: 30, cat: 'smileys' },
  { id: '😇', level: 32, cat: 'smileys' },
  { id: '☕', level: 34, cat: 'food' },
  { id: '🐢', level: 36, cat: 'nature' },
  { id: '🍻', level: 38, cat: 'food' },
  { id: '❤️', level: 40, cat: 'symbols' },
];

// The picker's expanded part follows the iPhone keyboard: its sections in
// this order (iOS merges smileys and people), within each the order below.
const EMOTE_CATEGORIES = ['smileys', 'nature', 'food', 'activity', 'objects', 'symbols'];
const KEYBOARD_ORDER = [
  '😅', '😂', '🙃', '😇', '🤩', '🤔', '😬', '🙄', '😴', '🥳', '😎', '😱', '😤', '🙈',
  '🤞', '👍', '👏', '🤝', '🙏', '💪', '👀',
  '🐢', '🍀', '🔥',
  '☕', '🍻',
  '🎉', '🃏', 'pikdame',
  '⏳',
  '❤️',
];

// Seasonal offers the client adds in October / December-January. Allowed
// year-round server-side.
const SEASONAL_EMOTES = ['🎃', '🎆'];
// Offered only to the account whose greeting day it is (game/GreetingDays.js).
const GREETING_EMOTE = '🎂';
// Offered to everyone on that holiday (game/Holidays.js); the client skips one
// the seasonal set already shows.
const HOLIDAY_EMOTES = { halloween: '🎃', nikolaus: '🎅', christmas: '🎄', silvester: '🎆', newyear: '🎆', easter: '🐣' };

const EMOTE_IDS = EMOTE_DEFS.map((e) => e.id);
const ALL_ALLOWED = new Set([...EMOTE_IDS, ...SEASONAL_EMOTES, GREETING_EMOTE, ...Object.values(HOLIDAY_EMOTES)]);

// Some keyboards send ❤ without the emoji variation selector (U+FE0F) or
// add one to ☕: match on the bare form, answer with the listed id.
const bare = (id) => String(id).replace(/\uFE0F/g, '');
const CANONICAL = new Map([...ALL_ALLOWED].map((id) => [bare(id), id]));

/** The listed id for an incoming emote, or null when it is not allowed. */
function normalizeEmote(id) {
  if (typeof id !== 'string' || id.length > 16) return null;
  return CANONICAL.get(bare(id)) || null;
}

function isAllowedEmote(id) {
  return normalizeEmote(id) !== null;
}

/** Level needed for an emote (1 = always). Unknown ids need level 1 too:
 *  the whitelist above decides what exists, this only decides when. */
function emoteLevel(id) {
  const canon = normalizeEmote(id) || id;
  const def = EMOTE_DEFS.find((e) => e.id === canon);
  return def ? def.level : 1;
}

module.exports = {
  EMOTE_DEFS, EMOTE_IDS, EMOTE_CATEGORIES, KEYBOARD_ORDER, SEASONAL_EMOTES, GREETING_EMOTE, HOLIDAY_EMOTES,
  normalizeEmote, isAllowedEmote, emoteLevel,
};

// game/BotQuips.js
// The ONE list of moments a bot may comment on with a short line. Only the
// moment id crosses the wire; the client holds the bilingual lines and picks
// one (contract test keeps both lists in sync).

const QUIP_MOMENTS = [
  'round_win', // a bot won the round
  'hand_aus', // ... in one go ("Hand aus")
  'game_win', // a bot won the match
  'queen_caught', // a bot was caught with the Queen of Spades in hand
  'queen_laid', // a bot melded a Queen of Spades (+100)
  'big_pile', // a bot swallowed a big discard pile
];

const isQuipMoment = (id) => QUIP_MOMENTS.includes(id);

module.exports = { QUIP_MOMENTS, isQuipMoment };

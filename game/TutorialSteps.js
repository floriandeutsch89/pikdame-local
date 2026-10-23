// game/TutorialSteps.js
// The ONE list of tutorial lessons the server knows: `tutorialStep` accepts only
// these keys, play_attempts ranks them by it (stage = position, 1-based). The
// lessons themselves live in public/client.js (same keys and bonus flags, contract
// test). Order = how a funnel reads them: pileDuty can only follow a draw.
// New, removed or reordered lessons need a new TUTORIAL_VERSION: it is the
// attempts' period, so the funnels of two tutorials never mix.
'use strict';

const TUTORIAL_VERSION = 'v1';
const TUTORIAL_STEPS = Object.freeze([
  { key: 'welcome' },
  { key: 'draw' },
  { key: 'pileDuty', optional: true },
  { key: 'firstSet' },
  { key: 'pikdame' },
  { key: 'queenSet' },
  { key: 'joker' },
  { key: 'moreMelds', optional: true },
  { key: 'discard' },
  { key: 'pile', optional: true },
  { key: 'layOff' },
  { key: 'jokerSwap', optional: true },
  { key: 'endgame' },
  { key: 'roundend' },
].map((s) => Object.freeze({ optional: false, ...s })));
const KEYS = new Set(TUTORIAL_STEPS.map((s) => s.key));

const isTutorialStep = (key) => typeof key === 'string' && KEYS.has(key);
/** 1-based position of a lesson, or null. */
const tutorialStepIndex = (key) => (isTutorialStep(key) ? TUTORIAL_STEPS.findIndex((s) => s.key === key) + 1 : null);

module.exports = { TUTORIAL_VERSION, TUTORIAL_STEPS, isTutorialStep, tutorialStepIndex };

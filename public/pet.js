// public/pet.js
// Table pets (game/Pets.js): the drawing and what the pet is doing. It decides
// no rule and stops nothing: a small figure at its owner's seat, for the whole
// table to see. client.js places it and feeds it the state.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PikdamePet = api;
}(typeof self !== 'undefined' ? self : this, () => {
  'use strict';

  // Mirrors game/Pets.js (contract test): id, level, names DE/EN.
  const PETS = [
    { id: 'none', level: 1, de: 'Keins', en: 'None' },
    { id: 'cat', level: 12, de: 'Katze', en: 'Cat' },
  ];
  const MOODS = ['idle', 'alert', 'sleep', 'happy', 'cheer', 'scared', 'yawn'];
  const HAPPY_MS = 3200; // hearts after its owner melded the Queen of Spades
  const YAWN_EVERY_MS = 25000; // a long turn: it yawns once per stretch ...
  const YAWN_MS = 2600; // ... for this long

  // At rest and asleep it lies down; everything else gets it up on its haunches.
  const poseOf = (mood) => (mood === 'idle' || mood === 'sleep' ? 'lie' : 'sit');
  const isPet = (id) => PETS.some((p) => p.id === id && p.id !== 'none');
  const petDef = (id) => PETS.find((p) => p.id === id) || null;

  // The cat, 64 x 64, back to front. Every moving part has its own class; pose and
  // mood only switch which body, eyes and mouth show and how the parts move (CSS).
  const FUR = '#e8913a';
  const FUR_DARK = '#b9651f';
  const CREAM = '#fbe9d2';
  const PINK = '#f29aa5';
  const INK = '#2a1a12';
  const eye = (cx) => `<g class="petEye"><ellipse cx="${cx}" cy="21.6" rx="3.3" ry="3.6" fill="#d3ea6c" stroke="${INK}" stroke-width=".6"/>` +
    `<ellipse class="petPupil" cx="${cx}" cy="21.8" rx="1.25" ry="3" fill="${INK}"/><circle cx="${cx - 0.9}" cy="20.3" r=".9" fill="#fff"/></g>`;
  const heart = (x, y, s, cls) => `<path class="petHeart ${cls}" transform="translate(${x} ${y}) scale(${s})" fill="#ff6f91" ` +
    'd="M0-1.2C-1.4-3.4-4-1.6-2.6.4L0 3 2.6.4C4-1.6 1.4-3.4 0-1.2Z"/>';
  const CAT_SVG = '<svg viewBox="0 0 64 64" aria-hidden="true" focusable="false">' +
    '<ellipse class="petShadow" cx="32" cy="59.5" rx="15" ry="2.6" fill="rgba(0,0,0,.3)"/>' +
    '<g class="petBounce">' +
    // --- sitting: tail, body, paws ---
    '<g class="petSit">' +
    // tail: fur, stripes, a cream tip
    '<g class="petTail">' +
    `<path d="M43 54C54 55 59 47 54.5 40 52.3 36 54.6 32.2 57 31.5" fill="none" stroke="${FUR}" stroke-width="5.6" stroke-linecap="round"/>` +
    `<path d="M48.4 53.6l1.2-4.6M53.6 49.6l-3.4-3M56 43.4l-4.6.6M53.4 37.4l-3.6 2.4" fill="none" stroke="${FUR_DARK}" stroke-width="1.5" stroke-linecap="round" opacity=".55"/>` +
    `<path d="M55.9 32.2C56.2 31.9 56.6 31.7 57 31.5" fill="none" stroke="${CREAM}" stroke-width="5.6" stroke-linecap="round"/></g>` +
    // body, flank stripes, chest
    `<g class="petBody"><path d="M19 57.5C15.6 46 20 35.6 32 35 44 35.6 48.4 46 45 57.5Z" fill="${FUR}" stroke="${INK}" stroke-opacity=".28" stroke-width=".8"/>` +
    `<path d="M20.2 46.2l4 1.2M19.6 50.6l3.8.6M43.8 46.2l-4 1.2M44.4 50.6l-3.8.6" fill="none" stroke="${FUR_DARK}" stroke-width="1.5" stroke-linecap="round" opacity=".5"/>` +
    `<path d="M25.6 39.6C27 46.6 26 52.6 27.6 57.5H36.4C38 52.6 37 46.6 38.4 39.6 36 43 28 43 25.6 39.6Z" fill="${CREAM}"/></g>` +
    // front paws with toes
    `<g class="petPaws"><ellipse cx="27" cy="56.6" rx="4.3" ry="3" fill="${CREAM}" stroke="${INK}" stroke-opacity=".28" stroke-width=".7"/>` +
    `<ellipse cx="37" cy="56.6" rx="4.3" ry="3" fill="${CREAM}" stroke="${INK}" stroke-opacity=".28" stroke-width=".7"/>` +
    `<path d="M25.6 57.4v1.5M28.4 57.4v1.5M35.6 57.4v1.5M38.4 57.4v1.5" stroke="${INK}" stroke-opacity=".4" stroke-width=".7" stroke-linecap="round"/></g>` +
    '</g>' +
    // --- lying (at rest, asleep): the tail laid around the front, a loaf of a body, the paws stretched out ---
    '<g class="petLie">' +
    `<g class="petLieTail"><path d="M51 51C60.5 51 62 60 52.5 60 47 60 43 59.4 39.6 58.6" fill="none" stroke="${FUR}" stroke-width="5.2" stroke-linecap="round"/>` +
    `<path d="M57.4 53.4l-3 1.6M57 58.2l-2.6-2M51 60l.4-3.4M46.4 59.6l.8-3.2" fill="none" stroke="${FUR_DARK}" stroke-width="1.4" stroke-linecap="round" opacity=".55"/>` +
    `<path d="M42.4 59.2C41.5 59 40.5 58.8 39.6 58.6" fill="none" stroke="${CREAM}" stroke-width="5.2" stroke-linecap="round"/></g>` +
    `<g class="petLieBody"><path d="M11.4 58C7.6 47 17 38.4 33 38.4 49 38.4 58.2 47 54.4 58Z" fill="${FUR}" stroke="${INK}" stroke-opacity=".28" stroke-width=".8"/>` +
    `<path d="M33.4 39.4l-.4 4.2M39 39.8l.4 4.2M44.4 41.4l1.2 3.8M49 44.2l1.8 3.2" fill="none" stroke="${FUR_DARK}" stroke-width="1.5" stroke-linecap="round" opacity=".55"/>` +
    `<path d="M43.6 58C41.6 51.4 46.4 46.4 52.4 48.2" fill="none" stroke="${FUR_DARK}" stroke-width="1.2" stroke-linecap="round" opacity=".4"/></g>` +
    `<g class="petLiePaws"><ellipse cx="17.4" cy="57.4" rx="4.8" ry="2.7" fill="${CREAM}" stroke="${INK}" stroke-opacity=".28" stroke-width=".7"/>` +
    `<ellipse cx="28" cy="57.7" rx="4.8" ry="2.7" fill="${CREAM}" stroke="${INK}" stroke-opacity=".28" stroke-width=".7"/>` +
    `<path d="M14.4 57.8v1.4M16.8 58.2v1.4M25 58.1v1.4M27.4 58.5v1.4" stroke="${INK}" stroke-opacity=".4" stroke-width=".7" stroke-linecap="round"/></g>` +
    '</g>' +
    // --- the head goes where the pose needs it; the collar (the owner's seat colour, a golden tag with a spade) comes along ---
    '<g class="petHeadAt"><g class="petHead">' +
    '<path class="petCollar" d="M22.4 33.2Q32 38.6 41.6 33.2" fill="none" stroke-width="3.1" stroke-linecap="round"/>' +
    '<g class="petTag"><circle cx="32" cy="38.4" r="2.9" fill="#f4c542" stroke="#a97a12" stroke-width=".6"/>' +
    `<path d="M32 36.5c1.5 1.3 2 1.9 2 2.6 0 .9-1.2 1.2-1.7.5l.4 1h-1.4l.4-1c-.5.7-1.7.4-1.7-.5 0-.7.5-1.3 2-2.6Z" fill="${INK}"/></g>` +
    `<g class="petEar petEarL"><path d="M19.4 17L16.6 3.8 28.4 11.4Z" fill="${FUR}" stroke="${INK}" stroke-opacity=".28" stroke-width=".8" stroke-linejoin="round"/><path d="M20.4 13.6L19 7.6 24.8 11.4Z" fill="${PINK}"/></g>` +
    `<g class="petEar petEarR"><path d="M44.6 17L47.4 3.8 35.6 11.4Z" fill="${FUR}" stroke="${INK}" stroke-opacity=".28" stroke-width=".8" stroke-linejoin="round"/><path d="M43.6 13.6L45 7.6 39.2 11.4Z" fill="${PINK}"/></g>` +
    `<path d="M18 22.6L12.8 24.4 17.2 26.2 13.6 28.8 19.4 28.6ZM46 22.6L51.2 24.4 46.8 26.2 50.4 28.8 44.6 28.6Z" fill="${FUR}" stroke="${INK}" stroke-opacity=".22" stroke-width=".6" stroke-linejoin="round"/>` +
    `<ellipse cx="32" cy="22" rx="15.2" ry="12.6" fill="${FUR}" stroke="${INK}" stroke-opacity=".28" stroke-width=".8"/>` +
    `<path d="M32 10.2v4.6M27.6 11.2l1 4M36.4 11.2l-1 4M18.6 18.4l3.4.8M45.4 18.4l-3.4.8" fill="none" stroke="${FUR_DARK}" stroke-width="1.5" stroke-linecap="round" opacity=".6"/>` +
    `<ellipse cx="32" cy="27.4" rx="7.4" ry="5.2" fill="${CREAM}"/>` +
    `<g class="petEyes">${eye(25.4)}${eye(38.6)}</g>` +
    `<path class="petEyesShut" d="M22.4 22Q25.4 24.3 28.4 22M35.6 22Q38.6 24.3 41.6 22" fill="none" stroke="${INK}" stroke-width="1.3" stroke-linecap="round"/>` +
    `<path class="petEyesHappy" d="M22.4 22.8Q25.4 19.4 28.4 22.8M35.6 22.8Q38.6 19.4 41.6 22.8" fill="none" stroke="${INK}" stroke-width="1.4" stroke-linecap="round"/>` +
    `<path d="M30.5 25.3h3L32 27.2Z" fill="${PINK}" stroke="${INK}" stroke-opacity=".35" stroke-width=".4" stroke-linejoin="round"/>` +
    `<path class="petMouth" d="M32 27.2v1.1M32 28.3Q30.4 30.1 28.9 28.7M32 28.3Q33.6 30.1 35.1 28.7" fill="none" stroke="${INK}" stroke-width=".95" stroke-linecap="round"/>` +
    `<g class="petYawn"><ellipse cx="32" cy="29.6" rx="2.7" ry="3.3" fill="#7a2f3a"/><ellipse cx="32" cy="31.2" rx="1.6" ry="1.1" fill="${PINK}"/>` +
    '<path d="M30.6 27.2l.5 1.2M33.4 27.2l-.5 1.2" stroke="#fff" stroke-width=".7" stroke-linecap="round"/></g>' +
    '<path class="petWhiskers" d="M24.4 27.2L14 25.4M24.2 28.5L13.4 28.9M24.6 29.8L15 32.2M39.6 27.2L50 25.4M39.8 28.5L50.6 28.9M39.4 29.8L49 32.2" fill="none" stroke-width=".7" stroke-linecap="round"/>' +
    '</g></g>' +
    '</g>' +
    // what a mood adds around it
    `${heart(50, 12, 1.5, 'petHeartA')}${heart(13, 9, 1.1, 'petHeartB')}${heart(44, 3, 0.9, 'petHeartC')}` +
    '<g class="petZAt"><g class="petZ" fill="none" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M51 12.5h4.4L51 17.3h4.4"/><path d="M57.6 4.6h3.2l-3.2 3.4h3.2"/></g></g>' +
    '<path class="petSpark petSparkA" d="M12 14l1.1 3 3 1.1-3 1.1-1.1 3-1.1-3-3-1.1 3-1.1Z" fill="#f5d76e"/>' +
    '<path class="petSpark petSparkB" d="M53 16l.9 2.4 2.4.9-2.4.9-.9 2.4-.9-2.4-2.4-.9 2.4-.9Z" fill="#f5d76e"/>' +
    '<path class="petDrop" d="M50.4 10.6c1.3 1.9 2 3 2 4a2 2 0 0 1-4 0c0-1 .7-2.1 2-4Z" fill="#9fd3ff" stroke="#5b9bd1" stroke-width=".5"/>' +
    '</svg>';

  const SVGS = { cat: CAT_SVG };

  /**
   * The pet as markup. `collar`: the owner's seat colour; `born`: when this pet
   * first showed (ms) - a re-drawn pet keeps its rhythm instead of starting over.
   */
  function html(id, { mood = 'idle', collar = '#e8454f', born = 0, now = Date.now(), size = '', extra = '', rose = false } = {}) {
    if (!SVGS[id]) return '';
    const safeMood = MOODS.includes(mood) ? mood : 'idle';
    // `rose`: it was lying a moment ago - the one time it gets up with a little stretch.
    if (rose && poseOf(safeMood) === 'sit') extra = `${extra} petRose`.trim();
    const t = Math.max(0, (now - (born || now)) / 1000).toFixed(2);
    const col = /^#[0-9a-f]{3,8}$/i.test(String(collar)) ? collar : '#e8454f';
    return `<span class="pet pet-${id} pose-${poseOf(safeMood)} mood-${safeMood}${size ? ` pet-${size}` : ''}${extra ? ` ${extra}` : ''}" style="--pet-collar:${col};--pet-t:-${t}s">${SVGS[id]}</span>`;
  }

  /** Queens of Spades a seat has melded as real cards. */
  function queensMelded(st, seatId) {
    let n = 0;
    for (const m of (st && st.tableMelds) || []) {
      if (m.ownerId !== seatId) continue;
      for (const s of m.slots || []) if (s.real && s.real.rank === 'Q' && s.real.suit === 'S') n += 1;
    }
    return n;
  }

  /**
   * What two states in a row mean for the pets: { seatId: { mood, until } }.
   * Read from where cards lie, never from counters (one bot turn is one state).
   */
  function eventsBetween(prev, st, now = Date.now()) {
    const out = {};
    if (!prev || !st || st.phase !== 'playing' || prev.phase !== 'playing' || prev.roundNumber !== st.roundNumber) return out;
    for (const p of st.players || []) {
      if (queensMelded(st, p.id) > queensMelded(prev, p.id)) out[p.id] = { mood: 'happy', until: now + HAPPY_MS };
    }
    return out;
  }

  /**
   * The mood of the pet at `seatId` right now.
   * `fx`: a running reaction ({mood, until}); `turnMs`: how long this seat has been on turn.
   */
  function mood(st, seatId, { fx = null, turnMs = 0, now = Date.now() } = {}) {
    if (!st) return 'idle';
    const seat = (st.players || []).find((p) => p.id === seatId);
    if (!seat) return 'idle';
    if (st.phase === 'roundEnd' || st.phase === 'gameOver') {
      const res = st.lastRoundResult && st.lastRoundResult[seatId];
      const caught = !!(res && res.breakdown && res.breakdown.pikDameCount > 0);
      const over = st.phase === 'gameOver' ? st.gameOverInfo : null;
      const wonGame = !!(over && (over.winnerId === seatId || (over.winnerIds || []).includes(seatId)));
      if (wonGame || (st.phase === 'roundEnd' && st.lastRoundWinnerId === seatId)) return 'cheer';
      return caught ? 'scared' : 'idle';
    }
    // Away from the table: the pet waits it out asleep.
    if (seat.controlledByBot || seat.connected === false) return 'sleep';
    if (st.phase !== 'playing') return 'idle';
    if (fx && fx.until > now && MOODS.includes(fx.mood)) return fx.mood;
    if (st.currentPlayerId !== seatId) return 'idle';
    const into = turnMs % YAWN_EVERY_MS;
    return turnMs >= YAWN_EVERY_MS && into < YAWN_MS ? 'yawn' : 'alert';
  }

  return { PETS, MOODS, HAPPY_MS, YAWN_EVERY_MS, YAWN_MS, isPet, petDef, poseOf, html, mood, eventsBetween, queensMelded, CAT_SVG };
}));

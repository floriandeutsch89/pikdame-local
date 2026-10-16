// Pik Dame docs: two small toys. Nothing here is needed to read the docs.
(function () {
  'use strict';

  // 1. The deck on the game-constants page can be shuffled - with the exact
  //    algorithm the game uses (Fisher-Yates, see game/Deck.js), so the FAQ
  //    answer "is the shuffle fair?" has a button next to it.
  function fisherYates(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }
  function sortedOrder(cards) {
    return cards.slice().sort((a, b) => Number(a.dataset.order) - Number(b.dataset.order));
  }
  function wireDeck(deck) {
    const bar = deck.previousElementSibling;
    if (!bar || !bar.classList.contains('pd-deck-bar')) return;
    const cards = Array.from(deck.children);
    const status = bar.querySelector('[data-pd-status]');
    const run = (order, label) => {
      deck.classList.remove('shuffling');
      void deck.offsetWidth; // restart the animation
      deck.classList.add('shuffling');
      order.forEach((c) => deck.appendChild(c));
      if (status) status.textContent = label;
    };
    bar.querySelector('[data-pd-shuffle]').addEventListener('click', () => {
      const t0 = performance.now();
      const order = fisherYates(cards.slice());
      run(order, `shuffled ${cards.length} cards in ${(performance.now() - t0).toFixed(2)} ms`);
    });
    bar.querySelector('[data-pd-sort]').addEventListener('click', () => run(sortedOrder(cards), 'fresh deck'));
  }
  document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('.pd-deck').forEach(wireDeck);
  });

  // 2. The real engine, in the browser. game/Card.js, Deck.js and Rules.js
  //    are plain CommonJS with no I/O; conf.py copies them into _static and
  //    this 20-line shim evaluates them in load order. Loaded on demand only.
  const ENGINE_FILES = ['Card.js', 'Deck.js', 'Rules.js'];
  let enginePromise = null;
  window.pdEngine = function pdEngine() {
    if (enginePromise) return enginePromise;
    const root = (document.documentElement.dataset.content_root || './') + '_static/';
    const modules = {};
    const require = (name) => {
      const key = name.replace(/^\.\//, '').replace(/\.js$/, '');
      if (!modules[key]) throw new Error(`engine: ${name} is not loaded`);
      return modules[key];
    };
    enginePromise = (async () => {
      for (const file of ENGINE_FILES) {
        const res = await fetch(root + file);
        if (!res.ok) throw new Error(`engine: ${file} ${res.status}`);
        const module = { exports: {} };
        new Function('require', 'module', 'exports', await res.text())(require, module, module.exports);
        modules[file.replace(/\.js$/, '')] = module.exports;
      }
      return { Card: modules.Card, Deck: modules.Deck, Rules: modules.Rules };
    })();
    return enginePromise;
  };

  // A card as the same HTML scripts/gen-docs.js writes, so CSS applies.
  const SUIT_GLYPH = { H: '♥', D: '♦', C: '♣', S: '♠' };
  window.pdCardEl = function pdCardEl(card, Card) {
    const el = document.createElement('span');
    el.className = 'pd-card';
    if (card.isJoker) el.classList.add('joker');
    else if (card.suit === 'H' || card.suit === 'D') el.classList.add('red');
    if (!card.isJoker && card.suit === 'S' && card.rank === 'Q') el.classList.add('queen');
    const rk = document.createElement('span'); rk.className = 'pd-rk'; rk.textContent = card.isJoker ? 'JK' : card.rank;
    const st = document.createElement('span'); st.className = 'pd-st'; st.textContent = card.isJoker ? '★' : SUIT_GLYPH[card.suit];
    el.append(rk, st);
    el.title = `${card.isJoker ? 'Joker' : card.rank + SUIT_GLYPH[card.suit]}, ${Card ? Card.cardValue(card) : ''} points`;
    el.dataset.cardId = card.id;
    return el;
  };

  // 3. Konami code deals a hand. Up up down down left right left right B A.
  const KONAMI = ['ArrowUp', 'ArrowUp', 'ArrowDown', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ArrowLeft', 'ArrowRight', 'b', 'a'];
  let konamiPos = 0;
  document.addEventListener('keydown', (e) => {
    konamiPos = e.key === KONAMI[konamiPos] ? konamiPos + 1 : (e.key === KONAMI[0] ? 1 : 0);
    if (konamiPos < KONAMI.length) return;
    konamiPos = 0;
    window.pdEngine().then(({ Card, Deck }) => {
      const deck = Deck.shuffle(Deck.createDeck());
      const { hands } = Deck.dealCards(deck, ['you', 'Uwe', 'Inge', 'Maria']);
      const hand = hands.you;
      const points = hand.reduce((n, c) => n + Card.cardValue(c), 0);
      const queens = hand.filter((c) => Card.isPikDame(c)).length;
      const overlay = document.createElement('div');
      overlay.className = 'pd-overlay';
      overlay.innerHTML = `<div class="pd-overlay-box"><p><b>Konami.</b> Uwe shuffled (Fisher-Yates, like every round) and dealt you ${hand.length} cards.</p><div class="pd-hand"></div><p>${points} points if you get caught with them${queens ? ` - ${queens === 1 ? 'one of them is the Queen of Spades' : 'two Queens of Spades, ouch'}` : ''}. Press Escape or click to fold.</p></div>`;
      hand.forEach((c) => overlay.querySelector('.pd-hand').appendChild(window.pdCardEl(c, Card)));
      const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey); };
      const onKey = (ev) => { if (ev.key === 'Escape') close(); };
      overlay.addEventListener('click', close);
      document.addEventListener('keydown', onKey);
      document.body.appendChild(overlay);
    }).catch((err) => console.warn('Konami hand failed:', err));
  });

  // 4. For people who open the console.
  const banner = [
    '  ♠  Pik Dame docs',
    '  Built from Markdown by Sphinx; the tables that must match the code',
    '  (env vars, protocol, constants, progression) are generated by',
    '  scripts/gen-docs.js and checked in CI. Source: github.com/floriandeutsch89/pikdame-local',
    '  pdEngine() loads the real rules (game/Rules.js) into this page. Try: (await pdEngine()).Rules',
  ].join('\n');
  try {
    console.log('%c' + banner, 'color:#2fd6b0;font-family:Georgia,serif;font-size:12px');
  } catch (e) { /* no console, no problem */ }
})();

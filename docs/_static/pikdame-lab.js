// Rules lab on the game-constants page: pick cards, the real Rules.js judges.
// Nothing here knows a rule; it only renders what the engine returns.
(function () {
  'use strict';
  const PLAYERS = ['you', 'Uwe', 'Inge', 'Maria'];

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }

  function build(root, { Card, Deck, Rules }) {
    root.textContent = '';
    const selection = []; // card objects currently under test
    const copies = {}; // card id prefix -> how many are selected (two decks, six jokers)

    const intro = el('p', 'pd-lab-intro',
      'Click cards to build a combination. The verdict comes from the same validateMeld() the server runs; nothing is re-implemented here.');
    const picker = el('div', 'pd-lab-picker');
    const handWrap = el('div', 'pd-lab-hand');
    const hand = el('div', 'pd-hand');
    const verdict = el('p', 'pd-lab-verdict');
    const bar = el('div', 'pd-deck-bar');
    const dealBtn = el('button', '', 'Deal me 15');
    dealBtn.type = 'button';
    const seedLabel = el('label', 'pd-lab-seed');
    seedLabel.append('seed ');
    const seed = el('input');
    seed.type = 'number'; seed.placeholder = 'random'; seed.min = '0';
    seedLabel.appendChild(seed);
    const clearBtn = el('button', '', 'Clear');
    clearBtn.type = 'button';
    const dealInfo = el('span', '');
    bar.append(dealBtn, seedLabel, clearBtn, dealInfo);
    root.append(intro, picker, bar, handWrap, verdict);
    handWrap.appendChild(hand);

    // One face per distinct card plus the joker. The second deck copy is
    // reachable by clicking twice; a third click is refused like a third
    // physical card would be.
    const limitFor = (card) => (card.isJoker ? 6 : 2);
    const keyFor = (card) => (card.isJoker ? 'JOKER' : `${card.suit}${card.rank}`);
    const pickable = [];
    for (const suit of Card.SUITS) for (const rank of Card.RANKS) pickable.push(Card.makeStandardCard(suit, rank, 0));
    pickable.push(Card.makeJoker(0));
    for (const proto of pickable) {
      const face = window.pdCardEl(proto, Card);
      face.setAttribute('role', 'button');
      face.tabIndex = 0;
      const add = () => {
        const k = keyFor(proto);
        const n = copies[k] || 0;
        if (n >= limitFor(proto)) { flash(verdict, `Only ${limitFor(proto)} of those exist in the deck.`); return; }
        copies[k] = n + 1;
        selection.push(proto.isJoker ? Card.makeJoker(n) : Card.makeStandardCard(proto.suit, proto.rank, n));
        render();
      };
      face.addEventListener('click', add);
      face.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); add(); } });
      picker.appendChild(face);
    }

    function flash(node, text) {
      node.textContent = text;
      node.className = 'pd-lab-verdict warn';
    }

    function render() {
      hand.textContent = '';
      selection.forEach((card, i) => {
        const face = window.pdCardEl(card, Card);
        face.title += ' - click to remove';
        face.addEventListener('click', () => {
          selection.splice(i, 1);
          copies[keyFor(card)] -= 1;
          render();
        });
        hand.appendChild(face);
      });
      judge();
    }

    function judge() {
      if (selection.length === 0) {
        verdict.textContent = 'No cards selected.';
        verdict.className = 'pd-lab-verdict';
        return;
      }
      const points = selection.reduce((n, c) => n + Card.cardValue(c), 0);
      const v = Rules.validateMeld(selection);
      if (!v.valid) {
        verdict.innerHTML = '';
        verdict.append('✗ Not a meld. The engine says: ');
        verdict.appendChild(el('q', '', v.reason));
        verdict.append(' (the server’s own message, hence German).');
        verdict.className = 'pd-lab-verdict bad';
        return;
      }
      const options = Rules.enumerateMeldOptions(selection);
      verdict.innerHTML = '';
      verdict.append(`✓ Valid ${v.type === 'set' ? 'set' : 'run'}: ${selection.length} cards, ${points} points on the table.`);
      if (options.length > 1) {
        verdict.append(` A joker makes it ambiguous - the engine sees ${options.length} readings and would ask you: `);
        verdict.appendChild(el('span', 'pd-lab-options', options.map((o) => o.label).join(' · ')));
      }
      verdict.className = 'pd-lab-verdict good';
    }

    dealBtn.addEventListener('click', () => {
      const s = seed.value === '' ? undefined : Number(seed.value);
      const deck = Deck.shuffle(Deck.createDeck(), s);
      const { hands, drawPile, discardPile } = Deck.dealCards(deck, PLAYERS);
      selection.length = 0;
      for (const k of Object.keys(copies)) delete copies[k];
      for (const card of hands.you) { selection.push(card); copies[keyFor(card)] = (copies[keyFor(card)] || 0) + 1; }
      const top = discardPile[0];
      dealInfo.textContent = `${PLAYERS.length} players, ${drawPile.length} cards left to draw, first discard ${top.isJoker ? 'Joker' : top.rank + {H:'♥',D:'♦',C:'♣',S:'♠'}[top.suit]}${s !== undefined ? ` - seed ${s} deals this exact hand every time, that is how the daily challenge works` : ''}.`;
      render();
      if (selection.length) {
        const caught = selection.reduce((n, c) => n + Card.cardValue(c), 0);
        verdict.textContent = `Your hand: ${selection.length} cards, ${caught} points if you get caught with them. Click cards to remove them until a meld remains.`;
        verdict.className = 'pd-lab-verdict';
      }
    });
    clearBtn.addEventListener('click', () => {
      selection.length = 0;
      for (const k of Object.keys(copies)) delete copies[k];
      dealInfo.textContent = '';
      render();
    });
    render();
  }

  document.addEventListener('DOMContentLoaded', () => {
    const root = document.getElementById('pd-lab');
    if (!root) return;
    root.textContent = 'Loading the engine (Card.js, Deck.js, Rules.js) …';
    window.pdEngine().then((engine) => build(root, engine)).catch((err) => {
      root.textContent = `The engine could not be loaded in this page: ${err.message}`;
    });
  });
})();

// public/boss-fight.js
// The Kartenhaus boss floors at the table: the boss panel, both life bars, the
// entrance and the hit effects. Reads state.bossFight (game/BossFight.js publicView),
// never decides a rule. Loaded before client.js; the tests require() it.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PikdameBoss = api;
}(typeof self !== 'undefined' ? self : this, () => {
  'use strict';

  const MINUS = '−';
  const TIMES = '×';
  const NBSP = ' ';
  // The effect of one hit ends within this; only the number lingers.
  const FX_MS = 400;
  const INTRO_MS = 1750; // + the fade: under two seconds before the first card

  const BOSSES = {
    jack: { rank: ['B', 'J'], suit: 'diamond', name: ['Karo-Bube', 'Jack of Diamonds'] },
    king: { rank: ['K', 'K'], suit: 'club', name: ['Kreuz-König', 'King of Clubs'] },
    queen: { rank: ['D', 'Q'], suit: 'spade', name: ['Pik Dame', 'Queen of Spades'] },
  };
  const CATS = [['Katze Mimi', 'Mimi'], ['Kater Mo', 'Mo']]; // short: each has half a phone's width

  const known = (view) => !!(view && BOSSES[view.id]);
  const nameOf = (id, L) => (BOSSES[id] ? L(...BOSSES[id].name) : '');
  const catName = (i, L) => L(...(CATS[i] || CATS[0]));
  /** 1.5 reads "1,5" in German. */
  const num = (v, L) => L(String(v).replace('.', ','), String(v));
  const pct = (factor) => Math.round((factor - 1) * 100);

  // --- Portraits: gold line on dark, one bust per boss (64 x 86) ------------
  const SUITS = {
    diamond: '<path d="M0-7 5 0 0 7-5 0z"/>',
    club: '<circle cx="0" cy="-3.6" r="3.1"/><circle cx="-3.5" cy="1.3" r="3.1"/><circle cx="3.5" cy="1.3" r="3.1"/><path d="M-1.1 1.5h2.2L2.4 7h-4.8z"/>',
    spade: '<path d="M0-7c3.4 3.6 6.4 5.6 6.4 8.6A3.3 3.3 0 0 1 .9 3.9L2.3 7h-4.6l1.4-3.1a3.3 3.3 0 0 1-5.5-2.3C-6.4-1.4-3.4-3.4 0-7z"/>',
  };
  const HEADS = {
    // A page's cap with a feather; a narrow, sly face.
    jack: '<path class="bpGold" d="M19 25c1-8 6-12 14-12 7 0 12 4 13 11l-4 2H22z"/>' +
      '<path class="bpLine" d="M43 15c3-6 8-8 12-7-1 5-5 8-11 10"/><path class="bpLine" d="M46 13l5-2"/>' +
      '<path class="bpFace" d="M23 26h19v9c0 7-4 12-9.5 12S23 42 23 35z"/>' +
      '<path class="bpEye" d="M26 32l6 1.6-6 1.8zM39 32l-6 1.6 6 1.8z"/>' +
      '<path class="bpLine" d="M29 41c2 1.4 5 1.4 7-.6"/>',
    // A heavy crown and a square beard.
    king: '<path class="bpGold" d="M18 26l-2-15 8 7 8-10 8 10 8-7-2 15z"/><path class="bpDark" d="M21 22h22v2H21z"/>' +
      '<circle class="bpEye" cx="32" cy="11" r="1.6"/>' +
      '<path class="bpFace" d="M21 27h22v8c0 8-5 14-11 14s-11-6-11-14z"/>' +
      '<path class="bpGold" d="M22 37c3 1 6 1.5 10 1.5s7-.5 10-1.5v3c0 6-4 11-10 11s-10-5-10-11z"/>' +
      '<path class="bpEye" d="M25 31h6l-1 2.4h-4zM39 31h-6l1 2.4h4z"/>' +
      '<path class="bpDark" d="M28 42h8v1.5h-8z"/>',
    // A tiara, long hair, a narrow chin.
    queen: '<path class="bpGold" d="M20 24l1-9 5 5 6-9 6 9 5-5 1 9z"/><circle class="bpEye" cx="32" cy="12.5" r="1.5"/>' +
      '<path class="bpHair" d="M18 26c0-2 2-3 4-3h20c2 0 4 1 4 3v22c0 3-2 5-4 6V30H22v24c-2-1-4-3-4-6z"/>' +
      '<path class="bpFace" d="M23 26h18v9c0 6-3.5 13-9 13s-9-7-9-13z"/>' +
      '<path class="bpEye" d="M26 32c2-1.6 4-1.6 5.5 0-1.5 1.3-3.5 1.3-5.5 0zM38 32c-2-1.6-4-1.6-5.5 0 1.5 1.3 3.5 1.3 5.5 0z"/>' +
      '<path class="bpLine" d="M30 41.5c1.3.8 2.7.8 4 0"/>',
  };
  /** The bust: head, shoulders, the suit on the chest. */
  function portraitSvg(id) {
    const b = BOSSES[id];
    if (!b) return '';
    return '<svg viewBox="0 0 64 86" aria-hidden="true" focusable="false">' + HEADS[id] +
      '<path class="bpRobe" d="M10 86c1-19 9-29 22-29s21 10 22 29z"/>' +
      '<path class="bpLine" d="M25 58l7 9 7-9"/>' +
      `<g class="bpSuit" transform="translate(32 76)">${SUITS[b.suit]}</g></svg>`;
  }
  const CAT_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
    '<path class="bpGold" d="M5 9V3l4 3h6l4-3v6c1 2 1 5-1 7s-4 3-6 3-4-1-6-3-2-5-1-7z"/>' +
    '<path class="bpCatEye" d="M9 12h.01M15 12h.01"/><path class="bpCatNose" d="M11 15l1 1 1-1"/></svg>';

  // --- Rules as words -----------------------------------------------------
  /** The chips of the panel: what each number means, in the order they matter. */
  function traits(view, L) {
    if (!known(view)) return [];
    const t = view.traits || {};
    const out = [];
    const guards = (view.adds || []).filter((a) => a.hp > 0).length;
    if (view.enraged) {
      out.push({
        key: 'rage', icon: 'flame', cls: 'rage',
        label: L(`Wütend +${pct(t.enrage)}${NBSP}%`, `Enraged +${pct(t.enrage)}%`),
        title: L('Wütend', 'Enraged'),
        text: L(`Der Boss ging mit weniger als der Hälfte seines Lebens in diese Runde. Seine Treffer zählen ${pct(t.enrage)}${NBSP}% mehr.`,
          `The boss entered this round below half of its life. Its hits count ${pct(t.enrage)}% more.`),
      });
    }
    if (t.ambush) {
      out.push({
        key: 'ambush', icon: 'bolt', cls: view.ambushReady ? 'armed' : 'spent',
        label: L(`Hinterhalt ${TIMES}${num(t.ambush, L)}`, `Ambush ${TIMES}${num(t.ambush, L)}`),
        title: L('Hinterhalt', 'Ambush'),
        text: L(`Sein erster Treffer in jeder Runde zählt ${TIMES}${num(t.ambush, L)}. `, `Its first hit of every round counts ${TIMES}${num(t.ambush, L)}. `) +
          (view.ambushReady ? L('In dieser Runde steht er noch aus.', 'This round it is still to come.')
            : L('In dieser Runde ist er schon gefallen.', 'This round it has already landed.')),
      });
    }
    if (t.armor) {
      out.push({
        key: 'armor', icon: 'shield',
        label: L(`Rüstung ${MINUS}${t.armor}`, `Armour ${MINUS}${t.armor}`),
        title: L('Rüstung', 'Armour'),
        text: L(`Jeder deiner Treffer verliert ${t.armor}. Kleine Züge prallen ab: Sammle und leg mehr auf einmal aus.`,
          `Each of your hits loses ${t.armor}. Small turns bounce off: collect and meld more at once.`),
      });
    }
    if (t.scratch && (view.adds || []).length) {
      out.push({
        key: 'scratch', icon: 'cat', cls: guards ? '' : 'spent',
        label: L(`Katzen: Kratzer ${MINUS}${t.scratch}`, `Cats: scratch ${MINUS}${t.scratch}`),
        title: L('Ihre Katzen', 'Her cats'),
        text: L(`Deine Treffer gehen zuerst auf die Katzen; was übrig bleibt, trifft die nächste und dann die Dame. Jede Katze, die noch steht, kratzt dich am Ende deines Zugs für ${t.scratch} Leben.`,
          `Your hits go to the cats first; what is left carries on to the next one and then to the queen. Every cat still standing scratches you for ${t.scratch} life at the end of your turn.`),
      });
    }
    if (t.curse) {
      out.push({
        key: 'curse', icon: 'spade', cls: 'curse',
        label: L(`Fluch ${MINUS}${t.curse}`, `Curse ${MINUS}${t.curse}`),
        title: L('Fluch', 'Curse'),
        text: L(`Endet dein Zug mit einer Pik Dame auf der Hand, kostet dich das ${t.curse} Leben.`,
          `Ending your turn with a Queen of Spades in hand costs you ${t.curse} life.`),
      });
    }
    if (t.crit) {
      out.push({
        key: 'crit', icon: 'sparkle',
        label: L(`Ausgelegt ${TIMES}${t.crit}`, `Melded ${TIMES}${t.crit}`),
        title: L('Die Dame ausgelegt', 'The queen melded'),
        text: L(`Legst du eine Pik Dame aus, trifft sie ${TIMES}${t.crit}: ${100 * t.crit} statt 100.`,
          `A Queen of Spades you meld hits ${TIMES}${t.crit}: ${100 * t.crit} instead of 100.`),
      });
    }
    if (t.combo) {
      out.push({
        key: 'combo', icon: 'swords', cls: 'mine',
        label: L(`Kombo ${TIMES}${num(t.combo[0], L)}${NBSP}/${NBSP}${TIMES}${num(t.combo[1], L)}`, `Combo ${TIMES}${num(t.combo[0], L)}${NBSP}/${NBSP}${TIMES}${num(t.combo[1], L)}`),
        title: L('Kombo', 'Combo'),
        text: L(`Zwei neue Auslagen im selben Zug treffen ${TIMES}${num(t.combo[0], L)}, drei oder mehr ${TIMES}${num(t.combo[1], L)}. Anlegen zählt einfach. Das gilt auch für den Boss.`,
          `Two new melds in one turn hit ${TIMES}${num(t.combo[0], L)}, three or more ${TIMES}${num(t.combo[1], L)}. Laying off counts once. The boss combos too.`),
      });
    }
    return out;
  }
  /** The life bar's own explanation (a tap on it). */
  function lifeRule(view, L) {
    return {
      key: 'life',
      title: L('Leben statt Punkte', 'Life instead of points'),
      text: L('Was du auslegst oder anlegst, zieht dem Boss den Kartenwert ab; was er legt, trifft dich. Karten, die am Rundenende auf der Hand bleiben, treffen ihren Besitzer. ' +
        `Fällt ein Leben auf 0, ist der Kampf sofort vorbei. Die Marke zeigt die Hälfte: Beginnt eine Runde darunter, wird der Boss wütend (+${pct(view.traits.enrage)}${NBSP}%).`,
      'What you meld or lay off takes its card value off the boss; what it melds hits you. Cards left in hand at the end of a round hit their holder. ' +
        `A life at 0 ends the fight at once. The mark shows the half: a round that starts below it enrages the boss (+${pct(view.traits.enrage)}%).`),
    };
  }
  /** One sentence for the entrance. */
  function introLine(view, L) {
    const t = view.traits || {};
    if (t.ambush) return L(`Sein erster Treffer jeder Runde zählt ${TIMES}${num(t.ambush, L)}.`, `Its first hit of every round counts ${TIMES}${num(t.ambush, L)}.`);
    if (t.armor) return L(`Seine Rüstung nimmt jedem deiner Treffer ${t.armor}.`, `Its armour takes ${t.armor} off each of your hits.`);
    if (t.curse) return L('Erst ihre Katzen, dann sie. Ihre Karte auf deiner Hand kostet Leben.', 'Her cats first, then her. Her card in your hand costs life.');
    return '';
  }

  // --- Hits: the last turn's events as effects ------------------------------
  /** The effects of the events after `sinceSeq`: my strike as one, then what struck me. */
  function effectsOf(view, sinceSeq, L) {
    if (!known(view)) return [];
    const fresh = (view.events || []).filter((e) => e && e.seq > sinceSeq);
    const out = [];
    const mine = fresh.filter((e) => (e.to === 'boss' || e.to === 'add') && e.kind === 'hit');
    if (mine.length) {
      const first = mine[0];
      const why = [];
      if (first.combo > 1) why.push(L(`KOMBO ${TIMES}${num(first.combo, L)}`, `COMBO ${TIMES}${num(first.combo, L)}`));
      if (first.crit) why.push(L(`PIK DAME ${TIMES}${first.crit}`, `QUEEN ${TIMES}${first.crit}`));
      if (first.armor && !why.length) why.push(L(`RÜSTUNG ${MINUS}${first.armor}`, `ARMOUR ${MINUS}${first.armor}`));
      out.push({
        fx: 'strike', amount: mine.reduce((s, e) => s + e.amount, 0), combo: first.combo > 1, label: why.join(' · '),
        adds: mine.filter((e) => e.to === 'add').map((e) => ({ add: e.add, amount: e.amount })),
        boss: mine.filter((e) => e.to === 'boss').reduce((s, e) => s + e.amount, 0),
      });
    }
    for (const e of fresh) {
      if (e.to !== 'me') continue;
      if (e.kind === 'hit') {
        const why = [];
        if (e.ambush) why.push(L(`HINTERHALT ${TIMES}${num(e.ambush, L)}`, `AMBUSH ${TIMES}${num(e.ambush, L)}`));
        if (e.combo > 1) why.push(L(`KOMBO ${TIMES}${num(e.combo, L)}`, `COMBO ${TIMES}${num(e.combo, L)}`));
        if (e.rage && why.length < 2) why.push(L('WÜTEND', 'ENRAGED'));
        out.push({ fx: 'slash', amount: e.amount, heavy: !!(e.rage || e.ambush), label: why.join(' · ') });
      } else if (e.kind === 'scratch') {
        out.push({ fx: 'claws', amount: e.amount, label: L('KRATZER', 'SCRATCH') });
      } else if (e.kind === 'curse') {
        out.push({ fx: 'curse', amount: e.amount, label: L('FLUCH', 'CURSE') });
      }
    }
    return out;
  }
  /** What the round's end took from each side (the result sheet's line). */
  function handDamage(view) {
    const ev = (view && view.events) || [];
    const sum = (to) => ev.filter((e) => e.kind === 'hand' && (to === 'me' ? e.to === 'me' : e.to !== 'me')).reduce((s, e) => s + e.amount, 0);
    return { me: sum('me'), boss: sum('boss') };
  }

  // --- Markup ---------------------------------------------------------------
  const share = (hp, max) => (max > 0 ? Math.max(0, Math.min(100, (100 * hp) / max)) : 0);
  /** A life bar: the fill, the part just lost (it follows late), the half mark. */
  function barHtml(cls, mark) {
    return `<span class="hpBar ${cls}"><i class="hpLost"></i><i class="hpFill"></i>${mark ? '<i class="hpMark"></i>' : ''}<b class="hpNum"></b></span>`;
  }
  function setBar(bar, hp, max) {
    if (!bar) return;
    const w = `${share(hp, max)}%`;
    bar.querySelector('.hpFill').style.width = w;
    bar.querySelector('.hpLost').style.width = w;
    const n = bar.querySelector('.hpNum');
    if (n) n.textContent = `${hp}${NBSP}/${NBSP}${max}`;
  }
  const iconHtml = (name) => `<svg class="icon" aria-hidden="true"><use href="#i-${name}"/></svg>`;

  /**
   * The table part. ctx: { L, esc, motion() -> may animate, fx() -> effects wanted, vibrate(ms) }.
   * The panel stays in the DOM between renders, so the bars can move and a popover stays open.
   */
  function createTable(ctx) {
    const { L, esc } = ctx;
    let seenSeq = -1; // -1: the next state is only a baseline (a resume replays nothing)
    let seenKey = '';
    let openTrait = '';
    let fxTimers = [];
    let outsideBound = false;

    const popOf = (panel) => panel.querySelector('.traitPop');
    function closePop(panel) {
      openTrait = '';
      if (!panel) return;
      const pop = popOf(panel);
      if (pop) pop.hidden = true;
      panel.querySelectorAll('[data-trait]').forEach((b) => b.setAttribute('aria-expanded', 'false'));
    }
    function openPop(panel, btn, rule) {
      const pop = popOf(panel);
      openTrait = rule.key;
      panel.querySelectorAll('[data-trait]').forEach((b) => b.setAttribute('aria-expanded', String(b === btn)));
      pop.innerHTML = `<h4>${esc(rule.title)}</h4><p>${esc(rule.text)}</p>`;
      pop.hidden = false;
      // The tip points at what was tapped.
      const p = panel.getBoundingClientRect();
      const b = btn.getBoundingClientRect();
      pop.style.setProperty('--tip-x', `${Math.max(18, Math.min(p.width - 18, b.left + b.width / 2 - p.left))}px`);
    }
    function ruleFor(view, key) {
      return key === 'life' ? lifeRule(view, L) : traits(view, L).find((t) => t.key === key) || null;
    }
    function bindOutside() {
      if (outsideBound || typeof document === 'undefined') return;
      outsideBound = true;
      document.addEventListener('pointerdown', (ev) => {
        if (!openTrait) return;
        const panel = document.querySelector('.bossPanel');
        if (panel && !ev.target.closest('.traitPop, [data-trait]')) closePop(panel);
      });
      document.addEventListener('keydown', (ev) => {
        if (ev.key === 'Escape' && openTrait) closePop(document.querySelector('.bossPanel'));
      });
    }

    function build(host, view, info) {
      const b = BOSSES[view.id];
      const adds = (view.adds || []).map((a, i) =>
        `<div class="bossAdd" data-add="${i}"><span class="baIcon">${CAT_SVG}</span><span class="baBody">` +
        `<span class="baHead"><em>${esc(catName(i, L))}</em><b class="baNum"></b></span>${barHtml('hpAdd', false)}</span></div>`).join('');
      host.innerHTML =
        `<div class="bossPanel" data-boss="${view.id}" data-player-id="${esc(info.playerId || '')}">` +
        `<span class="bossPortrait">${portraitSvg(view.id)}<span class="bpRank" aria-hidden="true">${esc(L(...b.rank))}</span></span>` +
        '<div class="bossBody">' +
        `<div class="bossName"><span class="bnName">${esc(nameOf(view.id, L))}</span><small>${esc(L(`Boss · Etage ${info.stage}`, `Boss · floor ${info.stage}`))}</small></div>` +
        '<div class="bossTraits"></div>' +
        `<button type="button" class="bossLife" data-trait="life" aria-expanded="false">${barHtml('hpBoss', true)}<svg class="icon bossLock" aria-hidden="true"><use href="#i-lock"/></svg></button>` +
        '<div class="bossMeta"><span class="bmRound"></span><span class="bmCards"></span></div>' +
        '</div>' +
        (adds ? `<div class="bossAdds">${adds}</div>` : '') +
        '<div class="traitPop" role="status" hidden></div></div>';
      const panel = host.firstElementChild;
      panel.addEventListener('click', (ev) => {
        const btn = ev.target.closest('[data-trait]');
        if (!btn) return;
        const key = btn.dataset.trait;
        if (openTrait === key) { closePop(panel); return; }
        const rule = panel._view && ruleFor(panel._view, key);
        if (rule) openPop(panel, btn, rule);
      });
      bindOutside();
      return panel;
    }

    /** Draws the panel into `host` (the opponents' row). info: { stage, playerId, handCount, active, lang }. */
    function renderPanel(host, view, info) {
      const key = `${view.id}|${info.lang}|${info.stage}|${(view.adds || []).length}`;
      let panel = host.querySelector(':scope > .bossPanel');
      if (!panel || panel.dataset.key !== key) {
        panel = build(host, view, info);
        panel.dataset.key = key;
        openTrait = '';
      }
      panel._view = view;
      const guards = (view.adds || []).some((a) => a.hp > 0);
      panel.classList.toggle('rage', !!view.enraged && !view.over);
      panel.classList.toggle('active', !!info.active);
      panel.classList.toggle('guarded', guards);
      panel.classList.toggle('down', view.hp <= 0);
      const list = traits(view, L);
      const sig = list.map((t) => `${t.key}:${t.cls || ''}:${t.label}`).join('|');
      const box = panel.querySelector('.bossTraits');
      if (box.dataset.sig !== sig) {
        box.dataset.sig = sig;
        box.innerHTML = list.map((t) =>
          `<button type="button" class="bossTrait${t.cls ? ` ${t.cls}` : ''}" data-trait="${t.key}" aria-label="${esc(t.label)}" aria-expanded="${openTrait === t.key}">` +
          `${iconHtml(t.icon)}<span>${esc(t.label)}</span></button>`).join('');
        if (openTrait && openTrait !== 'life') {
          const rule = ruleFor(view, openTrait);
          const btn = box.querySelector(`[data-trait="${openTrait}"]`);
          if (rule && btn) openPop(panel, btn, rule); else closePop(panel);
        }
      }
      const life = panel.querySelector('.bossLife');
      setBar(life.querySelector('.hpBar'), view.hp, view.maxHp);
      life.setAttribute('aria-label', guards
        ? L(`Leben des Bosses: ${view.hp} von ${view.maxHp}, geschützt von seinen Katzen. Erklärung`, `Boss life: ${view.hp} of ${view.maxHp}, guarded by her cats. Explain`)
        : L(`Leben des Bosses: ${view.hp} von ${view.maxHp}. Erklärung`, `Boss life: ${view.hp} of ${view.maxHp}. Explain`));
      panel.querySelector('.bmRound').textContent = L(`Runde ${view.round} von höchstens ${view.maxRounds}`, `Round ${view.round} of at most ${view.maxRounds}`);
      const n = Number(info.handCount) || 0;
      panel.querySelector('.bmCards').innerHTML = `${iconHtml('cards')}<span>${esc(n === 1 ? L('1 Karte', '1 card') : L(`${n} Karten`, `${n} cards`))}</span>`;
      (view.adds || []).forEach((a, i) => {
        const node = panel.querySelector(`.bossAdd[data-add="${i}"]`);
        if (!node) return;
        node.classList.toggle('down', a.hp <= 0);
        node.querySelector('.baNum').textContent = a.hp > 0 ? `${a.hp}${NBSP}/${NBSP}${a.maxHp}` : '';
        node.setAttribute('aria-label', a.hp > 0 ? `${catName(i, L)}: ${a.hp}${NBSP}/${NBSP}${a.maxHp}` : L(`${catName(i, L)}: besiegt`, `${catName(i, L)}: defeated`));
        setBar(node.querySelector('.hpBar'), a.hp, a.maxHp);
      });
      return panel;
    }

    /** My life where the score sits (`slot` = #myScore). */
    function renderMyLife(slot, view) {
      if (!slot.querySelector('.hpMe')) slot.innerHTML = `${iconHtml('heart')}${barHtml('hpMe', false)}`;
      setBar(slot.querySelector('.hpBar'), view.me, view.myMaxHp);
      slot.title = L(`Dein Leben: ${view.me} von ${view.myMaxHp}`, `Your life: ${view.me} of ${view.myMaxHp}`);
    }

    // --- Effects --------------------------------------------------------------
    const layer = () => {
      let n = document.getElementById('bossFx');
      if (!n) { n = document.createElement('div'); n.id = 'bossFx'; n.setAttribute('aria-hidden', 'true'); document.body.appendChild(n); }
      return n;
    };
    function add(html, ms) {
      const t = document.createElement('div');
      t.innerHTML = html;
      const n = t.firstElementChild;
      layer().appendChild(n);
      setTimeout(() => n.remove(), ms);
      return n;
    }
    function flash(node, cls, ms) {
      if (!node) return;
      node.classList.remove(cls);
      void node.offsetWidth; // restart
      node.classList.add(cls);
      setTimeout(() => node.classList.remove(cls), ms);
    }
    /** One tapered blade from a to b: glow, pale edge, white core. */
    function blade(x1, y1, x2, y2, w, delay = 0) {
      const mx = (x1 + x2) / 2;
      const my = (y1 + y2) / 2;
      const dx = x2 - x1;
      const dy = y2 - y1;
      const len = Math.hypot(dx, dy) || 1;
      const nx = (-dy / len) * w;
      const ny = (dx / len) * w;
      const leaf = (k, inset) => {
        const ax = x1 + dx * inset;
        const ay = y1 + dy * inset;
        const bx = x2 - dx * inset;
        const by = y2 - dy * inset;
        return `M${ax} ${ay}Q${mx + nx * k} ${my + ny * k} ${bx} ${by}Q${mx - nx * k} ${my - ny * k} ${ax} ${ay}Z`;
      };
      return `<g class="fxBlade" style="transform-origin:${x1}px ${y1}px;animation-delay:${delay}ms">` +
        `<path class="fxGlow" d="M${x1} ${y1}L${x2} ${y2}" stroke-width="${w * 2.4}"/>` +
        `<path class="fxEdge" d="${leaf(1, 0)}"/><path class="fxCore" d="${leaf(0.35, 0.08)}"/></g>`;
    }
    const slashSvg = (inner, cls = '') =>
      add(`<svg class="fxSlash ${cls}" viewBox="0 0 ${window.innerWidth} ${window.innerHeight}" focusable="false">${inner}</svg>`, FX_MS + 120);
    function floatNum(rect, amount, label, cls) {
      const n = add(`<div class="fxNum ${cls}">${MINUS}${amount}${label ? `<small>${esc(label)}</small>` : ''}</div>`, 1100);
      n.style.left = `${rect.left + rect.width / 2}px`;
      n.style.top = `${rect.top}px`;
    }

    function playOne(fx, panel, slot, still, nth) {
      const lifeBar = slot && slot.querySelector('.hpBar');
      const hr = (lifeBar || slot || document.body).getBoundingClientRect();
      if (fx.fx === 'strike') {
        const portrait = panel && panel.querySelector('.bossPortrait');
        const target = fx.boss > 0 || !fx.adds.length ? portrait : panel.querySelector(`.bossAdd[data-add="${fx.adds[fx.adds.length - 1].add}"] .baIcon`);
        if (!target) return;
        const p = target.getBoundingClientRect();
        const big = target === portrait;
        if (!still) {
          const pad = big ? 22 : 10;
          slashSvg(blade(p.right + pad, p.top - pad / 2, p.left - pad, p.bottom + pad / 2, big ? 8 : 4.5) +
            (fx.combo ? blade(p.right + pad + 30, p.top + 6, p.left + 8, p.bottom + pad + 6, big ? 6 : 3.5, 70) : ''));
          flash(panel, 'struck', 220);
        }
        fx.adds.forEach((a) => flash(panel.querySelector(`.bossAdd[data-add="${a.add}"]`), 'hit', FX_MS));
        if (fx.boss > 0) flash(panel.querySelector('.bossLife'), 'hit', FX_MS);
        // At the panel's right edge, clear of the portrait and the bar.
        const pr = panel.getBoundingClientRect();
        floatNum({ left: pr.right - 16, top: pr.top + 8, width: 0 }, fx.amount, fx.label, 'toBoss');
        return;
      }
      const curse = fx.fx === 'curse';
      flash(slot, curse ? 'hitCurse' : 'hit', FX_MS);
      if (!still) {
        add(`<div class="fxVignette${curse ? ' curse' : ''}"></div>`, FX_MS + 60);
        const hand = document.getElementById('hand');
        const h = (hand || document.body).getBoundingClientRect();
        if (fx.fx === 'slash') {
          slashSvg(blade(h.left + h.width * 0.86, hr.top - 34, h.left + h.width * 0.2, h.top + h.height * 0.72, fx.heavy ? 13 : 9));
        } else if (fx.fx === 'claws') {
          const x = h.left + h.width * 0.8;
          const y = hr.top - 16;
          slashSvg([-26, 0, 26].map((o, i) => blade(x + o, y + i * 3, x + o - 130, y + 132 + i * 3, 4.5, i * 30)).join(''));
        } else if (curse) {
          const q = hand && hand.querySelector('.card.pikdame-card');
          if (q) {
            flash(q, 'fxCursed', FX_MS + 200);
            const r = q.getBoundingClientRect();
            [[0, 0, 0], [-18, -40, 60], [14, -74, 120]].forEach(([dx, dy, delay]) => {
              const w = add(`<div class="fxWisp" style="animation-delay:${delay}ms"></div>`, FX_MS + 400);
              w.style.left = `${r.left + r.width / 2 - 34 + dx}px`;
              w.style.top = `${r.top - 96 + dy}px`;
            });
          }
        }
        if (ctx.vibrate && fx.fx === 'slash') ctx.vibrate(fx.heavy ? 60 : 30);
      }
      // Two in a row (scratch, then curse) stand side by side, never on top of each other.
      const at = nth < 0 ? { left: hr.left, width: hr.width } : { left: hr.left + hr.width * (nth % 2 ? 0.55 : -0.15), width: hr.width * 0.6 };
      floatNum({ ...at, top: hr.top - 52 }, fx.amount, fx.label, curse ? 'curse' : 'toMe');
    }

    /**
     * Plays what happened since the last state, once. `delay`: the boss's cards are still
     * flying (table-moves) - its hit lands with them, not before.
     */
    function playEffects(view, panel, slot, { key = '', delay = 0 } = {}) {
      const last = (view.events || []).reduce((m, e) => Math.max(m, e.seq), 0);
      const top = Math.max(last, 0);
      if (seenKey !== key || seenSeq < 0) { seenKey = key; seenSeq = top; return; }
      if (top <= seenSeq) return;
      const list = effectsOf(view, seenSeq, L);
      seenSeq = top;
      if (!ctx.fx() || !list.length) return;
      const still = !ctx.motion();
      fxTimers.forEach(clearTimeout);
      const mine = list.filter((fx) => fx.fx !== 'strike');
      fxTimers = list.map((fx, i) => setTimeout(() => {
        try { playOne(fx, panel, slot, still, mine.length > 1 ? mine.indexOf(fx) : -1); } catch (e) { /* cosmetic */ }
      }, (fx.fx === 'slash' ? delay : 0) + i * 260));
    }
    function reset() {
      seenSeq = -1;
      seenKey = '';
      openTrait = '';
      fxTimers.forEach(clearTimeout);
      fxTimers = [];
      const n = typeof document !== 'undefined' && document.getElementById('bossFx');
      if (n) n.innerHTML = '';
    }

    // --- Entrance -------------------------------------------------------------
    let introNode = null;
    let introTimer = null;
    function closeIntro(fast) {
      const n = introNode;
      if (!n) return;
      introNode = null;
      clearTimeout(introTimer);
      n.classList.add(fast ? 'leaveFast' : 'leave');
      setTimeout(() => n.remove(), fast ? 140 : 240);
      if (ctx.onIntroEnd) ctx.onIntroEnd();
    }
    /** Before the first card: vortex, alert, the boss, life against life. A tap skips it. */
    function playIntro(view, info) {
      if (introNode || !known(view) || !ctx.fx()) return false;
      const still = !ctx.motion();
      const o = document.createElement('div');
      o.className = `bossIntro${still ? ' still' : ''}`;
      o.setAttribute('role', 'dialog');
      o.setAttribute('aria-label', L(`Boss-Kampf: ${nameOf(view.id, L)}`, `Boss fight: ${nameOf(view.id, L)}`));
      // The vortex: rings of the same light, each turned and tightened a little further in.
      const rings = still ? '' : Array.from({ length: 9 }, (_, k) =>
        `<i class="biRing" style="--d:${250 - k * 24}vmax;--r:${k * 37}deg;--o:${(0.5 + k * 0.05).toFixed(2)};--t:${k % 2 ? -1 : 1}"></i>`).join('');
      const b = BOSSES[view.id];
      const guards = (view.adds || []).length;
      o.innerHTML = `<div class="biVortex">${rings}</div><div class="biHole"></div><div class="biRim"></div>` +
        `<p class="biAlert"><span>${esc(L('BOSS', 'BOSS'))}</span></p>` +
        '<div class="biStage">' +
        `<span class="bossPortrait">${portraitSvg(view.id)}<span class="bpRank" aria-hidden="true">${esc(L(...b.rank))}</span></span>` +
        `<div class="biText"><p class="biFloor">${esc(L(`Kartenhaus · Etage ${info.stage}`, `House of Cards · floor ${info.stage}`))}</p>` +
        `<h2>${esc(nameOf(view.id, L))}</h2><p class="biLine">${esc(introLine(view, L))}</p>` +
        `<p class="biVs"><span class="biMe">${iconHtml('heart')}<b>${view.myMaxHp}</b></span><em>${esc(L('gegen', 'versus'))}</em>` +
        `<span class="biBoss">${iconHtml('heart')}<b>${view.maxHp}</b></span>` +
        (guards ? `<span class="biCats">${iconHtml('cat')}<b>${guards}${NBSP}${TIMES}${NBSP}${view.adds[0].maxHp}</b></span>` : '') + '</p></div></div>' +
        `<p class="biSkip">${esc(L('Tippen zum Überspringen', 'Tap to skip'))}</p>`;
      o.addEventListener('click', () => closeIntro(true));
      document.body.appendChild(o);
      introNode = o;
      introTimer = setTimeout(() => closeIntro(false), INTRO_MS);
      return true;
    }

    return { renderPanel, renderMyLife, playEffects, playIntro, closeIntro, reset, introOpen: () => !!introNode };
  }

  return {
    BOSSES, FX_MS, INTRO_MS, known, nameOf, catName, traits, lifeRule, introLine, effectsOf, handDamage, portraitSvg, CAT_SVG, barHtml, setBar, createTable,
  };
}));

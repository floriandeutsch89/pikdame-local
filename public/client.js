// public/client.js
// Verbindet sich dynamisch über window.location.hostname, damit der Client
// im Hotspot-Netzwerk ohne Code-Änderung über die iPhone-IP funktioniert.

(function () {
  'use strict';

  // localStorage kann werfen (Safari-Privatmodus, volles Quota) - dann soll
  // die App ohne Persistenz weiterlaufen statt beim Laden zu sterben.
  function storageGet(key) {
    try { return localStorage.getItem(key); } catch (e) { return null; }
  }
  function storageSet(key, value) {
    try { localStorage.setItem(key, value); } catch (e) { /* ohne Persistenz weiter */ }
  }
  function storageRemove(key) {
    try { localStorage.removeItem(key); } catch (e) { /* egal */ }
  }

  const NAME_KEY = 'pikdame_player_name';
  const THEME_KEY = 'pikdame_theme';
  const SOUND_KEY = 'pikdame_sound_enabled';

  // Session-Code ggf. aus der URL übernehmen (geteilter Link: ?session=CODE)
  let sessionCode = (new URLSearchParams(window.location.search).get('session') || '').toUpperCase() || null;
  const urlSessionCode = sessionCode; // the value the page was OPENED with (join-via-link)
  // Die playerId wird PRO SESSION gespeichert, damit Reconnects in das
  // richtige Spiel zurückführen und parallele Spiele sich nicht vermischen.
  const playerKeyFor = (code) => `pikdame_player_${code}`;
  const tokenKeyFor = (code) => `pikdame_token_${code}`;
  let playerId = sessionCode ? storageGet(playerKeyFor(sessionCode)) : null;
  let myName = storageGet(NAME_KEY) || '';
  let soundEnabled = storageGet(SOUND_KEY) !== 'off';
  let ws = null;
  let lastState = null;
  let selectedCardIds = new Set();
  let lastRoundResultShownAt = 0;
  // Frisch gezogene/aufgenommene Karten hervorheben: Diff der Hand-IDs
  // zwischen zwei Renders. Bei Rundenwechsel (Erstverteilung) wird nichts
  // markiert.
  let prevHandIds = new Set();
  let prevTurnPlayerId = null;
  let prevForfeitVoteCount = 0;
  let countdownTimer = null; // per-second turn countdown; only runs when needed (battery)
  let quoteShownForRound = null; // Rundenstart-Spruch nur einmal pro Runde

  // Kreative Sprüche zum Rundenbeginn. Deterministisch aus Geber+Runde
  // geseedet, damit ALLE am Tisch denselben Spruch sehen - gemeinsames
  // Schmunzeln statt vier verschiedener Zufälle.
  function roundQuote(seedStr) {
    const Q = [
      ['Neue Runde, neues Glück - die Pik Dame wartet schon.', 'New round, new luck - the Queen of Spades is waiting.'],
      ['Wer die Dame fängt, zahlt die Zeche: 100 Punkte!', 'Catch the Queen, pay the price: 100 points!'],
      ['Erst denken, dann abwerfen. Meistens jedenfalls.', 'Think first, discard second. Usually, anyway.'],
      ['Joker sind wie Kuchen: Man gibt sie nicht freiwillig her.', "Jokers are like cake: you don't give them away."],
      ['Ein guter Fächer ist die halbe Miete.', 'A well-sorted hand is half the battle.'],
      ['Die 2 nach dem Ass? Hier schon! K-A-2 gilt.', 'A 2 after the Ace? Here it does! K-A-2 is legal.'],
      ['Heute schon jemandem die Ablage vermiest?', 'Ruined anyone\u2019s discard pile plans yet today?'],
      ['Die Pik Dame lächelt nur, wenn sie ausgelegt wird.', 'The Queen of Spades only smiles when melded.'],
      ['15 Karten, 1000 Möglichkeiten, 0 Gnade.', '15 cards, 1000 possibilities, 0 mercy.'],
      ['Mut zur Folge - Feiglinge sammeln nur Sätze.', 'Dare to run - cowards only collect sets.'],
      ['Der Ablagestapel sieht heute verdächtig lecker aus.', 'That discard pile looks suspiciously tasty today.'],
      ['Wer zuletzt lacht, hat die Dame nicht auf der Hand.', 'He who laughs last isn\u2019t holding the Queen.'],
      ['Glücksgriff verpasst? Selbst schuld, sagt der Geber.', 'Missed the lucky cut? Dealer says: your loss.'],
      ['Tipp des Tages: Bots bluffen nicht. Menschen schon.', 'Tip of the day: bots don\u2019t bluff. Humans do.'],
      ['Ein Satz ohne Joker ist wie Kaffee ohne Kuchen.', 'A set without a joker is like coffee without cake.'],
      ['Runde eins der Diplomatie: freundlich abwerfen.', 'Diplomacy, round one: discard politely.'],
      ['Heute wird ausgelegt, nicht ausgeredet.', 'Today we meld, not meddle.'],
      ['Achtung: Oma sieht mehr, als sie zugibt.', 'Careful: grandma sees more than she admits.'],
      ['Hand aus in Runde eins? Legenden existieren.', 'Out in one on turn one? Legends do exist.'],
      ['Die beste Verteidigung ist ein voller eigener Stapel.', 'The best defense is a big meld pile of your own.'],
      ['Karten lügen nie. Mitspieler manchmal.', 'Cards never lie. Players sometimes do.'],
      ['Erst der Endspurt zeigt, wer zählen kann.', 'The final stretch shows who can really count.'],
      ['Ein Ass auf der Hand kostet 20 - nur zur Info.', 'An Ace in hand costs 20 - just saying.'],
      ['Möge der Stapel mit dir sein.', 'May the pile be with you.'],
      ['Der lange Aal schlackert im Nebel.', 'The long eel wobbles in the fog.'],
      ['Per aspera ad astra.', 'Per aspera ad astra.'],
      ['Merke: Wer den Stapel nimmt, nimmt ALLES. Auch die Überraschung.', 'Remember: take the pile, take EVERYTHING. Surprises included.'],
      ['Heute schon einen Joker getauscht? Der Tag ist noch jung.', 'Swapped a joker yet? The day is still young.'],
      ['Oma sagt: Erst die Folge, dann das Vergnügen.', 'Grandma says: run first, fun second.'],
      ['Die letzte Karte fliegt immer am schönsten.', 'The last card always flies the prettiest.'],
      ['Wer zögert, dem mischt das Leben nach.', 'Hesitate, and life reshuffles on you.'],
      ['13 Karten sind eine Folge. 14 sind ein Problem.', '13 cards make a run. 14 make a problem.'],
      ['Ein Ass in der Hand ist 20 Punkte im Minus.', 'An ace in hand is 20 points in the red.'],
      ['Bluffen ist erlaubt. Erwischt werden nicht.', 'Bluffing is allowed. Getting caught is not.'],
      ['Der Ablagestapel vergisst nichts.', 'The discard pile never forgets.'],
      ['Heimlich Karten zählen? Zen macht das auch.', 'Counting cards on the sly? Zen does it too.'],
      ['Glücksgriff heißt Glücksgriff, weil er selten ist.', "It's called a lucky cut because it's rare."],
      ['Vier Spieler, zwei Damen, null Gnade.', 'Four players, two queens, zero mercy.'],
      ['Wer zuletzt lacht, hat die Pik Dame rechtzeitig abgeworfen.', 'Who laughs last discarded the Queen in time.'],
      ['Hand aus! - das schönste Wort nach "Kuchen".', 'Hand out! - the finest phrase after "cake".'],
      ['Neue Runde, neues Glück - altes Misstrauen.', 'New round, new luck - same old suspicion.'],
      ['Die Pik Dame schläft nie. Sie wartet.', 'The Queen of Spades never sleeps. She waits.'],
      ['Wer den Joker abwirft, glaubt auch an gutes W-LAN im Keller.', 'Discarding a joker? Sure, and the basement has great wifi.'],
      ['Erst denken, dann ziehen. Oder andersrum, wir urteilen nicht.', 'Think first, then draw. Or the other way - no judgement.'],
      ['Drei Damen sind ein Satz. Zwei Damen sind ein Drama.', 'Three queens make a set. Two queens make a drama.'],
      ['Der Stapel lügt nie. Er schweigt nur sehr laut.', 'The pile never lies. It just stays very loudly silent.'],
      ['Zen-Meister zählen Karten. Alle anderen zählen auf Glück.', 'Zen masters count cards. Everyone else counts on luck.'],
      ['Hände weg von der Pik Dame - außer sie liegt schon fest.', 'Hands off the Queen of Spades - unless she is safely melded.'],
      ['Ein Fächer voller Möglichkeiten. Und drei davon sind Fehler.', 'A fan full of options. Three of them are mistakes.'],
      ['Familienspiel heißt: Alle lieben sich. Bis zum Ausmachen.', 'Family game means: everyone loves each other. Until someone goes out.'],
      ['Der beste Zug ist der, über den keiner lacht.', 'The best move is the one nobody laughs at.'],
      ['Runde eins ist Aufwärmen. Ab Runde zwei ist es persönlich.', 'Round one is a warm-up. From round two on, it is personal.'],
    ];
    let h = 0;
    for (let i = 0; i < seedStr.length; i++) h = (h * 31 + seedStr.charCodeAt(i)) | 0;
    const pair = Q[Math.abs(h) % Q.length];
    return L(pair[0], pair[1]);
  }

  function maybeShowRoundQuote() {
    if (!lastState || lastState.phase !== 'playing') return;
    const key = `${lastState.roundNumber}`;
    if (quoteShownForRound === key) return;
    quoteShownForRound = key;
    if (lastState.roundNumber === 0) return;
    // Wichtige Rundenstart-Meldungen (Endspurt ⚠️, Glücksgriff 🍀) haben
    // Vorfahrt - der Spruch drängelt sich dann nicht dazwischen.
    const latest = (lastState.log || [])[lastState.log.length - 1];
    if (latest && latest.text && !/^Runde \d+ gestartet/.test(latest.text)) return;
    showToast(`🃏 ${roundQuote(`${lastState.dealerId}-${lastState.roundNumber}`)}`, { duration: 5000, priority: true });
  }
  let prevDiscardTopId;
  // Auslagen-Filter: null = alle anzeigen; sonst nur die Auslagen dieses
  // Spielers (Toggle per Klick auf den Namen).
  let meldFilterPlayerId = null;
  // IDs aller Pik Damen, die bereits in den Auslagen liegen - taucht eine
  // NEUE auf, gibt es die große Ankündigung (Raid-Warning-Stil).
  let prevTablePikdameIds = null;
  let prevPikdameRound = null;
  // --- Sprache (Deutsch/Englisch, Default Deutsch) ----------------------------
  const LANG_KEY = 'pikdame_lang';
  let lang = storageGet(LANG_KEY) === 'en' ? 'en' : 'de';

  /** Sprach-Helfer für dynamische Texte: L(deutsch, englisch). */
  function L(de, en) {
    return lang === 'en' ? en : de;
  }

  /** Übersetzt SERVER-Texte (Log/Fehler) per Muster - Fallback: Original. */
  function trs(text) {
    if (lang !== 'en' || !text) return text;
    for (const [re, tpl] of window.I18N_SERVER_PATTERNS || []) {
      if (re.test(text)) return text.replace(re, tpl);
    }
    return text;
  }

  // Statische HTML-Texte: beim Start werden alle Blatt-Elemente sowie
  // title-/placeholder-Attribute inventarisiert (deutsches Original als
  // data-Attribut), danach kann verlustfrei hin- und hergeschaltet werden.
  let i18nSnapshotDone = false;
  let rulesHtmlDe = '';
  function applyStaticLang() {
    const map = window.I18N_STATIC || {};
    if (!i18nSnapshotDone) {
      document.querySelectorAll('body *').forEach((n) => {
        if (n.children.length === 0) {
          const txt = n.textContent.trim();
          if (txt && map[txt]) n.dataset.i18nDe = n.textContent;
        }
        if (n.title && map[n.title]) n.dataset.i18nTitleDe = n.title;
        if (n.placeholder && map[n.placeholder]) n.dataset.i18nPhDe = n.placeholder;
      });
      rulesHtmlDe = el('rulesContent').innerHTML;
      i18nSnapshotDone = true;
    }
    document.querySelectorAll('[data-i18n-de]').forEach((n) => {
      const de = n.dataset.i18nDe;
      n.textContent = lang === 'en' ? map[de.trim()] || de : de;
    });
    document.querySelectorAll('[data-i18n-title-de]').forEach((n) => {
      const de = n.dataset.i18nTitleDe;
      n.title = lang === 'en' ? map[de] || de : de;
    });
    document.querySelectorAll('[data-i18n-ph-de]').forEach((n) => {
      const de = n.dataset.i18nPhDe;
      n.placeholder = lang === 'en' ? map[de] || de : de;
    });
    el('rulesContent').innerHTML = lang === 'en' ? window.I18N_RULES_EN : rulesHtmlDe;
    el('rulesTitle').textContent = L('📖 Spielregeln', '📖 How to play');
    el('langBtnLobby').textContent = lang === 'en' ? '🌐 Language: English' : '🌐 Sprache: Deutsch';
    document.documentElement.lang = lang;
  }
  function cycleLang() {
    lang = lang === 'de' ? 'en' : 'de';
    storageSet(LANG_KEY, lang);
    applyStaticLang();
    updateSortToggleLabel();
    updateHandToggle();
    applyUiScale(); // Label des Anzeigegröße-Buttons neu setzen
    if (lastState) render();
  }

  // --- Anzeigegröße (für ältere Mitspieler): 3 Stufen, pro Gerät gespeichert ---
  const UI_SCALE_KEY = 'pikdame_ui_scale';
  const UI_SCALES = ['normal', 'large', 'xlarge'];
  function uiScaleLabel(scale) {
    return { normal: L('Normal', 'Normal'), large: L('Groß', 'Large'), xlarge: L('Sehr groß', 'Extra large') }[scale];
  }
  let uiScale = UI_SCALES.includes(storageGet(UI_SCALE_KEY))
    ? storageGet(UI_SCALE_KEY)
    : 'normal';
  function applyUiScale() {
    if (uiScale === 'normal') {
      delete document.documentElement.dataset.uiscale;
    } else {
      document.documentElement.dataset.uiscale = uiScale;
    }
    const lobbyBtn = document.getElementById('uiScaleBtnLobby');
    if (lobbyBtn) lobbyBtn.textContent = L(`🔍 Anzeigegröße: ${uiScaleLabel(uiScale)}`, `🔍 Display size: ${uiScaleLabel(uiScale)}`);
  }
  function cycleUiScale() {
    uiScale = UI_SCALES[(UI_SCALES.indexOf(uiScale) + 1) % UI_SCALES.length];
    storageSet(UI_SCALE_KEY, uiScale);
    applyUiScale();
    showToast(L(`Anzeigegröße: ${uiScaleLabel(uiScale)}`, `Display size: ${uiScaleLabel(uiScale)}`));
    if (typeof render === 'function' && lastState) render(); // Hand-Überlappung neu messen
  }
  applyUiScale();

  const SORT_KEY = 'pikdame_hand_sort';
  let handSortMode = storageGet(SORT_KEY) === 'rank' ? 'rank' : 'suit';
  let prevHandRound = null;
  let freshCardIds = new Set();
  let dealAnimatedForRound = null; // one-shot card deal-in per fresh round
  let pendingDealCards = [];
  let knownProfiles = [];
  let lastEarnedBadges = null; // frisch verdiente Erfolge (fuers Ergebnis-Overlay)

  // Erfolgs-Badge-Katalog: IDs kommen vom Server, Texte leben hier (DE/EN).
  /** Stable, friendly avatar colour from the player name (djb2 -> hue). */
  function avatarFor(name, isBot) {
    let h = 5381;
    for (const ch of String(name)) h = ((h * 33) ^ ch.codePointAt(0)) >>> 0;
    const hue = h % 360;
    const glyph = isBot ? '🤖' : escapeHtml((Array.from(String(name).trim())[0] || '?').toUpperCase());
    return `<span class="opAvatar" style="background:hsl(${hue},46%,40%)">${glyph}</span>`;
  }

  function badgeMeta(id) {
    const M = {
      first_win: { emoji: '🏆', name: L('Erster Sieg', 'First win'), desc: L('Erste gewonnene Partie', 'Won your first game') },
      hand_aus_win: { emoji: '🚀', name: L('Hand aus!', 'Out in one!'), desc: L('Alles in einem einzigen Zug ausgelegt und gewonnen', 'Laid out the whole hand in a single turn and won') },
      pd_laid: { emoji: '♠', name: L('Damensammler', 'Queen collector'), desc: L('Eine Pik Dame sicher ausgelegt (+100)', 'Melded a Queen of Spades (+100)') },
      pd_triple: { emoji: '👑', name: L('Dreifache Dame', 'Triple queen'), desc: L('3+ Pik Damen in einer Partie ausgelegt', 'Melded 3+ Queens of Spades in one game') },
      pd_caught: { emoji: '😱', name: L('Autsch!', 'Ouch!'), desc: L('Pik Dame am Rundenende auf der Hand erwischt (−100)', 'Caught with the Queen of Spades in hand (−100)') },
      score_500: { emoji: '💯', name: L('Punktekönig', 'Point royalty'), desc: L('500+ Punkte Endstand in einer Partie', 'Finished a game with 500+ points') },
      streak_3: { emoji: '🔥', name: L('Siegesserie', 'Winning streak'), desc: L('3 Partien in Folge gewonnen', 'Won 3 games in a row') },
      comeback: { emoji: '🐢', name: L('Comeback', 'Comeback'), desc: L('Nach Runde 1 Letzter - und trotzdem gewonnen', 'Last after round 1 - and still won') },
      double_queen_round: { emoji: '👯', name: L('Doppeldame', 'Double queen'), desc: L('BEIDE Pik Damen in ein und derselben Runde ausgelegt', 'Melded BOTH Queens of Spades in the same round') },
      round_300: { emoji: '💥', name: L('Monsterrunde', 'Monster round'), desc: L('300+ Punkte in einer einzigen Runde', '300+ points in a single round') },
      zen_slayer: { emoji: '⚔️', name: L('Zen-Bezwinger', 'Zen slayer'), desc: L('Partie mit einem Zen-Meister am Tisch gewonnen', 'Won a game with a zen master at the table') },
      marathon_10: { emoji: '🏃', name: L('Marathon', 'Marathon'), desc: L('10 Partien gespielt', 'Played 10 games') },
      pd_hunter_10: { emoji: '🎯', name: L('Damenjägerin', 'Queen hunter'), desc: L('10 Pik Damen insgesamt ausgelegt', 'Melded 10 Queens of Spades in total') },
    };
    return M[id] || { emoji: '🎖️', name: id, desc: '' };
  }
  let globalStatsData = null; // anonyme Server-Zähler (Partien, Pik Damen, ...)
  let publicMode = false;

  const el = (id) => document.getElementById(id);

  // Defense in Depth: Namen werden zwar bereits serverseitig auf harmlose
  // Zeichen begrenzt, aber alles, was per innerHTML gerendert wird, läuft
  // zusätzlich durch dieses Escaping - eine einzelne vergessene Stelle
  // wird so nicht zur XSS-Lücke auf einem öffentlichen Server.
  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // A little heart for Liisa. Returns the HTML-escaped name, with ❤️ appended
  // when the (trimmed, case-insensitive) name is Liisa.
  function nameWithHeart(name) {
    const safe = escapeHtml(name);
    return typeof name === 'string' && name.trim().toLowerCase() === 'liisa' ? `${safe} ❤️` : safe;
  }

  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    storageSet(THEME_KEY, theme);
    document.querySelectorAll('.themeBtn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.themeChoice === theme);
    });
  }

  document.querySelectorAll('.themeBtn').forEach((btn) => {
    btn.addEventListener('click', () => applyTheme(btn.dataset.themeChoice));
  });
  applyTheme(storageGet(THEME_KEY) || 'table');

  document.querySelectorAll('.seatCountBtn').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (btn.disabled) return;
      send({ type: 'setMaxSeats', count: Number(btn.dataset.seatCount) });
    });
  });

  // --- Sound & Haptik (komplett offline: synthetisierte Töne, kein Audio-Download) ---

  let audioCtx = null;
  let audioIdleTimer = null;
  function getAudioCtx() {
    if (!audioCtx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (Ctx) audioCtx = new Ctx();
    }
    return audioCtx;
  }

  // BATTERY: a running AudioContext keeps the audio hardware powered even in
  // total silence. Our sounds are short one-shots, so suspend it a moment after
  // the last one (and immediately when the app goes to the background); it
  // resumes automatically on the next sound.
  function scheduleAudioSuspend() {
    clearTimeout(audioIdleTimer);
    audioIdleTimer = setTimeout(() => {
      if (audioCtx && audioCtx.state === 'running') audioCtx.suspend().catch(() => {});
    }, 3000);
  }
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && audioCtx && audioCtx.state === 'running') {
      audioCtx.suspend().catch(() => {});
    }
  });

  function playTone(freqs, durationMs, type = 'sine', gainValue = 0.06) {
    if (!soundEnabled) return;
    const ctx = getAudioCtx();
    if (!ctx) return;
    if (ctx.state === 'suspended') ctx.resume();
    const now = ctx.currentTime;
    freqs.forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = type;
      osc.frequency.value = freq;
      const start = now + i * (durationMs / 1000 / freqs.length);
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(gainValue, start + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + durationMs / 1000 / freqs.length);
      osc.connect(gain).connect(ctx.destination);
      osc.start(start);
      osc.stop(start + durationMs / 1000 / freqs.length + 0.02);
    });
    scheduleAudioSuspend(); // power the audio hardware down again once idle
  }

  function vibrate(pattern) {
    if (!soundEnabled) return;
    if (navigator.vibrate) navigator.vibrate(pattern);
  }

  const sound = {
    pikdame: () => { playTone([98, 147, 98], 520, 'sawtooth', 0.06); vibrate([60, 40, 60, 40, 120]); },
    turn: () => { playTone([523, 659], 180, 'sine', 0.06); vibrate([30, 60, 30]); },
    draw: () => { playTone([320], 90, 'triangle', 0.05); vibrate(8); },
    discard: () => { playTone([260, 180], 110, 'triangle', 0.05); vibrate(12); },
    meld: () => { playTone([440, 554, 660], 220, 'sine', 0.06); vibrate([10, 30, 10]); },
    error: () => { playTone([140], 160, 'square', 0.05); vibrate(40); },
    roundEnd: () => { playTone([392, 494, 587, 784], 420, 'sine', 0.07); vibrate([15, 40, 15, 40]); },
  };

  function setSoundEnabled(enabled) {
    soundEnabled = enabled;
    storageSet(SOUND_KEY, enabled ? 'on' : 'off');
    const toggleBtn = el('soundToggle');
    if (toggleBtn) toggleBtn.textContent = enabled ? '🔊' : '🔇';
    const ruleCheckbox = el('ruleSound');
    if (ruleCheckbox) ruleCheckbox.checked = enabled;
  }
  setSoundEnabled(soundEnabled);

  // Spiel-Tipps (der 'Tipp: 3+ Karten...'-Toast pro Zug): erfahrene Spieler
  // koennen sie hinterm Zahnrad dauerhaft abschalten. Persistiert lokal auf
  // dem Geraet (localStorage) - PFLICHT-Hinweise (z.B. Anlege-Zwang nach
  // Stapelaufnahme) bleiben bewusst immer sichtbar.
  const TIPS_KEY = 'pikdame_tips';
  let gameTipsEnabled = storageGet(TIPS_KEY) !== 'off';
  function setTipsEnabled(enabled) {
    gameTipsEnabled = enabled;
    storageSet(TIPS_KEY, enabled ? 'on' : 'off');
    const btn = el('tipsToggle');
    if (btn) {
      btn.textContent = enabled ? '💡' : '💤';
      btn.title = enabled
        ? L('Spiel-Tipps ausblenden', 'Hide game tips')
        : L('Spiel-Tipps wieder anzeigen', 'Show game tips again');
    }
  }
  setTipsEnabled(gameTipsEnabled);

  function wsUrl() {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const port = window.location.port ? `:${window.location.port}` : '';
    return `${proto}//${window.location.hostname}${port}`;
  }

  function connect() {
    ws = new WebSocket(wsUrl());
    el('connStatus').textContent = L('Verbinde...', 'Connecting...');

    ws.addEventListener('open', () => {
      el('connStatus').textContent = L('Verbunden.', 'Connected.');
      // Automatischer Wiedereintritt NUR, wenn wir bereits Teil einer
      // Session waren (Reconnect nach Verbindungsabbruch oder geteilter
      // Link mit gespeicherter playerId). Ohne Code entscheidet der Nutzer
      // im UI: neues Spiel erstellen oder Code eingeben.
      if (sessionCode && playerId) {
        ws.send(JSON.stringify({ type: 'joinSession', code: sessionCode, playerId, playerToken: storageGet(tokenKeyFor(sessionCode)) || undefined, name: myName }));
      } else {
        // Start screen: only offer 'resume' if that game still exists.
        const last = storageGet(LAST_SESSION_KEY);
        if (last) ws.send(JSON.stringify({ type: 'checkSession', code: last }));
      }
    });

    ws.addEventListener('close', () => {
      el('connStatus').textContent = L('Verbindung verloren - neuer Versuch in 2s...', 'Connection lost - retrying in 2s...');
      setTimeout(connect, 2000);
    });

    ws.addEventListener('error', () => {
      el('connStatus').textContent = L('Verbindungsfehler.', 'Connection error.');
    });

    ws.addEventListener('message', (ev) => {
      // WICHTIG: Ohne try/catch würde EINE kaputte/unerwartete Nachricht
      // (oder ein Render-Fehler) den Handler-Durchlauf ungefangen abbrechen -
      // der State-Update ginge verloren und die UI bliebe inkonsistent.
      // So wird geloggt und der nächste State heilt die Anzeige.
      try {
        handleMessage(JSON.parse(ev.data));
      } catch (err) {
        console.error('Fehler beim Verarbeiten einer Server-Nachricht:', err);
      }
    });
  }

  // --- Abheben (interaktiver Rundenstart) ----------------------------------
  let cutWired = false;
  function renderCutOverlay() {
    const ov = el('cutOverlay');
    const isCutting = lastState && lastState.phase === 'cutting';
    ov.classList.toggle('hidden', !isCutting);
    if (!isCutting) return;

    const iAmCutter = lastState.cutterId === playerId;
    const cutter = (lastState.players || []).find((p) => p.id === lastState.cutterId);
    const name = cutter ? cutter.name : '?';

    el('cutTitle').textContent = iAmCutter
      ? L('Du hebst ab', 'Your cut')
      : L('Abheben', 'Cutting the deck');
    el('cutHint').classList.toggle('hidden', !iAmCutter);
    el('cutDeckArea').classList.toggle('hidden', !iAmCutter);
    el('cutConfirmBtn').classList.toggle('hidden', !iAmCutter);
    const waiting = el('cutWaiting');
    waiting.classList.toggle('hidden', iAmCutter);
    if (!iAmCutter) {
      waiting.textContent = L(
        `${name} hebt das frisch gemischte Deck ab …`,
        `${name} is cutting the freshly shuffled deck …`
      );
    }

    if (!cutWired) {
      cutWired = true;
      const slider = el('cutSlider');
      const syncMarker = () => { el('cutMarker').style.left = slider.value + '%'; };
      slider.addEventListener('input', syncMarker);
      syncMarker();
      el('cutConfirmBtn').addEventListener('click', () => {
        send({ type: 'performCut', position: Number(slider.value) / 100 });
      });
    }
  }

  // --- Abhebe-Aufdeckung: aufgedeckte Karten kurz einfliegen lassen ---------
  let shownCutRevealKey = null;
  function maybeShowCutReveal() {
    const r = lastState && lastState.lastCutReveal;
    if (!r || !Array.isArray(r.cards) || r.cards.length === 0) return;
    if (lastState.phase !== 'playing') return; // erst wenn die Runde wirklich läuft
    const key = r.round + ':' + r.cards.map((c) => c.id).join(',');
    if (key === shownCutRevealKey) return;
    shownCutRevealKey = key;
    if (document.hidden) return; // im Hintergrund keine Show

    const cutter = (lastState.players || []).find((p) => p.id === r.cutterId);
    const name = cutter ? cutter.name : '?';
    const iAmCutter = r.cutterId === playerId;
    const lucky = r.luckyCount > 0;

    // GLÜCKSGRIFF = Jackpot-Moment: großes Kleeblatt-Popup für den GANZEN
    // Tisch (die Karten gehen ja öffentlich in die Hand des Abhebers).
    if (lucky) {
      const what = r.cards.slice(0, r.luckyCount)
        .map((cd) => (cd.isJoker ? L('Joker', 'Joker') : L('Pik Dame', 'Queen of Spades')))
        .join(' + ');
      showRaidWarning(
        L('🍀 GLÜCKSGRIFF! 🍀', '🍀 LUCKY CUT! 🍀'),
        iAmCutter
          ? L(`Du ziehst beim Abheben: ${what}!`, `Your cut reveals: ${what}!`)
          : L(`${name} zieht beim Abheben: ${what}!`, `${name}'s cut reveals: ${what}!`),
        'lucky'
      );
    } else if (!iAmCutter) {
      // Gewöhnliche Karte: sieht NUR der Abheber (der Server schickt sie auch
      // nur ihm) - für alle anderen bleibt sie verdeckt im Deck.
      return;
    }

    const old = document.getElementById('cutReveal');
    if (old) old.remove();
    const wrap = document.createElement('div');
    wrap.id = 'cutReveal';
    const title = document.createElement('div');
    title.className = 'cutRevealTitle';
    title.textContent = lucky
      ? (iAmCutter && r.cards.length > r.luckyCount
          ? L('Deine Beute - die letzte Karte geht mit dem Packen beiseite', 'Your haul - the last card leaves with the packet')
          : L(`${name} behält ${r.luckyCount} Karte${r.luckyCount > 1 ? 'n' : ''}`,
              `${name} keeps ${r.luckyCount} card${r.luckyCount > 1 ? 's' : ''}`))
      : L('Deine Abhebekarte - geht mit dem Packen beiseite', 'Your cut card - leaves with the packet');
    wrap.appendChild(title);

    const row = document.createElement('div');
    row.className = 'cutRevealCards';
    r.cards.forEach((card, i) => {
      const div = cardEl(card, {});
      div.style.setProperty('--i', i);
      if (i < r.luckyCount) div.classList.add('cutLucky');
      else div.classList.add('cutStopper');
      row.appendChild(div);
    });
    wrap.appendChild(row);
    document.body.appendChild(wrap);

    const holdMs = (lucky ? 2400 : 1700) + r.cards.length * 160;
    setTimeout(() => {
      wrap.classList.add('cutRevealOut');
      setTimeout(() => wrap.remove(), 450);
    }, holdMs);
  }

  function send(obj) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(obj));
    }
  }

  function handleMessage(msg) {
    if (msg.type === 'joined') {
      storageSet('pikdame_last_session', msg.sessionCode);
      // Secret seat token: proves this browser owns the seat on reconnect
      if (msg.playerToken) storageSet(tokenKeyFor(msg.sessionCode), msg.playerToken);
      playerId = msg.playerId;
      sessionCode = msg.sessionCode;
      storageSet(playerKeyFor(sessionCode), playerId);
      // URL aktualisieren, damit der Link direkt teilbar ist (?session=CODE)
      const url = new URL(window.location.href);
      url.searchParams.set('session', sessionCode);
      history.replaceState(null, '', url.toString());
      renderSessionBanner();
      return;
    }
    if (msg.type === 'sessionStatus') {
      // Existence probe reply: reveal the resume button only for a live game,
      // and drop a stale code so it is never offered again.
      const last = storageGet('pikdame_last_session');
      const btn = el('resumeBtn');
      if (msg.exists && msg.code === last && !sessionCode) {
        btn.textContent = L(`↩️ Weiterspielen (${msg.code})`, `↩️ Resume game (${msg.code})`);
        btn.classList.remove('hidden');
      } else {
        if (!msg.exists && msg.code === last) storageRemove('pikdame_last_session');
        btn.classList.add('hidden');
      }
      return;
    }
    if (msg.type === 'error') {
      // A stale resume target is gone for good - stop offering it.
      if (/Kein Spiel mit diesem Code/.test(msg.error || '')) {
        storageRemove('pikdame_last_session');
      }
      showHint(trs(msg.error), true);
      // Wichtige Fehler (z.B. Ablagestapel nicht aufnehmbar) deutlich und
      // laenger in der Bildmitte zeigen - die Hint-Zeile allein wird auf
      // kleinen Displays leicht uebersehen.
      showToast(trs(msg.error), { duration: 5000, priority: true });
      return;
    }
    if (msg.type === 'state') {
      lastState = msg.state;
      // Keep the hand selection in sync with reality: a card stays selected
      // until it actually LEAVES the hand (laid off / melded / discarded).
      // A failed lay-off ("doesn't fit") leaves the card in hand, so it stays
      // selected and can be aimed at another meld right away - no reselecting.
      const meNow = lastState.players && lastState.players.find((p) => p.id === playerId);
      if (meNow && meNow.hand) {
        const handIds = new Set(meNow.hand.map((c) => c.id));
        for (const id of [...selectedCardIds]) if (!handIds.has(id)) selectedCardIds.delete(id);
      } else if (lastState.phase !== 'playing') {
        selectedCardIds.clear();
      }
      // "Du bist dran"-Signal: Ton + Vibration + kurzer Puls der Statuszeile,
      // sobald der Zug auf mich wechselt (nicht beim allerersten Render).
      if (
        lastState.phase === 'playing' &&
        lastState.currentPlayerId === playerId &&
        prevTurnPlayerId !== null &&
        prevTurnPlayerId !== playerId
      ) {
        sound.turn();
        if (handCollapsed) {
          handCollapsed = false;
          updateHandToggle();
        }
        const bar = el('topBar');
        bar.classList.remove('yourTurnPulse');
        void bar.offsetWidth; // Animation neu starten
        bar.classList.add('yourTurnPulse');
      }
      prevTurnPlayerId = lastState.currentPlayerId;
      updateWakeLock();
      maybeShowActionToast();
      maybeShowRoundQuote();
      checkPikdameAnnouncement();
      render();
      return;
    }
    if (msg.type === 'challengeBoard') {
      lastChallengeBoard = msg;
      renderChallengeBoard();
      return;
    }
    if (msg.type === 'badges') {
      lastEarnedBadges = msg.earned || null;
      if (!el('resultOverlay').classList.contains('hidden')) renderResultOverlay();
      return;
    }
    if (msg.type === 'profiles') {
      knownProfiles = msg.players || [];
      globalStatsData = msg.globalStats || null;
      // Öffentlicher Server: Profile/Statistik sind deaktiviert.
      publicMode = !!msg.publicMode;
      el('statsBtn').classList.toggle('hidden', publicMode);
      if (!el('statsOverlay').classList.contains('hidden')) renderStats();
      return;
    }
    if (msg.type === 'emote') {
      showEmote(msg.playerId, msg.emoji);
      return;
    }
    if (msg.type === 'gameExport') {
      // The same server payload feeds two features: the JSON download and
      // the round-by-round replay overlay (whoever asked last wins).
      if (pendingReplayRequest) {
        pendingReplayRequest = false;
        openReplay(msg.record);
      } else {
        downloadJson(msg.record, `pikdame-spielverlauf-${new Date(msg.record.finishedAt).toISOString().slice(0, 19)}.json`);
      }
      return;
    }
    if (msg.type === 'meldAmbiguous') {
      showJokerChoice('meld', msg.cardIds, msg.options);
      return;
    }
    if (msg.type === 'layOffAmbiguous') {
      showJokerChoice('layOff', { meldId: msg.meldId, cardId: msg.cardId }, msg.options);
      return;
    }
  }

  function downloadJson(data, filename) {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // --- Joker-Mehrdeutigkeit: Nachfrage-Overlay ----------------------------

  function showJokerChoice(kind, context, options) {
    const optionsDiv = el('jokerChoiceOptions');
    optionsDiv.innerHTML = '';
    options.forEach((opt) => {
      const btn = document.createElement('button');
      btn.textContent = trs(opt.label);
      btn.addEventListener('click', () => {
        el('jokerChoiceOverlay').classList.add('hidden');
        sound.meld();
        if (kind === 'meld') {
          send({ type: 'layoutMeld', cardIds: context, jokerAssignments: opt.jokerAssignments });
        } else {
          send({ type: 'layOff', meldId: context.meldId, cardId: context.cardId, asSuit: opt.asSuit, side: opt.side });
        }
        // Reconciled on the next state update (see the 'state' handler).
      });
      optionsDiv.appendChild(btn);
    });
    el('jokerChoiceOverlay').classList.remove('hidden');
  }

  el('jokerChoiceCancelBtn').addEventListener('click', () => {
    el('jokerChoiceOverlay').classList.add('hidden');
  });

  // --- Rendering ---------------------------------------------------------

  function suitSymbol(suit) {
    return { H: '♥', D: '♦', C: '♣', S: '♠' }[suit] || '?';
  }
  function suitColor(suit) {
    return suit === 'H' || suit === 'D' ? 'red' : 'black';
  }

  function cardEl(card, { selectable, selected, onClick, compact } = {}) {
    const div = document.createElement('div');
    div.className = compact ? 'card card-compact' : 'card';
    if (card && card.id != null) div.dataset.cardId = String(card.id); // z.B. Tutorial-Glow
    if (card.isJoker) {
      div.classList.add('joker');
      // Ecken-Index oben links, damit der Joker auch bei starker
      // Überlappung im Fächer erkennbar bleibt.
      div.innerHTML = compact
        ? `<div class="corner">🃏</div>`
        : `<div class="corner">🃏</div><div class="suitMark">🃏</div>`;
    } else {
      div.classList.add(suitColor(card.suit));
      // Wie bei echten Spielkarten: Rang + Farbe klein in der linken oberen
      // Ecke - die bleibt bei überlappenden Karten immer sichtbar. Das große
      // Symbol in der Mitte dient der schnellen Orientierung.
      div.innerHTML = compact
        ? `<div class="corner"><span>${card.rank}</span><span>${suitSymbol(card.suit)}</span></div>`
        : `<div class="corner"><span>${card.rank}</span><span>${suitSymbol(card.suit)}</span></div><div class="suitMark">${suitSymbol(card.suit)}</div>`;
      if (card.rank === 'Q' && card.suit === 'S') {
        div.classList.add('pikdame-card');
        if (!compact) {
          const tag = document.createElement('div');
          tag.className = 'pikdame-tag';
          tag.textContent = '100';
          div.appendChild(tag);
        }
      }
    }
    if (selected) div.classList.add('selected');
    if (selectable) {
      div.addEventListener('click', () => onClick && onClick(card));
    }
    return div;
  }

  let soundedForRound = -1;

  function render() {
    try { updateTutorial(); } catch (e) { /* hints must never break the table */ }
    delete el('turnInfo').dataset.baseText; // countdown suffix rebuilds fresh
    try { updateCountdownTimer(); } catch (e) { /* timer must never break the table */ }
    try { renderCutOverlay(); } catch (e) { /* cut overlay must never break the table */ }
    try { maybeShowCutReveal(); } catch (e) { /* reveal must never break the table */ }
    if (!lastState) return;

    const inLobby = lastState.phase === 'lobby';
    el('lobby').classList.toggle('hidden', !inLobby);
    el('table').classList.toggle('hidden', inLobby);
    renderPause();

    if (inLobby) {
      // Coming back to the lobby (e.g. after a rematch) must clear any result
      // overlay - otherwise a player who did not click the rematch button keeps
      // the game-over overlay stuck on top of the lobby and cannot ready up.
      el('resultOverlay').classList.add('hidden');
      renderLobby();
      return;
    }

    renderTable();

    if (lastState.phase === 'roundEnd' || lastState.phase === 'gameOver') {
      if (soundedForRound !== lastState.roundNumber) {
        soundedForRound = lastState.roundNumber;
        sound.roundEnd();
      }
      renderResultOverlay();
    } else {
      el('resultOverlay').classList.add('hidden');
    }
  }

  function renderLobby() {
    const humanCount = lastState.players.filter((p) => !p.isBot).length;
    const isHost = !!lastState.isHost;
    const ready = new Set(lastState.lobbyReady || []);
    el('lobbyPlayers').innerHTML =
      `${lastState.players.length} Spieler am Tisch` +
      (lastState.players.length
        ? '<br>' +
          lastState.players
            .map((p) => `${!p.isBot && ready.has(p.id) ? '✅ ' : ''}${nameWithHeart(p.name)}${p.isBot ? ' (Bot)' : ''}`)
            .join(', ')
        : '');

    // Ready check before a NEW game (and after a rematch): with 2+ humans
    // everyone confirms first - the start button waits for the group.
    // Count SEATED humans (not just connected): a minimised player still
    // counts, so the game never starts behind their back.
    const seatedHumans = lastState.players.filter((p) => !p.isBot);
    const multiHuman = seatedHumans.length > 1;
    const readyCount = seatedHumans.filter((p) => ready.has(p.id)).length;
    const readyBtn = el('lobbyReadyBtn');
    const iAmSeated = lastState.players.some((p) => p.id === playerId);
    readyBtn.classList.toggle('hidden', !multiHuman || !iAmSeated);
    if (multiHuman && iAmSeated) {
      readyBtn.textContent = ready.has(playerId)
        ? L('✅ Bereit - warte auf die anderen', '✅ Ready - waiting for the others')
        : L('🖐️ Bereit melden', '🖐️ Mark me ready');
    }
    const allReady = !multiHuman || readyCount === seatedHumans.length;
    el('startBtn').classList.toggle('hidden', !isHost); // only the organizer starts
    el('startBtn').disabled = humanCount === 0 || !allReady;
    el('startBtn').textContent = multiHuman
      ? L(`Spiel starten (${readyCount}/${seatedHumans.length} bereit)`, `Start game (${readyCount}/${seatedHumans.length} ready)`)
      : L('Spiel starten', 'Start game');

    const hasJoined = lastState.players.some((p) => p.id === playerId);
    el('seatCountSection').classList.toggle('hidden', !hasJoined);
    el('seatingSection').classList.toggle('hidden', !hasJoined || lastState.players.length === 0);
    el('houseRulesSection').classList.toggle('hidden', !hasJoined);
    el('nonHostHint').classList.toggle('hidden', !hasJoined || isHost);
    // Reflect the host's settings for EVERYONE from the broadcast state, so
    // non-hosts (and a reconnecting host) see the actual chosen values. Skip a
    // control the host is editing right now to avoid clobbering mid-change.
    const hr = lastState.houseRules || {};
    const setCtl = (id, val, isCheckbox) => {
      const c = el(id);
      if (document.activeElement === c) return;
      if (isCheckbox) c.checked = !!val;
      else c.value = String(val);
    };
    setCtl('ruleHandAus', hr.handAusDoubles, true);
    setCtl('ruleStrict1000', hr.strictThreshold, true);
    setCtl('ruleTurnTimer', hr.turnTimerSeconds != null ? hr.turnTimerSeconds : 0);
    // House rules are read-only for non-hosts.
    el('houseRulesSection').querySelectorAll('input, select, button').forEach((ctrl) => {
      // ruleSound is a personal (per-device) setting - never lock it.
      ctrl.disabled = !isHost && ctrl.id !== 'ruleSound';
    });

    document.querySelectorAll('.seatCountBtn').forEach((btn) => {
      const count = Number(btn.dataset.seatCount);
      btn.classList.toggle('active', count === lastState.maxSeats);
      // non-hosts cannot change the seat count; hosts cannot go below joined humans
      btn.disabled = !isHost || count < humanCount;
    });

    renderSeatingList(isHost);
  }

  function renderSeatingList(isHost) {
    const list = el('seatingList');
    list.innerHTML = '';
    const canEdit = isHost !== false; // default true when called without arg
    lastState.players.forEach((p, idx) => {
      const row = document.createElement('div');
      row.className = 'seatRow';
      const isDealer = p.id === lastState.dealerId;
      const lock = !canEdit ? 'disabled' : '';
      // Per-bot difficulty badge (bots only) - each bot is configured
      // individually right here in the lobby; there is no global setting.
      // Non-hosts still SEE each bot's difficulty (read-only, clearly visible).
      const diff = BOT_DIFF[p.botDifficulty] || BOT_DIFF.zen;
      const diffTitle = canEdit
        ? L('Schwierigkeit ändern', 'Change difficulty')
        : L(`Schwierigkeit: ${diff.label()}`, `Difficulty: ${diff.label()}`);
      const diffBadge = p.isBot
        ? `<button class="btn-icon seatDiff${canEdit ? '' : ' readonly'}" title="${diffTitle}">${diff.icon}</button>`
        : '';
      row.innerHTML = `
        <span class="seatName">${nameWithHeart(p.name)}${p.isBot ? ' 🤖' : ''}</span>
        <span class="seatControls">
          ${diffBadge}
          <button class="btn-icon seatUp" ${idx === 0 || !canEdit ? 'disabled' : ''} title="Nach oben">▲</button>
          <button class="btn-icon seatDown" ${idx === lastState.players.length - 1 || !canEdit ? 'disabled' : ''} title="Nach unten">▼</button>
          <button class="btn-icon seatDealer ${isDealer ? 'active' : ''}" ${lock} title="Als Geber festlegen">${isDealer ? '⭐' : '☆'}</button>
        </span>`;
      if (canEdit) {
        row.querySelector('.seatUp').addEventListener('click', () => moveSeat(idx, -1));
        row.querySelector('.seatDown').addEventListener('click', () => moveSeat(idx, 1));
        row.querySelector('.seatDealer').addEventListener('click', () => send({ type: 'setDealer', playerId: p.id }));
        if (p.isBot) row.querySelector('.seatDiff').addEventListener('click', () => openBotDiffOverlay(p));
      }
      list.appendChild(row);
    });
  }

  function moveSeat(idx, dir) {
    const order = lastState.players.map((p) => p.id);
    const target = idx + dir;
    if (target < 0 || target >= order.length) return;
    [order[idx], order[target]] = [order[target], order[idx]];
    send({ type: 'reorderSeats', order });
  }


  function collectHouseRules() {
    return {
      handAusDoubles: el('ruleHandAus').checked,
      strictThreshold: el('ruleStrict1000').checked,
      turnTimerSeconds: Number(el('ruleTurnTimer').value),
    };
  }

  function renderTable() {
    const SCORE_TARGET = 1000;
    const myTotal = (lastState.totals && lastState.totals[playerId]) || 0;
    el('myScore').textContent = L(`${myTotal} Pkt`, `${myTotal} pts`);
    // Progress towards the 1000-point finish line (negatives clamp to 0)
    el('myScoreBar').querySelector('i').style.width =
      `${Math.max(0, Math.min(100, (myTotal / SCORE_TARGET) * 100))}%`;
    const dealer = lastState.players.find((p) => p.id === lastState.dealerId);
    const iAmDealer = dealer && dealer.id === playerId;
    // Kompakte Topbar: Der Geber ist jetzt per ⭐ direkt am jeweiligen
    // Gegner-Chip markiert - die Topbar nennt ihn nur noch, wenn ICH es bin.
    el('roundInfo').textContent = iAmDealer
      ? L(`R${lastState.roundNumber} · Du gibst ⭐`, `R${lastState.roundNumber} · You deal ⭐`)
      : `R${lastState.roundNumber}`;
    const cp = lastState.players.find((p) => p.id === lastState.currentPlayerId);
    const isMyTurn = lastState.currentPlayerId === playerId;
    updateTurnTitleNotice(isMyTurn && lastState.phase === 'playing');
    el('turnInfo').textContent = isMyTurn
      ? `Du bist am Zug (${phaseLabel(lastState.turnPhase)})`
      : `${cp ? cp.name : '?'} ist am Zug`;

    // Gegner
    const opponentsDiv = el('opponents');
    opponentsDiv.innerHTML = '';
    // Gegner in ZUGRICHTUNG ab dem eigenen Platz: der Chip ganz links ist
    // immer der Spieler, der direkt nach mir dran ist - so sieht man auf
    // einen Blick, zu wem der Zug als Nächstes wandert.
    const meIdx = lastState.players.findIndex((p) => p.id === playerId);
    const orderedOpponents = [];
    if (meIdx >= 0) {
      for (let i = 1; i < lastState.players.length; i++) {
        orderedOpponents.push(lastState.players[(meIdx + i) % lastState.players.length]);
      }
    } else {
      orderedOpponents.push(...lastState.players.filter((p) => p.id !== playerId));
    }
    orderedOpponents
      .forEach((p) => {
        const d = document.createElement('div');
        const roundOver = lastState.phase === 'roundEnd' || lastState.phase === 'gameOver';
        d.className =
          'opponent' +
          // During play the green ring marks whose TURN it is; once the
          // round is over it marks the player who WENT OUT instead - the
          // stale turn ring used to confuse people.
          (!roundOver && p.id === lastState.currentPlayerId ? ' active' : '') +
          (roundOver && p.id === lastState.lastRoundWinnerId ? ' roundWinner' : '') +
          (p.id === meldFilterPlayerId ? ' meldFilterActive' : '');
        d.dataset.playerId = p.id;
        // Klick auf den Namen: nur die Auslagen dieses Spielers zeigen
        // (erneuter Klick: wieder alle).
        d.addEventListener('click', () => {
          meldFilterPlayerId = meldFilterPlayerId === p.id ? null : p.id;
          render();
        });
        const reconnecting = !p.isBot && p.controlledByBot;
        const opTotal = (lastState.totals && lastState.totals[p.id]) || 0;
        const dealerStar = p.id === lastState.dealerId ? ` <span title="${L('Geber dieser Runde', 'Dealer this round')}">⭐</span>` : '';
        // Bots wear their difficulty as a tappable badge (per-bot adjustable)
        // Badge lives OUTSIDE the name div (appended below): inside it, the
        // name ellipsis on narrow chips (3 bots, portrait) swallowed the
        // button - invisible and untappable.
        const diffBadge = '';
        d.title = L(`${p.handCount} Karten · ${opTotal} Punkte`, `${p.handCount} cards · ${opTotal} points`);
        const opProgress = Math.max(0, Math.min(100, (opTotal / 1000) * 100));
        d.innerHTML = `<div class="opName">${avatarFor(p.name, p.isBot)}${nameWithHeart(p.name)}${diffBadge}${dealerStar}${reconnecting ? ` <span class="reconnectTag">⏳ ${L('getrennt – Bot übernimmt', 'disconnected – bot takes over')}</span>` : ''}</div><div class="opCount"><b>${p.handCount}</b> ${L('Kt', 'cd')} · <b>${opTotal}</b> ${L('Pkt', 'pts')}</div><div class="scoreBar" title="${L('Fortschritt bis 1000 Punkte', 'Progress towards 1000 points')}"><i style="width:${opProgress}%"></i></div>`;
        if (p.isBot) {
          const meta = BOT_DIFF[p.botDifficulty] || BOT_DIFF.zen;
          const badgeBtn = document.createElement('button');
          badgeBtn.className = 'botDiffBadge';
          badgeBtn.textContent = meta.icon;
          if (lastState.isHost) {
            badgeBtn.title = L('Schwierigkeit ändern', 'Change difficulty');
            badgeBtn.addEventListener('click', (ev) => {
              ev.stopPropagation(); // chip click keeps its meld-filter role
              openBotDiffOverlay(p);
            });
          } else {
            // Non-hosts see the difficulty read-only (clearly visible, not tappable).
            badgeBtn.classList.add('readonly');
            badgeBtn.title = L(`Schwierigkeit: ${meta.label()}`, `Difficulty: ${meta.label()}`);
          }
          d.appendChild(badgeBtn); // absolute corner - immune to ellipsis
        }
        opponentsDiv.appendChild(d);
      });

    // Auslagen
    const meldsDiv = el('melds');
    meldsDiv.innerHTML = '';
    // Für die Anlege-Hinweise: die aktuell einzeln ausgewählte Handkarte
    const meForHints = lastState.players.find((p) => p.id === playerId);
    const singleSelectedCard =
      selectedCardIds.size === 1 && meForHints && meForHints.hand
        ? meForHints.hand.find((cd) => cd.id === [...selectedCardIds][0])
        : null;

    // Auslagen nach BESITZER gruppiert (jeder Spieler hat seinen eigenen
    // Stapel!). Reihenfolge: eigene zuerst, danach die Mitspieler in
    // umgekehrter Zugrichtung - also der Spieler direkt VOR mir zuerst.
    // Der hat zuletzt gelegt und ist taktisch am relevantesten (liegen bei
    // ihm z.B. schon vier Sechsen, ist eine 6 gefahrloser abzuwerfen).
    const players = lastState.players;
    const myIdx = players.findIndex((p) => p.id === playerId);
    const ownerOrder = [];
    if (myIdx >= 0) {
      ownerOrder.push(players[myIdx]);
      for (let step = 1; step < players.length; step++) {
        ownerOrder.push(players[((myIdx - step) % players.length + players.length) % players.length]);
      }
    } else {
      ownerOrder.push(...players);
    }

    // Filter zurücksetzen, wenn der gefilterte Spieler nicht mehr existiert
    if (meldFilterPlayerId && !players.some((p) => p.id === meldFilterPlayerId)) {
      meldFilterPlayerId = null;
    }
    // Aktiver Filter: Hinweiszeile zum Zurücksetzen
    if (meldFilterPlayerId) {
      const filterOwner = players.find((p) => p.id === meldFilterPlayerId);
      const bar = document.createElement('div');
      bar.className = 'meldFilterBar';
      bar.textContent = L(`Nur Auslagen von ${filterOwner.id === playerId ? 'dir' : filterOwner.name} – tippen für alle`, `Only ${filterOwner.id === playerId ? 'your' : filterOwner.name + "'s"} melds – tap for all`);
      bar.addEventListener('click', () => { meldFilterPlayerId = null; render(); });
      meldsDiv.appendChild(bar);
    }

    // Empty-State: Erstspielern erklaeren, was hier hinkommt
    if ((lastState.tableMelds || []).length === 0 && !meldFilterPlayerId && lastState.phase === 'playing') {
      const empty = document.createElement('div');
      empty.className = 'meldsEmptyState';
      empty.textContent = L('Noch keine Auslagen – sammle 3+ passende Karten (Satz: gleicher Wert · Folge: gleiche Farbe in Reihe) und lege sie hier aus.', 'No melds yet – collect 3+ matching cards (set: same rank · run: same suit in sequence) and lay them down here.');
      meldsDiv.appendChild(empty);
    }

    ownerOrder.forEach((owner) => {
      if (meldFilterPlayerId && owner.id !== meldFilterPlayerId) return;
      const ownerMelds = lastState.tableMelds.filter((m) => m.ownerId === owner.id);
      if (ownerMelds.length === 0) {
        if (meldFilterPlayerId === owner.id) {
          const empty = document.createElement('div');
          empty.className = 'meldOwnerHeader';
          empty.textContent = L(`${owner.id === playerId ? 'Du hast' : owner.name + ' hat'} noch nichts ausgelegt.`, `${owner.id === playerId ? 'You have' : owner.name + ' has'} not melded anything yet.`);
          meldsDiv.appendChild(empty);
        }
        return;
      }
      const isMine = owner.id === playerId;

      const section = document.createElement('div');
      section.className = 'meldOwnerGroup' + (isMine ? ' own' : '');
      const header = document.createElement('div');
      header.className = 'meldOwnerHeader';
      header.innerHTML = isMine
        ? L('Deine Auslagen', 'Your melds')
        : L(`Auslagen von ${escapeHtml(owner.name)}${owner.isBot ? ' 🤖' : ''}`, `${escapeHtml(owner.name)}'s melds${owner.isBot ? ' 🤖' : ''}`);
      header.addEventListener('click', () => {
        meldFilterPlayerId = meldFilterPlayerId === owner.id ? null : owner.id;
        render();
      });
      section.appendChild(header);

      // Kombinationen NEBENEINANDER anzeigen - umbrechen erst, wenn der
      // Platz nicht mehr reicht (flex-wrap im meldRow-Container).
      const row = document.createElement('div');
      row.className = 'meldRow';
      ownerMelds.forEach((meld) => {
        const group = document.createElement('div');
        group.className = 'meldGroup';
        if (meld.id != null) group.dataset.meldId = String(meld.id);
        // Grüner Hinweis: EINE Karte, die hier anpasst - ODER mehrere,
        // die GEMEINSAM anpassen (z.B. zwei Zehnen an den Zehner-Satz)
        if (isMine && isMyTurn && lastState.turnPhase === 'meld') {
          if (singleSelectedCard && cardFitsMeld(meld, singleSelectedCard)) {
            group.classList.add('layOffTarget');
          } else if (selectedCardIds.size > 1 && meForHints && meForHints.hand) {
            const sel = meForHints.hand.filter((cd) => selectedCardIds.has(cd.id));
            if (sel.length === selectedCardIds.size && cardsFitMeldTogether(meld, sel)) {
              group.classList.add('layOffTarget');
            }
          }
        }
        meld.slots.forEach((slot) => {
          const card = slot.real || { isJoker: true, rank: slot.representsRank, suit: slot.representsSuit, _isJokerSlot: true };
          const cEl = cardEl(card, {
            // Nur die EIGENEN Auslagen sind interaktiv - mit fremden
            // Stapeln gibt es keinerlei Interaktion (weder Anlegen noch
            // Joker-Tausch).
            selectable: isMine && isMyTurn && lastState.turnPhase === 'meld',
            onClick: () => onMeldCardClick(meld),
            compact: true,
          });
          group.appendChild(cEl);
        });
        row.appendChild(group);
      });
      section.appendChild(row);
      meldsDiv.appendChild(section);
    });

    // Retired jokers are intentionally NOT rendered: the info bar added no
    // gameplay value (the swap is announced in the log; the cards are out of
    // the game either way). Server-side tracking stays untouched - it is
    // part of the rules (retired jokers can never be picked up again).

    // Stapel
    el('drawCount').textContent = lastState.drawPileCount;
    const drawCardDiv = el('drawPile').querySelector('.pile-card');
    drawCardDiv.classList.toggle('stacked-2', lastState.drawPileCount > 15);
    drawCardDiv.classList.toggle('stacked-1', lastState.drawPileCount > 1 && lastState.drawPileCount <= 15);

    const discardTopDiv = el('discardTopCard');
    discardTopDiv.innerHTML = '';
    discardTopDiv.className = 'pile-card';
    if (lastState.discardTop && !lastState.discardTop.faceDown) {
      const t = lastState.discardTop;
      discardTopDiv.classList.add(t.isJoker ? 'joker' : suitColor(t.suit));
      discardTopDiv.textContent = t.isJoker ? '🃏' : `${t.rank}${suitSymbol(t.suit)}`;
    } else if (lastState.discardTop) {
      discardTopDiv.classList.add('back');
    } else {
      discardTopDiv.classList.add('empty');
      discardTopDiv.textContent = L('leer', 'empty');
    }
    // Stapel-Tiefe visuell: mehr Karten = mehr sichtbare Ebenen unter der obersten
    discardTopDiv.classList.toggle('stacked-2', lastState.discardPileCount > 6);
    discardTopDiv.classList.toggle(
      'stacked-1',
      lastState.discardPileCount > 1 && lastState.discardPileCount <= 6
    );
    el('discardCount').textContent = lastState.discardPileCount > 0 ? lastState.discardPileCount : '';
    // Pop-Animation, wenn eine neue Karte oben liegt (z.B. Gegner-Abwurf)
    const topId = lastState.discardTop ? lastState.discardTop.id || 'facedown' : null;
    if (topId && topId !== prevDiscardTopId && prevDiscardTopId !== undefined) {
      discardTopDiv.classList.remove('pop');
      void discardTopDiv.offsetWidth;
      discardTopDiv.classList.add('pop');
    }
    prevDiscardTopId = topId;

    const canDraw = isMyTurn && lastState.turnPhase === 'draw';
    // Auch bei 0 Karten klickbar: der Server füllt aus dem Abhebe-Packen nach,
    // verweist auf die Ablage oder beendet die Runde regelkonform. Der alte
    // disabled-Zustand hat einen Spieler live eingesperrt (Screenshot-Bug):
    // ziehen ging clientseitig nicht, aufnehmen war regelwidrig.
    el('drawPile').classList.toggle('disabled', !canDraw);
    el('discardPile').classList.toggle('disabled', !canDraw || !lastState.discardTop);
    // Sanfter Glow signalisiert: jetzt darfst du ziehen
    el('drawPile').classList.toggle('glow', canDraw && (lastState.drawPileCount > 0 || (lastState.setAsideCount || 0) > 0));
    el('discardPile').classList.toggle('glow', canDraw && !!lastState.discardTop);

    // Hand
    const myPlayer = lastState.players.find((p) => p.id === playerId);
    const handDiv = el('hand');
    handDiv.innerHTML = '';
    if (myPlayer && myPlayer.hand) {
      // Neue Karten seit dem letzten Render ermitteln (Ziehen/Stapelaufnahme).
      const currentIds = new Set(myPlayer.hand.map((c) => c.id));
      const isNewRound = prevHandRound !== lastState.roundNumber;
      if (isNewRound || prevHandIds.size === 0) {
        freshCardIds = new Set(); // Erstverteilung nicht markieren
      } else {
        const added = myPlayer.hand.filter((c) => !prevHandIds.has(c.id)).map((c) => c.id);
        if (added.length > 0) freshCardIds = new Set(added);
        // Markierung erlischt, sobald die Karte die Hand verlässt
        for (const id of [...freshCardIds]) if (!currentIds.has(id)) freshCardIds.delete(id);
        // Glow lives only for the OWN running turn: the lingering rim
        // shimmer used to survive into the opponents' turns (bug report).
        if (lastState.currentPlayerId !== playerId) freshCardIds.clear();
      }
      prevHandIds = currentIds;
      prevHandRound = lastState.roundNumber;
      if (handCollapsed) updateHandToggle(); // Kartenzahl am Pfeil aktualisieren
      // Hand sortieren - umschaltbar: nach Farbe (gut für Folgen) oder nach
      // Wert (gut für Sätze). Joker immer ans Ende.
      const sorted = myPlayer.hand.slice().sort((a, b) => {
        if (a.isJoker && b.isJoker) return 0;
        if (a.isJoker) return 1;
        if (b.isJoker) return -1;
        if (handSortMode === 'rank') {
          const dr = RANK_ORDER.indexOf(a.rank) - RANK_ORDER.indexOf(b.rank);
          if (dr !== 0) return dr;
          return a.suit.localeCompare(b.suit);
        }
        if (a.suit !== b.suit) return a.suit.localeCompare(b.suit);
        return RANK_ORDER.indexOf(a.rank) - RANK_ORDER.indexOf(b.rank);
      });
      sorted.forEach((card, idx) => {
        const cEl = cardEl(card, {
          selectable: isMyTurn && lastState.turnPhase === 'meld',
          selected: selectedCardIds.has(card.id),
          onClick: () => onHandCardClick(card),
        });
        // Gerade gezogene/aufgenommene Karte sichtbar machen
        if (freshCardIds.has(card.id)) cEl.classList.add('just-drawn');
        // Fächer-Optik: Karten leicht um die Mitte der Hand rotiert + angehoben.
        // Rotation flacht bei vielen Karten ab, sonst wird der Fächer unleserlich.
        const mid = (sorted.length - 1) / 2;
        const offset = idx - mid;
        const rotFactor = Math.min(3.5, 42 / Math.max(sorted.length, 1));
        const rotate = Math.max(-10, Math.min(10, offset * rotFactor));
        // Dip is CAPPED: with 15 cards the old |offset|*2 sank the edge
        // cards 14px - the last joker visibly fell out of the row and
        // clipped below the bar. 6px keeps the fan feel without strays.
        const lift = Math.min(6, Math.abs(offset) * 1.2);
        cEl.style.transform = `rotate(${rotate}deg) translateY(${lift}px)`;
        if (selectedCardIds.has(card.id)) {
          cEl.style.transform += ' translateY(-18px)';
        }
        handDiv.appendChild(cEl);
        pendingDealCards.push(cEl);
      });

      // Dynamische Überlappung: die gesamte Hand passt IMMER auf die
      // Bildschirmbreite - kein horizontales Scrollen. Je mehr Karten,
      // desto stärker überlappen sie; der Ecken-Index oben links bleibt
      // dabei stets sichtbar. Mindestens 14px sichtbarer Streifen.
      const prevHandScroll = handDiv.scrollLeft; // Scroll-Position über Re-Render retten
      requestAnimationFrame(() => {
        const cards = [...handDiv.children];
        if (cards.length < 2) return;
        const cardWidth = cards[0].offsetWidth || 60;
        const available = handDiv.parentElement.clientWidth - 64; // Padding + Rotations-Überhang
        const naturalVisible = cardWidth * 0.62; // lockerer Fächer, wenn Platz da ist
        const fitVisible = (available - cardWidth) / (cards.length - 1);
        // Ab 16 Karten (Stapelaufnahme!) wird NICHT weiter gestaucht: Auf einem
        // iPhone blieben sonst ~14px sichtbarer Streifen pro Karte (Apple
        // empfiehlt 44px Touchziele). Stattdessen behält jede Karte einen
        // komfortablen Streifen und die Hand wird seitlich scrollbar.
        const MANY_CARDS = 16;
        const comfortable = Math.max(26, Math.round(cardWidth * 0.42));
        const scrollMode = cards.length >= MANY_CARDS && fitVisible < comfortable;
        handDiv.classList.toggle('handScroll', scrollMode);
        const visible = scrollMode
          ? comfortable
          : Math.max(14, Math.min(naturalVisible, fitVisible));
        const overlap = visible - cardWidth;
        cards.forEach((c, i) => {
          c.style.marginLeft = i === 0 ? '0' : `${overlap}px`;
        });
        if (scrollMode) {
          updateHandScrollEdges(handDiv);
          const fresh = cards.find((c) => c.classList.contains('just-drawn'));
          if (fresh) {
            // Frisch aufgenommene Karten sofort ins Bild holen - so merkt man
            // auch ohne Suchen, dass die Hand jetzt scrollt.
            const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
            fresh.scrollIntoView({ inline: 'center', block: 'nearest', behavior: reduce ? 'auto' : 'smooth' });
          } else {
            handDiv.scrollLeft = prevHandScroll;
          }
        }
      });
    }

    const showMeldControls = isMyTurn && lastState.turnPhase === 'meld' && selectedCardIds.size >= 3;
    el('confirmMeldBtn').classList.toggle('hidden', !showMeldControls);

    const showDiscardBtn =
      isMyTurn && lastState.turnPhase === 'meld' && selectedCardIds.size === 1 && !lastState.mustLayOffCardId;
    el('discardBtn').classList.toggle('hidden', !showDiscardBtn);

    el('clearSelectionBtn').classList.toggle('hidden', selectedCardIds.size === 0);
    // Vertipper-Ausweg: Stapel-Aufnahme zurücknehmen, solange die Pflichtkarte
    // noch nicht gelegt wurde (Server validiert; Flag kommt nur für mich true).
    el('undoPileBtn').classList.toggle('hidden', !lastState.canUndoPileTake);
    const iSeatedForfeit = lastState.players.some((p) => p.id === playerId && !p.isBot);
    el('forfeitBtn').classList.toggle('hidden', lastState.phase !== 'playing' || !iSeatedForfeit);
    const forfeitVotes = lastState.forfeitVotes || [];
    const humansForfeit = lastState.players.filter((p) => !p.isBot && p.connected !== false).length;
    const iVotedForfeit = forfeitVotes.includes(playerId);
    el('forfeitBtn').classList.toggle('active', iVotedForfeit);
    el('forfeitBtn').textContent = forfeitVotes.length
      ? L(`🏳️ Aufgeben (${forfeitVotes.length}/${humansForfeit})`, `🏳️ Forfeit (${forfeitVotes.length}/${humansForfeit})`)
      : L('🏳️ Spiel aufgeben', '🏳️ Forfeit game');
    el('forfeitBtn').title = forfeitVotes.length
      ? L(`${forfeitVotes.length}/${humansForfeit} wollen das Spiel aufgeben - tippe zum Zustimmen`, `${forfeitVotes.length}/${humansForfeit} want to forfeit the game - tap to agree`)
      : L('Das ganze Spiel aufgeben (alle aktiven Spieler müssen zustimmen)', 'Forfeit the whole game (all active players must agree)');
    // Ask everyone visibly: when a proposal appears (or grows) and I haven't
    // agreed yet, pop a toast so no one misses that they are being asked.
    if (lastState.phase === 'playing' && forfeitVotes.length > prevForfeitVoteCount && !iVotedForfeit && iSeatedForfeit) {
      showToast(
        L(`🏳️ Spiel aufgeben vorgeschlagen (${forfeitVotes.length}/${humansForfeit}) - tippe auf 🏳️, um zuzustimmen.`,
          `🏳️ Forfeit proposed (${forfeitVotes.length}/${humansForfeit}) - tap 🏳️ to agree.`),
        { priority: true }
      );
    }
    prevForfeitVoteCount = forfeitVotes.length;

    if (lastState.mustLayOffCardId && isMyTurn) {
      // WICHTIG bleibt persistent sichtbar
      showHint(L('Pflicht: Die aufgenommene Ablagekarte muss zuerst ausgelegt/angelegt werden.', 'Required: the picked-up discard must be melded first.'), false);
    } else if (isMyTurn && lastState.turnPhase === 'meld') {
      // Der allgemeine Bedien-Tipp wandert in einen einmaligen Toast pro Zug -
      // so kann die Action-Leiste auch im eigenen Zug einklappen.
      clearHintIfNotError();
      const turnKey = `${lastState.roundNumber}-${lastState.turnIndexInRound}`;
      if (gameTipsEnabled && tipShownForTurn !== turnKey && selectedCardIds.size === 0) {
        tipShownForTurn = turnKey;
        showToast(L('Tipp: 3+ Karten auswählen zum Auslegen, 1 Karte + „Abwerfen", oder Karte wählen und auf eine grün markierte Auslage tippen.', 'Tip: select 3+ cards to meld, 1 card + "Discard", or select a card and tap a green-highlighted meld.'));
      }
    } else {
      clearHintIfNotError();
    }

    // Platz sparen: die Action-Leiste komplett einklappen, wenn sie nichts
    // Sichtbares enthaelt (der Aufgeben-Button lebt jetzt ueber der Hand).
    // WICHTIG: erst NACH der Hint-Logik pruefen, sonst zaehlt der alte Text.
    const actionBarEmpty =
      !showMeldControls && !showDiscardBtn && selectedCardIds.size === 0 && !el('hint').textContent;
    el('actionBar').classList.toggle('collapsed', actionBarEmpty);

    // Log
    const logEntries = el('logEntries');
    logEntries.innerHTML = '';
    (lastState.log || [])
      .slice()
      .reverse()
      .forEach((entry) => {
        const d = document.createElement('div');
        d.textContent = trs(entry.text);
        logEntries.appendChild(d);
      });
  }

  const RANK_ORDER = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];

  // --- Anlege-Hinweise: passt die AUSGEWÄHLTE Karte an eine eigene Auslage? ---
  // Bewusst KONSERVATIV (falsche Negative sind ok, falsche grüne Rahmen
  // nicht): Nur eindeutige Fälle werden markiert; die verbindliche Prüfung
  // macht weiterhin der Server. Joker-Handkarten werden nicht gehintet.
  function slotRank(s) { return s.real ? s.real.rank : s.representsRank; }
  function slotSuit(s) { return s.real ? s.real.suit : s.representsSuit; }
  // Multi lay-off: can ALL selected cards go onto this meld together?
  // Greedy simulation on a lightweight copy - pure ADDING only (no joker
  // swaps, no jokers), mirroring the server's layOffCards exactly so the
  // green highlight never promises something the server would reject.
  function cardsFitMeldTogether(meld, cards) {
    if (!cards.length || cards.some((cd) => cd.isJoker)) return false;
    // Reject cards that would only "fit" via a joker swap
    const isSwapOnly = (m, cd) =>
      m.slots.some((s) => s.joker && s.representsRank === cd.rank && s.representsSuit === cd.suit) &&
      !cardFitsMeldPureAdd(m, cd);
    let sim = { ...meld, slots: meld.slots.slice() };
    const remaining = cards.slice();
    while (remaining.length > 0) {
      const idx = remaining.findIndex((cd) => !isSwapOnly(sim, cd) && cardFitsMeldPureAdd(sim, cd));
      if (idx === -1) return false;
      const cd = remaining[idx];
      if (sim.type === 'set') {
        sim.slots = [...sim.slots, { real: cd }];
      } else {
        // run: attach at the matching end (ring order)
        const rIdx = (r) => RANK_ORDER.indexOf(r);
        const first = slotRank(sim.slots[0]);
        const prev = RANK_ORDER[(rIdx(first) - 1 + 13) % 13];
        sim.slots = cd.rank === prev ? [{ real: cd }, ...sim.slots] : [...sim.slots, { real: cd }];
      }
      remaining.splice(idx, 1);
    }
    return true;
  }
  // Pure-add check: cardFitsMeld minus the joker-swap shortcut
  function cardFitsMeldPureAdd(meld, card) {
    if (!card || card.isJoker) return false;
    if (meld.type === 'set') {
      if (card.rank !== meld.rank || meld.slots.length >= 8) return false;
      const sameSuit = meld.slots.filter((s) => slotSuit(s) === card.suit).length;
      return sameSuit < 2;
    }
    if (meld.type === 'run') {
      if (meld.slots.length >= 13) return false;
      if (card.suit !== slotSuit(meld.slots[0])) return false;
      const idx = (r) => RANK_ORDER.indexOf(r);
      const first = slotRank(meld.slots[0]);
      const last = slotRank(meld.slots[meld.slots.length - 1]);
      const prev = RANK_ORDER[(idx(first) - 1 + 13) % 13];
      const next = RANK_ORDER[(idx(last) + 1) % 13];
      return card.rank === prev || card.rank === next;
    }
    return false;
  }

  function cardFitsMeld(meld, card) {
    if (!card || card.isJoker) return false;
    // Exakter Joker-Tausch: Karte entspricht genau dem, was ein Joker vertritt
    if (meld.slots.some((s) => s.joker && s.representsRank === card.rank && s.representsSuit === card.suit)) {
      return true;
    }
    if (meld.type === 'set') {
      if (card.rank !== meld.rank || meld.slots.length >= 8) return false;
      const sameSuit = meld.slots.filter((s) => slotSuit(s) === card.suit).length;
      return sameSuit < 2; // 2 Decks: jede Farbe maximal doppelt
    }
    if (meld.type === 'run') {
      if (meld.slots.length >= 13) return false;
      if (card.suit !== slotSuit(meld.slots[0])) return false;
      // Ring-Folge: anlegbar an beiden Enden (K-A-2 ist gültig)
      const idx = (r) => RANK_ORDER.indexOf(r);
      const first = slotRank(meld.slots[0]);
      const last = slotRank(meld.slots[meld.slots.length - 1]);
      const prev = RANK_ORDER[(idx(first) - 1 + 13) % 13];
      const next = RANK_ORDER[(idx(last) + 1) % 13];
      return card.rank === prev || card.rank === next;
    }
    return false;
  }

  function phaseLabel(phase) {
    return phase === 'draw' ? 'Karte ziehen' : 'Auslegen/Abwerfen';
  }

  let hintIsError = false;
  function showHint(text, isError) {
    el('hint').textContent = text;
    el('hint').classList.toggle('error', !!isError);
    hintIsError = isError;
    if (isError) {
      sound.error();
      setTimeout(() => {
        if (hintIsError) {
          el('hint').textContent = '';
          hintIsError = false;
          el('hint').classList.remove('error');
        }
      }, 3000);
    }
  }
  function clearHintIfNotError() {
    if (!hintIsError) el('hint').textContent = '';
  }

  let confettiShownForRound = null;
  function launchConfetti() {
    if (reducedMotion) return;
    const overlay = el('resultOverlay');
    // Card-suit rain on top of the classic confetti: spades & co. tumble
    // down in the deck's own colours - the win feels like Pik Dame.
    const suits = ['♠', '♥', '♦', '♣', '♛'];
    for (let i = 0; i < 16; i++) {
      const s = document.createElement('span');
      s.className = 'spadeRainPiece';
      const glyph = suits[i % suits.length];
      s.textContent = glyph;
      s.style.color = glyph === '♥' || glyph === '♦' ? 'var(--suit-red)' : 'rgba(255,255,255,0.92)';
      if (glyph === '♛') s.style.color = 'var(--accent)';
      s.style.setProperty('--x', `${Math.random() * 100}%`);
      s.style.setProperty('--sz', `${14 + Math.random() * 17}px`);
      s.style.setProperty('--dur', `${2.2 + Math.random() * 1.5}s`);
      s.style.setProperty('--delay', `${Math.random() * 0.8}s`);
      s.style.setProperty('--driftX', `${(Math.random() - 0.5) * 140}px`);
      s.style.setProperty('--spin', `${(Math.random() - 0.5) * 480}deg`);
      overlay.appendChild(s);
      setTimeout(() => s.remove(), 5200);
    }
    const colors = ['#2fd6b0', '#8f90f8', '#ff9f5a', '#ff7d8c', '#f5d76e'];
    for (let i = 0; i < 46; i++) {
      const p = document.createElement('div');
      p.className = 'confetti';
      p.style.left = `${Math.random() * 100}%`;
      p.style.background = colors[i % colors.length];
      p.style.animationDelay = `${Math.random() * 0.7}s`;
      p.style.animationDuration = `${1.7 + Math.random() * 1.3}s`;
      p.style.setProperty('--drift', `${(Math.random() - 0.5) * 120}px`);
      if (Math.random() > 0.5) p.style.borderRadius = '50%';
      overlay.appendChild(p);
      setTimeout(() => p.remove(), 3400);
    }
  }

  function renderResultOverlay() {
    const forfeited = lastState.phase === 'gameOver' && lastState.gameOverInfo && lastState.gameOverInfo.forfeited;
    if (!lastState.lastRoundResult && !forfeited) return;
    el('resultOverlay').classList.remove('hidden');
    // Konfetti, wenn ICH die Runde gewonnen habe (einmal pro Runde)
    const winKey = `${lastState.roundNumber}`;
    const myResult = lastState.lastRoundResult && lastState.lastRoundResult[playerId];
    if (myResult && myResult.breakdown && myResult.breakdown.isWinner && confettiShownForRound !== winKey) {
      confettiShownForRound = winKey;
      launchConfetti();
    }
    const isGameOver = lastState.phase === 'gameOver';
    el('resultTitle').textContent = forfeited
      ? L('🏳️ Spiel aufgegeben', '🏳️ Game forfeited')
      : isGameOver ? L('Spielende!', 'Game over!') : L('Rundenende', 'End of round');

    const body = el('resultBody');
    body.innerHTML = '';

    // Zwei Reiter: „Ergebnis" (Standard) und „Statistik" (Detail-Tabelle,
    // Punkteverlauf, Partie-Totals). Vorher stand alles untereinander - bei
    // 4 Spielern rutschte der Weiter-Knopf unter den Falz und man musste
    // scrollen, um die nächste Runde zu bestätigen.
    const paneResult = document.createElement('div');
    paneResult.className = 'resultPane';
    const paneStats = document.createElement('div');
    paneStats.className = 'resultPane hidden';
    const tabBar = document.createElement('div');
    tabBar.className = 'resultTabs';
    const tabResultBtn = document.createElement('button');
    tabResultBtn.type = 'button';
    tabResultBtn.className = 'resultTabBtn active';
    tabResultBtn.textContent = L('Ergebnis', 'Result');
    const tabStatsBtn = document.createElement('button');
    tabStatsBtn.type = 'button';
    tabStatsBtn.className = 'resultTabBtn';
    tabStatsBtn.textContent = L('📈 Statistik', '📈 Stats');
    const selectResultTab = (which) => {
      tabResultBtn.classList.toggle('active', which === 'result');
      tabStatsBtn.classList.toggle('active', which === 'stats');
      paneResult.classList.toggle('hidden', which !== 'result');
      paneStats.classList.toggle('hidden', which !== 'stats');
    };
    tabResultBtn.addEventListener('click', () => selectResultTab('result'));
    tabStatsBtn.addEventListener('click', () => selectResultTab('stats'));
    tabBar.append(tabResultBtn, tabStatsBtn);
    body.append(tabBar, paneResult, paneStats);

    if (forfeited) {
      const note = document.createElement('p');
      note.className = 'handAusNote';
      note.textContent = L(
        '🏳️ Das Spiel wurde einvernehmlich aufgegeben - alle aktiven Spieler waren einverstanden. Kein Sieger, das Spiel wird nicht gewertet.',
        '🏳️ The game was forfeited by mutual agreement - all active players agreed. No winner, the game is not recorded.'
      );
      paneResult.appendChild(note);
      const fTotals = (lastState.gameOverInfo && lastState.gameOverInfo.finalTotals) || lastState.totals || {};
      lastState.players
        .slice()
        .sort((a, b) => (fTotals[b.id] || 0) - (fTotals[a.id] || 0))
        .forEach((p) => {
          const row = document.createElement('div');
          row.className = 'resultRow';
          row.innerHTML = `<span>${nameWithHeart(p.name)}${p.isBot ? ' 🤖' : ''}</span><span>${L('Gesamt', 'Total')}: ${fTotals[p.id] || 0}</span>`;
          paneResult.appendChild(row);
        });
    }

    if (!forfeited && lastState.lastRoundWasHandAus) {
      const handAusNote = document.createElement('p');
      handAusNote.className = 'handAusNote';
      handAusNote.textContent = L('🎉 Hand aus! Die komplette Rundenwertung zählt doppelt.', '🎉 Out in one! The entire round score counts double.');
      paneResult.appendChild(handAusNote);
    }
    if (!forfeited && lastState.lastRoundResult) {
      lastState.players.forEach((p) => {
        const r = lastState.lastRoundResult[p.id];
        const row = document.createElement('div');
        row.className = 'resultRow' + (r && r.breakdown.isWinner ? ' winner' : '');
        const total = lastState.totals[p.id] || 0;
        row.innerHTML = `<span>${nameWithHeart(p.name)}${p.isBot ? ' 🤖' : ''}</span><span>${r ? r.roundScore : 0} ${L('Pkt', 'pts')} (${L('Gesamt', 'total')}: ${total})</span>`;
        paneResult.appendChild(row);
      });
    }

    // Rundenstatistiken (Details)
    if (!forfeited && lastState.lastRoundStats) {
      const statsTable = document.createElement('table');
      statsTable.className = 'statsTable';
      // ♠Q/🃏 zeigen die AUSGELEGTEN Karten (die Hand-Zaehler waren am
      // Rundenende fast immer 0 - deshalb wirkten die Spalten 'kaputt').
      // Fallback ?? 0 fuer Runden, die vor diesem Update gespielt wurden.
      statsTable.innerHTML = `
        <thead><tr><th>${L('Spieler', 'Player')}</th><th>${L('Runde', 'Round')}</th><th>${L('Ausgelegt', 'Melded')}</th><th>${L('Auf Hand', 'In hand')}</th><th title="${L('Pik Damen ausgelegt', 'Queens of Spades melded')}">♠Q</th><th title="${L('Joker ausgelegt', 'Jokers melded')}">🃏</th></tr></thead>
        <tbody>${lastState.lastRoundStats
          .map((s) => {
            const r = lastState.lastRoundResult && lastState.lastRoundResult[s.id];
            const delta = r ? r.roundScore : null;
            const deltaCell =
              delta === null
                ? '–'
                : delta > 0
                  ? `<span class="deltaUp">+${delta} ▲</span>`
                  : delta < 0
                    ? `<span class="deltaDown">${delta} ▼</span>`
                    : '±0';
            return `<tr${s.id === lastState.lastRoundWinnerId ? ' class="winnerRow"' : ''}><td>${escapeHtml(s.name)}${s.id === lastState.lastRoundWinnerId ? ' 🏆' : ''}</td><td>${deltaCell}</td><td>${s.laidOutCount}</td><td>${s.handCount}</td><td>${s.pikDameLaidOut ?? 0}</td><td>${s.jokersLaidOut ?? 0}</td></tr>`;
          })
          .join('')}</tbody>`;
      paneStats.appendChild(statsTable);
    }

    // Punkteverlauf über alle Runden als kleines SVG-Chart (ab 2 Runden)
    const history = lastState.scoreHistory || [];
    if (history.length >= 2) {
      paneStats.appendChild(renderScoreChart(history));
    }

    if (isGameOver && !forfeited && lastState.gameOverInfo) {
      const winner = lastState.players.find((p) => p.id === lastState.gameOverInfo.winnerId);
      const winLine = document.createElement('p');
      winLine.innerHTML = `<strong>🏆 ${L(`${escapeHtml(winner ? winner.name : '?')} gewinnt das Spiel!`, `${escapeHtml(winner ? winner.name : '?')} wins the game!`)}</strong>`;
      paneResult.appendChild(winLine);
      // Nice visual stat: how many turns (and rounds) the whole game took.
      const gi = lastState.gameOverInfo;
      if (typeof gi.totalTurns === 'number') {
        const statLine = document.createElement('p');
        statLine.className = 'gameOverStats';
        const rounds = gi.totalRounds || 0;
        statLine.textContent = L(
          `🎲 ${gi.totalTurns} Züge in ${rounds} ${rounds === 1 ? 'Runde' : 'Runden'}`,
          `🎲 ${gi.totalTurns} turns across ${rounds} ${rounds === 1 ? 'round' : 'rounds'}`
        );
        paneResult.appendChild(statLine);
      }
    }

    el('exportGameBtn').classList.toggle('hidden', !(isGameOver && lastState.hasExportableGame));
    el('replayBtn').classList.toggle('hidden', !(isGameOver && lastState.hasExportableGame));
    if (isGameOver) renderChallengeBoard();
    // Toggleable game totals: how many Queens of Spades / jokers each
    // player melded across the WHOLE game.
    const oldTotals = el('resultBody').querySelector('.gameTotalsBox');
    if (oldTotals) oldTotals.remove();
    if (isGameOver && lastState.gameStatsTotals && Object.keys(lastState.gameStatsTotals).length > 0) {
      const box = document.createElement('div');
      box.className = 'gameTotalsBox';
      const tBtn = document.createElement('button');
      tBtn.className = 'btn-secondary';
      tBtn.textContent = L('♠Q & 🃏 der Partie anzeigen', 'Show game totals ♠Q & 🃏');
      const tbl = document.createElement('table');
      tbl.className = 'statsTable hidden';
      const rows = (lastState.players || [])
        .map((p) => ({ name: p.name, t: lastState.gameStatsTotals[p.id] || { pikDames: 0, jokers: 0 } }))
        .sort((a, b) => b.t.pikDames - a.t.pikDames || b.t.jokers - a.t.jokers)
        .map((r) => `<tr><td>${escapeHtml(r.name)}</td><td>${r.t.pikDames > 0 ? '♠'.repeat(r.t.pikDames) : '–'}</td><td>${r.t.jokers > 0 ? '🃏'.repeat(Math.min(r.t.jokers, 8)) + (r.t.jokers > 8 ? '×' + r.t.jokers : '') : '–'}</td></tr>`)
        .join('');
      tbl.innerHTML = `<thead><tr><th>${L('Spieler', 'Player')}</th><th>${L('♠Q ausgelegt', '♠Q melded')}</th><th>${L('🃏 ausgelegt', '🃏 melded')}</th></tr></thead><tbody>${rows}</tbody>`;
      tBtn.addEventListener('click', () => {
        const nowHidden = tbl.classList.toggle('hidden');
        tBtn.textContent = nowHidden ? L('♠Q & 🃏 der Partie anzeigen', 'Show game totals ♠Q & 🃏') : L('♠Q & 🃏 ausblenden', 'Hide game totals');
      });
      box.appendChild(tBtn);
      box.appendChild(tbl);
      paneStats.appendChild(box);
    }
    // 🎖️ Frisch verdiente Erfolge feiern (kommen per Server-Nachricht)
    const oldBadgeBox = el('resultBody').querySelector('.badgeBox');
    if (oldBadgeBox) oldBadgeBox.remove();
    if (isGameOver && lastEarnedBadges && lastEarnedBadges.length > 0) {
      const box = document.createElement('div');
      box.className = 'badgeBox';
      box.innerHTML = `<h3>🎖️ ${L('Neue Erfolge', 'New achievements')}</h3>`;
      for (const entry of lastEarnedBadges) {
        for (const id of entry.badges) {
          const m = badgeMeta(id);
          const row = document.createElement('div');
          row.className = 'badgeRow';
          row.innerHTML = `<span class="badgeEmoji">${m.emoji}</span><span><b>${escapeHtml(entry.name)}</b>: ${m.name} – <span class="badgeDesc">${m.desc}</span></span>`;
          box.appendChild(row);
        }
      }
      paneResult.appendChild(box);
    }

    // Statistik-Reiter nur anbieten, wenn er auch Inhalt hat (z. B. nicht
    // nach einem aufgegebenen Spiel).
    if (!paneStats.childNodes.length) tabBar.classList.add('hidden');

    // Ready check: at round end EVERY connected human confirms before the
    // next round starts - the button shows who the table is waiting for.
    const contBtn = el('resultContinueBtn');
    el('resultHomeBtn').classList.toggle('hidden', !isGameOver); // main menu only after the match
    // Forfeit the whole game straight from the points overview (round end only,
    // not once the game is already over). Same unanimous vote as in-game.
    const rfBtn = el('resultForfeitBtn');
    const rfSeated = lastState.players.some((p) => p.id === playerId && !p.isBot);
    const showRoundEndForfeit = lastState.phase === 'roundEnd' && rfSeated && !forfeited;
    rfBtn.classList.toggle('hidden', !showRoundEndForfeit);
    if (showRoundEndForfeit) {
      const fv = lastState.forfeitVotes || [];
      const hc = lastState.players.filter((p) => !p.isBot && p.connected !== false).length;
      rfBtn.classList.toggle('active', fv.includes(playerId));
      rfBtn.textContent = fv.length
        ? L(`🏳️ Aufgeben (${fv.length}/${hc})`, `🏳️ Forfeit (${fv.length}/${hc})`)
        : L('🏳️ Spiel aufgeben', '🏳️ Forfeit game');
    }
    if (isGameOver) {
      contBtn.disabled = false;
      contBtn.textContent = L('Neue Partie (Rematch)', 'New game (rematch)');
    } else {
      const humans = (lastState.players || []).filter((p) => !p.isBot && p.connected);
      const ready = new Set(lastState.nextRoundReady || []);
      const iAmReady = ready.has(playerId);
      contBtn.disabled = iAmReady;
      if (humans.length <= 1) {
        contBtn.textContent = L('Nächste Runde', 'Next round');
      } else if (iAmReady) {
        const waiting = humans.filter((h) => !ready.has(h.id)).map((h) => h.name).join(', ');
        contBtn.textContent = L(`Warte auf ${waiting}…`, `Waiting for ${waiting}…`);
      } else {
        const n = humans.filter((h) => ready.has(h.id)).length;
        contBtn.textContent = L(`Nächste Runde (${n}/${humans.length} bereit)`, `Next round (${n}/${humans.length} ready)`);
      }
    }
  }

  // --- Interaktion ---------------------------------------------------------

  function onHandCardClick(card) {
    if (!lastState) return;
    const isMyTurn = lastState.currentPlayerId === playerId;
    updateTurnTitleNotice(isMyTurn && lastState.phase === 'playing');
    if (!isMyTurn || lastState.turnPhase !== 'meld') return;

    if (selectedCardIds.has(card.id)) {
      selectedCardIds.delete(card.id);
    } else {
      selectedCardIds.add(card.id);
    }
    render();
  }

  function onMeldCardClick(meld) {
    if (!lastState) return;
    const isMyTurn = lastState.currentPlayerId === playerId;
    updateTurnTitleNotice(isMyTurn && lastState.phase === 'playing');
    if (!isMyTurn || lastState.turnPhase !== 'meld') return;

    if (selectedCardIds.size === 1) {
      const cardId = [...selectedCardIds][0];
      // Enthält die Auslage einen Joker, der GENAU die gewählte Handkarte
      // repräsentiert, ist der Joker-Tausch gemeint (exakt dieselbe Prüfung
      // wie tryJokerSwap auf dem Server). Andernfalls normales Anlegen.
      const myPlayer = lastState.players.find((p) => p.id === playerId);
      const card = myPlayer && myPlayer.hand ? myPlayer.hand.find((c) => c.id === cardId) : null;
      const matchesJokerSlot =
        card && !card.isJoker &&
        meld.slots.some((s) => s.joker && s.representsRank === card.rank && s.representsSuit === card.suit);
      if (matchesJokerSlot) {
        send({ type: 'swapJoker', meldId: meld.id, handCardId: cardId });
      } else {
        send({ type: 'layOff', meldId: meld.id, cardId });
      }
      // Selection is reconciled on the next state update: it clears only if the
      // card actually left the hand. A rejected lay-off keeps it selected so it
      // can be retargeted at another meld without reselecting.
    } else if (selectedCardIds.size > 1) {
      // Multiple cards: lay them all off in one tap (server validates
      // all-or-nothing and finds the working order, e.g. J before Q).
      send({ type: 'layOffMulti', meldId: meld.id, cardIds: [...selectedCardIds] });
    } else {
      showHint(L('Wähle mindestens eine Handkarte aus, um sie an diese Auslage anzulegen (mehrere passende Karten gehen mit einem Tipp).', 'Select at least one hand card to add it to this meld (several fitting cards go in one tap).'), false);
    }
  }

  el('nameInput').value = myName;
  if (sessionCode) el('codeInput').value = sessionCode;

  function currentName() {
    myName = el('nameInput').value.trim() || `Spieler${Math.floor(Math.random() * 1000)}`;
    storageSet(NAME_KEY, myName);
    return myName;
  }

  el('createGameBtn').addEventListener('click', () => {
    send({ type: 'createSession', name: currentName(), accountToken: accountToken() || undefined });
  });

  // Desktop-Tastatur: Enter im Code-Feld tritt bei, Enter im Namensfeld
  // erstellt ein Spiel (bzw. tritt bei, wenn schon ein Code eingegeben ist).
  el('codeInput').addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') el('joinGameBtn').click();
  });
  el('nameInput').addEventListener('keydown', (ev) => {
    if (ev.key !== 'Enter') return;
    if (el('codeInput').value.trim()) el('joinGameBtn').click();
    else el('createGameBtn').click();
  });

  el('joinGameBtn').addEventListener('click', () => {
    const code = el('codeInput').value.trim().toUpperCase();
    if (!code) {
      showHint(L('Bitte den Spiel-Code eingeben.', 'Please enter the game code.'), true);
      return;
    }
    const storedId = storageGet(playerKeyFor(code));
    send({ type: 'joinSession', code, name: currentName(), playerId: storedId || undefined, playerToken: storageGet(tokenKeyFor(code)) || undefined, accountToken: accountToken() || undefined });
  });

  el('updateNameBtn').addEventListener('click', () => {
    if (!sessionCode || !playerId) return;
    send({ type: 'joinSession', code: sessionCode, playerId, playerToken: storageGet(tokenKeyFor(sessionCode)) || undefined, name: currentName(), accountToken: accountToken() || undefined });
  });

  el('shareCodeBtn').addEventListener('click', async () => {
    if (!sessionCode) return;
    const url = new URL(window.location.href);
    url.searchParams.set('session', sessionCode);
    const shareData = {
      title: 'Pik Dame',
      text: `Spiel mit! Code: ${sessionCode}`,
      url: url.toString(),
    };
    if (navigator.share) {
      try {
        await navigator.share(shareData);
      } catch (e) {
        /* Nutzer hat das Teilen abgebrochen */
      }
    } else if (navigator.clipboard) {
      await navigator.clipboard.writeText(`${shareData.text} - ${shareData.url}`);
      showHint(L('Link kopiert!', 'Link copied!'), false);
    }
  });

  function renderSessionBanner() {
    const inSession = !!sessionCode && !!playerId;
    el('sessionSetup').classList.toggle('hidden', inSession);
    el('sessionBanner').classList.toggle('hidden', !inSession);
    if (inSession) {
      el('sessionCodeText').textContent = sessionCode;
      el('startBtn').disabled = false;
    }
  }
  renderSessionBanner();

  el('startBtn').addEventListener('click', () => {
    send({ type: 'startGame', houseRules: collectHouseRules() });
  });


  el('uiScaleBtn').addEventListener('click', cycleUiScale);
  el('uiScaleBtnLobby').addEventListener('click', cycleUiScale);
  el('langBtnLobby').addEventListener('click', cycleLang);
  applyStaticLang();

  el('handToggleBtn').addEventListener('click', () => {
    handCollapsed = !handCollapsed;
    updateHandToggle();
  });
  function updateHandToggle() {
    el('handWrapper').classList.toggle('handCollapsed', handCollapsed);
    if (handCollapsed) {
      const me = lastState && lastState.players.find((p) => p.id === playerId);
      const n = me && me.hand ? me.hand.length : 0;
      el('handToggleBtn').textContent = L(`⌃ ${n} Karten`, `⌃ ${n} cards`);
    } else {
      el('handToggleBtn').textContent = '⌄';
    }
  }

  el('sortToggleBtn').addEventListener('click', () => {
    handSortMode = handSortMode === 'suit' ? 'rank' : 'suit';
    storageSet(SORT_KEY, handSortMode);
    updateSortToggleLabel();
    render();
  });
  function updateSortToggleLabel() {
    // One-shot deal-in: on the first render of a fresh round the cards fly
    // in from the draw-pile direction, staggered, and settle into their own
    // fan transform (the dealIn keyframe only defines FROM).
    if (
      lastState && // the sort-label updater also runs ONCE at init, pre-state!
      lastState.phase === 'playing' &&
      dealAnimatedForRound !== lastState.roundNumber &&
      pendingDealCards.length > 0 &&
      !reducedMotion
    ) {
      dealAnimatedForRound = lastState.roundNumber;
      const pileRect = el('drawPile').getBoundingClientRect();
      pendingDealCards.forEach((cardEl, idx) => {
        const r = cardEl.getBoundingClientRect();
        cardEl.style.setProperty('--deal-dx', `${pileRect.left + pileRect.width / 2 - (r.left + r.width / 2)}px`);
        cardEl.style.setProperty('--deal-dy', `${pileRect.top + pileRect.height / 2 - (r.top + r.height / 2)}px`);
        cardEl.style.setProperty('--deal-delay', `${idx * 34}ms`);
        cardEl.classList.add('deal-in');
        cardEl.addEventListener('animationend', () => cardEl.classList.remove('deal-in'), { once: true });
      });
    }
    pendingDealCards = [];

    el('sortToggleBtn').textContent = handSortMode === 'suit' ? L('⇅ ♠♥ Farbe', '⇅ ♠♥ Suit') : L('⇅ 77 Wert', '⇅ 77 Rank');
    el('sortToggleBtn').title = handSortMode === 'suit'
      ? L('Sortiert nach Farbe (gut für Folgen) - tippen für Wert', 'Sorted by suit (good for runs) - tap for rank')
      : L('Sortiert nach Wert (gut für Sätze) - tippen für Farbe', 'Sorted by rank (good for sets) - tap for suit');
  }
  updateSortToggleLabel();

  el('drawPile').addEventListener('click', () => {
    if (el('drawPile').classList.contains('disabled')) return;
    sound.draw();
    flyCard(el('drawPile'), el('hand'), true);
    send({ type: 'drawFromPile' });
  });

  el('discardPile').addEventListener('click', () => {
    if (el('discardPile').classList.contains('disabled')) return;
    sound.draw();
    flyCard(el('discardPile'), el('hand'), false);
    send({ type: 'drawFromDiscard' });
  });

  function performDiscard(cardId) {
    sound.discard();
    const selectedEl = document.querySelector('#hand .card.selected');
    flyCard(selectedEl, el('discardPile'), false);
    send({ type: 'discard', cardId });
    selectedCardIds.clear();
    render();
  }

  el('discardBtn').addEventListener('click', () => {
    if (selectedCardIds.size !== 1) return;
    const cardId = [...selectedCardIds][0];
    // Abwurf-Schutz: Pik Dame (100 Punkte!) und Joker nicht aus Versehen
    // abwerfen - der Gegner würde sich freuen.
    const myPlayer = lastState && lastState.players.find((p) => p.id === playerId);
    const card = myPlayer && myPlayer.hand ? myPlayer.hand.find((cd) => cd.id === cardId) : null;
    const isPikDame = card && card.rank === 'Q' && card.suit === 'S';
    if (card && (isPikDame || card.isJoker)) {
      el('confirmDiscardTitle').textContent = isPikDame ? L('Pik Dame abwerfen?', 'Discard the Queen of Spades?') : L('Joker abwerfen?', 'Discard the joker?');
      el('confirmDiscardText').textContent = isPikDame
        ? L('Die Pik Dame ist 100 Punkte wert - und der nächste Spieler könnte sie aufnehmen!', 'The Queen of Spades is worth 100 points - and the next player could pick her up!')
        : L('Der Joker ist die flexibelste Karte im Spiel - und der nächste Spieler könnte ihn aufnehmen!', 'The joker is the most flexible card in the game - and the next player could pick it up!');
      pendingConfirmDiscardId = cardId;
      el('confirmDiscardOverlay').classList.remove('hidden');
      return;
    }
    performDiscard(cardId);
  });

  let pendingConfirmDiscardId = null;
  el('confirmDiscardYesBtn').addEventListener('click', () => {
    el('confirmDiscardOverlay').classList.add('hidden');
    if (pendingConfirmDiscardId) performDiscard(pendingConfirmDiscardId);
    pendingConfirmDiscardId = null;
  });
  el('confirmDiscardNoBtn').addEventListener('click', () => {
    el('confirmDiscardOverlay').classList.add('hidden');
    pendingConfirmDiscardId = null;
  });

  el('forfeitBtn').addEventListener('click', () => {
    if (!lastState || lastState.phase !== 'playing') return;
    const seated = lastState.players.some((p) => p.id === playerId && !p.isBot);
    if (!seated) return;
    const votes = lastState.forfeitVotes || [];
    const iVoted = votes.includes(playerId);
    // First proposal asks everyone to end the round - confirm it. Agreeing to an
    // existing proposal (or withdrawing) just toggles, no dialog.
    if (!iVoted && votes.length === 0) {
      const ok = window.confirm(
        L('Das ganze Spiel aufgeben? Die Partie endet nur, wenn ALLE aktiven Spieler zustimmen - dann wird das Spiel sofort abgebrochen (kein Sieger, keine Wertung).',
          'Forfeit the whole game? The match only ends if ALL active players agree - then the game is aborted immediately (no winner, not recorded).')
      );
      if (!ok) return;
    }
    sound.discard();
    send({ type: 'forfeitRound' }); // toggles my forfeit vote
  });

  el('confirmMeldBtn').addEventListener('click', () => {
    if (selectedCardIds.size < 3) return;
    sound.meld();
    send({ type: 'layoutMeld', cardIds: [...selectedCardIds] });
    // Reconciled on the next state update - a rejected meld keeps the cards
    // selected so they can be adjusted instead of reselected from scratch.
  });

  el('clearSelectionBtn').addEventListener('click', () => {
    selectedCardIds.clear();
    render();
  });

  el('logToggle').addEventListener('click', () => {
    el('logPanel').classList.toggle('hidden');
  });

  el('tipsToggle').addEventListener('click', () => {
    setTipsEnabled(!gameTipsEnabled);
    showToast(
      gameTipsEnabled
        ? L('Spiel-Tipps sind wieder an.', 'Game tips are back on.')
        : L('Spiel-Tipps sind aus. Wieder einschalten: 💤 hinterm Zahnrad.', 'Game tips are off. Re-enable via 💤 behind the gear.')
    );
  });
  el('soundToggle').addEventListener('click', () => {
    setSoundEnabled(!soundEnabled);
  });

  el('ruleSound').addEventListener('change', () => {
    setSoundEnabled(el('ruleSound').checked);
  });

  // Host changes to house rules sync LIVE so every player sees them and the
  // bots follow immediately (ruleSound stays local - it's a personal setting).
  ['ruleHandAus', 'ruleStrict1000', 'ruleTurnTimer'].forEach((id) => {
    el(id).addEventListener('change', () => {
      if (lastState && lastState.isHost && !lastState.challengeDate) send({ type: 'setHouseRules', houseRules: collectHouseRules() });
    });
  });

  // --- Turn-timer countdown: purely client-side ticking against the
  // server-provided deadline (zero extra server traffic) ----------------------
  // BATTERY: only tick while a countdown is ACTUALLY running and the app is
  // visible. Previously this woke the CPU every second forever - in the lobby,
  // at round end, with the timer off, and in the background. It now starts and
  // stops itself, so an idle app does no per-second work at all.
  function countdownWanted() {
    if (!lastState || document.hidden) return false;
    if (lastState.phase === 'playing' && lastState.turnDeadline) return true;
    if (lastState.phase === 'cutting' && lastState.cutDeadline) return true; // Abhebe-Frist
    return false;
  }
  function tickCountdown() {
    // Abheben: Restzeit im Overlay statt in der Zugleiste anzeigen.
    if (lastState && lastState.phase === 'cutting' && lastState.cutDeadline) {
      const rem = Math.max(0, Math.ceil((lastState.cutDeadline - Date.now()) / 1000));
      const n = el('cutCountdown');
      if (n) n.textContent = L(`Automatisch in ${rem}s`, `Auto-cut in ${rem}s`);
      return;
    }
    const el2 = el('turnInfo');
    if (!el2 || !lastState || !lastState.turnDeadline) return;
    const remaining = Math.max(0, Math.ceil((lastState.turnDeadline - Date.now()) / 1000));
    const base = el2.dataset.baseText || el2.textContent;
    el2.dataset.baseText = base;
    el2.textContent = `${base} ⏱${remaining}s`;
    el2.classList.toggle('timerUrgent', remaining <= 10);
  }
  function updateCountdownTimer() {
    if (countdownWanted()) {
      if (!countdownTimer) {
        tickCountdown(); // paint immediately, don't wait a second
        countdownTimer = setInterval(tickCountdown, 1000);
      }
    } else if (countdownTimer) {
      clearInterval(countdownTimer);
      countdownTimer = null;
    }
  }
  document.addEventListener('visibilitychange', updateCountdownTimer);

  // --- Home button + gear menu (Fishdom-style tidy header) -------------------
  el('settingsBtn').addEventListener('click', () => {
    el('settingsGroup').classList.toggle('hidden');
  });
  el('homeBtn').addEventListener('click', () => {
    el('homeOverlay').classList.remove('hidden');
  });
  el('homeCancelBtn').addEventListener('click', () => el('homeOverlay').classList.add('hidden'));
  el('homeOverlay').addEventListener('click', (ev) => {
    if (ev.target === el('homeOverlay')) el('homeOverlay').classList.add('hidden');
  });
  // Quick re-entry: remember the last table and offer one-tap resume on
  // the start screen (pairs with the home button - leave and come back).
  const LAST_SESSION_KEY = 'pikdame_last_session';
  function updateResumeButton() {
    // Never reveal the button from localStorage alone - a stored code may point
    // at a game that no longer exists. Keep it hidden and ask the server; the
    // 'sessionStatus' reply reveals it only when the game is still live.
    const last = storageGet(LAST_SESSION_KEY);
    const btn = el('resumeBtn');
    btn.classList.add('hidden');
    if (last && !sessionCode && ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'checkSession', code: last }));
    }
  }
  el('resumeBtn').addEventListener('click', () => {
    const last = storageGet(LAST_SESSION_KEY);
    if (last) window.location.href = `${window.location.pathname}?session=${encodeURIComponent(last)}`;
  });
  updateResumeButton();

  // Opened via a shared ?session=CODE link -> the visitor wants to JOIN, not
  // create. Hide "new game" and the menu chips, and pre-fill the code.
  if (urlSessionCode) {
    el('createGameBtn').classList.add('hidden');
    const chips = document.querySelector('#sessionSetup .menuChips');
    if (chips) chips.classList.add('hidden');
    const divider = document.querySelector('#sessionSetup .join-divider');
    if (divider) divider.classList.add('hidden');
    if (el('codeInput')) el('codeInput').value = urlSessionCode;
  }

  el('homeConfirmBtn').addEventListener('click', () => {
    // Back to the start screen: drop the ?session query and reload. The
    // per-session playerId stays in storage - re-entering the code later
    // reclaims the seat (a bot covers it after the grace period meanwhile).
    window.location.href = window.location.pathname;
  });
  // After the match: a direct way back to the main menu (rematch stays too).
  el('resultHomeBtn').addEventListener('click', () => {
    window.location.href = window.location.pathname;
  });

  // Forfeit the whole game from the round-end points overview (same unanimous
  // vote as the in-game 🏳️ button).
  el('resultForfeitBtn').addEventListener('click', () => {
    if (!lastState || lastState.phase !== 'roundEnd') return;
    if (!lastState.players.some((p) => p.id === playerId && !p.isBot)) return;
    const votes = lastState.forfeitVotes || [];
    if (!votes.includes(playerId) && votes.length === 0) {
      const ok = window.confirm(
        L('Das ganze Spiel aufgeben? Die Partie endet nur, wenn ALLE aktiven Spieler zustimmen - dann wird das Spiel sofort abgebrochen (kein Sieger, keine Wertung).',
          'Forfeit the whole game? The match only ends if ALL active players agree - then the game is aborted immediately (no winner, not recorded).')
      );
      if (!ok) return;
    }
    sound.discard();
    send({ type: 'forfeitRound' });
  });

  // --- Per-bot difficulty ---------------------------------------------------
  const BOT_DIFF = {
    easy: { icon: '🌱', label: () => L('Anfänger', 'Beginner'), hint: () => L('macht Anfängerfehler', 'makes beginner mistakes') },
    medium: { icon: '🙂', label: () => L('Fortgeschritten', 'Advanced'), hint: () => L('solides Familienspiel', 'solid family play') },
    zen: { icon: '🧘', label: () => L('Zen-Meister', 'Zen master'), hint: () => L('zählt die Karten mit', 'counts the cards') },
  };
  function openBotDiffOverlay(bot) {
    // Tages-Challenge: Bot-Stärke ist fest (Zen für alle) - Menü gar nicht anbieten.
    if (lastState && lastState.challengeDate) return;
    el('botDiffTitle').textContent = L(`Schwierigkeit: ${bot.name}`, `Difficulty: ${bot.name}`);
    const box = el('botDiffOptions');
    box.innerHTML = '';
    for (const [key, meta] of Object.entries(BOT_DIFF)) {
      const btn = document.createElement('button');
      if (key === bot.botDifficulty) btn.classList.add('current');
      btn.innerHTML = `<span class="diffIcon">${meta.icon}</span><span>${meta.label()}<small>${meta.hint()}</small></span>`;
      btn.addEventListener('click', () => {
        send({ type: 'setBotDifficulty', botId: bot.id, difficulty: key });
        el('botDiffOverlay').classList.add('hidden');
      });
      box.appendChild(btn);
    }
    el('botDiffOverlay').classList.remove('hidden');
  }
  el('botDiffCloseBtn').addEventListener('click', () => el('botDiffOverlay').classList.add('hidden'));
  el('botDiffOverlay').addEventListener('click', (ev) => {
    if (ev.target === el('botDiffOverlay')) el('botDiffOverlay').classList.add('hidden');
  });

  // --- Tutorial mode: contextual hints for first-time players --------------
  // Fully client-side (works offline in CodeApp): each rule is explained
  // the moment it first becomes relevant during a real game vs easy bots.
  let tutorialActive = storageGet('pikdame_tutorial') === 'on';
  let tutorialSeen = new Set();
  try { tutorialSeen = new Set(JSON.parse(storageGet('pikdame_tutorial_seen') || '[]')); } catch (e) { /* fresh start */ }
  let tutorialCurrentStep = null;

  const TUTORIAL_STEPS = [
    {
      key: 'lobby',
      when: (st) => st.phase === 'lobby',
      text: () => L(
        'Willkommen bei Pik Dame! 🎓 Ziel: alle Karten auslegen und die LETZTE Karte abwerfen. Tippe unten auf "Spiel starten" - freie Plätze übernehmen Bots.',
        'Welcome to Pik Dame! 🎓 Goal: meld all your cards and discard the LAST one. Tap "Start game" below - empty seats are filled by bots.'
      ),
    },
    {
      key: 'draw',
      when: (st, me, myTurn) => myTurn && st.turnPhase === 'draw',
      text: () => L(
        'Du bist dran! Ziehe eine Karte: verdeckt vom Stapel ODER nimm den Ablagestapel. Achtung beim Ablagestapel: Du bekommst ALLE Karten darin, und die oberste musst du sofort verwenden.',
        'Your turn! Draw a card: face-down from the stock OR take the discard pile. Careful with the pile: you get ALL of its cards, and you must use the top one immediately.'
      ),
    },
    {
      key: 'pickupRest',
      when: (st, me, myTurn) => myTurn && !!st.mustLayOffCardId,
      highlight: (st, me) => {
        const hl = { cardIds: [st.mustLayOffCardId], meldIds: [] };
        const card = me && me.hand ? me.hand.find((cd) => cd.id === st.mustLayOffCardId) : null;
        if (card) {
          for (const meld of st.tableMelds || []) {
            if (meld.ownerId === me.id && cardFitsMeld(meld, card)) hl.meldIds.push(meld.id);
          }
        }
        return hl;
      },
      text: () => L(
        'Ablagestapel genommen: Die oberste Karte MUSS jetzt zuerst in eine Auslage - danach kommt der Rest des Stapels auf deine Hand.',
        'Pile taken: the top card MUST go into a meld first - then the rest of the pile joins your hand.'
      ),
    },
    {
      key: 'meld',
      when: (st, me, myTurn) => myTurn && st.turnPhase === 'meld' && !st.mustLayOffCardId,
      highlight: (st, me) => {
        if (!me || !me.hand) return null;
        const combo = findTutorialMeld(me.hand);
        if (combo) return { cardIds: combo, meldIds: [] };
        // keine neue Kombination? Dann eine anlegbare Einzelkarte + ihr Ziel zeigen
        for (const meld of st.tableMelds || []) {
          if (meld.ownerId !== me.id) continue;
          const fit = me.hand.find((cd) => cardFitsMeld(meld, cd));
          if (fit) return { cardIds: [fit.id], meldIds: [meld.id] };
        }
        return null;
      },
      text: () => L(
        'Auslegen (freiwillig): Tippe 3+ Karten gleichen Werts (Satz) oder eine Folge derselben Farbe an und lege sie. Einzelkarten kannst du an DEINE eigenen Auslagen anlegen. Zum Schluss eine Karte abwerfen - das beendet den Zug.',
        'Melding (optional): tap 3+ cards of the same rank (set) or a same-suit run and lay them down. Single cards can be added to YOUR OWN melds. Finish by discarding one card - that ends your turn.'
      ),
    },
    {
      key: 'pikdame',
      when: (st, me) => me && me.hand && me.hand.some((cd) => cd.rank === 'Q' && cd.suit === 'S'),
      highlight: (st, me) => ({
        cardIds: me.hand.filter((cd) => cd.rank === 'Q' && cd.suit === 'S').map((cd) => cd.id),
        meldIds: [],
      }),
      text: () => L(
        'Du hältst die Pik Dame! ♠Q ausgelegt = +100 Punkte. Am Rundenende auf der Hand erwischt = -100. Werde sie rechtzeitig los - oder lege sie aus.',
        'You hold the Queen of Spades! ♠Q melded = +100 points. Caught in hand at round end = -100. Shed her in time - or meld her.'
      ),
    },
    {
      key: 'joker',
      when: (st, me) => me && me.hand && me.hand.some((cd) => cd.isJoker),
      highlight: (st, me) => ({
        cardIds: me.hand.filter((cd) => cd.isJoker).map((cd) => cd.id),
        meldIds: [],
      }),
      text: () => L(
        'Ein Joker! 🃏 Er ersetzt jede Karte in Sätzen und Folgen (20 Punkte). Abwerfen ist fast nie klug - und getauschte Joker sind dauerhaft aus dem Spiel.',
        'A joker! 🃏 It substitutes any card in sets and runs (20 points). Discarding one is almost never wise - and swapped jokers leave the game for good.'
      ),
    },
    {
      key: 'endgame',
      when: (st, me, myTurn) => st.phase === 'playing' && me && me.hand && me.hand.length <= 3 && me.hand.length > 0,
      text: () => L(
        'Fast geschafft! Wichtig: Ausmachen geht NUR, indem du deine letzte Karte ABWIRFST - nicht durch Auslegen der ganzen Hand.',
        'Almost there! Important: you can only go out by DISCARDING your last card - not by melding your whole hand.'
      ),
    },
    {
      key: 'roundend',
      when: (st) => st.phase === 'roundEnd',
      text: () => L(
        'Rundenende! Wertung: Ausgelegtes zählt PLUS, Restkarten auf der Hand MINUS. Ab 1000 Punkten endet die Partie. Wenn alle auf "Weiter" tippen, geht es in die nächste Runde.',
        'Round over! Scoring: melded cards count PLUS, cards left in hand MINUS. The game ends at 1000 points. Once everyone taps "Continue", the next round begins.'
      ),
    },
  ];

  /**
   * Findet EINE sicher legbare Kombination in der Hand für den Tutorial-Glow:
   * zuerst Sätze (3+ gleicher Rang, max. 2 pro Farbe - zwei Decks im Spiel),
   * dann einfache Folgen (gleiche Farbe, lückenlos). Bewusst konservativ:
   * ohne Joker und ohne Ring-Folgen (K-A-2) - lieber nichts markieren als
   * etwas Falsches. Der Server bleibt die einzige Regel-Autorität.
   */
  function findTutorialMeld(hand) {
    const real = hand.filter((cd) => !cd.isJoker);
    const byRank = {};
    for (const cd of real) (byRank[cd.rank] = byRank[cd.rank] || []).push(cd);
    for (const cards of Object.values(byRank)) {
      const perSuit = {};
      const pick = [];
      for (const cd of cards) {
        perSuit[cd.suit] = (perSuit[cd.suit] || 0) + 1;
        if (perSuit[cd.suit] <= 2) pick.push(cd);
      }
      if (pick.length >= 3) return pick.slice(0, 4).map((cd) => cd.id);
    }
    const ORDER = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
    const bySuit = {};
    for (const cd of real) (bySuit[cd.suit] = bySuit[cd.suit] || new Map()).set(cd.rank, cd);
    for (const m of Object.values(bySuit)) {
      let run = [];
      for (const r of ORDER) {
        if (m.has(r)) {
          run.push(m.get(r));
          if (run.length >= 3) return run.slice(-3).map((cd) => cd.id);
        } else run = [];
      }
    }
    return null;
  }

  let tutorialHighlight = null;
  function applyTutorialHighlight(hl) {
    document.querySelectorAll('.tutorialGlow').forEach((n) => n.classList.remove('tutorialGlow'));
    document.querySelectorAll('.tutorialGlowMeld').forEach((n) => n.classList.remove('tutorialGlowMeld'));
    if (!hl) return;
    for (const id of hl.cardIds || []) {
      const n = document.querySelector(`#hand [data-card-id="${CSS.escape(String(id))}"]`);
      if (n) n.classList.add('tutorialGlow');
    }
    for (const id of hl.meldIds || []) {
      const n = document.querySelector(`[data-meld-id="${CSS.escape(String(id))}"]`);
      if (n) n.classList.add('tutorialGlowMeld');
    }
  }

  function persistTutorial() {
    storageSet('pikdame_tutorial', tutorialActive ? 'on' : 'off');
    storageSet('pikdame_tutorial_seen', JSON.stringify([...tutorialSeen]));
  }

  function updateTutorial() {
    const banner = el('tutorialBanner');
    if (!tutorialActive || !lastState) {
      banner.classList.add('hidden');
      return;
    }
    const me = (lastState.players || []).find((p) => p.id === playerId);
    const myTurn = lastState.phase === 'playing' && lastState.currentPlayerId === playerId;
    const step = TUTORIAL_STEPS.find((s) => !tutorialSeen.has(s.key) && s.when(lastState, me, myTurn));
    // BUGFIX (v1.71): Ein Hinweis, dessen Situation vorbei ist (Bedingung wird
    // false oder ein anderer Step löst ihn ab), gilt als GESEHEN - vorher
    // wurde 'seen' nur beim aktiven Weiter-Klick gesetzt, wodurch z.B.
    // "Du bist dran!" jede Runde erneut auftauchte.
    const nextKey = step ? step.key : null;
    if (tutorialCurrentStep && tutorialCurrentStep !== nextKey) {
      tutorialSeen.add(tutorialCurrentStep);
      persistTutorial();
    }
    if (!step) {
      banner.classList.add('hidden');
      tutorialCurrentStep = null;
      tutorialHighlight = null;
      requestAnimationFrame(() => applyTutorialHighlight(null));
      // Everything explained once -> the tutorial retires itself.
      if (TUTORIAL_STEPS.every((s) => tutorialSeen.has(s.key))) {
        tutorialActive = false;
        persistTutorial();
      }
      return;
    }
    if (tutorialCurrentStep !== step.key) {
      tutorialCurrentStep = step.key;
      el('tutorialText').textContent = step.text();
    }
    banner.classList.remove('hidden');
    // Kontextuelle Markierung: die konkreten Karten (und ggf. die Ziel-
    // Auslage) glühen. Nach dem synchronen Render anwenden (rAF), weil das
    // Hand-/Auslagen-DOM bei jedem State neu aufgebaut wird.
    tutorialHighlight = typeof step.highlight === 'function' ? step.highlight(lastState, me) : null;
    requestAnimationFrame(() => applyTutorialHighlight(tutorialHighlight));
  }

  let lastChallengeBoard = null;
  function renderChallengeBoard() {
    if (!lastChallengeBoard) return;
    const body = el('resultBody');
    if (!body) return;
    const old2 = body.querySelector('.challengeBoardBox');
    if (old2) old2.remove();
    const b = lastChallengeBoard;
    const box = document.createElement('div');
    box.className = 'challengeBoardBox';
    const rows = (b.board || [])
      .map((e) => `<tr${e.rank === b.yourRank ? ' class="winnerRow"' : ''}><td>${e.rank}.</td><td>${escapeHtml(e.name)}</td><td>${e.score}</td></tr>`)
      .join('');
    box.innerHTML = `<h3>🗓️ ${L('Tages-Challenge', 'Daily challenge')} ${escapeHtml(b.date)}</h3>
      <p class="challengeYour">${L(`Dein Ergebnis: ${b.yourScore} Punkte${b.yourRank ? ` · Platz ${b.yourRank}` : ''}`, `Your result: ${b.yourScore} points${b.yourRank ? ` · rank ${b.yourRank}` : ''}`)}</p>
      <table class="statsTable"><tbody>${rows}</tbody></table>`;
    body.appendChild(box);
  }

  // --- Daily challenge --------------------------------------------------------
  el('challengeBtn').addEventListener('click', () => {
    // Explain first, play second: the cold start straight into a running
    // game left people wondering what was going on.
    el('challengeTopLine').textContent = '…';
    el('challengeIntroOverlay').classList.remove('hidden');
    fetch('/challengeboardz')
      .then((r) => r.json())
      .then((d) => {
        const top = d && d.board && d.board[0];
        el('challengeTopLine').textContent = top
          ? `🥇 ${top.name} – ${top.score} ${L('Punkte', 'points')}${d.board[1] ? `  ·  🥈 ${d.board[1].name} – ${d.board[1].score}` : ''}`
          : L('Noch niemand - sichere dir Platz 1!', 'Nobody yet - claim first place!');
      })
      .catch(() => {
        el('challengeTopLine').textContent = L('Bestenliste gerade nicht erreichbar.', 'Leaderboard unavailable right now.');
      });
  });
  el('challengeStartBtn').addEventListener('click', () => {
    el('challengeIntroOverlay').classList.add('hidden');
    send({ type: 'startChallenge', name: currentName(), accountToken: accountToken() || undefined });
  });
  el('challengeCancelBtn').addEventListener('click', () => el('challengeIntroOverlay').classList.add('hidden'));
  el('challengeIntroOverlay').addEventListener('click', (ev) => {
    if (ev.target === el('challengeIntroOverlay')) el('challengeIntroOverlay').classList.add('hidden');
  });

  el('lobbyReadyBtn').addEventListener('click', () => send({ type: 'lobbyReady' }));
  el('undoPileBtn').addEventListener('click', () => send({ type: 'undoPileTake' }));

  el('tutorialBtn').addEventListener('click', () => {
    tutorialActive = true;
    tutorialSeen = new Set();
    persistTutorial();
    // Beginners play against gentle opponents - preselect easy bots.
    el('createGameBtn').click(); // normal solo flow - bots fill the seats
  });
  el('tutorialNextBtn').addEventListener('click', () => {
    if (tutorialCurrentStep) tutorialSeen.add(tutorialCurrentStep);
    tutorialCurrentStep = null;
    persistTutorial();
    updateTutorial();
  });
  el('tutorialOffBtn').addEventListener('click', () => {
    tutorialActive = false;
    persistTutorial();
    el('tutorialBanner').classList.add('hidden');
  });

  el('resultContinueBtn').addEventListener('click', () => {
    const isGameOver = lastState && lastState.phase === 'gameOver';
    send({ type: isGameOver ? 'rematch' : 'nextRound' });
    // Round end: the overlay STAYS open - the ready check may still be
    // waiting for others (the button reflects that). It closes on its own
    // when the server starts the next round.
    if (isGameOver) el('resultOverlay').classList.add('hidden');
    else el('resultContinueBtn').disabled = true;
  });

  el('exportGameBtn').addEventListener('click', () => {
    send({ type: 'exportLastGame' });
  });

  // --- Game replay: browse the finished game round by round ---------------
  let pendingReplayRequest = false;
  let replayRecord = null;
  let replayIndex = 0;
  el('replayBtn').addEventListener('click', () => {
    pendingReplayRequest = true;
    send({ type: 'exportLastGame' });
  });
  el('replayCloseBtn').addEventListener('click', closeReplay);
  el('replayOverlay').addEventListener('click', (ev) => {
    if (ev.target === el('replayOverlay')) closeReplay();
  });
  el('replayPrevBtn').addEventListener('click', () => {
    if (replayIndex > 0) { replayIndex--; renderReplayRound(); }
  });
  el('replayNextBtn').addEventListener('click', () => {
    if (replayRecord && replayIndex < replayRecord.rounds.length - 1) { replayIndex++; renderReplayRound(); }
  });
  let replayReturnToResult = false;
  function openReplay(record) {
    if (!record || !Array.isArray(record.rounds) || record.rounds.length === 0) {
      showToast(L('Kein Verlauf verfügbar.', 'No history available.'));
      return;
    }
    replayRecord = record;
    replayIndex = 0;
    renderReplayRound();
    // Overlays stack in DOM order and the result overlay comes AFTER the
    // replay in the markup - it would cover the replay completely (the
    // "replay does nothing" bug). Hide it while browsing, restore on close.
    replayReturnToResult = !el('resultOverlay').classList.contains('hidden');
    el('resultOverlay').classList.add('hidden');
    el('replayOverlay').classList.remove('hidden');
  }
  function closeReplay() {
    el('replayOverlay').classList.add('hidden');
    if (replayReturnToResult) {
      replayReturnToResult = false;
      el('resultOverlay').classList.remove('hidden');
    }
  }
  function replayPlayerName(pid) {
    const p = (replayRecord.players || []).find((x) => x.id === pid);
    return p ? p.name : '?';
  }
  function renderReplayRound() {
    const rounds = replayRecord.rounds;
    const round = rounds[replayIndex];
    el('replayRoundLabel').textContent = L(`Runde ${round.roundNumber} / ${rounds.length}`, `Round ${round.roundNumber} / ${rounds.length}`);
    el('replayPrevBtn').disabled = replayIndex === 0;
    el('replayNextBtn').disabled = replayIndex === rounds.length - 1;

    const winnerName = round.winnerId ? replayPlayerName(round.winnerId) : null;
    const badges = [
      `<span class="replayBadge">⭐ ${L('Geber', 'Dealer')}: ${escapeHtml(replayPlayerName(round.dealerId))}</span>`,
      winnerName
        ? `<span class="replayBadge">🏆 ${escapeHtml(winnerName)}</span>`
        : `<span class="replayBadge">🤝 ${L('Unentschieden', 'Draw')}</span>`,
      round.isHandAus ? `<span class="replayBadge">⚡ ${L('Hand aus!', 'Hand out!')}</span>` : '',
    ].join('');

    // One row per player: round score with its breakdown, then the running total
    const rows = Object.entries(round.results || {})
      .map(([pid, r]) => {
        const b = r.breakdown || {};
        const total = (round.totalsAfter || {})[pid];
        return { pid, name: replayPlayerName(pid), score: r.roundScore, laid: b.laidOutValue ?? 0, hand: b.handValue ?? 0, pd: b.pikDameLaidOut ?? 0, total };
      })
      .sort((a, b) => (b.total ?? 0) - (a.total ?? 0))
      .map((r) =>
        `<tr><td>${escapeHtml(r.name)}</td><td>${r.score >= 0 ? '+' : ''}${r.score}</td><td>+${r.laid} / −${r.hand}</td><td>${r.pd > 0 ? '♠'.repeat(r.pd) : '–'}</td><td><b>${r.total ?? '–'}</b></td></tr>`
      )
      .join('');
    el('replayBody').innerHTML =
      `<div class="replayMeta">${badges}</div>` +
      `<table class="statsTable"><thead><tr><th>${L('Spieler', 'Player')}</th><th>${L('Runde', 'Round')}</th><th>${L('Ausgelegt / Hand', 'Melded / Hand')}</th><th title="${L('Pik Damen ausgelegt', 'Queens of Spades melded')}">♠Q</th><th>${L('Gesamt', 'Total')}</th></tr></thead><tbody>${rows}</tbody></table>`;
  }

  // --- "Your turn" notice while the tab is in the background ---------------
  const BASE_TITLE = document.title;
  let titleNotifyActive = false;
  function updateTurnTitleNotice(isMyTurn) {
    const shouldNotify = isMyTurn && document.hidden;
    if (shouldNotify && !titleNotifyActive) {
      titleNotifyActive = true;
      document.title = L('🔔 Du bist dran! – ', '🔔 Your turn! – ') + BASE_TITLE;
    } else if (!shouldNotify && titleNotifyActive) {
      titleNotifyActive = false;
      document.title = BASE_TITLE;
    }
  }
  // BATTERY: mark the app as hidden so CSS can stop the endless pulse
  // animations (draw pile glow, lay-off target, active opponent). They are
  // pointless when nobody is looking but keep the compositor busy.
  document.addEventListener('visibilitychange', () => {
    document.documentElement.classList.toggle('appHidden', document.hidden);
  });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    // Coming back to the tab: clear the notice; if it is (still) our turn,
    // give a short nudge - the state may have changed while away.
    const myTurn = lastState && lastState.phase === 'playing' && lastState.currentPlayerId === playerId;
    updateTurnTitleNotice(false);
    if (myTurn) {
      showToast(L('Du bist dran!', 'Your turn!'));
      if (navigator.vibrate) navigator.vibrate(80);
    }
  });

  // --- Ablagestapel-Vorschau -----------------------------------------------
  // Alle Karten des Ablagestapels wurden offen abgelegt - die Vorschau ist
  // eine Gedächtnishilfe (oberste zuerst). Der 👁-Button ist ein eigenes
  // Tap-Ziel, damit er nicht mit dem Ziehen kollidiert.
  el('discardPreviewBtn').addEventListener('click', (ev) => {
    ev.stopPropagation();
    renderDiscardPreview();
    el('discardPreviewOverlay').classList.remove('hidden');
  });
  el('discardPreviewCloseBtn').addEventListener('click', () => {
    el('discardPreviewOverlay').classList.add('hidden');
  });
  el('discardPreviewOverlay').addEventListener('click', (ev) => {
    if (ev.target === el('discardPreviewOverlay')) {
      el('discardPreviewOverlay').classList.add('hidden');
    }
  });

  function renderDiscardPreview() {
    const cardsDiv = el('discardPreviewCards');
    cardsDiv.innerHTML = '';
    const cards = (lastState && lastState.discardCards) || [];
    el('discardPreviewTitle').textContent = L('Ablagestapel', 'Discard pile');
    el('discardPreviewCount').textContent = `(${cards.length} ${cards.length === 1 ? L('Karte', 'card') : L('Karten', 'cards')})`;
    if (cards.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'lobby-hint';
      empty.textContent = L('Der Ablagestapel ist leer.', 'The discard pile is empty.');
      cardsDiv.appendChild(empty);
      return;
    }
    cards.forEach((card, idx) => {
      if (card.faceDown) {
        const d = document.createElement('div');
        d.className = 'card card-compact';
        d.innerHTML = '<div class="corner">?</div>';
        cardsDiv.appendChild(d);
        return;
      }
      const cEl = cardEl(card, { compact: true });
      if (idx === 0) cEl.classList.add('previewTop');
      cardsDiv.appendChild(cEl);
    });
  }

  // --- Punkteverlauf-Chart ---------------------------------------------------
  const CHART_COLORS = ['#2fd6b0', '#8f90f8', '#ff9f5a', '#ff7d8c'];
  function renderScoreChart(history) {
    const wrap = document.createElement('div');
    wrap.className = 'scoreChart';
    const title = document.createElement('div');
    title.className = 'scoreChartTitle';
    title.textContent = L('Punkteverlauf', 'Score history');
    wrap.appendChild(title);

    const W = 300;
    const H = 130;
    const PAD = { l: 34, r: 8, t: 8, b: 18 };
    const players = lastState.players;
    const allValues = history.flatMap((h) => players.map((p) => h.totals[p.id] || 0));
    const maxV = Math.max(10, ...allValues);
    const minV = Math.min(0, ...allValues);
    const x = (i) => PAD.l + (i / Math.max(1, history.length - 1)) * (W - PAD.l - PAD.r);
    const y = (v) => PAD.t + (1 - (v - minV) / (maxV - minV || 1)) * (H - PAD.t - PAD.b);

    const svgParts = [];
    // Nulllinie + Gitter (Min/Mitte/Max)
    for (const v of [minV, (minV + maxV) / 2, maxV]) {
      svgParts.push(`<line x1="${PAD.l}" y1="${y(v)}" x2="${W - PAD.r}" y2="${y(v)}" class="gridLine"/>`);
      svgParts.push(`<text x="${PAD.l - 5}" y="${y(v) + 3}" class="axisLabel" text-anchor="end">${Math.round(v)}</text>`);
    }
    players.forEach((p, pi) => {
      const color = CHART_COLORS[pi % CHART_COLORS.length];
      const points = history.map((h, i) => `${x(i).toFixed(1)},${y(h.totals[p.id] || 0).toFixed(1)}`).join(' ');
      svgParts.push(`<polyline points="${points}" fill="none" stroke="${color}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>`);
      const last = history[history.length - 1];
      svgParts.push(`<circle cx="${x(history.length - 1).toFixed(1)}" cy="${y(last.totals[p.id] || 0).toFixed(1)}" r="3.4" fill="${color}"/>`);
    });
    // Runden-Beschriftung (erste/letzte)
    svgParts.push(`<text x="${x(0)}" y="${H - 4}" class="axisLabel" text-anchor="middle">R${history[0].round}</text>`);
    svgParts.push(`<text x="${x(history.length - 1)}" y="${H - 4}" class="axisLabel" text-anchor="middle">R${history[history.length - 1].round}</text>`);

    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.classList.add('scoreChartSvg');
    svg.innerHTML = svgParts.join('');
    wrap.appendChild(svg);

    const legend = document.createElement('div');
    legend.className = 'scoreChartLegend';
    legend.innerHTML = players
      .map((p, pi) => `<span><i style="background:${CHART_COLORS[pi % CHART_COLORS.length]}"></i>${nameWithHeart(p.name)}</span>`)
      .join('');
    wrap.appendChild(legend);
    return wrap;
  }

  // --- Karten-Flug-Animation -------------------------------------------------
  // Kleine "Geister-Karte", die vom Start- zum Zielrechteck fliegt. Nur
  // Deko - der echte Zustand kommt weiterhin vom Server-Broadcast.
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  function flyCard(fromEl, toEl, faceDown) {
    if (reducedMotion || !fromEl || !toEl) return;
    const from = fromEl.getBoundingClientRect();
    const to = toEl.getBoundingClientRect();
    if (!from.width || !to.width) return;
    const ghost = document.createElement('div');
    ghost.className = 'flyCard' + (faceDown ? ' back' : '');
    ghost.style.left = `${from.left + from.width / 2 - 26}px`;
    ghost.style.top = `${from.top + from.height / 2 - 36}px`;
    document.body.appendChild(ghost);
    const dx = to.left + to.width / 2 - (from.left + from.width / 2);
    const dy = to.top + to.height / 2 - (from.top + from.height / 2);
    requestAnimationFrame(() => {
      ghost.style.transform = `translate(${dx}px, ${dy}px) rotate(8deg) scale(0.85)`;
      ghost.style.opacity = '0';
    });
    setTimeout(() => ghost.remove(), 480);
  }

  // --- Toast: letzte Aktion kurz einblenden ---------------------------------
  let seenLogLength = null;
  let tipShownForTurn = null; // Zug-Tipp nur EINMAL pro eigenem Zug als Toast
  let handCollapsed = false; // eigene Karten per Pfeil ein-/ausblendbar
  function maybeShowActionToast() {
    if (lastState && lastState.phase === 'playing' && lastState.roundNumber === 1 && lastState.turnIndexInRound === 0) {
      lastEarnedBadges = null; // neue Partie -> alte Erfolgs-Anzeige verwerfen
    }
    const log = (lastState && lastState.log) || [];
    if (seenLogLength === null) {
      seenLogLength = log.length; // erstes Render: nichts nachreichen
      return;
    }
    if (log.length > seenLogLength) {
      const latest = log[log.length - 1];
      seenLogLength = log.length;
      if (latest && latest.text) {
        // Die Endspurt-Ansage ist wichtig genug fuer eine laengere Anzeige
        const isWarning = latest.text.startsWith('⚠️');
        showToast(trs(latest.text), isWarning ? { duration: 6000, priority: true } : {});
      }
    } else {
      seenLogLength = log.length;
    }
  }
  let toastTimer = null;
  let toastLockUntil = 0; // prioritäre Toasts sperren den Container
  // Toasts erscheinen zentriert in der Bildmitte (Standard 4s). Prioritäre
  // Toasts (Rundenspruch, ⚠️-Warnung, Fehlermeldungen) bekommen ihre VOLLE
  // Anzeigedauer: normale Aktions-Toasts, die währenddessen eintreffen
  // (z.B. 'Bot zieht eine Karte'), werden verworfen statt sie zu verdrängen.
  function showToast(text, opts = {}) {
    const now = Date.now();
    if (!opts.priority && now < toastLockUntil) return;
    const duration = opts.duration || 4000;
    if (opts.priority) toastLockUntil = now + duration;
    const container = el('toastContainer');
    container.textContent = text;
    container.classList.add('visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => container.classList.remove('visible'), duration);
  }

  // --- Vollbild ("Kiosk-Modus" wie bei Videos) -------------------------------
  // Fullscreen-API gibt es auf Android/Desktop (Chrome/Edge/Firefox). iOS
  // Safari unterstützt sie für Webseiten nicht - dort bleibt der Button
  // verborgen (der PWA-Homescreen-Modus übernimmt das auf dem iPhone).
  const fsRoot = document.documentElement;
  if (fsRoot.requestFullscreen) {
    el('fullscreenBtn').classList.remove('hidden');
    el('fullscreenBtn').addEventListener('click', () => {
      if (document.fullscreenElement) {
        document.exitFullscreen();
      } else {
        fsRoot.requestFullscreen().catch(() => {});
      }
    });
    document.addEventListener('fullscreenchange', () => {
      el('fullscreenBtn').textContent = document.fullscreenElement ? '⛶✕' : '⛶';
      el('fullscreenBtn').title = document.fullscreenElement ? L('Vollbild verlassen', 'Exit fullscreen') : L('Vollbild', 'Fullscreen');
    });
  }

  // --- Wake Lock: Display bleibt an, WÄHREND ICH DRAN BIN -------------------
  // (iOS ab 16.4; wo nicht unterstützt, passiert einfach nichts.)
  // BATTERY: previously the lock was held for the whole 'playing' phase, so the
  // screen stayed at full brightness even while waiting minutes for the other
  // players/bots - by far the biggest drain on a phone. Now it is only held when
  // it actually helps: when it is MY turn (so the screen never dies mid-move).
  // While waiting, the phone may dim/sleep as usual; an incoming turn brings a
  // notification/toast anyway.
  let wakeLock = null;
  async function updateWakeLock() {
    const myTurn = !!(
      lastState &&
      lastState.phase === 'playing' &&
      lastState.currentPlayerId === playerId &&
      !lastState.paused
    );
    const wantLock = myTurn && document.visibilityState === 'visible';
    try {
      if (wantLock && !wakeLock && 'wakeLock' in navigator) {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => { wakeLock = null; });
      } else if (!wantLock && wakeLock) {
        await wakeLock.release();
        wakeLock = null;
      }
    } catch (e) {
      wakeLock = null; // z.B. Energiesparmodus - kein Drama
    }
  }
  document.addEventListener('visibilitychange', updateWakeLock);

  // --- QR-Code zum Beitreten ------------------------------------------------
  el('showQrBtn').addEventListener('click', () => {
    if (!sessionCode || typeof qrcode !== 'function') return;
    const url = new URL(window.location.href);
    url.searchParams.set('session', sessionCode);
    const link = url.toString();
    const qr = qrcode(0, 'M'); // Version automatisch, Fehlerkorrektur M
    qr.addData(link);
    qr.make();
    // Als skalierbares SVG rendern (scharf auf jedem Display)
    el('qrCodeBox').innerHTML = qr.createSvgTag({ cellSize: 5, margin: 3, scalable: true });
    el('qrLinkText').textContent = link;
    el('qrOverlay').classList.remove('hidden');
  });
  el('qrCloseBtn').addEventListener('click', () => el('qrOverlay').classList.add('hidden'));
  el('qrOverlay').addEventListener('click', (ev) => {
    if (ev.target === el('qrOverlay')) el('qrOverlay').classList.add('hidden');
  });

  // --- Pik-Dame-Ankündigung (Raid-Warning) -----------------------------------
  function collectTablePikdames() {
    const found = new Map(); // cardId -> ownerId
    for (const meld of lastState.tableMelds || []) {
      for (const slot of meld.slots || []) {
        if (slot.real && slot.real.rank === 'Q' && slot.real.suit === 'S') {
          found.set(slot.real.id, meld.ownerId);
        }
      }
    }
    return found;
  }

  function checkPikdameAnnouncement() {
    if (!lastState || lastState.phase !== 'playing') {
      prevTablePikdameIds = null;
      return;
    }
    const current = collectTablePikdames();
    const isNewRound = prevPikdameRound !== lastState.roundNumber;
    if (prevTablePikdameIds !== null && !isNewRound) {
      for (const [cardId, ownerId] of current) {
        if (!prevTablePikdameIds.has(cardId)) {
          const owner = lastState.players.find((p) => p.id === ownerId);
          const isMe = ownerId === playerId;
          showRaidWarning(
            L('♠ PIK DAME! ♠', '♠ QUEEN OF SPADES! ♠'),
            isMe ? L('Du sicherst dir 100 Punkte!', 'You secure 100 points!') : L(`${owner ? owner.name : '?'} sichert sich 100 Punkte!`, `${owner ? owner.name : '?'} secures 100 points!`)
          );
          break; // eine Ankündigung reicht, auch wenn beide PD gleichzeitig fallen
        }
      }
    }
    prevTablePikdameIds = new Set(current.keys());
    prevPikdameRound = lastState.roundNumber;
  }

  function showRaidWarning(title, sub, variant) {
    document.querySelectorAll('.raidWarning').forEach((n) => n.remove());
    const w = document.createElement('div');
    w.className = 'raidWarning' + (variant ? ' ' + variant : '');
    const t = document.createElement('div');
    t.className = 'rwTitle';
    t.textContent = title;
    const s = document.createElement('div');
    s.className = 'rwSub';
    s.textContent = sub;
    w.appendChild(t);
    w.appendChild(s);
    document.body.appendChild(w);
    sound.pikdame();
    setTimeout(() => w.remove(), 2500);
  }

  // --- Benutzerkonto (nur wenn der Server Accounts anbietet) -------------------
  // In der CodeApp/im Hotspot-Betrieb meldet der Server accountsEnabled=false
  // und die komplette Konto-UI bleibt unsichtbar - dort ändert sich nichts.
  const ACC_TOKEN_KEY = 'pikdame_account_token';
  let accountUsername = null;
  function accountToken() {
    return storageGet(ACC_TOKEN_KEY) || '';
  }
  async function accountApi(path, body) {
    try {
      const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      return await r.json();
    } catch (e) {
      return { error: L('Server nicht erreichbar.', 'Server unreachable.') };
    }
  }
  function setAccountStatus(text, isError) {
    const s = el('accountStatus');
    s.textContent = text || '';
    s.style.color = isError ? 'var(--danger, #ff7d8c)' : '';
  }
  function refreshAccountUi() {
    const loggedIn = !!accountUsername;
    el('accountLoggedOut').classList.toggle('hidden', loggedIn);
    el('accountLoggedIn').classList.toggle('hidden', !loggedIn);
    el('accountWhoami').textContent = loggedIn
      ? L(`Angemeldet als ${accountUsername}`, `Signed in as ${accountUsername}`)
      : '–';
    el('accountBtn').textContent = loggedIn
      ? `👤 ${accountUsername}`
      : L('👤 Konto', '👤 Account');
    // Angemeldet: der Spielername IST der Kontoname (Fortschritt haengt dran)
    if (loggedIn) {
      el('nameInput').value = accountUsername;
      el('nameInput').disabled = true;
      el('nameInput').title = L('Name ist durch dein Konto festgelegt', 'Name is fixed by your account');
    } else {
      el('nameInput').disabled = false;
      el('nameInput').title = '';
    }
  }
  async function initAccount(enabled) {
    if (!enabled) return; // Button bleibt versteckt (CodeApp/Hotspot)
    el('accountBtn').classList.remove('hidden');
    if (accountToken()) {
      const me = await accountApi('/api/me', { token: accountToken() });
      if (me.ok) accountUsername = me.username;
      else storageRemove(ACC_TOKEN_KEY);
    }
    refreshAccountUi();
  }
  el('accountBtn').addEventListener('click', () => {
    setAccountStatus('');
    el('accountOverlay').classList.remove('hidden');
  });
  el('accountCloseBtn').addEventListener('click', () => el('accountOverlay').classList.add('hidden'));
  el('accountOverlay').addEventListener('click', (ev) => {
    if (ev.target === el('accountOverlay')) el('accountOverlay').classList.add('hidden');
  });
  el('accountTabLogin').addEventListener('click', () => {
    el('accountLoginForm').classList.remove('hidden');
    el('accountRegisterForm').classList.add('hidden');
    el('accountTabLogin').classList.add('active');
    el('accountTabRegister').classList.remove('active');
    setAccountStatus('');
  });
  el('accountTabRegister').addEventListener('click', () => {
    el('accountLoginForm').classList.add('hidden');
    el('accountRegisterForm').classList.remove('hidden');
    el('accountTabRegister').classList.add('active');
    el('accountTabLogin').classList.remove('active');
    setAccountStatus('');
  });
  el('accRegisterBtn').addEventListener('click', async () => {
    setAccountStatus(L('Registriere...', 'Registering...'));
    const r = await accountApi('/api/register', {
      username: el('accRegUser').value,
      email: el('accRegEmail').value,
      password: el('accRegPass').value,
    });
    if (r.error) return setAccountStatus(trs(r.error), true);
    setAccountStatus(
      r.mailDelivered
        ? L('✅ Fast geschafft! Bitte den Bestätigungslink in deiner E-Mail öffnen, danach kannst du dich anmelden.', '✅ Almost done! Please open the confirmation link in your e-mail, then sign in.')
        : L('✅ Konto angelegt. Der Bestätigungslink steht im Server-Log (noch kein Mailserver eingetragen).', '✅ Account created. The confirmation link is in the server log (no mail server configured yet).')
    );
  });
  el('accLoginBtn').addEventListener('click', async () => {
    setAccountStatus(L('Melde an...', 'Signing in...'));
    const r = await accountApi('/api/login', {
      username: el('accLoginUser').value,
      password: el('accLoginPass').value,
    });
    if (r.error) return setAccountStatus(trs(r.error), true);
    storageSet(ACC_TOKEN_KEY, r.token);
    accountUsername = r.username;
    setAccountStatus('');
    refreshAccountUi();
    el('accountOverlay').classList.add('hidden');
    showToast(L(`Angemeldet als ${r.username}`, `Signed in as ${r.username}`));
  });
  el('accLogoutBtn').addEventListener('click', async () => {
    await accountApi('/api/logout', { token: accountToken() });
    storageRemove(ACC_TOKEN_KEY);
    accountUsername = null;
    refreshAccountUi();
    el('accountOverlay').classList.add('hidden');
  });

  // --- Version & Changelog ----------------------------------------------------
  // Die Version kommt vom Server (/statusz, Quelle: package.json) - so zeigt
  // der Client immer den tatsaechlich laufenden Stand, nie einen gecachten.
  fetch('/statusz')
    .then((r) => r.json())
    .then((s) => {
      if (s && s.version) {
        el('versionBtn').textContent = `v${s.version}`;
        el('ingameVersion').textContent = `v${s.version}`;
        // PWA auto-update, part 2: my bundle carries the version of the
        // server that SERVED it (__PIKDAME_BUILD). If the live server is
        // newer, this client is stale (nightly update, PWA cache) - reload
        // ONCE to fetch the fresh bundle. Loop guard: at most one attempt
        // per 5 minutes; if the mismatch survives a reload, tell the user
        // instead of reload-cycling.
        const mine = window.__PIKDAME_BUILD;
        if (mine && mine !== s.version) {
          const last = Number(storageGet('pikdame_reload_at') || 0);
          if (Date.now() - last > 5 * 60 * 1000) {
            storageSet('pikdame_reload_at', String(Date.now()));
            window.location.reload();
          } else {
            showToast(L(
              `Neue Version v${s.version} verfügbar - bitte App einmal komplett schließen und neu öffnen.`,
              `New version v${s.version} available - please fully close and reopen the app once.`
            ));
          }
        }
      }
      initAccount(!!(s && s.accountsEnabled));
    })
    .catch(() => {});

  function openChangelog() {
    fetch('/changelogz')
      .then((r) => r.text())
      .then((md) => {
        el('changelogContent').innerHTML = renderMiniMarkdown(md);
        el('changelogOverlay').classList.remove('hidden');
      })
      .catch(() => showToast(L('Changelog konnte nicht geladen werden.', 'Could not load the changelog.')));
  }
  el('versionBtn').addEventListener('click', openChangelog);
  el('ingameVersion').addEventListener('click', openChangelog);

  // --- Spielregeln (Lobby + ingame) ------------------------------------------
  function openRules() {
    el('rulesOverlay').classList.remove('hidden');
  }
  el('rulesBtnLobby').addEventListener('click', openRules);
  el('rulesCloseBtn').addEventListener('click', () => el('rulesOverlay').classList.add('hidden'));
  el('rulesOverlay').addEventListener('click', (ev) => {
    if (ev.target === el('rulesOverlay')) el('rulesOverlay').classList.add('hidden');
  });
  el('changelogCloseBtn').addEventListener('click', () => el('changelogOverlay').classList.add('hidden'));
  el('changelogOverlay').addEventListener('click', (ev) => {
    if (ev.target === el('changelogOverlay')) el('changelogOverlay').classList.add('hidden');
  });

  // Bewusst winziger Markdown-Renderer (nur Ueberschriften, Listen, Links
  // werden NICHT gerendert) - alles wird zuerst escaped, kein XSS-Risiko.
  function renderMiniMarkdown(md) {
    const lines = md.split('\n');
    const out = [];
    let inList = false;
    // Inline formatting on already-escaped text: links, **bold**, *italic*.
    // Links are restricted to http(s) so nothing like javascript: can slip in;
    // the captured groups are escaped, so this cannot inject markup.
    const inline = (s) =>
      s
        // [label](https://url) -> anchor
        .replace(
          /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
          '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>'
        )
        // bare https://url not already inside an href -> anchor
        .replace(
          /(^|[\s(])(https?:\/\/[^\s<)]+)/g,
          '$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>'
        )
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/(^|[^*])\*(?!\s)([^*]+?)\*(?!\*)/g, '$1<em>$2</em>');
    for (const raw of lines) {
      const line = inline(escapeHtml(raw));
      const isItem = /^\s*-\s+/.test(raw);
      if (inList && !isItem) { out.push('</ul>'); inList = false; }
      if (/^###\s+/.test(raw)) out.push(`<h4>${line.replace(/^###\s+/, '')}</h4>`);
      else if (/^##\s+/.test(raw)) out.push(`<h3>${line.replace(/^##\s+/, '')}</h3>`);
      else if (/^#\s+/.test(raw)) continue; // Haupttitel steht schon im Overlay
      else if (isItem) {
        if (!inList) { out.push('<ul>'); inList = true; }
        out.push(`<li>${line.replace(/^\s*-\s+/, '')}</li>`);
      } else if (raw.trim() === '') out.push('');
      else out.push(`<p>${line}</p>`);
    }
    if (inList) out.push('</ul>');
    return out.join('');
  }

  // --- Emotes -----------------------------------------------------------------
  el('pauseBtn').addEventListener('click', () => send({ type: 'togglePause' }));
  el('pauseResumeBtn').addEventListener('click', () => send({ type: 'togglePause' }));

  function renderPause() {
    const s = lastState;
    const playing = s && s.phase === 'playing';
    const seated = s && s.players.some((p) => p.id === playerId && !p.isBot);
    const votes = (s && s.pauseVotes) || [];
    const humans = (s && s.players.filter((p) => !p.isBot && p.connected !== false)) || [];
    // Pause button: only while seated in a running game.
    el('pauseBtn').classList.toggle('hidden', !(playing && seated));
    const iVoted = votes.includes(playerId);
    el('pauseBtn').classList.toggle('active', iVoted);
    el('pauseBtn').title = s && s.paused
      ? L('Fortsetzen (alle müssen zustimmen)', 'Resume (everyone must agree)')
      : votes.length
        ? L(`Pause: ${votes.length}/${humans.length} dafür`, `Pause: ${votes.length}/${humans.length} in favour`)
        : L('Pause (alle müssen zustimmen)', 'Pause (everyone must agree)');
    // Pause overlay while the game is frozen.
    const paused = !!(s && s.paused);
    el('pauseOverlay').classList.toggle('hidden', !paused);
    if (paused) {
      const need = humans.length;
      const have = votes.length;
      el('pauseInfo').textContent = have
        ? L(`Weiter, sobald alle zustimmen (${have}/${need}).`, `Resumes once everyone agrees (${have}/${need}).`)
        : L('Das Spiel ist pausiert. Tippe „Fortsetzen", um weiterzuspielen (alle müssen zustimmen).',
            'The game is paused. Tap "Resume" to continue (everyone must agree).');
      el('pauseResumeBtn').classList.toggle('active', iVoted);
      el('pauseResumeBtn').textContent = iVoted
        ? L('✅ Warte auf die anderen', '✅ Waiting for the others')
        : L('▶️ Fortsetzen', '▶️ Resume');
    }
  }

  el('emoteBtn').addEventListener('click', () => {
    el('emoteBar').classList.toggle('hidden');
  });
  document.querySelectorAll('.emoteChoice').forEach((btn) => {
    btn.addEventListener('click', () => {
      send({ type: 'emote', emoji: btn.dataset.emote });
      el('emoteBar').classList.add('hidden');
    });
  });

  function showEmote(fromPlayerId, emoji) {
    // While the result overlay is open it covers the player chips - show
    // round-end reactions as name chips inside the overlay instead.
    if (!el('resultOverlay').classList.contains('hidden')) {
      const sender = (lastState && lastState.players || []).find((p) => p.id === fromPlayerId);
      const chip = document.createElement('span');
      chip.className = 'resultEmoteChip';
      const emojiHtml = emoji === 'pikdame' ? '<span class="miniPikdame">♠<b>Q</b></span>' : escapeHtml(emoji);
      chip.innerHTML = `${escapeHtml(sender ? sender.name : '?')} ${emojiHtml}`;
      const box = el('resultEmotes');
      while (box.children.length >= 6) box.firstChild.remove();
      box.appendChild(chip);
      setTimeout(() => chip.remove(), 5000);
      return;
    }
    // Ziel: der Chip des Absenders; eigene Emotes schweben über der Hand.
    let anchor = document.querySelector(`#opponents .opponent[data-player-id="${CSS.escape(fromPlayerId)}"]`);
    if (fromPlayerId === playerId) anchor = el('handWrapper');
    const rect = anchor ? anchor.getBoundingClientRect() : { left: window.innerWidth / 2, top: window.innerHeight / 2, width: 0 };
    const bubble = document.createElement('div');
    bubble.className = 'emoteFloat';
    if (emoji === 'pikdame') {
      // Es gibt kein Pik-Dame-Emoji - also eine kleine gestylte Spielkarte.
      bubble.innerHTML = '<span class="miniPikdame">♠<b>Q</b></span>';
    } else {
      bubble.textContent = emoji;
    }
    bubble.style.left = `${rect.left + rect.width / 2 - 18}px`;
    bubble.style.top = `${rect.top - 6}px`;
    document.body.appendChild(bubble);
    setTimeout(() => bubble.remove(), 1600);
  }

  // --- Statistik ---------------------------------------------------------------
  el('statsBtn').addEventListener('click', () => {
    send({ type: 'listProfiles' }); // frische Daten anfordern
    renderStats();
    el('statsOverlay').classList.remove('hidden');
  });
  // Record details: tapping a profile row expands its personal records
  // (best round, queen/joker balance, hand-aus wins) right beneath it.
  el('statsContent').addEventListener('click', (ev) => {
    const card = ev.target.closest('.statsCard');
    if (!card) return;
    const existing = card.nextElementSibling;
    if (existing && existing.classList.contains('recordRow')) {
      existing.remove();
      return;
    }
    document.querySelectorAll('.recordRow').forEach((r) => r.remove());
    const p = (knownProfiles || []).find((pr) => pr.name === card.dataset.name);
    if (!p) return;
    const detail = document.createElement('div');
    detail.className = 'recordRow';
    const bits = [
      `${L('Beste Runde', 'Best round')}: <b>${p.bestRoundScore ?? '–'}</b>`,
      `♠Q ${L('ausgelegt/erwischt', 'melded/caught')}: <b>${p.totalQueensLaid || 0}/${p.totalQueensCaught || 0}</b>`,
      `🃏: <b>${p.totalJokersLaid || 0}</b>`,
      `${L('Hand aus', 'Out in one')}: <b>${p.totalHandAus || 0}</b>`,
    ];
    detail.innerHTML = `<div class="recordCell">${bits.join(' · ')}</div>`;
    card.after(detail);
  });

  el('statsCloseBtn').addEventListener('click', () => el('statsOverlay').classList.add('hidden'));
  el('statsOverlay').addEventListener('click', (ev) => {
    if (ev.target === el('statsOverlay')) el('statsOverlay').classList.add('hidden');
  });

  function renderStats() {
    const box = el('statsContent');
    // Globale, anonyme Server-Statistik (funktioniert auch im Public Mode)
    const gsBox = el('globalStatsBox');
    if (globalStatsData && globalStatsData.games > 0) {
      const g = globalStatsData;
      const row = (label, value) => `<div class="statRow"><span>${label}</span><b>${value}</b></div>`;
      gsBox.innerHTML =
        `<h3>${L('🌍 Server-Statistik (alle Spiele)', '🌍 Server statistics (all games)')}</h3>` +
        row(L('Partien gespielt', 'Games played'), g.games) +
        row(L('Runden gespielt', 'Rounds played'), g.rounds) +
        row(L('♠ Pik Damen ausgelegt (+100)', '♠ Queens of Spades melded (+100)'), g.pikDamesLaidOut) +
        row(L('♠ Pik Damen auf der Hand erwischt (−100)', '♠ Queens of Spades caught in hand (−100)'), g.pikDamesCaught) +
        row(L('„Hand aus"-Runden', '"Out in one" rounds'), g.handAusRounds);
      gsBox.classList.remove('hidden');
    } else {
      gsBox.classList.add('hidden');
    }

    const profiles = (knownProfiles || []).filter((p) => (p.gamesPlayed || 0) > 0);
    if (profiles.length === 0) {
      box.innerHTML = `<p class="lobby-hint">${L('Noch keine abgeschlossenen Partien - spielt erstmal eine Runde! 🃏', 'No finished games yet - go play a round! 🃏')}</p>`;
      return;
    }
    const sorted = profiles.slice().sort((a, b) => (b.gamesWon || 0) - (a.gamesWon || 0) || (b.totalScore || 0) - (a.totalScore || 0));
    const cards = sorted
      .map((p) => {
        const played = p.gamesPlayed || 0;
        const won = p.gamesWon || 0;
        const rate = played > 0 ? Math.round((won / played) * 100) : 0;
        const best = p.bestGameScore !== undefined ? p.bestGameScore : '–';
        const badgeChips = Object.keys(p.badges || {})
          .map((id) => {
            const m = badgeMeta(id);
            return `<span class="statsBadgeChip" title="${escapeHtml(m.desc)}">${m.emoji} ${escapeHtml(m.name)}</span>`;
          })
          .join('');
        return `<div class="statsCard" data-name="${escapeHtml(p.name)}">
          <div class="statsCardHead"><span class="statsCardName">${nameWithHeart(p.name)}</span><span class="statsCardRate">${rate}% · ${won}/${played} ${L('Siege', 'wins')}</span></div>
          <div class="statsCardMeta">${L('Spiele', 'Games')}: <b>${played}</b> · ${L('Beste Partie', 'Best game')}: <b>${best}</b></div>
          <div class="statsCardBadges">${badgeChips || `<span class="statsNoBadge">${L('Noch keine Erfolge', 'No badges yet')}</span>`}</div>
        </div>`;
      })
      .join('');
    box.innerHTML = `<div class="statsCards">${cards}</div>`;
  }

  // Bei Orientierungswechsel/Fenstergröße die Hand-Überlappung neu berechnen.
  // PWA-Viewport-Fix: Im iOS-Standalone-Modus kann 100dvh von der echten
  // Fensterhöhe abweichen (der App-Container endete sichtbar über der
  // Unterkante). Wir messen die echte Höhe und stellen sie als CSS-Variable
  // bereit; die display-mode:standalone-Query in style.css nutzt sie.
  function setAppViewportHeight() {
    document.documentElement.style.setProperty('--appvh', window.innerHeight + 'px');
  }
  setAppViewportHeight();

  let resizeTimer = null;
  window.addEventListener('resize', () => {
    setAppViewportHeight();
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => render(), 150);
  });

  connect();
})();

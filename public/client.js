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
  // Which source the pending draw came from ('discard' = Ablagestapel).
  // Only a pile take drags the scrollable fan to the new cards; a single
  // card off the draw pile must NOT, see freshScrollPending below.
  let pendingDrawSource = null;
  // One-shot: consumed by the next hand render. Without the one-shot the
  // re-centring ran on EVERY render and yanked the fan back while the
  // player was still scrolling (bug report).
  let freshScrollPending = false;

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
      ['Wer die Ablage nimmt, braucht einen Plan. Oder sehr viel Mut.', 'Taking the pile needs a plan. Or a lot of nerve.'],
      ['Der Ziehstapel schrumpft schneller, als man rechnet.', 'The draw pile shrinks faster than you count.'],
      ['Sätze sind Fleiß, Folgen sind Kunst.', 'Sets are diligence. Runs are art.'],
      ['Zwei Joker auf der Hand? Jetzt bloß nicht übermütig werden.', 'Two jokers in hand? Now do not get cocky.'],
      ['Kaffee kalt, Karten heiß.', 'Coffee cold, cards hot.'],
      ['Die Pik Dame wiegt 100 Punkte - und kein Gramm weniger.', 'The Queen of Spades weighs 100 points - not a gram less.'],
      ['Wer früh auslegt, schläft ruhiger.', 'Meld early, sleep better.'],
      ['Ein Blatt voller Zehner ist ein Blatt voller Reue.', 'A hand full of tens is a hand full of regret.'],
      ['Der beste Zeitpunkt zum Auslegen war letzte Runde. Der zweitbeste ist jetzt.', 'The best time to meld was last round. The second best is now.'],
      ['Merke: Der Ziehstapel wird NICHT nachgefüllt.', 'Remember: the draw pile is NEVER refilled.'],
      ['Ist der Stapel leer, zählt nur noch, was in der Hand klebt.', 'When the pile runs dry, only what sticks in your hand counts.'],
      ['Der Familienfrieden endet bei 1000 Punkten.', 'Family peace ends at 1000 points.'],
      ['Ein Joker in der Auslage ist ein Joker in Sicherheit.', 'A joker on the table is a joker out of harm.'],
      ['Manche zählen Karten. Manche zählen auf Oma.', 'Some count cards. Some count on grandma.'],
      ['Wer den Fächer sortiert, hat halb gewonnen. Sagt der Fächer.', 'Sorting your fan is half the win. Says the fan.'],
      ['Schon abgehoben? Der Glücksgriff wartet nicht ewig.', 'Cut the deck yet? The lucky cut will not wait forever.'],
      ['Große Hand, große Verantwortung.', 'Big hand, big responsibility.'],
      ['Kurz nachdenken kostet nichts. Falsch abwerfen schon.', 'Thinking is free. Discarding wrong is not.'],
      ['Ein Ass ist kein Kuscheltier. Leg es hin.', 'An ace is not a pet. Put it down.'],
      ['Die Zwei nach dem Ass rettet mehr Folgen, als man glaubt.', 'The 2 after the ace saves more runs than you would think.'],
      ['Bots vergessen keinen Abwurf. Auch deinen nicht.', 'Bots forget no discard. Not even yours.'],
      ['Wer nichts wagt, sammelt Punkte. Leider die falschen.', 'Play it safe and you still collect points. The wrong kind.'],
      ['Am Ende zählt nicht die Hand, sondern die Auslage.', 'In the end it is not the hand that counts, it is the table.'],
      ['Ein fetter Ablagestapel ist eine Falle mit Geschenkpapier.', 'A fat discard pile is a trap in gift wrapping.'],
      ['Eine geschenkte Runde? Gibt es hier nicht.', 'A free round? Not in this house.'],
      ['Der Geber mischt, das Schicksal teilt aus.', 'The dealer shuffles, fate deals.'],
      ['Erst die Dame loswerden, dann angeben.', 'Ditch the Queen first, brag later.'],
      ['Dreizehn Karten in einer Folge? Dafür darf man einmal laut lachen.', 'A thirteen-card run? That earns you one loud laugh.'],
      ['Keine Panik: Auch Zen hatte schon schlechte Blätter.', 'No panic: even Zen has had bad cards.'],
      ['Vier Buben, ein Problem: nur EIN Satz je Wert.', 'Four jacks, one problem: only ONE set per rank.'],
      ['Ziehen ist Pflicht, Abwerfen ist Kunst.', 'Drawing is duty. Discarding is art.'],
      ['Heute keine Gnade - aber Kuchen gibt es trotzdem.', 'No mercy today - but there is cake anyway.'],
      ['Wer die Ablage kennt, kennt die Mitspieler.', 'Know the discard pile, know the players.'],
      ['Der Joker-Tausch ist der eleganteste Zug im Spiel.', 'Swapping in for a joker is the most elegant move there is.'],
      ['Karten mischen kann jeder. Karten merken nicht.', 'Anyone can shuffle. Not everyone can remember.'],
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

  // Dynamische Beschriftungen (enthalten Werte wie den Spiel-Code) koennen
  // nicht ueber I18N_STATIC laufen. Sie werden hier zentral neu gesetzt -
  // beim Erzeugen UND bei jedem Sprachwechsel.
  let resumeCode = null;
  function updateResumeBtn() {
    try {
      const btn = document.getElementById('resumeBtn');
      if (!btn) return;
      if (resumeCode) {
        btn.innerHTML = '<svg class="icon" aria-hidden="true"><use href="#i-resume"/></svg><span></span>';
        btn.querySelector('span').textContent = L(`Weiterspielen (${resumeCode})`, `Resume game (${resumeCode})`);
        btn.classList.remove('hidden');
      } else {
        btn.classList.add('hidden');
      }
    } catch (e) { /* Beschriftung ist nie kritisch */ }
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
  // Buttons and headings that carry an <svg class="icon"> keep their label in a
  // <span>. Writing textContent on the element itself would delete the icon,
  // and the i18n snapshot below only inventories LEAF elements - the span is
  // that leaf, the button is not.
  function setLabelText(host, text) {
    const span = host && host.querySelector('span');
    if (span) span.textContent = text;
    else if (host) host.textContent = text;
  }
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
    // Both carry an <svg class="icon"> - write the label span, never the
    // button itself, or the icon is wiped on the next language switch.
    setLabelText(el('rulesTitle'), L('Spielregeln', 'How to play'));
    // Short label in the icon row; the current language lives in the tooltip.
    setLabelText(el('langBtnLobby'), lang === 'en' ? 'Language' : 'Sprache');
    el('langBtnLobby').title = lang === 'en' ? 'Switch language (English)' : 'Sprache wechseln (Deutsch)';
    document.documentElement.lang = lang;
  }
  function cycleLang() {
    lang = lang === 'de' ? 'en' : 'de';
    storageSet(LANG_KEY, lang);
    applyStaticLang();
    updateSortToggleLabel();
    updateHandToggle();
    applyUiScale();       // Auswahlfeld Anzeigegröße
    updateResumeBtn();    // "Weiterspielen (CODE)" - enthaelt einen Wert
    try { updateStudioLogoBtn(); } catch (e) { /* erst spaeter definiert */ }
    try { applyCardback(); } catch (e) { /* erst spaeter definiert */ }
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
    const sel = document.getElementById('uiScaleSelect');
    if (sel) {
      sel.value = uiScale;
      // Optionstexte enthalten keine Werte, stehen aber im HTML - ueber L()
      // gesetzt bleiben sie beim Sprachwechsel korrekt, ohne dass kurze
      // Woerter wie "Aus" versehentlich anderswo uebersetzt werden.
      for (const opt of sel.options) if (UI_SCALES.includes(opt.value)) opt.textContent = uiScaleLabel(opt.value);
    }
    setRowValue(document.getElementById('uiScaleBtn'), uiScaleLabel(uiScale));
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
  const BOT_FACES = ['👵', '🧔', '👩‍🦳', '👴', '👨‍🦰', '👱‍♀️', '🧓', '👨‍🦳', '👩‍🦰', '🧑‍🌾'];
  /** Textuelle Bot-Kennzeichnung: Gesicht statt Roboter. */
  function botMark(p) {
    if (!p || !p.isBot) return '';
    let h = 5381;
    for (const ch of String(p.name)) h = ((h * 33) ^ ch.codePointAt(0)) >>> 0;
    return ' ' + BOT_FACES[h % BOT_FACES.length];
  }

  function avatarFor(name, isBot) {
    let h = 5381;
    for (const ch of String(name)) h = ((h * 33) ^ ch.codePointAt(0)) >>> 0;
    const hue = h % 360;
    // Bots bekommen GESICHTER statt fünfmal 🤖 (Brotato-Prinzip: sofortige
    // Wiedererkennung am Tisch) - deterministisch aus demselben Namens-Hash.
    const glyph = isBot ? BOT_FACES[h % BOT_FACES.length] : escapeHtml((Array.from(String(name).trim())[0] || '?').toUpperCase());
    return `<span class="opAvatar" style="background:hsl(${hue},46%,40%)">${glyph}</span>`;
  }

  // Display order of the trophy cabinet: the ones every player meets first,
  // then the rare feats. Must stay in sync with BADGE_IDS in game/Badges.js.
  const BADGE_ORDER = [
    'first_win', 'pd_laid', 'hand_aus_win', 'marathon_10', 'streak_3',
    'pd_caught', 'round_300', 'score_500', 'pd_triple', 'double_queen_round',
    'comeback', 'zen_slayer', 'pd_hunter_10',
  ];

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
  // --- Fortschritt über Partien hinweg ------------------------------------
  // dailyQuests: {date, ids} kommt IMMER vom Server (alle Spieler weltweit
  // arbeiten an denselben drei Aufgaben); die Beschriftungen leben hier,
  // weil sie zweisprachig sind. questProgress zählt den heutigen Stand.
  let dailyQuests = null;
  let questProgress = {};
  let myProgress = null;      // {xp, level:{level,into,need,total}}
  let accountProgress = null; // {xp, seasonXp, season, games, wins, rank}

  function questMeta(id) {
    const M = {
      finish_game: { icon: '🏁', text: L('Eine Partie zu Ende spielen', 'Finish one match') },
      win_game: { icon: '🏆', text: L('Eine Partie gewinnen', 'Win a match') },
      win_rounds_3: { icon: '🎯', text: L('3 Runden gewinnen', 'Win 3 rounds') },
      meld_queen: { icon: '♠', text: L('Eine Pik Dame auslegen', 'Meld a Queen of Spades') },
      meld_jokers_3: { icon: '👑', text: L('3 Joker auslegen', 'Meld 3 jokers') },
      round_150: { icon: '💥', text: L('Eine Runde mit 150+ Punkten', 'Score 150+ in one round') },
      clean_hands: { icon: '🧼', text: L('Partie ohne erwischte Pik Dame', 'Finish a match never caught with the Queen') },
      hand_aus: { icon: '🚀', text: L('Eine Runde mit „Hand aus" gewinnen', 'Win a round with "out in one"') },
      score_400: { icon: '💯', text: L('400+ Punkte Endstand', 'Finish a match with 400+ points') },
      beat_zen: { icon: '⚔️', text: L('Eine Partie gegen einen Zen-Bot gewinnen', 'Beat a table with a zen bot') },
    };
    return M[id] || { icon: '🎲', text: id };
  }
  // Targets mirror game/Progression.js - the server is the authority and
  // sends the progress; these numbers only draw the bar.
  const QUEST_NEED = {
    finish_game: 1, win_game: 1, win_rounds_3: 3, meld_queen: 1, meld_jokers_3: 3,
    round_150: 1, clean_hands: 1, hand_aus: 1, score_400: 1, beat_zen: 1,
  };
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

  // Settings rows carry an <svg class="icon"> plus a label and a value span.
  // Never assign textContent to the row itself - that would wipe the icon.
  function setRowIcon(btn, iconId) {
    const use = btn && btn.querySelector('.icon use');
    if (use) use.setAttribute('href', `#${iconId}`);
  }
  function setRowValue(btn, text) {
    const span = btn && btn.querySelector('.sheetRowValue');
    if (span) span.textContent = text;
  }

  function setSoundEnabled(enabled) {
    soundEnabled = enabled;
    storageSet(SOUND_KEY, enabled ? 'on' : 'off');
    const toggleBtn = el('soundToggle');
    setRowIcon(toggleBtn, enabled ? 'i-sound-on' : 'i-sound-off');
    setRowValue(toggleBtn, enabled ? L('An', 'On') : L('Aus', 'Off'));
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
      setRowIcon(btn, enabled ? 'i-bulb' : 'i-bulb-off');
      setRowValue(btn, enabled ? L('An', 'On') : L('Aus', 'Off'));
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
      // Profile + Tagesaufgaben sofort holen: der Startbildschirm zeigt den
      // heutigen Aufgaben-Fortschritt, und der steht im eigenen Profil - ohne
      // diese Anfrage stünde dort bis zum Beitritt immer 0/3.
      ws.send(JSON.stringify({ type: 'listProfiles' }));
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
          ? L('Deine Beute - die letzte Karte bleibt im Spiel', 'Your haul - the last card stays in play')
          : L(`${name} behält ${r.luckyCount} Karte${r.luckyCount > 1 ? 'n' : ''}`,
              `${name} keeps ${r.luckyCount} card${r.luckyCount > 1 ? 's' : ''}`))
      : L('Deine Abhebekarte - bleibt im Spiel', 'Your cut card - stays in play');
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

  // Scrollable hand (16+ cards): subtle fade edges show which side still has
  // cards hidden off-screen. On iOS the overlay scrollbar is invisible at
  // rest, so these masks are the only affordance that the hand scrolls.
  // Kept in sync on scroll and on every re-layout.
  let handScrollWired = false;
  function updateHandScrollEdges(handDiv) {
    const canL = handDiv.scrollLeft > 4;
    const canR = handDiv.scrollLeft + handDiv.clientWidth < handDiv.scrollWidth - 4;
    handDiv.classList.toggle('canScrollL', canL);
    handDiv.classList.toggle('canScrollR', canR);
    if (!handScrollWired) {
      handScrollWired = true;
      handDiv.addEventListener('scroll', () => updateHandScrollEdges(handDiv), { passive: true });
    }
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
      if (msg.exists && msg.code === last && !sessionCode) {
        resumeCode = msg.code;
      } else {
        if (!msg.exists && msg.code === last) storageRemove('pikdame_last_session');
        resumeCode = null;
      }
      // Beschriftung kommt aus updateResumeBtn(), damit ein SPAeTERER
      // Sprachwechsel sie mitnimmt - vorher wurde sie hier einmalig gesetzt
      // und blieb danach in der alten Sprache stehen (Nutzer-Report).
      updateResumeBtn();
      return;
    }
    if (msg.type === 'leftLobby') {
      // Sitz ist serverseitig frei - Zugangsdaten dieser Session vergessen
      // und sauber ins Hauptmenü (ohne ?session=... in der URL).
      if (sessionCode) {
        storageRemove(playerKeyFor(sessionCode));
        storageRemove(tokenKeyFor(sessionCode));
        if (storageGet(LAST_SESSION_KEY) === sessionCode) storageRemove(LAST_SESSION_KEY);
      }
      window.location.href = window.location.pathname;
      return;
    }
    if (msg.type === 'error') {
      // A stale resume target is gone for good - stop offering it.
      if (/Kein Spiel mit diesem Code/.test(msg.error || '')) {
        storageRemove('pikdame_last_session');
      }
      showHint(trs(msg.error), true);
      // Im Tutorial ist eine Ablehnung der beste Lehrmoment: zusaetzlich zur
      // Meldung die REGEL dahinter in einfachen Worten.
      if (tutorialActive) {
        const why = tutorialExplainError(msg.error || '');
        if (why) setTimeout(() => showToast(`🎓 ${why}`, { duration: 7000 }), 900);
      }
      // Wichtige Fehler (z.B. Ablagestapel nicht aufnehmbar) deutlich und
      // laenger in der Bildmitte zeigen - die Hint-Zeile allein wird auf
      // kleinen Displays leicht uebersehen.
      showToast(trs(msg.error), { duration: 5000, priority: true });
      return;
    }
    if (msg.type === 'state') {
      lastState = msg.state;
      // Solo-Spiel abgebrochen (Challenge/Tutorial, nicht rechtzeitig
      // zurueckgekehrt): klar ansagen, den Wiederaufnehmen-Code wegwerfen -
      // die Sitzung existiert serverseitig nicht mehr.
      if (lastState.abandoned) {
        try { storageRemove('pikdame_last_session'); } catch (e) { /* egal */ }
        resumeCode = null;
        try { updateResumeBtn(); } catch (e) { /* egal */ }
        showToast(
          L('⏹️ Spiel abgebrochen - du warst zu lange weg. Es wurde nicht gewertet und nicht gespeichert.',
            '⏹️ Game abandoned - you were away too long. It was not scored and not saved.'),
          { duration: 8000, priority: true }
        );
      }
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
      // Re-apply the card back NOW that we know the profile. Its unlock gate
      // reads gamesWon/gamesPlayed from there, and at startup knownProfiles is
      // still empty - so an unlocked back (Gold, Nachtblau, Joker) counted as
      // locked and was silently downgraded to "Klassisch" on every load. The
      // choice itself survived in localStorage, only the draw pile never
      // showed it (player report).
      try { applyCardback(); } catch (e) { /* Kosmetik bricht nie den Start */ }
      globalStatsData = msg.globalStats || null;
      // Öffentlicher Server: Profile/Statistik sind deaktiviert.
      publicMode = !!msg.publicMode;
      el('statsBtn').classList.toggle('hidden', publicMode);
      if (msg.quests) dailyQuests = msg.quests;
      // My own counters live on my profile (name-based, like every other
      // statistic) - no extra round trip and no extra server state.
      if (dailyQuests) {
        const mine = myProfile();
        questProgress = (mine && mine.quests && mine.quests[dailyQuests.date]) || {};
      }
      renderQuests();
      if (!el('statsOverlay').classList.contains('hidden')) renderStats();
      return;
    }
    if (msg.type === 'progress') {
      // End of a match: experience, level and the daily quests that ticked.
      myProgress = { xp: msg.xp, level: msg.level };
      if (msg.quests) {
        dailyQuests = { date: msg.quests.date, ids: msg.quests.ids };
        questProgress = msg.quests.progress || {};
      }
      renderQuests();
      celebrateProgress(msg);
      return;
    }
    if (msg.type === 'accountProgress') {
      accountProgress = msg.progress || null;
      renderAccountProgress();
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

  // The joker's face. Used to be the 🃏 emoji set at the same font-size as the
  // ♠/♥ suit marks - it painted far smaller, sat off the baseline and ignored
  // the theme, so jokers read as a different card stock. A jester's cap drawn
  // on --joker scales with the suit marks and takes the theme colour.
  // A crown: royal, on-brand next to the Queen of Spades, and only two solid
  // shapes so it still reads at the ~20px corner index. The jewels sit ON the
  // peaks rather than floating above them - as separate dots they blurred away
  // at small sizes. (A jester's cap was tried first and read as an angel.)
  const JOKER_MARK_SVG =
    '<svg class="jokerMark" viewBox="0 0 24 24" aria-hidden="true">' +
    '<path d="M4.6 16.4 3.4 7.6l4.4 4.2L12 5.4l4.2 6.4 4.4-4.2-1.2 8.8z"/>' +
    '<circle cx="3.4" cy="7.0" r="1.7"/><circle cx="12" cy="4.6" r="1.8"/><circle cx="20.6" cy="7.0" r="1.7"/>' +
    '<path d="M4.3 17.4h15.4a1.1 1.1 0 0 1 1.1 1.1v1.1a1.1 1.1 0 0 1-1.1 1.1H4.3a1.1 1.1 0 0 1-1.1-1.1v-1.1a1.1 1.1 0 0 1 1.1-1.1z"/>' +
    '</svg>';
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
      // Ghost label in a meld: which card the joker stands in for. Without it,
      // [Joker, J, Joker] gave no clue whether that is three jacks or a
      // 10-J-Q run (player report). Italic + dimmed = "represented, not real".
      // In a RUN the suit belongs on the label - it is what you read the
      // sequence by. In a SET it does not: every card there has a different
      // suit, and naming one made the joker look like a real ♥/♠ card.
      const ghost = card._isJokerSlot && card.rank
        ? `<div class="jokerGhost">${card.rank}${
            card._jokerInRun && card.suit ? suitSymbol(card.suit) : ''
          }</div>`
        : '';
      div.innerHTML = compact
        ? `<div class="corner">${JOKER_MARK_SVG}</div>${ghost}`
        : `<div class="corner">${JOKER_MARK_SVG}</div>${ghost}<div class="suitMark">${JOKER_MARK_SVG}</div>`;
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

    // Feel: Punkte-Popup (kosmetisch, seq-entdupliziert). Eigene Punkte
    // steigen über der eigenen Auslagen-Zone auf, fremde am Spieler-Chip.
    try {
      const ev = lastState.lastPointsEvent;
      if (ev && ev.seq !== shownPointsSeq) {
        shownPointsSeq = ev.seq;
        spawnPointsPopup(ev);
      }
    } catch (e) { /* nie kritisch */ }

    // Feel: Runden-Stempel beim Rundenwechsel (nicht bei Reload/Resume).
    try {
      if (lastState.phase === 'playing' && stampKnownRound !== null &&
          lastState.roundNumber === stampKnownRound + 1) {
        showRoundStamp(lastState.roundNumber);
      }
      if (lastState.phase === 'playing' || lastState.phase === 'roundEnd') {
        stampKnownRound = lastState.roundNumber;
      }
    } catch (e) { /* nie kritisch */ }

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
    // Zurück ins Hauptmenü: nur sinnvoll, solange ich in einer unbegonnenen
    // Lobby wirklich am Tisch sitze.
    const meSeated = lastState.players.some((p) => p.id === playerId && !p.isBot);
    el('leaveLobbyBtn').classList.toggle('hidden', !meSeated);
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
        ? L('Bereit - warte auf die anderen', 'Ready - waiting for the others')
        : L('Bereit melden', 'Mark me ready');
    }
    const allReady = !multiHuman || readyCount === seatedHumans.length;
    el('startBtn').classList.toggle('hidden', !isHost); // only the organizer starts
    el('startBtn').disabled = humanCount === 0 || !allReady;
    el('startBtn').textContent = multiHuman
      ? L(`Spiel starten (${readyCount}/${seatedHumans.length} bereit)`, `Start game (${readyCount}/${seatedHumans.length} ready)`)
      : L('Spiel starten', 'Start game');
    // The sticky bar only exists while it has something to show - an empty
    // pinned strip at the bottom of the start screen would be pure noise.
    el('lobbyActions').classList.toggle(
      'hidden',
      el('startBtn').classList.contains('hidden') && readyBtn.classList.contains('hidden')
    );

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
        <span class="seatName">${nameWithHeart(p.name)}${botMark(p)}</span>
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

  let shownPointsSeq = 0;
  let stampKnownRound = null;

  function spawnPointsPopup(ev) {
    const mine = ev.playerId === playerId;
    let anchor = null;
    if (mine) anchor = el('melds');
    else anchor = document.querySelector(`.opponent[data-player-id="${ev.playerId}"]`) || el('melds');
    if (!anchor) return;
    const r = anchor.getBoundingClientRect();
    const pop = document.createElement('div');
    pop.className = 'pointsPop' + (ev.queen ? ' queen' : '');
    pop.textContent = `+${ev.points}`;
    pop.style.left = `${r.left + r.width / 2}px`;
    pop.style.top = `${Math.max(r.top + 8, 60)}px`;
    document.body.appendChild(pop);
    setTimeout(() => pop.remove(), 1400);
  }

  function showRoundStamp(n) {
    const old = document.querySelector('.roundStamp');
    if (old) old.remove();
    const s = document.createElement('div');
    s.className = 'roundStamp';
    s.textContent = `${L('Runde', 'Round')} ${n}`;
    document.body.appendChild(s);
    setTimeout(() => s.remove(), 1100);
  }

  function updateMeldScrollHint() {
    const m = el('melds');
    if (!m) return;
    m.classList.toggle('canScrollDown', m.scrollHeight - m.clientHeight - m.scrollTop > 8);
    m.classList.toggle('canScrollUp', m.scrollTop > 8);
  }

  function renderTable() {
    const SCORE_TARGET = 1000;
    const myTotal = (lastState.totals && lastState.totals[playerId]) || 0;
    const scorePill = el('myScore');
    scorePill.textContent = L(`${myTotal} Pkt`, `${myTotal} pts`);
    // Colour carries the standing: accent only while I am actually ahead,
    // red when the total is negative, neutral otherwise. Before this a -245
    // read in the same celebratory green as a winning score.
    const bestOther = Math.max(
      0,
      ...lastState.players.filter((p) => p.id !== playerId).map((p) => (lastState.totals && lastState.totals[p.id]) || 0)
    );
    const negative = myTotal < 0;
    const leading = myTotal > 0 && myTotal >= bestOther;
    scorePill.classList.toggle('scoreNegative', negative);
    scorePill.classList.toggle('scoreLeading', leading);
    scorePill.classList.toggle('scoreNeutral', !negative && !leading);
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
        if (reconnecting) d.classList.add('disconnected');
        d.innerHTML = `<div class="opName">${avatarFor(p.name, p.isBot)}${nameWithHeart(p.name)}${diffBadge}${dealerStar}${reconnecting ? ` <span class="reconnectTag">⏳ ${L('getrennt', 'offline')}</span>` : ''}</div><div class="opCount"><b>${p.handCount}</b> ${L('Kt', 'cd')} · <b>${opTotal}</b> ${L('Pkt', 'pts')}</div><div class="scoreBar" title="${L('Fortschritt bis 1000 Punkte', 'Progress towards 1000 points')}"><i style="width:${opProgress}%"></i></div>`;
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
        : L(`Auslagen von ${escapeHtml(owner.name)}${botMark(owner)}`, `${escapeHtml(owner.name)}'s melds${botMark(owner)}`);
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
          const card = slot.real || {
            isJoker: true,
            rank: slot.representsRank,
            suit: slot.representsSuit,
            _isJokerSlot: true,
            // In a RUN the suit is what makes the sequence readable, so the
            // ghost label keeps it. In a SET every card has a different suit
            // anyway and naming one made the joker look like a real card.
            _jokerInRun: meld.type === 'run',
          };
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
      if (t.isJoker) discardTopDiv.innerHTML = JOKER_MARK_SVG;
      else discardTopDiv.textContent = `${t.rank}${suitSymbol(t.suit)}`;
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
    el('drawPile').classList.toggle('glow', canDraw && lastState.drawPileCount > 0);
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
        if (added.length > 0) {
          freshCardIds = new Set(added);
          // Jump the fan to the new cards ONLY after a pile take: that can
          // add a dozen cards at once and is easy to miss. A single drawn
          // card stays where it is - re-centring fought the player's own
          // scrolling and made the hand feel stuck.
          if (pendingDrawSource === 'discard') freshScrollPending = true;
          pendingDrawSource = null;
        }
        // Markierung erlischt, sobald die Karte die Hand verlässt
        for (const id of [...freshCardIds]) if (!currentIds.has(id)) freshCardIds.delete(id);
        // Glow lives only for the OWN running turn: the lingering rim
        // shimmer used to survive into the opponents' turns (bug report).
        if (lastState.currentPlayerId !== playerId) {
          freshCardIds.clear();
          // A take the server refused would otherwise keep the marker armed
          // into a later, unrelated draw.
          pendingDrawSource = null;
        }
      }
      prevHandIds = currentIds;
      prevHandRound = lastState.roundNumber;
      if (handCollapsed) updateHandToggle(); // Kartenzahl am Pfeil aktualisieren
      // Hand sortieren - umschaltbar: nach Farbe (gut für Folgen) oder nach
      // Wert (gut für Sätze). Joker immer ans Ende.
      // Card count above the fan: with 15+ overlapping cards you cannot count
      // them by eye, and the number decides whether you can still go out.
      el('handCount').textContent = L(
        `${myPlayer.hand.length} Karten`,
        `${myPlayer.hand.length} cards`
      );
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
        // DICHTE-ADAPTIV (Foto-Report, 15 Karten auf 402pt): Bei voller Hand
        // blieb pro Karte nur ein ~20px-Streifen, aber Rotation (±10°) und
        // Hub liefen auf voller Stärke - Ergebnis: Gedränge, tanzende Kanten
        // und Anschnitt links durch den Rotations-Überhang. Ab 12 Karten
        // beruhigt sich der Fächer deutlich (±4°, Hub ≤3px); die Fächer-
        // Anmutung bleibt, die Eck-Indizes werden wieder ruhig lesbar.
        const dense = sorted.length >= 12;
        const rotCap = dense ? 4 : 10;
        const rotFactor = Math.min(3.5, (dense ? 18 : 42) / Math.max(sorted.length, 1));
        const rotate = Math.max(-rotCap, Math.min(rotCap, offset * rotFactor));
        const lift = Math.min(dense ? 3 : 6, Math.abs(offset) * (dense ? 0.6 : 1.2));
        cEl.style.transform = `rotate(${rotate}deg) translateY(${lift}px)`;
        // Die Auswahl-Anhebung kommt AUSSCHLIESSLICH aus CSS (.card.selected
        // { top: -14px }) - die frühere zusätzliche translateY(-18px) hier
        // war redundant und hob Karten 32px an, weit über die Reserve des
        // Containers (Foto-Report: Karten über der Werkzeugleiste).
        handDiv.appendChild(cEl);
        pendingDealCards.push(cEl);
      });

      // Dynamische Überlappung: die gesamte Hand passt IMMER auf die
      // Bildschirmbreite - kein horizontales Scrollen. Je mehr Karten,
      // desto stärker überlappen sie; der Ecken-Index oben links bleibt
      // dabei stets sichtbar. Mindestens 14px sichtbarer Streifen.
      const prevHandScroll = handDiv.scrollLeft; // Scroll-Position über Re-Render retten
      // Consume the one-shot here, not inside the frame: an early return
      // below (fewer than two cards) would otherwise leave it armed and
      // hijack a later, unrelated render.
      const scrollToFresh = freshScrollPending;
      freshScrollPending = false;
      requestAnimationFrame(() => {
        const cards = [...handDiv.children];
        if (cards.length < 2) return;
        const cardWidth = cards[0].offsetWidth || 60;
        // Randabzug dynamisch: der flache Dichte-Fächer (±4°) hat kaum noch
        // Rotations-Überhang - der alte 64px-Abzug verschenkte Streifenbreite.
        const denseHand = cards.length >= 12;
        const available = handDiv.parentElement.clientWidth - (denseHand ? 44 : 64);
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
          : Math.max(16, Math.min(naturalVisible, fitVisible));
        const overlap = visible - cardWidth;
        cards.forEach((c, i) => {
          c.style.marginLeft = i === 0 ? '0' : `${overlap}px`;
        });
        if (scrollMode) {
          updateHandScrollEdges(handDiv);
          const fresh = scrollToFresh
            ? cards.find((c) => c.classList.contains('just-drawn'))
            : null;
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
    // The row in the settings sheet is labelled, so the value column only
    // carries the vote tally while a forfeit is being decided. Whoever is
    // being asked also gets the toast further below.
    setRowValue(el('forfeitBtn'), forfeitVotes.length ? `${forfeitVotes.length}/${humansForfeit}` : '');
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
      // Once per turn was still 10-15 times a round: the same sentence over
      // and over long after it was understood (player report). It is a
      // how-to-play tip, not a status message - it fades out after a few
      // showings and stays gone. Switching tips off and on again in the
      // settings is an explicit "show me that again" and resets the count.
      const turnKey = `${lastState.roundNumber}-${lastState.turnIndexInRound}`;
      if (
        gameTipsEnabled &&
        tipShownForTurn !== turnKey &&
        selectedCardIds.size === 0 &&
        tipSeenCount < TIP_MAX_SHOWS
      ) {
        tipShownForTurn = turnKey;
        tipSeenCount += 1;
        storageSet(TIP_SEEN_KEY, String(tipSeenCount));
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
  // Multi lay-off: can ALL selected cards go onto this meld together - und
  // zwar EINDEUTIG? Spiegelt die Server-Suche aus layOffCards: alle
  // Reihenfolgen und alle Joker-Plaetze durchprobieren, Ergebnisse
  // reihenfolgeunabhaengig vergleichen. Nur bei GENAU EINEM Ergebnis wird
  // gruen markiert - der Server fragt sonst nach, und ein gruener Rahmen
  // darf nie etwas versprechen, was dann abgelehnt wird.
  const SUIT_ORDER = ['H', 'D', 'C', 'S'];   // gleiche Reihenfolge wie im Server
  function layOffOptionsFor(meld, card) {
    const rIdx = (r) => RANK_ORDER.indexOf(r);
    if (!card.isJoker) {
      // Karten, die nur ueber einen Joker-TAUSCH "passen", zaehlen nicht.
      const swapOnly =
        meld.slots.some((s) => s.joker && s.representsRank === card.rank && s.representsSuit === card.suit) &&
        !cardFitsMeldPureAdd(meld, card);
      if (swapOnly || !cardFitsMeldPureAdd(meld, card)) return [];
      if (meld.type === 'set') return [{ ...meld, slots: [...meld.slots, { real: card }] }];
      const first = slotRank(meld.slots[0]);
      const prev = RANK_ORDER[(rIdx(first) - 1 + 13) % 13];
      return card.rank === prev
        ? [{ ...meld, slots: [{ real: card }, ...meld.slots] }]
        : [{ ...meld, slots: [...meld.slots, { real: card }] }];
    }
    // Joker
    if (meld.type === 'set') {
      if (meld.slots.length >= 8) return [];
      const free = SUIT_ORDER.find((s) => meld.slots.filter((x) => slotSuit(x) === s).length < 2);
      if (!free) return [];
      // Kanonisch die erste freie Farbe - genau EINE Moeglichkeit (wie im Server).
      return [{ ...meld, slots: [...meld.slots, { joker: card, representsRank: meld.rank, representsSuit: free }] }];
    }
    if (meld.type === 'run') {
      if (meld.slots.length >= 13) return [];
      const suit = slotSuit(meld.slots[0]);
      const first = slotRank(meld.slots[0]);
      const last = slotRank(meld.slots[meld.slots.length - 1]);
      const prev = RANK_ORDER[(rIdx(first) - 1 + 13) % 13];
      const next = RANK_ORDER[(rIdx(last) + 1) % 13];
      const out = [{ ...meld, slots: [...meld.slots, { joker: card, representsRank: next, representsSuit: suit }] }];
      if (prev !== next) {
        out.push({ ...meld, slots: [{ joker: card, representsRank: prev, representsSuit: suit }, ...meld.slots] });
      }
      return out;
    }
    return [];
  }
  function cardsFitMeldTogether(meld, cards) {
    if (!cards.length) return false;
    const signature = (m) =>
      m.slots
        .map((s) => (s.real ? `${s.real.rank}${s.real.suit}` : `J:${s.representsRank}${s.representsSuit}`))
        .sort()
        .join('|');
    const results = new Set();
    let budget = 300;
    const walk = (cur, remaining) => {
      if (budget-- <= 0 || results.size > 1) return;
      if (remaining.length === 0) { results.add(signature(cur)); return; }
      for (let i = 0; i < remaining.length; i++) {
        for (const next of layOffOptionsFor(cur, remaining[i])) {
          walk(next, remaining.filter((_, j) => j !== i));
        }
      }
    };
    walk({ ...meld, slots: meld.slots.slice() }, cards.slice());
    return results.size === 1;
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

  /**
   * Count a score up from zero. The final number is written immediately as the
   * element's text, so a reduced-motion user (or a mid-animation re-render)
   * always sees the real value - the animation only replaces what is painted.
   */
  function countUpScore(node, finalValue, { signed: withSign = false } = {}) {
    if (!node) return;
    const fmt = (v) => (withSign && v > 0 ? `+${v}` : `${v}`);
    node.textContent = fmt(finalValue);
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    if (!Number.isFinite(finalValue) || finalValue === 0) return;
    const DURATION = 650;
    const start = performance.now();
    const step = (now) => {
      const t = Math.min(1, (now - start) / DURATION);
      // ease-out: fast first, settles onto the real number
      const eased = 1 - Math.pow(1 - t, 3);
      node.textContent = fmt(Math.round(finalValue * eased));
      if (t < 1) requestAnimationFrame(step);
      else node.textContent = fmt(finalValue);
    };
    requestAnimationFrame(step);
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
      ? L('Spiel aufgegeben', 'Game forfeited')
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
    tabStatsBtn.textContent = L('Statistik', 'Stats'); // no emoji: its sibling tab has none either
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
          row.innerHTML = `<span>${nameWithHeart(p.name)}${botMark(p)}</span><span>${L('Gesamt', 'Total')}: ${fTotals[p.id] || 0}</span>`;
          paneResult.appendChild(row);
        });
    }

    // Die Doppelwertung ist eine OPTIONALE Hausregel. Ohne sie ist "Hand aus"
    // keine Punktbesonderheit - dann darf hier auch keine versprochen werden
    // (Spieler-Report: Notiz erschien immer, die Wertung verdoppelte aber
    // korrekterweise nur bei aktiver Regel).
    const handAusDoubles = !!(lastState.houseRules && lastState.houseRules.handAusDoubles);
    if (!forfeited && lastState.lastRoundWasHandAus && handAusDoubles) {
      const handAusNote = document.createElement('p');
      handAusNote.className = 'handAusNote';
      handAusNote.textContent = L('🎉 Hand aus! Die komplette Rundenwertung zählt doppelt.', '🎉 Out in one! The entire round score counts double.');
      paneResult.appendChild(handAusNote);
    }
    if (!forfeited && lastState.lastRoundResult) {
      const SCORE_TARGET = 1000;
      const signed = (n) => (n > 0 ? `+${n}` : `${n}`);

      // The winner is whoever went OUT, which is often not the biggest number
      // on screen - as a green table row among four that read like a bug
      // ("why is 245 the winner when 250 is right below it?"). Lift them out
      // of the table into a headline that says it in words.
      const winner = lastState.players.find(
        (p) => lastState.lastRoundResult[p.id] && lastState.lastRoundResult[p.id].breakdown.isWinner
      );
      if (winner && !isGameOver) {
        const wr = lastState.lastRoundResult[winner.id];
        const head = document.createElement('div');
        head.className = 'resultWinner';
        head.innerHTML =
          `<div class="resultWinnerName">${nameWithHeart(winner.name)}${botMark(winner)}</div>` +
          `<div class="resultWinnerSub">${
            winner.id === playerId
              ? L('Du gewinnst die Runde', 'You win the round')
              : L('gewinnt die Runde', 'wins the round')
          }</div>` +
          `<div class="resultWinnerScore"></div>`;
        paneResult.appendChild(head);
        countUpScore(head.querySelector('.resultWinnerScore'), wr ? wr.roundScore : 0, { signed: true });
      }

      // Everyone else: the round delta is the number that changed, so it gets
      // the size; the running total is context underneath. A bar shows how far
      // each player has come towards the 1000-point finish - the round table
      // alone never showed how close the match actually is.
      const list = document.createElement('div');
      list.className = 'resultList';
      // EVERY player stays in the list, the winner included. Promoting them
      // into the headline and dropping their row left a 4-player game showing
      // three lines, which reads as a missing player (report) - and the race
      // bars are only comparable if all of them are there.
      lastState.players
        .forEach((p) => {
          const r = lastState.lastRoundResult[p.id];
          const total = lastState.totals[p.id] || 0;
          const pct = Math.max(0, Math.min(100, (total / SCORE_TARGET) * 100));
          const delta = r ? r.roundScore : 0;
          const row = document.createElement('div');
          row.className = 'resultRow' + (r && r.breakdown.isWinner ? ' winner' : '') +
            (p.id === playerId ? ' isMe' : '');
          // The delta is coloured by its SIGN, nothing else. Marking "me" or
          // the round winner in green painted -170 the same celebratory green
          // as +230 (player report).
          const deltaCls = delta > 0 ? ' pos' : delta < 0 ? ' neg' : '';
          row.innerHTML =
            `<div class="resultRowTop">` +
            `<span class="resultName">${nameWithHeart(p.name)}${botMark(p)}</span>` +
            `<span class="resultDelta${deltaCls}">${signed(delta)}</span>` +
            `</div>` +
            `<div class="resultRowBar"><i style="width:${pct}%"></i></div>` +
            `<div class="resultRowFoot">${L('gesamt', 'total')} ${total}</div>`;
          list.appendChild(row);
        });
      paneResult.appendChild(list);
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
      // The match winner belongs at the TOP. It used to be a line of body text
      // below four score rows - the single most important sentence on the
      // screen, and you had to read past everything else to reach it.
      const head = document.createElement('div');
      head.className = 'resultWinner resultWinnerGame';
      head.innerHTML =
        `<div class="resultWinnerCrown">${JOKER_MARK_SVG}</div>` +
        `<div class="resultWinnerName">${nameWithHeart(winner ? winner.name : '?')}${winner ? botMark(winner) : ''}</div>` +
        `<div class="resultWinnerSub">${
          winner && winner.id === playerId
            ? L('Du gewinnst die Partie', 'You win the match')
            : L('gewinnt die Partie', 'wins the match')
        }</div>` +
        `<div class="resultWinnerScore"></div>`;
      paneResult.insertBefore(head, paneResult.firstChild);
      countUpScore(
        head.querySelector('.resultWinnerScore'),
        (lastState.totals && lastState.totals[winner ? winner.id : '']) || 0
      );
      // Schlüsselmomente der Partie: 3 erzählte Zeilen statt nur Zahlen.
      const hl = isGameOver && lastState.gameOverInfo && lastState.gameOverInfo.highlights;
      if (hl && hl.length) {
        const box = document.createElement('div');
        box.className = 'matchMoments';
        // A timeline, not a list of emoji-led sentences: round as a chip, a
        // headline naming what happened, the detail underneath, and the
        // point swing on the right where the eye already looks for numbers.
        const moment = (h) => {
          if (h.type === 'queenCaught') {
            return {
              kind: 'bad', swing: '-100',
              title: L(`${h.name} erwischt`, `${h.name} caught out`),
              text: L('Die Pik Dame blieb auf der Hand liegen.', 'Left holding the Queen of Spades.'),
            };
          }
          if (h.type === 'queenLaid') {
            return {
              kind: 'good', swing: '+100',
              title: L(`${h.name} legt die Pik Dame`, `${h.name} melds the Queen of Spades`),
              text: L('Die teuerste Karte im Spiel - ausgelegt statt kassiert.', 'The most expensive card in the game, melded instead of eaten.'),
            };
          }
          if (h.type === 'handAus') {
            return {
              kind: 'good', swing: '',
              title: L(`${h.name} macht Hand aus`, `${h.name} goes out in one`),
              text: L('Die komplette Hand in einem einzigen Zug.', 'The whole hand in a single turn.'),
            };
          }
          if (h.type === 'bestRound') {
            return {
              kind: 'good', swing: h.score > 0 ? `+${h.score}` : `${h.score}`,
              title: L(`Beste Runde der Partie: ${h.name}`, `Best round of the match: ${h.name}`),
              text: L('Keine Runde brachte jemandem mehr ein.', 'No round earned anyone more.'),
            };
          }
          return null;
        };
        const rows = hl
          .map((h) => ({ h, m: moment(h) }))
          .filter((x) => x.m)
          .map(({ h, m }) =>
            `<li class="momentItem ${m.kind}">` +
            `<span class="momentRound">${L('R', 'R')}${h.round}</span>` +
            `<span class="momentBody">` +
            `<span class="momentTitle">${escapeHtml(m.title)}</span>` +
            `<span class="momentText">${escapeHtml(m.text)}</span>` +
            `</span>` +
            (m.swing ? `<span class="momentSwing">${m.swing}</span>` : '') +
            `</li>`
          )
          .join('');
        box.innerHTML = `<h4>${L('Schlüsselmomente', 'Key moments')}</h4><ul class="momentList">${rows}</ul>`;
        paneResult.appendChild(box);
      }
      // Brotato-artige Anti-Auszeichnung: liebevoller Spott, rein kosmetisch.
      const ft = isGameOver && lastState.gameOverInfo && lastState.gameOverInfo.funTitle;
      if (ft && ft.type === 'queenMagnet') {
        const t = document.createElement('p');
        t.className = 'funTitleLine';
        t.textContent = `🎩 ${L(
          `Damen-Magnet der Partie: ${ft.name} (${ft.count}× mit der ♠Q erwischt)`,
          `Queen magnet of the match: ${ft.name} (caught with the ♠Q ${ft.count}×)`
        )}`;
        paneResult.appendChild(t);
      }
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
    // Leaving for the main menu used to be offered ONLY after the whole match
    // was over - at round end the result overlay covers the table, so the
    // header's home button is unreachable and the only exits were "next round"
    // or forfeiting the entire game (player report). The table keeps running
    // and the session code still resumes it, so leaving is safe here.
    el('resultHomeBtn').classList.remove('hidden');
    // At game over "Weiter" is no longer the obvious next step - unfold the
    // secondary actions so the way out is visible without a tap.
    const moreBox = el('resultMore');
    if (moreBox) moreBox.open = isGameOver;
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
      // Label span only - the button carries an <svg class="icon">, and
      // textContent would delete it (and put an emoji back in its place).
      setLabelText(
        rfBtn,
        fv.length
          ? L(`Aufgeben (${fv.length}/${hc})`, `Forfeit (${fv.length}/${hc})`)
          : L('Spiel aufgeben', 'Forfeit game')
      );
    }
    if (isGameOver) {
      contBtn.disabled = false;
      // Challenge: dieselbe Tages-Herausforderung noch einmal versuchen -
      // gleiches Deck, frische Chance (der Server startet solo direkt neu).
      contBtn.textContent = lastState.challengeDate
        ? L('🔁 Noch mal probieren', '🔁 Try again')
        : L('Neue Partie (Rematch)', 'New game (rematch)');
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
    // The body scrolls on its own now (the action footer is pinned) - so it
    // needs the same fade affordance as the hand and the melds: on iOS the
    // scrollbar is invisible at rest and nothing else says "more below".
    requestAnimationFrame(() => updateResultScrollEdges());
  }

  function updateResultScrollEdges() {
    const b = el('resultBody');
    if (!b) return;
    b.classList.toggle('canScrollDown', b.scrollHeight - b.clientHeight - b.scrollTop > 8);
  }
  el('resultBody').addEventListener('scroll', updateResultScrollEdges, { passive: true });

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
  try {
    const scaleSel = el('uiScaleSelect');
    if (scaleSel) {
      scaleSel.addEventListener('change', () => {
        uiScale = UI_SCALES.includes(scaleSel.value) ? scaleSel.value : 'normal';
        storageSet(UI_SCALE_KEY, uiScale);
        applyUiScale();
        if (typeof render === 'function' && lastState) render(); // Hand-Überlappung neu messen
      });
    }
  } catch (e) { /* Einstellung ist Komfort */ }
  el('langBtnLobby').addEventListener('click', cycleLang);
  applyStaticLang();

  el('handToggleBtn').addEventListener('click', () => {
    handCollapsed = !handCollapsed;
    updateHandToggle();
  });
  function updateHandToggle() {
    el('handWrapper').classList.toggle('handCollapsed', handCollapsed);
    // The button is a plain chevron that flips (CSS rotates it). It used to
    // relabel itself to "⌃ 15 Karten" when collapsed, which made it change
    // width and typography mid-game; the count now lives permanently in
    // #handCount next to it, visible in both states.
    el('handToggleBtn').title = handCollapsed
      ? L('Karten einblenden', 'Show cards')
      : L('Karten ausblenden', 'Hide cards');
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
    pendingDrawSource = 'drawPile';
    flyCard(el('drawPile'), el('hand'), true);
    send({ type: 'drawFromPile' });
  });

  el('discardPile').addEventListener('click', () => {
    if (el('discardPile').classList.contains('disabled')) return;
    sound.draw();
    // Remembered until the new cards show up in the next state: only a
    // pile take is allowed to scroll the fan to them.
    pendingDrawSource = 'discard';
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
    // Opened from the settings sheet - close that first, otherwise the panel
    // appears behind it and the tap looks like it did nothing.
    el('gameSettingsOverlay').classList.add('hidden');
    el('logPanel').classList.toggle('hidden');
  });

  el('logCloseBtn').addEventListener('click', () => {
    el('logPanel').classList.add('hidden');
  });

  el('tipsToggle').addEventListener('click', () => {
    setTipsEnabled(!gameTipsEnabled);
    if (gameTipsEnabled) {
      // Deliberately switching them back on means "show me those again".
      tipSeenCount = 0;
      tipShownForTurn = null;
      storageSet(TIP_SEEN_KEY, '0');
    }
    showToast(
      gameTipsEnabled
        ? L('Spiel-Tipps sind wieder an.', 'Game tips are back on.')
        : L('Spiel-Tipps sind aus. Wieder einschalten: in den Einstellungen.', 'Game tips are off. Re-enable them in the settings.')
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

  // --- Home button + settings sheet (tidy three-button header) ---------------
  el('settingsBtn').addEventListener('click', () => {
    el('gameSettingsOverlay').classList.remove('hidden');
  });
  el('gameSettingsCloseBtn').addEventListener('click', () => {
    el('gameSettingsOverlay').classList.add('hidden');
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

  // Lobby verlassen: Server räumt den Sitz, wir vergessen die Zugangsdaten
  // (sonst würde der Auto-Resume sofort wieder in die Session springen) und
  // laden das Hauptmenü. Vorher gab es aus einer erstellten Lobby KEINEN Weg
  // zurück ins Hauptmenü.
  el('leaveLobbyBtn').addEventListener('click', () => {
    if (!lastState || lastState.phase !== 'lobby') return;
    send({ type: 'leaveLobby' });
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
    // Tages-Challenge: Bot-Stärke ist fest (mittel für alle) - Menü gar nicht anbieten.
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
      highlight: () => ({ cardIds: [], meldIds: [], targets: ['drawPile'] }),
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
      // Tutorial-Deck: Die Starthand enthaelt DREI Damen inklusive der Pik
      // Dame - der beste Moment, den Unterschied zwischen +100 und -100 zu
      // zeigen, statt nur davor zu warnen.
      key: 'queenSet',
      when: (st, me, myTurn) =>
        st.tutorialMode && myTurn && st.turnPhase === 'meld' && me && me.hand &&
        me.hand.filter((cd) => cd.rank === 'Q').length >= 3 &&
        me.hand.some((cd) => cd.rank === 'Q' && cd.suit === 'S'),
      highlight: (st, me) => ({
        cardIds: me.hand.filter((cd) => cd.rank === 'Q').map((cd) => cd.id),
        meldIds: [],
        targets: [],
      }),
      text: () => L(
        'Chance! Du hast drei Damen - eine davon ist die Pik Dame. Legst du sie aus, bringt sie dir +100 statt am Ende -100. Tippe die markierten Damen an und lege sie.',
        'Opportunity! You hold three queens - one is the Queen of Spades. Melded she scores +100 instead of -100 at the end. Tap the highlighted queens and lay them down.'
      ),
    },
    {
      key: 'discardStep',
      when: (st, me, myTurn) =>
        st.tutorialMode && myTurn && st.turnPhase === 'meld' && !st.mustLayOffCardId &&
        me && me.hand && me.hand.length > 1 && !findTutorialMeld(me.hand),
      highlight: () => ({ cardIds: [], meldIds: [], targets: ['discardBtn'] }),
      text: () => L(
        'Zug beenden: Wähle eine Karte, die du am wenigsten brauchst, und tippe auf „Abwerfen". Erst damit ist dein Zug vorbei.',
        'End your turn: pick the card you need least and tap "Discard". Only then is your turn over.'
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

  /** Erklaert die Regel hinter einer Ablehnung - nur im Tutorial. */
  function tutorialExplainError(error) {
    const RULES = [
      [/abzuwerfen|abwerfen übrig|keine Karte zum Abwerfen/i, L(
        'Ausmachen geht nur, indem du deine LETZTE Karte abwirfst. Deshalb darfst du den Ablagestapel nicht nehmen, wenn danach nichts zum Abwerfen übrig bliebe.',
        'You can only go out by DISCARDING your last card. That is why you cannot take the discard pile if nothing would be left to discard.')],
      [/passt zu keiner Kombination/i, L(
        'Die oberste Ablagekarte darfst du nur nehmen, wenn sie SOFORT mit deinen Handkarten eine neue Kombination bildet - an eine Auslage anlegen reicht nicht.',
        'You may only take the top discard if it IMMEDIATELY forms a new combination with your hand - being able to add it to a meld is not enough.')],
      [/EIGENEN Auslagen|fremde Stapel/i, L(
        'Anlegen darfst du nur an deine eigenen Auslagen. Fremde Auslagen sind tabu - so bleibt jedem sein Punktestand.',
        'You may only add to your own melds. Other players\' melds are off limits - that keeps everyone\'s score their own.')],
      [/mindestens drei|zu kurz|keine gültige/i, L(
        'Eine Kombination braucht mindestens DREI Karten: gleicher Wert (Satz) oder lückenlose Folge derselben Farbe.',
        'A combination needs at least THREE cards: same rank (set) or a gap-free run in one suit.')],
      [/nicht am Zug|bist nicht dran/i, L(
        'Erst wenn du am Zug bist. Oben steht immer, wer gerade dran ist.',
        'Only when it is your turn. The top line always shows whose turn it is.')],
    ];
    for (const [pattern, explanation] of RULES) if (pattern.test(error)) return explanation;
    return null;
  }

  let tutorialHighlight = null;
  function applyTutorialHighlight(hl) {
    document.querySelectorAll('.tutorialGlow').forEach((n) => n.classList.remove('tutorialGlow'));
    document.querySelectorAll('.tutorialGlowMeld').forEach((n) => n.classList.remove('tutorialGlowMeld'));
    // ZIELE (Ziehstapel, Abwerfen-Knopf ...) - nur im Tutorial, nie im
    // normalen Spiel.
    document.querySelectorAll('.tutorialGlowTarget').forEach((n) => n.classList.remove('tutorialGlowTarget'));
    if (hl && Array.isArray(hl.targets) && tutorialActive) {
      for (const id of hl.targets) {
        const node = document.getElementById(id);
        if (node && !node.classList.contains('hidden')) node.classList.add('tutorialGlowTarget');
      }
    }
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
    // '7 Tage sichtbar' jetzt wörtlich: kompakter Rückblick auf die letzten
    // Tage (Tagessieger + eigener Platz), aufklappbar unter der Tagesliste.
    const past = (b.history || []).filter((d) => d.date !== b.date && (d.players > 0 || d.yourScore != null));
    const histRows = past
      .map((d) => {
        const win = d.top && d.top[0]
          ? `🥇 ${escapeHtml(d.top[0].name)} · ${d.top[0].score}`
          : L('keine Teilnahmen', 'no entries');
        const mine = d.yourScore != null
          ? ` — ${L(`du: ${d.yourScore} (Platz ${d.yourRank})`, `you: ${d.yourScore} (rank ${d.yourRank})`)}`
          : '';
        return `<div class="challengeHistDay"><span>${escapeHtml(d.date)}</span><span>${win}${mine}</span></div>`;
      })
      .join('');
    const histBlock = histRows
      ? `<details class="challengeHistory"><summary>${L('Vergangene Tage', 'Past days')} (${past.length})</summary>${histRows}</details>`
      : '';
    // Wochenwertung: beste 5 Tages-Scores der laufenden Woche (Mo-So).
    const wk = b.weekly;
    const weeklyBlock = wk && wk.players > 0
      ? `<div class="challengeWeekly"><h4>🗓️ ${L('Wochenwertung', 'Weekly ranking')} <span class="weekRange">${escapeHtml(wk.week)}</span></h4>` +
        wk.top.map((e) => `<div class="challengeHistDay"><span>#${e.rank} ${escapeHtml(e.name)}</span><span>${e.weekScore} ${L('Pkt', 'pts')} · ${e.days} ${L('Tage', 'days')}</span></div>`).join('') +
        (wk.yourRank && wk.yourRank > wk.top.length
          ? `<div class="challengeHistDay"><span>#${wk.yourRank} ${L('du', 'you')}</span><span>${wk.yourScore} ${L('Pkt', 'pts')}</span></div>`
          : '') +
        `<p class="weeklyHint">${L('Deine besten 5 Tage der Woche zählen.', 'Your best 5 days of the week count.')}</p></div>`
      : '';
    box.innerHTML = `<h3>🗓️ ${L('Tages-Challenge', 'Daily challenge')} ${escapeHtml(b.date)}</h3>
      <p class="challengeYour">${L(`Dein Ergebnis: ${b.yourScore} Punkte${b.yourRank ? ` · Platz ${b.yourRank}` : ''}`, `Your result: ${b.yourScore} points${b.yourRank ? ` · rank ${b.yourRank}` : ''}`)}</p>
      <table class="statsTable"><tbody>${rows}</tbody></table>${weeklyBlock}${histBlock}`;
    body.appendChild(box);
  }

  // --- Daily challenge --------------------------------------------------------
  el('challengeBtn').addEventListener('click', () => {
    // Explain first, play second: the cold start straight into a running
    // game left people wondering what was going on.
    el('challengeTopLine').textContent = '…';
    el('challengeIntroOverlay').classList.remove('hidden');
    el('challengeWeekLine').textContent = '';
    fetch('/challengeboardz')
      .then((r) => r.json())
      .then((d) => {
        const top = d && d.board && d.board[0];
        el('challengeTopLine').textContent = top
          ? `🥇 ${top.name} – ${top.score} ${L('Punkte', 'points')}${d.board[1] ? `  ·  🥈 ${d.board[1].name} – ${d.board[1].score}` : ''}`
          : L('Noch niemand - sichere dir Platz 1!', 'Nobody yet - claim first place!');
        // Wochenwertung: beste 5 von 7 Tagen - belohnt Regelmaessigkeit statt
        // eines einzelnen Gluckstreffers.
        // ACHTUNG: getWeekly liefert das Feld "top" (nicht "board" wie die
        // Tagesliste) - mit dem falschen Namen bliebe die Zeile still leer.
        const week = (d && d.weekly && d.weekly.top) || [];
        el('challengeWeekLine').textContent = week.length
          ? week.slice(0, 3).map((e, i) => `${['🥇', '🥈', '🥉'][i]} ${e.name} – ${e.weekScore}`).join('  ·  ')
          : L('Diese Woche noch offen.', 'Nothing this week yet.');
      })
      .catch(() => {
        el('challengeTopLine').textContent = L('Bestenliste gerade nicht erreichbar.', 'Leaderboard unavailable right now.');
        el('challengeWeekLine').textContent = '';
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
    // Eigene Sitzung mit FESTEM Deck (Server: startTutorial). Vorher lief das
    // Tutorial auf einem zufaelligen Spiel - ob ein Satz, ein Joker oder die
    // Pik Dame ueberhaupt auftauchte, entschied das Mischgluck.
    send({ type: 'startTutorial', name: currentName(), accountToken: accountToken() || undefined });
  });
  el('tutorialNextBtn').addEventListener('click', () => {
    if (tutorialCurrentStep) tutorialSeen.add(tutorialCurrentStep);
    tutorialCurrentStep = null;
    persistTutorial();
    updateTutorial();
  });
  const TUTORIAL_LABELS = {
    lobby: () => L('Spiel starten', 'Start a game'),
    draw: () => L('Karte ziehen', 'Draw a card'),
    meld: () => L('Kombination auslegen', 'Lay down a combination'),
    queenSet: () => L('Pik Dame auslegen (+100)', 'Meld the Queen of Spades (+100)'),
    discardStep: () => L('Zug mit Abwerfen beenden', 'End the turn by discarding'),
    pickupRest: () => L('Ablagestapel aufnehmen', 'Take the discard pile'),
    pikdame: () => L('Pik Dame: +100 oder -100', 'Queen of Spades: +100 or -100'),
    joker: () => L('Joker einsetzen', 'Use a joker'),
    endgame: () => L('Ausmachen: letzte Karte abwerfen', 'Going out: discard the last card'),
    roundend: () => L('Wertung verstehen', 'Understand the scoring'),
  };
  function renderTutorialChecklist() {
    const list = document.getElementById('tutorialChecklist');
    if (!list) return;
    list.innerHTML = '';
    let done = 0;
    for (const step of TUTORIAL_STEPS) {
      const label = TUTORIAL_LABELS[step.key];
      if (!label) continue;
      const seen = tutorialSeen.has(step.key);
      if (seen) done += 1;
      const li = document.createElement('li');
      if (seen) li.className = 'done';
      const tick = document.createElement('span');
      tick.className = 'tick';
      tick.textContent = seen ? '✅' : '⬜';
      const txt = document.createElement('span');
      txt.textContent = label();
      li.append(tick, txt);
      list.appendChild(li);
    }
    const title = document.getElementById('tutorialChecklistTitle');
    if (title) title.textContent = `🎓 ${L('Dein Fortschritt', 'Your progress')} ${done}/${list.children.length}`;
  }
  try {
    const progressBtn = el('tutorialProgressBtn');
    const overlay = el('tutorialChecklistOverlay');
    const closeBtn = el('tutorialChecklistCloseBtn');
    if (progressBtn && overlay) {
      progressBtn.addEventListener('click', () => { renderTutorialChecklist(); overlay.classList.remove('hidden'); });
    }
    if (closeBtn && overlay) closeBtn.addEventListener('click', () => overlay.classList.add('hidden'));
    if (overlay) overlay.addEventListener('click', (ev) => { if (ev.target === overlay) overlay.classList.add('hidden'); });
  } catch (e) { /* Lernhilfe ist nie kritisch */ }

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
  const TIP_SEEN_KEY = 'pikdame_tip_seen';
  const TIP_MAX_SHOWS = 3; // danach kennt man den Bedien-Tipp
  let tipSeenCount = Number(storageGet(TIP_SEEN_KEY)) || 0;
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
        // Getrennt-/Rückkehr-Meldungen leben jetzt DAUERHAFT am Spieler-Chip
        // (gedimmter Chip + ⏳-Badge) - der flüchtige Riesen-Toast mitten im
        // Spielfeld entfällt dafür (Nutzer-Feedback). Im Log stehen sie weiter.
        const chipStatus = / ist getrennt - kehrt | ist wieder (da|verbunden)/.test(latest.text);
        if (!chipStatus) {
          // Die Endspurt-Ansage ist wichtig genug fuer eine laengere Anzeige
          const isWarning = latest.text.startsWith('⚠️');
          showToast(trs(latest.text), isWarning ? { duration: 6000, priority: true } : {});
        }
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

  function hideToast() {
    clearTimeout(toastTimer);
    toastLockUntil = 0;
    el('toastContainer').classList.remove('visible');
  }

  // Overlays are modal and centred - exactly where the toast sits, and the
  // toast wins on z-index (350 vs 50). A tip that is still on screen when the
  // round result opens covers the score rows, so drop the CURRENT toast the
  // moment an overlay becomes visible. Toasts raised afterwards (server
  // errors, warnings) still show through on top, which is what we want.
  const overlayToastWatcher = new MutationObserver((records) => {
    for (const r of records) {
      const wasHidden = (r.oldValue || '').split(/\s+/).includes('hidden');
      if (wasHidden && !r.target.classList.contains('hidden')) {
        hideToast();
        return;
      }
    }
  });
  document.querySelectorAll('.overlay').forEach((o) =>
    overlayToastWatcher.observe(o, { attributes: true, attributeFilter: ['class'], attributeOldValue: true }));

  // --- Vollbild ("Kiosk-Modus" wie bei Videos) -------------------------------
  // Fullscreen-API gibt es auf Android/Desktop (Chrome/Edge/Firefox). iOS
  // Safari unterstützt sie für Webseiten nicht - dort bleibt der Button
  // verborgen (der PWA-Homescreen-Modus übernimmt das auf dem iPhone).
  const fsRoot = document.documentElement;
  if (fsRoot.requestFullscreen) {
    el('fullscreenBtn').classList.remove('hidden');
    setRowValue(el('fullscreenBtn'), L('Aus', 'Off')); // no fullscreenchange has fired yet
    el('fullscreenBtn').addEventListener('click', () => {
      if (document.fullscreenElement) {
        document.exitFullscreen();
      } else {
        fsRoot.requestFullscreen().catch(() => {});
      }
    });
    document.addEventListener('fullscreenchange', () => {
      const on = !!document.fullscreenElement;
      setRowIcon(el('fullscreenBtn'), on ? 'i-fullscreen-exit' : 'i-fullscreen');
      setRowValue(el('fullscreenBtn'), on ? L('An', 'On') : L('Aus', 'Off'));
      el('fullscreenBtn').title = on ? L('Vollbild verlassen', 'Exit fullscreen') : L('Vollbild', 'Fullscreen');
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
      // ALLE neuen Pik Damen einsammeln, nicht nur die erste: Wer beide in
      // einem Zug auslegt, sichert sich 200 Punkte - die Meldung behauptete
      // bisher 100 (Spieler-Report). Die WERTUNG war immer korrekt, nur die
      // Ankuendigung zaehlte nach der ersten Karte nicht weiter.
      const fresh = [...current].filter(([cardId]) => !prevTablePikdameIds.has(cardId));
      if (fresh.length > 0) {
        const owners = new Set(fresh.map(([, ownerId]) => ownerId));
        const points = fresh.length * 100;
        if (owners.size === 1) {
          const ownerId = fresh[0][1];
          const owner = lastState.players.find((p) => p.id === ownerId);
          const isMe = ownerId === playerId;
          const who = owner ? owner.name : '?';
          showRaidWarning(
            fresh.length > 1
              ? L('♠♠ BEIDE PIK DAMEN! ♠♠', '♠♠ BOTH QUEENS OF SPADES! ♠♠')
              : L('♠ PIK DAME! ♠', '♠ QUEEN OF SPADES! ♠'),
            isMe
              ? L(`Du sicherst dir ${points} Punkte!`, `You secure ${points} points!`)
              : L(`${who} sichert sich ${points} Punkte!`, `${who} secures ${points} points!`)
          );
        } else {
          // Selten, aber moeglich: zwei verschiedene Spieler im selben Zustand.
          showRaidWarning(
            L('♠♠ BEIDE PIK DAMEN! ♠♠', '♠♠ BOTH QUEENS OF SPADES! ♠♠'),
            L('Je 100 Punkte für zwei Spieler!', '100 points each for two players!')
          );
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
    // Label span only - the button carries an <svg class="icon">.
    setLabelText(el('accountBtn'), loggedIn ? accountUsername : L('Konto', 'Account'));
    // Angemeldet: der Spielername IST der Kontoname (Fortschritt haengt dran)
    if (loggedIn) {
      el('nameInput').value = accountUsername;
      el('nameInput').disabled = true;
      el('nameInput').title = L('Name ist durch dein Konto festgelegt', 'Name is fixed by your account');
    } else {
      el('nameInput').disabled = false;
      el('nameInput').title = '';
      accountProgress = null;
      el('ladderBox').classList.add('hidden');
    }
    renderAccountProgress();
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
    // Ladder + level are the reason to have an account at all - fetch them
    // when the panel opens, not on every page load.
    if (accountUsername) loadLadder().catch(() => {});
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
    // Three outcomes, not two: delivered, no relay configured, or a
    // configured relay that failed. The old two-way message blamed a
    // missing mail server even when SMTP was set up and merely broken.
    setAccountStatus(
      r.mailDelivered
        ? L('✅ Fast geschafft! Bitte den Bestätigungslink in deiner E-Mail öffnen, danach kannst du dich anmelden.', '✅ Almost done! Please open the confirmation link in your e-mail, then sign in.')
        : r.mailConfigured
          ? L('⚠️ Konto angelegt, aber die Bestätigungsmail konnte nicht verschickt werden. Der Link steht im Server-Log - bitte den Mailserver prüfen.', '⚠️ Account created, but the confirmation e-mail could not be sent. The link is in the server log - please check the mail server.')
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
    loadLadder().catch(() => {}); // fills level + season rank for next open
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
        setRowValue(el('ingameVersion'), `v${s.version}`);
        // PWA auto-update, part 2: my bundle carries the version of the
        // server that SERVED it (__PIKDAME_BUILD). If the live server is
        // newer, this client is stale (nightly update, PWA cache) - reload
        // ONCE to fetch the fresh bundle. Loop guard: at most one attempt
        // per 5 minutes; if the mismatch survives a reload, tell the user
        // instead of reload-cycling.
        const mine = window.__PIKDAME_BUILD;
        if (mine && mine !== s.version) {
          // On an iOS home-screen app location.reload() commonly re-serves the
          // SAME cached bundle, so reloading would just spin. There the banner
          // goes up straight away and names the only cure: close the app for
          // real (swipe it away in the app switcher) and reopen it.
          const iosStandalone = window.navigator.standalone === true;
          const last = Number(storageGet('pikdame_reload_at') || 0);
          if (!iosStandalone && Date.now() - last > 5 * 60 * 1000) {
            storageSet('pikdame_reload_at', String(Date.now()));
            window.location.reload();
          } else {
            showUpdateBanner(s.version, iosStandalone);
          }
        }
      }
      initAccount(!!(s && s.accountsEnabled));
      // Daily tasks belong on the FIRST screen - progress you only see after
      // a match motivates nobody. The counters arrive with the profiles.
      if (s && s.quests) {
        dailyQuests = s.quests;
        renderQuests();
      }
    })
    .catch(() => {});

  /**
   * Persistent "you are running an old bundle" notice. Deliberately NOT a
   * toast: the toast lasts 4s, sits in the middle of the screen and is now
   * dismissed as soon as any overlay opens - all wrong for something the
   * player has to act on.
   */
  function showUpdateBanner(serverVersion, iosStandalone) {
    const banner = el('updateBanner');
    if (!banner) return;
    el('updateBannerText').textContent = iosStandalone
      ? L(
          `Version v${serverVersion} ist da. Diese App läuft noch mit einer älteren - bitte einmal komplett schließen (im App-Umschalter nach oben wischen) und neu öffnen.`,
          `Version v${serverVersion} is out. This app is still running an older one - please close it completely (swipe it away in the app switcher) and reopen it.`
        )
      : L(
          `Version v${serverVersion} ist da. Diese Seite läuft noch mit einer älteren.`,
          `Version v${serverVersion} is out. This page is still running an older one.`
        );
    const reloadBtn = el('updateReloadBtn');
    reloadBtn.textContent = L('Neu laden', 'Reload');
    // On iOS the reload is exactly the thing that does not help - do not
    // offer a button that quietly does nothing.
    reloadBtn.classList.toggle('hidden', !!iosStandalone);
    banner.classList.remove('hidden');
  }
  el('updateReloadBtn').addEventListener('click', () => {
    storageSet('pikdame_reload_at', String(Date.now()));
    window.location.reload();
  });
  el('updateDismissBtn').addEventListener('click', () => {
    el('updateBanner').classList.add('hidden');
  });

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
  try {
    const openBtn = el('settingsBtnLobby');
    const overlay = el('settingsOverlay');
    const closeBtn = el('settingsOverlayCloseBtn');
    if (openBtn && overlay) openBtn.addEventListener('click', () => overlay.classList.remove('hidden'));
    if (closeBtn && overlay) closeBtn.addEventListener('click', () => overlay.classList.add('hidden'));
    if (overlay) overlay.addEventListener('click', (ev) => { if (ev.target === overlay) overlay.classList.add('hidden'); });
  } catch (e) { /* Menue ist Komfort */ }

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
      // Label span only - the button carries an <svg class="icon">.
      setLabelText(
        el('pauseResumeBtn'),
        iVoted ? L('Warte auf die anderen', 'Waiting for the others') : L('Fortsetzen', 'Resume')
      );
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
  // Tapping anywhere else dismisses the emote bar - it is a transient picker,
  // not a mode. Capture phase so it also closes when the tap lands on a card
  // or a button that stops propagation. The opening tap on #emoteBtn and taps
  // on the choices themselves are excluded (they have their own handlers).
  document.addEventListener(
    'pointerdown',
    (ev) => {
      const bar = el('emoteBar');
      if (bar.classList.contains('hidden')) return;
      if (ev.target.closest('#emoteBar') || ev.target.closest('#emoteBtn')) return;
      bar.classList.add('hidden');
    },
    true
  );

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

  // --- Fortschritt: Tagesaufgaben, Erfolge-Galerie, Saison-Rangliste -------

  function renderQuests() {
    const box = el('questsSection');
    const list = el('questList');
    if (!box || !list) return;
    // Ohne Profile (öffentlicher Server) wird nichts gezählt - dann wäre eine
    // Aufgabenliste ohne Fortschritt nur eine Enttäuschung.
    if (!dailyQuests || !dailyQuests.ids || dailyQuests.ids.length === 0 || publicMode) {
      box.classList.add('hidden');
      return;
    }
    box.classList.remove('hidden');
    list.innerHTML = dailyQuests.ids
      .map((id) => {
        const meta = questMeta(id);
        const need = QUEST_NEED[id] || 1;
        const have = Math.min(questProgress[id] || 0, need);
        const done = have >= need;
        const pct = Math.round((have / need) * 100);
        return `<div class="questRow${done ? ' done' : ''}">
          <span class="questIcon">${done ? '✅' : meta.icon}</span>
          <span class="questText">${escapeHtml(meta.text)}</span>
          <span class="questCount">${need > 1 ? `${have}/${need}` : ''}</span>
          <span class="questBar"><i style="width:${pct}%"></i></span>
        </div>`;
      })
      .join('');
  }

  // Ein Höhepunkt pro Partie-Ende, nicht drei gleichzeitig: erst die
  // erledigten Aufgaben, dann ein Stufenaufstieg, sonst nur die XP.
  let lastLevelSeen = null;
  function celebrateProgress(msg) {
    const completed = (msg.quests && msg.quests.completed) || [];
    for (const id of completed) {
      showToast(`✅ ${L('Tagesaufgabe geschafft', 'Daily task done')}: ${questMeta(id).text}`);
    }
    const lvl = msg.level && msg.level.level;
    if (lvl && lastLevelSeen !== null && lvl > lastLevelSeen) {
      showToast(`⭐ ${L(`Stufe ${lvl} erreicht!`, `Level ${lvl} reached!`)}`);
    } else if (!completed.length && msg.gainedXp > 0) {
      showToast(`✨ +${msg.gainedXp} ${L('Erfahrung', 'XP')}`);
    }
    if (lvl) lastLevelSeen = lvl;
  }

  function renderAchievements() {
    const box = el('achievementsBox');
    if (!box) return;
    const me = myProfile();
    if (publicMode || !me) {
      box.classList.add('hidden');
      return;
    }
    const owned = me.badges || {};
    const progress = badgeProgressFor(me);
    const tiles = BADGE_ORDER.map((id) => {
      const m = badgeMeta(id);
      const at = owned[id];
      const p = progress[id];
      const sub = at
        ? new Date(at).toLocaleDateString()
        : p && p.need > 1
          ? `${p.have}/${p.need}`
          : L('gesperrt', 'locked');
      return `<div class="achTile${at ? ' earned' : ''}" title="${escapeHtml(m.desc)}">
        <span class="achEmoji">${at ? m.emoji : '🔒'}</span>
        <span class="achName">${escapeHtml(m.name)}</span>
        <span class="achSub">${escapeHtml(sub)}</span>
      </div>`;
    }).join('');
    const have = BADGE_ORDER.filter((id) => owned[id]).length;
    box.classList.remove('hidden');
    box.innerHTML =
      `<h3>${L('🏅 Erfolge', '🏅 Achievements')} <span class="achCount">${have} / ${BADGE_ORDER.length}</span></h3>` +
      `<div class="achGrid">${tiles}</div>`;
  }

  // Mirrors game/Progression.js#badgeProgress - the countable badges only.
  function badgeProgressFor(p) {
    const cap = (v, n) => ({ have: Math.min(v || 0, n), need: n });
    return {
      first_win: cap(p.gamesWon, 1),
      pd_laid: cap(p.totalQueensLaid, 1),
      pd_triple: cap(p.totalQueensLaid, 3),
      pd_caught: cap(p.totalQueensCaught, 1),
      hand_aus_win: cap(p.totalHandAus, 1),
      score_500: cap(p.bestGameScore, 500),
      round_300: cap(p.bestRoundScore, 300),
      streak_3: cap(p.winStreak, 3),
      marathon_10: cap(p.gamesPlayed, 10),
      pd_hunter_10: cap(p.totalQueensLaid, 10),
    };
  }

  function renderAccountProgress() {
    const lvlBox = el('accountLevelBox');
    if (!lvlBox) return;
    if (!accountProgress) {
      lvlBox.classList.add('hidden');
      return;
    }
    const lv = levelFromXpClient(accountProgress.xp);
    const pct = Math.round((lv.into / lv.need) * 100);
    lvlBox.classList.remove('hidden');
    lvlBox.innerHTML =
      `<div class="levelHead"><b>${L(`Stufe ${lv.level}`, `Level ${lv.level}`)}</b>` +
      `<span>${lv.into} / ${lv.need} ${L('EP', 'XP')}</span></div>` +
      `<div class="levelBar"><i style="width:${pct}%"></i></div>` +
      `<div class="levelMeta">${L('Saison', 'Season')} ${escapeHtml(accountProgress.season || '–')}: ` +
      `<b>${accountProgress.seasonXp}</b> ${L('EP', 'XP')}` +
      (accountProgress.rank ? ` · ${L('Platz', 'Rank')} <b>${accountProgress.rank}</b>` : '') +
      ` · ${accountProgress.wins}/${accountProgress.games} ${L('Siege', 'wins')}</div>`;
  }

  // Same curve as game/Progression.js - kept tiny and duplicated on purpose:
  // the client must be able to draw a level bar without a round trip.
  function levelFromXpClient(totalXp) {
    let xp = Math.max(0, Math.floor(Number(totalXp) || 0));
    let level = 1;
    const need = (l) => 100 + (l - 1) * 50;
    while (level < 200 && xp >= need(level)) {
      xp -= need(level);
      level += 1;
    }
    return { level, into: xp, need: need(level) };
  }

  async function loadLadder() {
    const box = el('ladderBox');
    if (!box) return;
    box.classList.remove('hidden');
    box.innerHTML = `<h3>${L('Saison-Rangliste', 'Season ladder')}</h3><p class="lobby-hint">…</p>`;
    const r = await accountApi('/api/ladder', { token: accountToken() || undefined });
    if (!r || r.error || !Array.isArray(r.board)) {
      box.innerHTML = `<h3>${L('Saison-Rangliste', 'Season ladder')}</h3>` +
        `<p class="lobby-hint">${L('Rangliste gerade nicht erreichbar.', 'Ladder unavailable right now.')}</p>`;
      return;
    }
    if (r.me) {
      accountProgress = r.me;
      renderAccountProgress();
    }
    const rows = r.board.length
      ? r.board
          .map((e, i) => {
            const medal = ['🥇', '🥈', '🥉'][i] || `${i + 1}.`;
            const mine = accountUsername && e.username.toLowerCase() === accountUsername.toLowerCase();
            return `<div class="ladderRow${mine ? ' isMe' : ''}"><span>${medal} ${escapeHtml(e.username)}</span>` +
              `<b>${e.seasonXp} ${L('EP', 'XP')}</b></div>`;
          })
          .join('')
      : `<p class="lobby-hint">${L('Diese Saison hat noch niemand gepunktet - hol dir Platz 1!', 'Nobody has scored this season - claim first place!')}</p>`;
    box.innerHTML = `<h3>${L('Saison-Rangliste', 'Season ladder')} <span class="achCount">${escapeHtml(r.season || '')}</span></h3>${rows}`;
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
    renderAchievements();
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
      // Präzise sagen, WARUM hier nichts steht (Nutzer-Frage 'immer leer?'):
      // gezählt wird erst eine KOMPLETT zu Ende gespielte Partie.
      box.innerHTML = `<p class="lobby-hint">${L(
        'Noch keine abgeschlossenen Partien. Die Statistik zählt nur komplett zu Ende gespielte Partien (bis 1000 Punkte) - aufgegebene oder vorzeitig verlassene Spiele zählen nicht. 🃏',
        'No finished games yet. Statistics only count matches played to the end (1000 points) - forfeited or abandoned games do not count. 🃏'
      )}</p>`;
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
    // visualViewport ist im iOS-Standalone die verlässlichere Quelle; beim
    // Kaltstart liefert innerHeight dort gern erst NACH dem ersten Layout
    // den echten Wert (Live-Report: Lücke unten). CSS nimmt per max() ohnehin
    // nie einen zu kleinen Wert an - hier sorgen wir für frische Messwerte.
    const h = (window.visualViewport && window.visualViewport.height) || window.innerHeight;
    document.documentElement.style.setProperty('--appvh', Math.round(h) + 'px');
  }
  setAppViewportHeight();
  setTimeout(setAppViewportHeight, 350);   // Kaltstart: nach dem ersten Layout nachmessen
  window.addEventListener('pageshow', setAppViewportHeight);
  window.addEventListener('orientationchange', () => setTimeout(setAppViewportHeight, 60));
  if (window.visualViewport) window.visualViewport.addEventListener('resize', setAppViewportHeight);

  // --- Kartenrücken: kosmetisch, über Erfolge freischaltbar -------------------
  // Gates lesen das eigene Profil (Name-basiert); ohne Profil bleibt Standard.
  const CARDBACK_KEY = 'pikdame_cardback';
  const CARDBACKS = [
    { id: 'classic', label: 'Klassisch', labelEn: 'Classic', gate: null },
    { id: 'gold', label: 'Gold', labelEn: 'Gold', gate: { field: 'gamesWon', min: 10, de: 'ab 10 Siegen', en: 'from 10 wins' } },
    { id: 'night', label: 'Nachtblau', labelEn: 'Midnight', gate: { field: 'gamesPlayed', min: 25, de: 'ab 25 Partien', en: 'from 25 games' } },
    { id: 'joker', label: 'Joker', labelEn: 'Joker', gate: { field: 'totalHandAus', min: 3, de: 'ab 3× Hand aus', en: 'from 3 out-in-one' } },
  ];
  function myProfile() {
    return (knownProfiles || []).find((p) => p.name && myName && p.name.toLowerCase() === myName.toLowerCase()) || null;
  }
  function cardbackUnlocked(cb) {
    if (!cb.gate) return true;
    const p = myProfile();
    return !!p && (p[cb.gate.field] || 0) >= cb.gate.min;
  }
  function applyCardback() {
    try {
      let chosen = storageGet(CARDBACK_KEY) || 'classic';
      const def = CARDBACKS.find((x) => x.id === chosen);
      if (!def || !cardbackUnlocked(def)) chosen = 'classic';
      document.documentElement.dataset.cardback = chosen;
      const btn = el('cardbackBtn');
      if (btn) {
        const d = CARDBACKS.find((x) => x.id === chosen);
        btn.textContent = L(d.label, d.labelEn);
      }
    } catch (e) { /* Kosmetik bricht nie den Start */ }
  }
  // Galerie statt Blindzyklus (Brotato-Prinzip: gesperrte Freischaltungen
  // sichtbar machen - 'was mir noch fehlt' motiviert): Kacheln mit Vorschau,
  // aktive Wahl markiert, gesperrte zeigen 🔒 + ihr Ziel.
  function openCardbackGallery() {
    const existing = document.querySelector('.cardbackGallery');
    if (existing) { existing.remove(); return; }
    const cur = document.documentElement.dataset.cardback || 'classic';
    const wrap = document.createElement('div');
    wrap.className = 'cardbackGallery';
    const box = document.createElement('div');
    box.className = 'cardbackGalleryBox';
    box.innerHTML = `<h3>🎴 ${L('Kartenrücken', 'Card backs')}</h3>`;
    const grid = document.createElement('div');
    grid.className = 'cardbackGrid';
    for (const cb of CARDBACKS) {
      const unlocked = cardbackUnlocked(cb);
      const tile = document.createElement('button');
      tile.type = 'button';
      tile.className = `cardbackTile${cb.id === cur ? ' active' : ''}${unlocked ? '' : ' locked'}`;
      tile.innerHTML = `<span class="cbPrev cbPrev-${cb.id}">${unlocked ? '' : '🔒'}</span>` +
        `<span class="cbName">${L(cb.label, cb.labelEn)}</span>` +
        `<span class="cbGate">${unlocked ? (cb.id === cur ? '✓' : '') : L(cb.gate.de, cb.gate.en)}</span>`;
      tile.addEventListener('click', () => {
        if (!unlocked) { showToast(`🔒 ${L(cb.label, cb.labelEn)}: ${L(cb.gate.de, cb.gate.en)}`); return; }
        storageSet(CARDBACK_KEY, cb.id);
        applyCardback();
        wrap.remove();
      });
      grid.appendChild(tile);
    }
    box.appendChild(grid);
    wrap.appendChild(box);
    wrap.addEventListener('click', (e) => { if (e.target === wrap) wrap.remove(); });
    document.body.appendChild(wrap);
  }
  // --- Saisonale Akzente (klein & abschaltfrei): Dezember-Schnee,
  // Oktober-Kürbis-Emote, Silvester-Feuerwerk-Emoji im Emote-Set. -------------
  try {
    const month = new Date().getMonth() + 1;
    if (month === 12) {
      for (let i = 0; i < 12; i++) {
        const f = document.createElement('div');
        f.className = 'seasonFlake';
        f.textContent = '❄';
        f.style.left = `${Math.random() * 100}vw`;
        f.style.animationDuration = `${9 + Math.random() * 9}s`;
        f.style.animationDelay = `${Math.random() * 9}s`;
        f.style.fontSize = `${9 + Math.random() * 8}px`;
        document.body.appendChild(f);
      }
    }
    const seasonalEmote = month === 10 ? '🎃' : (month === 12 || month === 1) ? '🎆' : null;
    if (seasonalEmote) {
      const bar = document.querySelector('.emoteBar');
      const sample = bar && bar.querySelector('button[data-emote]');
      if (bar && sample) {
        const b = sample.cloneNode(false);
        b.dataset.emote = seasonalEmote;
        b.textContent = seasonalEmote;
        b.addEventListener('click', () => {
          send({ type: 'emote', emoji: seasonalEmote });
          el('emoteBar').classList.add('hidden');
        });
        bar.appendChild(b);
      }
    }
  } catch (e) { /* Saison-Deko bricht nie den Start */ }

  try {
    const cbBtn = el('cardbackBtn');
    if (cbBtn) cbBtn.addEventListener('click', openCardbackGallery);
    applyCardback();
  } catch (e) { /* optional */ }

  // --- Debug-Overlay (Einstellungen): Gitter + Live-Metriken -----------------
  // Für Ferndiagnosen von Layout-Fehlern: Ein Screenshot mit aktivem Overlay
  // enthält alle Viewport-Quellen, die Container-Kanten (farbige Umrandungen)
  // und ein 10/50px-Gitter zum Nachmessen.
  const DEBUG_KEY = 'pikdame_debug';
  let debugTimer = null;
  function debugEnabled() { return storageGet(DEBUG_KEY) === 'on'; }
  function updateDebugPanel() {
    if (!debugEnabled()) return;
    const probe = document.createElement('div');
    probe.style.cssText = 'position:fixed;height:100dvh;width:0;visibility:hidden;';
    document.body.appendChild(probe);
    const dvh = probe.offsetHeight;
    probe.remove();
    const cs = getComputedStyle(document.documentElement);
    const app = document.getElementById('app');
    const vv = window.visualViewport;
    const lines = [
      `Pik Dame ${el('versionBtn') ? el('versionBtn').textContent : ''}  ${new Date().toISOString().slice(11, 19)}Z`,
      `standalone: ${window.matchMedia('(display-mode: standalone)').matches}  dpr: ${window.devicePixelRatio}`,
      `innerH: ${window.innerHeight}  vv.h: ${vv ? Math.round(vv.height) : '-'}  100dvh: ${dvh}`,
      `--appvh: ${cs.getPropertyValue('--appvh').trim() || '-'}  #app.h: ${app ? app.clientHeight : '-'}`,
      `viewport-app delta: ${app ? Math.max(window.innerHeight, dvh) - app.clientHeight : '-'}px`,
      `safe t/b: ${cs.getPropertyValue('--safe-top').trim() || '0px'} / ${cs.getPropertyValue('--safe-bottom').trim() || '0px'}`,
      `uiscale: ${document.documentElement.dataset.uiscale || 'normal'}  w: ${window.innerWidth}`,
      `outlines: app=rot screen=orange handWrap=cyan hand=gelb`,
    ];
    const panel = el('debugPanel');
    if (panel) panel.textContent = lines.join('\n');
  }
  function applyDebugMode() {
    // KRITISCHE LEKTION (Live-Ausfall): Beim PWA-Start kann kurzzeitig ALTES
    // Markup (ohne die Debug-Elemente) mit NEUEM Script kombiniert sein -
    // iOS revalidiert das Start-HTML nicht immer, trotz no-cache. Ein
    // ungefangener null-Zugriff hier brach den gesamten Init ab, BEVOR
    // connect() lief: 'Neues Spiel', 'Beitreten' und 'Tutorial' waren tot,
    // und ausgerechnet die Auto-Update-Selbstheilung (Versions-Stempel ->
    // Reload) kam nie zum Zug. Ein OPTIONALES Feature darf den kritischen
    // Startpfad niemals töten: alles hier ist null-sicher und gefangen.
    try {
      const on = debugEnabled();
      const grid = el('debugGrid');
      const panel = el('debugPanel');
      document.documentElement.classList.toggle('debugMode', on);
      if (grid) grid.classList.toggle('hidden', !on);
      if (panel) panel.classList.toggle('hidden', !on);
      const box = document.getElementById('debugCheckbox');
      if (box) box.checked = on;
      clearInterval(debugTimer);
      if (on && panel) {
        updateDebugPanel();
        debugTimer = setInterval(updateDebugPanel, 1000);
      }
    } catch (e) {
      /* Debug ist Komfort - nie kritisch */
    }
  }
  function toggleDebugMode() {
    storageSet(DEBUG_KEY, debugEnabled() ? 'off' : 'on');
    applyDebugMode();
  }
  try {
    const dbgBox = el('debugCheckbox');
    const dbgGame = el('debugBtn');
    if (dbgBox) dbgBox.addEventListener('change', toggleDebugMode);
    if (dbgGame) dbgGame.addEventListener('click', toggleDebugMode);
    window.addEventListener('resize', () => { if (debugEnabled()) updateDebugPanel(); });
    applyDebugMode();
  } catch (e) {
    /* siehe oben: optional bricht nie den Start */
  }

  let resizeTimer = null;
  window.addEventListener('resize', () => {
    setAppViewportHeight();
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => render(), 150);
  });

  try {
    const meldsEl = el('melds');
    if (meldsEl) meldsEl.addEventListener('scroll', updateMeldScrollHint, { passive: true });
    const meldsObs = new MutationObserver(() => updateMeldScrollHint());
    if (meldsEl) meldsObs.observe(meldsEl, { childList: true, subtree: true });
    window.addEventListener('resize', updateMeldScrollHint);
  } catch (e) { /* Hinweis-Kante ist Komfort, nie kritisch */ }

  // Debug-Panel: Tipp wechselt oben/unten, damit es keine Diagnose verdeckt.
  try {
    const dp = el('debugPanel');
    if (dp) dp.addEventListener('click', () => dp.classList.toggle('dockBottom'));
  } catch (e) { /* optional */ }

  // --- Studio-Vorspann "Flodex Interactive" ---------------------------------
  // Einmal pro Sitzung, Antippen ueberspringt. Drei Einstellungen:
  //   automatisch = folgt der Systemeinstellung "Bewegung reduzieren"
  //   voll        = immer der volle Wirbel
  //   aus         = gar kein Vorspann
  // Phase 2 haengt am ECHTEN Ende der Klingen-Animation, nicht an einer
  // ausgerechneten Uhrzeit - feste Zeiten koennen mit der laufenden
  // Animation auseinanderdriften.
  const LOGO_MODE_KEY = 'pikdame_studio_logo';
  const LOGO_MODES = ['auto', 'full', 'off'];
  function logoModeLabel(mode) {
    if (mode === 'full') return L('Voll', 'Full');
    if (mode === 'off') return L('Aus', 'Off');
    return L('Automatisch', 'Automatic');
  }
  function updateStudioLogoBtn() {
    const sel = document.getElementById('studioLogoSelect');
    if (sel) {
      sel.value = storageGet(LOGO_MODE_KEY) || 'auto';
      for (const opt of sel.options) if (LOGO_MODES.includes(opt.value)) opt.textContent = logoModeLabel(opt.value);
    }
  }
  try {
    const sel = el('studioLogoSelect');
    if (sel) {
      sel.addEventListener('change', () => {
        const next = LOGO_MODES.includes(sel.value) ? sel.value : 'auto';
        storageSet(LOGO_MODE_KEY, next);
        updateStudioLogoBtn();
        showToast(`🌀 ${L('Studio-Logo', 'Studio logo')}: ${logoModeLabel(next)}`);
      });
      updateStudioLogoBtn();
    }
  } catch (e) { /* Einstellung ist Komfort */ }

  try {
    const splash = el('studioSplash');
    if (splash) {
      let seen = false;
      try { seen = sessionStorage.getItem('pikdame_splash_seen') === '1'; } catch (e) { seen = false; }
      const mode = storageGet(LOGO_MODE_KEY) || 'auto';
      const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

      if (seen || mode === 'off') {
        splash.remove();
      } else {
        try { sessionStorage.setItem('pikdame_splash_seen', '1'); } catch (e) { /* egal */ }
        if (mode === 'full' || !reduce) splash.classList.add('fullMotion');
        splash.classList.add('play');

        let finished = false;
        const finish = () => {
          if (finished) return;
          finished = true;
          splash.classList.add('done');
          setTimeout(() => splash.remove(), 600);
        };
        splash.addEventListener('click', finish);

        const lastBlade = splash.querySelector('.ssBlade:nth-child(5)');
        const startPhase2 = () => splash.classList.add('phase2');
        if (lastBlade) lastBlade.addEventListener('animationend', startPhase2, { once: true });
        // Sicherheitsnetze: Phase 2 startet auch ohne Ereignis, und der
        // Vorspann verschwindet in JEDEM Fall - er darf das Spiel nie blockieren.
        setTimeout(startPhase2, 4200);
        setTimeout(finish, 8200);
      }
    }
  } catch (e) {
    const s = document.getElementById('studioSplash');
    if (s) s.remove();
  }

  connect();
})();

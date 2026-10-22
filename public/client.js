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
  const SPLASH_DEVICE_KEY = 'pikdame_splash_device'; // intro played once on this device
  const TABLE_PREFS_KEY = 'pikdame_table_prefs'; // host's last lobby choices, seed the next new table
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
  let prevPauseVoteCount = 0;
  let prevIVotedPause = false;
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
    if (lastState.tutorialMode && tutorialHintsOn()) return; // the coach card talks here
    const key = `${lastState.roundNumber}`;
    if (quoteShownForRound === key) return;
    quoteShownForRound = key;
    if (lastState.roundNumber === 0) return;
    // Wichtige Rundenstart-Meldungen (Endspurt ⚠️, Glücksgriff 🍀) haben
    // Vorfahrt - der Spruch drängelt sich dann nicht dazwischen.
    const latest = (lastState.log || [])[lastState.log.length - 1];
    if (latest && latest.text && !/^Runde \d+ gestartet/.test(latest.text)) return;
    showToast(roundQuote(`${lastState.dealerId}-${lastState.roundNumber}`), { duration: 5000, priority: true });
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

  // --- Formatting for the active UI language (one place, exposed for tests) ---
  const MINUS = '\u2212';
  const NBSP = '\u00a0';
  const localeOf = (l = lang) => (l === 'en' ? 'en-GB' : 'de-DE');
  /** 1385 -> "1.385" (de) / "1,385" (en); negatives use the true minus sign U+2212. */
  function fmtNum(n, l = lang) {
    return new Intl.NumberFormat(localeOf(l)).format(Number(n) || 0).replace('-', MINUS);
  }
  /** Explicit sign for deltas: +270, \u221235, 0. */
  function fmtSigned(n, l = lang) {
    const v = Number(n) || 0;
    return v > 0 ? `+${fmtNum(v, l)}` : fmtNum(v, l);
  }
  /** Date or timestamp in the UI language; opts as for toLocaleDateString. */
  function fmtDate(d, opts, l = lang) {
    const date = d instanceof Date ? d : new Date(d);
    return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString(localeOf(l), opts);
  }
  /** A game-day string "2026-10-19" as a human date ("19. Okt. 2026" / "19 Oct 2026"). */
  function fmtDay(iso, opts, l = lang) {
    const d = new Date(`${iso}T12:00:00Z`);
    return Number.isNaN(d.getTime()) ? String(iso) : fmtDate(d, opts || { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }, l);
  }
  const COUNT_WORDS = {
    game: [['Partie', 'Partien'], ['game', 'games']],
    win: [['Sieg', 'Siege'], ['win', 'wins']],
    round: [['Runde', 'Runden'], ['round', 'rounds']],
    turn: [['Zug', 'Züge'], ['turn', 'turns']],
    day: [['Tag', 'Tage'], ['day', 'days']],
  };
  /** The noun alone, singular for exactly 1: unitWord(1, 'win') -> "Sieg". */
  function unitWord(n, key, l = lang) {
    const [one, many] = COUNT_WORDS[key][l === 'en' ? 1 : 0];
    return Number(n) === 1 ? one : many;
  }
  /** Number and noun: "1 Sieg", "1.385 Partien". */
  function fmtCount(n, key, l = lang) {
    return `${fmtNum(n, l)} ${unitWord(n, key, l)}`;
  }
  /** Sprite icon; put the text next to it in its own <span>. */
  const iconHtml = (name) => `<svg class="icon" aria-hidden="true"><use href="#i-${name}"/></svg>`;
  window.PikFormat = { fmtNum, fmtSigned, fmtDate, fmtDay, unitWord, fmtCount, MINUS };

  // Dynamische Beschriftungen (enthalten Werte wie den Spiel-Code) koennen
  // nicht ueber I18N_STATIC laufen. Sie werden hier zentral neu gesetzt -
  // beim Erzeugen UND bei jedem Sprachwechsel.
  let resumeCode = null;
  // The resumable game is today's running daily challenge (server says so).
  let resumeIsChallenge = false;
  let resumeIsTutorial = false; // known once the server reported this device's seat
  function updateResumeBtn() {
    try { renderToday(); } catch (e) { /* cosmetic, defined further down */ }
    try {
      const btn = document.getElementById('resumeBtn');
      if (!btn) return;
      if (resumeCode) {
        btn.innerHTML = '<svg class="icon" aria-hidden="true"><use href="#i-resume"/></svg><span></span>';
        const tower = openGame && openGame.code === resumeCode && openGame.tower;
        btn.querySelector('span').textContent = resumeIsChallenge
          ? L('Challenge fortsetzen', 'Resume challenge')
          : resumeIsTutorial ? L('Tutorial fortsetzen', 'Resume tutorial')
            : tower ? L(`Kartenhaus fortsetzen (Etage ${tower})`, `Resume House of Cards (floor ${tower})`)
              : L(`Weiterspielen (${resumeCode})`, `Resume game (${resumeCode})`);
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
        // The tutorial button's label carries a step counter set by the client.
        const aria = n.getAttribute('aria-label');
        if (aria && map[aria] && n.id !== 'tutorialProgressBtn') n.dataset.i18nAriaDe = aria;
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
    document.querySelectorAll('[data-i18n-aria-de]').forEach((n) => {
      const de = n.dataset.i18nAriaDe;
      n.setAttribute('aria-label', lang === 'en' ? map[de] || de : de);
    });
    document.querySelectorAll('[data-i18n-ph-de]').forEach((n) => {
      const de = n.dataset.i18nPhDe;
      n.placeholder = lang === 'en' ? map[de] || de : de;
    });
    el('rulesContent').innerHTML = lang === 'en' ? window.I18N_RULES_EN : rulesHtmlDe;
    // Both carry an <svg class="icon"> - write the label span, never the
    // button itself, or the icon is wiped on the next language switch.
    setLabelText(el('rulesTitle'), L('Spielregeln', 'How to play'));
    // Names the language you switch TO, in that language - readable for
    // exactly the person who needs it.
    const langBtn = el('langBtn');
    setLabelText(langBtn, lang === 'en' ? 'Deutsch' : 'English');
    langBtn.lang = lang === 'en' ? 'de' : 'en';
    langBtn.title = lang === 'en' ? 'Auf Deutsch umstellen' : 'Switch to English';
    document.documentElement.lang = lang;
  }
  function cycleLang() {
    lang = lang === 'de' ? 'en' : 'de';
    storageSet(LANG_KEY, lang);
    applyStaticLang();
    updateThemeName();    // the swatch titles were just translated
    updateSortToggleLabel();
    updateHandToggle();
    applyUiScale();       // Auswahlfeld Anzeigegröße
    updateResumeBtn();    // "Weiterspielen (CODE)" - enthaelt einen Wert
    try { updateStudioLogoBtn(); } catch (e) { /* erst spaeter definiert */ }
    try { updateCelebrationSetting(); } catch (e) { /* erst spaeter definiert */ }
    try { updateMusicSetting(); } catch (e) { /* erst spaeter definiert */ }
    try { applyCardback(); } catch (e) { /* erst spaeter definiert */ }
    try { setTipsEnabled(gameTipsEnabled); renderAidControls(); renderBotQuipsControls(); } catch (e) { /* Einstellungsblatt ist nie kritisch */ }
    // Aus dem Code erzeugte Listen: Ihre Texte kommen aus L(), werden aber nur
    // beim Rendern gesetzt - ohne erneuten Aufruf bleiben sie in der alten
    // Sprache stehen (Nutzer-Report zu den Tagesaufgaben). Betrifft alle drei
    // Bloecke des Fortschrittsbereichs, nicht nur die Aufgaben.
    try { renderQuests(); } catch (e) { /* Fortschritt ist nie kritisch */ }
    try { renderPuzzle(); } catch (e) { /* dito */ }
    try { renderStammtisch(); renderStammtischRecent(); renderSessionBanner(); } catch (e) { /* dito */ }
    try { renderAchievements(); } catch (e) { /* dito */ }
    try { renderStatsMe(); } catch (e) { /* dito */ }
    try { renderToday(); } catch (e) { /* dito */ }
    try { renderYearSlide(); } catch (e) { /* dito */ }
    try { renderProgressSheet(); } catch (e) { /* dito */ }
    try { renderTower(); renderTowerTile(); } catch (e) { /* dito */ }
    try { arrangeEmoteBar(el('emoteBar')); arrangeEmoteBar(el('resultEmoteBar')); } catch (e) { /* toggle label */ }
    try { renderAccountProgress(); } catch (e) { /* dito */ }
    // "Angemeldet als ..." steht dauerhaft in der Lobby - vom Vertragstest
    // unten gefunden, bevor es jemand melden konnte.
    try { refreshAccountUi(); } catch (e) { /* dito */ }
    // Eigene Spielhistorie: nur relevant, wenn der Reiter offen ist, aber
    // billig genug, es einfach immer zu versuchen statt den Sichtbarkeits-
    // Zustand zu pruefen.
    try { renderGameHistory(); } catch (e) { /* dito */ }
    try { updateNetBanner(); } catch (e) { /* defined further down */ }
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
    try { syncSegments(); } catch (e) { /* segments are cosmetic */ }
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
  // Result overview order, per device: 'points' (default) or 'seat' (table order).
  const RESULT_SORT_KEY = 'pikdame_result_sort';
  let resultSortMode = storageGet(RESULT_SORT_KEY) === 'seat' ? 'seat' : 'points';
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
  // then the rare feats. Must stay in sync with BADGE_IDS in game/Badges.js;
  // `how` is the earning condition, shown for locked badges too (contract test).
  // \u00ad in long German names: a break point where hyphens:auto has no dictionary.
  function badgeMeta(id) {
    const M = {
      first_win: { emoji: '🏆', name: L('Erster Sieg', 'First win'), desc: L('Erste gewonnene Partie', 'Won your first game'),
        how: L('Gewinne eine Partie.', 'Win a game.') },
      hand_aus_win: { emoji: '🚀', name: L('Hand aus!', 'Out in one!'), desc: L('Alles in einem einzigen Zug ausgelegt und gewonnen', 'Laid out the whole hand in a single turn and won'),
        how: L('Lege deine ganze Hand in einem einzigen Zug aus und mach so die Runde aus.', 'Lay out your whole hand in a single turn and go out.') },
      pd_laid: { emoji: '♠', name: L('Damen\u00adsammler', 'Queen collector'), desc: L('Eine Pik Dame sicher ausgelegt (+100)', 'Melded a Queen of Spades (+100)'),
        how: L('Lege eine Pik Dame in einer Auslage ab.', 'Meld a Queen of Spades.') },
      pd_triple: { emoji: '🎩', name: L('Huttrick', 'Hat trick'), desc: L('3+ Pik Damen in einer Partie ausgelegt', 'Melded 3+ Queens of Spades in one game'),
        how: L('Lege in einer einzigen Partie mindestens 3 Pik Damen aus.', 'Meld at least 3 Queens of Spades within one game.') },
      pd_caught: { emoji: '😱', name: L('Autsch!', 'Ouch!'), desc: L('Pik Dame am Rundenende auf der Hand erwischt (−100)', 'Caught with the Queen of Spades in hand (−100)'),
        how: L('Halte am Rundenende noch eine Pik Dame auf der Hand - passiert irgendwann jedem.', 'Still hold a Queen of Spades when a round ends - happens to everyone.') },
      score_500: { emoji: '💯', name: L('Punkte\u00adkönig', 'Point royalty'), desc: L('500+ Punkte Endstand in einer Partie', 'Finished a game with 500+ points'),
        how: L('Beende eine Partie mit mindestens 500 Punkten Endstand.', 'Finish a game with at least 500 points.') },
      streak_3: { emoji: '🔥', name: L('Siegesserie', 'Winning streak'), desc: L('3 Partien in Folge gewonnen', 'Won 3 games in a row'),
        how: L('Gewinne 3 Partien hintereinander, ohne dazwischen zu verlieren.', 'Win 3 games in a row without losing one in between.') },
      comeback: { emoji: '🐢', name: L('Comeback', 'Comeback'), desc: L('Nach Runde 1 Letzter - und trotzdem gewonnen', 'Last after round 1 - and still won'),
        how: L('Sei nach der ersten Runde allein Letzter - und gewinne trotzdem die Partie.', 'Be alone in last place after round 1 - and still win the game.') },
      double_queen_round: { emoji: '👯', name: L('Doppeldame', 'Double queen'), desc: L('BEIDE Pik Damen in ein und derselben Runde ausgelegt', 'Melded BOTH Queens of Spades in the same round'),
        how: L('Lege beide Pik Damen in derselben Runde aus.', 'Meld both Queens of Spades in the same round.') },
      round_300: { emoji: '💥', name: L('Monster\u00adrunde', 'Monster round'), desc: L('300+ Punkte in einer einzigen Runde', '300+ points in a single round'),
        how: L('Hole in einer einzigen Runde mindestens 300 Punkte.', 'Score at least 300 points in a single round.') },
      zen_slayer: { emoji: '⚔️', name: L('Zen-Bezwinger', 'Zen slayer'), desc: L('Partie mit einem Zen-Meister am Tisch gewonnen', 'Won a game with a zen master at the table'),
        how: L('Gewinne eine Partie, bei der mindestens ein Zen-Meister-Bot mitspielt.', 'Win a game with at least one zen master bot at the table.') },
      marathon_10: { emoji: '🏃', name: L('Marathon', 'Marathon'), desc: L('10 Partien gespielt', 'Played 10 games'),
        how: L('Spiele 10 Partien zu Ende.', 'Finish 10 games.') },
      pd_hunter_10: { emoji: '🎯', name: L('Damen\u00adjägerin', 'Queen hunter'), desc: L('10 Pik Damen insgesamt ausgelegt', 'Melded 10 Queens of Spades in total'),
        how: L('Lege insgesamt 10 Pik Damen aus (über alle Partien).', 'Meld 10 Queens of Spades in total (across all games).') },
      // Tiers (bronze/silver/gold on the same counter)
      pd_hunter_50: { emoji: '🎯', name: L('Damen\u00adlegende', 'Queen legend'), desc: L('50 Pik Damen insgesamt ausgelegt', 'Melded 50 Queens of Spades in total'),
        how: L('Lege insgesamt 50 Pik Damen aus (über alle Partien).', 'Meld 50 Queens of Spades in total (across all games).') },
      marathon_50: { emoji: '🏃', name: L('Dauer\u00adläufer', 'Long runner'), desc: L('50 Partien gespielt', 'Played 50 games'),
        how: L('Spiele 50 Partien zu Ende.', 'Finish 50 games.') },
      marathon_100: { emoji: '🏃', name: L('Sitzfleisch', 'Staying power'), desc: L('100 Partien gespielt', 'Played 100 games'),
        how: L('Spiele 100 Partien zu Ende.', 'Finish 100 games.') },
      wins_10: { emoji: '🏆', name: L('Serien\u00adsieger', 'Serial winner'), desc: L('10 Partien gewonnen', 'Won 10 games'),
        how: L('Gewinne insgesamt 10 Partien.', 'Win 10 games in total.') },
      wins_50: { emoji: '🏆', name: L('Tisch\u00adlegende', 'Table legend'), desc: L('50 Partien gewonnen', 'Won 50 games'),
        how: L('Gewinne insgesamt 50 Partien.', 'Win 50 games in total.') },
      streak_5: { emoji: '🔥', name: L('Lauffeuer', 'Wildfire'), desc: L('5 Partien in Folge gewonnen', 'Won 5 games in a row'),
        how: L('Gewinne 5 Partien hintereinander.', 'Win 5 games in a row.') },
      streak_10: { emoji: '🔥', name: L('Unauf\u00adhaltsam', 'Unstoppable'), desc: L('10 Partien in Folge gewonnen', 'Won 10 games in a row'),
        how: L('Gewinne 10 Partien hintereinander.', 'Win 10 games in a row.') },
      hand_aus_5: { emoji: '🚀', name: L('Blitzhand', 'Lightning hand'), desc: L('5× per „Hand aus“ gewonnen', 'Won 5 rounds out in one'),
        how: L('Mach 5 Runden per „Hand aus“ aus (alles in einem Zug).', 'Go out in one 5 times (whole hand in a single turn).') },
      daily_7: { emoji: '📅', name: L('Eine Woche dabei', 'A week running'), desc: L('7 Tage in Folge gespielt', 'Played 7 days in a row'),
        how: L('Spiele an 7 Tagen in Folge (Partie oder gelöstes Tagesrätsel). Ein ausgelassener Tag pro Woche wird per Joker-Tag überbrückt.', 'Play on 7 days in a row (a game or a solved daily puzzle). One missed day per week is bridged by a joker day.') },
      daily_30: { emoji: '🗓️', name: L('Ein Monat dabei', 'A month running'), desc: L('30 Tage in Folge gespielt', 'Played 30 days in a row'),
        how: L('Spiele an 30 Tagen in Folge (Partie oder gelöstes Tagesrätsel). Ein ausgelassener Tag pro Woche wird per Joker-Tag überbrückt.', 'Play on 30 days in a row (a game or a solved daily puzzle). One missed day per week is bridged by a joker day.') },
      // One-offs from the engine facts
      ring_run: { emoji: '🔄', name: L('Ringschluss', 'Full circle'), desc: L('Eine Folge über K-A-2 ausgelegt', 'Melded a run wrapping K-A-2'),
        how: L('Lege eine Folge aus, die über König-Ass-Zwei läuft (z. B. D-K-A-2).', 'Meld a run that wraps King-Ace-Two (e.g. Q-K-A-2).') },
      run_13: { emoji: '🌈', name: L('Die ganze Farbe', 'The whole suit'), desc: L('Eine Folge mit allen 13 Karten ausgelegt', 'Melded a full 13-card run'),
        how: L('Lege eine Folge mit allen 13 Karten einer Farbe aus.', 'Meld a run with all 13 cards of one suit.') },
      pile_glutton: { emoji: '🍽️', name: L('Stapel\u00adfresser', 'Pile glutton'), desc: L('10+ Karten vom Ablagestapel genommen und die Runde trotzdem gewonnen', 'Picked up 10+ discards and still won the round'),
        how: L('Nimm 10 oder mehr Karten vom Ablagestapel auf und gewinne die Runde trotzdem.', 'Pick up 10 or more cards from the discard pile and still win the round.') },
      zen_trio: { emoji: '🧘', name: L('Drei Meister', 'Three masters'), desc: L('Gegen drei Zen-Meister gewonnen', 'Beat three zen masters'),
        how: L('Gewinne eine Partie gegen drei Zen-Meister-Bots.', 'Win a game against three zen master bots.') },
      no_joker_win: { emoji: '🃏', name: L('Ohne Joker', 'No jokers'), desc: L('Eine Partie gewonnen, ohne je einen Joker auszulegen', 'Won a game without ever melding a joker'),
        how: L('Gewinne eine Partie, ohne einen einzigen Joker auszulegen.', 'Win a game without melding a single joker.') },
      // Consolation and curiosity badges (v2.48)
      purple_heart_10: { emoji: '💜', name: L('Tapferes Herz', 'Brave heart'), desc: L('10 Partien verloren - und weitergespielt', 'Lost 10 games - and kept playing'),
        how: L('Verliere 10 Partien. Dranbleiben zählt!', 'Lose 10 games. Sticking with it counts!') },
      purple_heart_50: { emoji: '💜', name: L('Unver\u00adwüstlich', 'Unbreakable'), desc: L('50 Partien verloren - und weitergespielt', 'Lost 50 games - and kept playing'),
        how: L('Verliere insgesamt 50 Partien.', 'Lose 50 games in total.') },
      purple_heart_100: { emoji: '💜', name: L('Herz aus Gold', 'Heart of gold'), desc: L('100 Partien verloren - und weitergespielt', 'Lost 100 games - and kept playing'),
        how: L('Verliere insgesamt 100 Partien.', 'Lose 100 games in total.') },
      red_lantern: { emoji: '😤', name: L('Rote Laterne', 'Red lantern'), desc: L('3 Partien in Folge Letzter', 'Last place in 3 games in a row'),
        how: L('Werde 3 Partien hintereinander Letzter (Gleichstand ganz unten zählt mit).', 'Finish last in 3 games in a row (a tie at the bottom counts).') },
      rock_bottom: { emoji: '😡', name: L('Tiefpunkt', 'Rock bottom'), desc: L('Partie mit negativem Endstand beendet', 'Finished a game below zero'),
        how: L('Beende eine Partie mit weniger als 0 Punkten.', 'Finish a game with fewer than 0 points.') },
      cold_shower: { emoji: '🥶', name: L('Kalte Dusche', 'Cold shower'), desc: L('Beide Pik Damen in einer Runde auf der Hand erwischt (−200)', 'Caught with both Queens of Spades in one round (−200)'),
        how: L('Halte am Ende einer Runde beide Pik Damen auf der Hand.', 'Hold both Queens of Spades when a round ends.') },
      joker_king: { emoji: '🤹', name: L('Jokerkönig', 'Joker king'), desc: L('4+ Joker in einer Runde ausgelegt', 'Melded 4+ jokers in one round'),
        how: L('Lege in einer einzigen Runde mindestens 4 Joker aus.', 'Meld at least 4 jokers in a single round.') },
      quick_start: { emoji: '⚡', name: L('Blitzstart', 'Lightning start'), desc: L('„Hand aus“ schon in Runde 1', 'Out in one in round 1'),
        how: L('Mach gleich in der ersten Runde einer Partie per „Hand aus“ aus.', 'Go out in one in the very first round of a game.') },
      near_miss: { emoji: '😅', name: L('Knapp vorbei', 'So close'), desc: L('Mit weniger als 20 Punkten Rückstand verloren', 'Lost by less than 20 points'),
        how: L('Verliere eine Partie mit weniger als 20 Punkten Rückstand auf den Sieger.', 'Lose a game by less than 20 points to the winner.') },
      landslide: { emoji: '🏔️', name: L('Erd\u00adrutsch\u00adsieg', 'Landslide'), desc: L('Mit 500+ Punkten Vorsprung gewonnen', 'Won by 500+ points'),
        how: L('Gewinne eine Partie mit mindestens 500 Punkten Vorsprung auf Platz 2.', 'Win a game at least 500 points ahead of second place.') },
      night_owl: { emoji: '🦉', name: L('Nachteule', 'Night owl'), desc: L('Partie zwischen 0 und 4 Uhr beendet', 'Finished a game between midnight and 4 am'),
        how: L('Beende eine Partie zwischen 0 und 4 Uhr nachts (deutsche Zeit).', 'Finish a game between midnight and 4 am (German time).') },
      stammtisch_10: { emoji: '🍻', name: L('Stamm\u00adtisch\u00adbruder', 'Table regular'), desc: L('10 Partien am Stammtisch', '10 games at a regulars table'),
        how: L('Spiele 10 Partien an einem Stammtisch.', 'Play 10 games at a regulars table.') },
      challenger_7: { emoji: '🏁', name: L('Heraus\u00adforderer', 'Challenger'), desc: L('7 Tages-Challenges gespielt', 'Played 7 daily challenges'),
        how: L('Spiele 7 Tages-Challenges (an beliebigen Tagen).', 'Play 7 daily challenges (any days).') },
      challenger_30: { emoji: '🏁', name: L('Challenge-Profi', 'Challenge pro'), desc: L('30 Tages-Challenges gespielt', 'Played 30 daily challenges'),
        how: L('Spiele 30 Tages-Challenges.', 'Play 30 daily challenges.') },
      challenge_champ: { emoji: '🥇', name: L('Tagesbester', 'Champion of the day'), desc: L('Platz 1 einer Tages-Challenge', 'First place in a daily challenge'),
        how: L('Steh am Ende eines Tages auf Platz 1 der Tages-Challenge. Vergeben wird es bei deiner nächsten Partie.', 'Be first in a daily challenge when the day ends. Awarded with your next game.') },
      queen_magnet_day: { emoji: '🧲', name: L('Damen-Magnet des Tages', 'Queen magnet of the day'), desc: L('Tages-Challenge: am häufigsten mit der Pik Dame erwischt', 'Daily challenge: caught with the Queen of Spades the most'),
        how: L('Werde in deinem gewerteten Versuch der Tages-Challenge am häufigsten mit der Pik Dame auf der Hand erwischt. Gibt es nur dort, einmal pro Tag; vergeben bei deiner nächsten Partie nach Tagesende.', 'Get caught with the Queen of Spades in hand the most in your ranked daily challenge game. Only there, once per day; awarded with your next game after the day ends.') },
      puzzle_7: { emoji: '🧩', name: L('Rätselfuchs', 'Puzzle fox'), desc: L('7 Tagesrätsel gelöst', 'Solved 7 daily puzzles'),
        how: L('Löse 7 Tagesrätsel, ohne „Lösung zeigen“ zu tippen.', 'Solve 7 daily puzzles without tapping "show solution".') },
      puzzle_30: { emoji: '🧩', name: L('Rätsel\u00admeister', 'Puzzle master'), desc: L('30 Tagesrätsel gelöst', 'Solved 30 daily puzzles'),
        how: L('Löse 30 Tagesrätsel.', 'Solve 30 daily puzzles.') },
      puzzle_perfect_10: { emoji: '🌟', name: L('Sternstunde', 'Star moment'), desc: L('10 Tagesrätsel mit 3 Sternen gelöst', 'Solved 10 daily puzzles with 3 stars'),
        how: L('Löse 10 Tagesrätsel jeweils im ersten Versuch - das gibt 3 Sterne.', 'Solve 10 daily puzzles on the first try - that is 3 stars.') },
      puzzle_perfect_30: { emoji: '🌟', name: L('Sternen\u00adsammler', 'Star collector'), desc: L('30 Tagesrätsel mit 3 Sternen gelöst', 'Solved 30 daily puzzles with 3 stars'),
        how: L('Löse 30 Tagesrätsel im ersten Versuch.', 'Solve 30 daily puzzles on the first try.') },
      puzzle_perfect_100: { emoji: '🌟', name: L('Rätsel-Ass', 'Puzzle ace'), desc: L('100 Tagesrätsel mit 3 Sternen gelöst', 'Solved 100 daily puzzles with 3 stars'),
        how: L('Löse 100 Tagesrätsel im ersten Versuch.', 'Solve 100 daily puzzles on the first try.') },
      royal_flush: { emoji: '💎', name: L('Royal Flush', 'Royal flush'), desc: L('10-B-D-K-A einer Farbe ausgelegt, ohne Joker', 'Melded 10-J-Q-K-A of one suit, no jokers'),
        how: L('Lege eine Folge mit 10, Bube, Dame, König und Ass derselben Farbe aus - alles echte Karten, kein Joker.', 'Meld a run with 10, jack, queen, king and ace of one suit - all real cards, no joker.') },
      pik_royal: { emoji: '👑', name: L('Pik Royal', 'Spade royal'), desc: L('Royal Flush in Pik - mit der Pik Dame', 'Royal flush in spades - with the Queen of Spades'),
        how: L('Lege 10, Bube, Dame, König und Ass in Pik als Folge aus - alles echte Karten, kein Joker.', 'Meld 10, jack, queen, king and ace of spades as a run - all real cards, no joker.') },
      // Kartenhaus (game/BotTower.js): floors and stars in the best month, crowned months
      tower_3: { emoji: '🏠', name: L('Karten\u00adstapler/in', 'Card stacker'), desc: L('3 Etagen in einem Monat geschafft', 'Cleared 3 floors in one month'),
        how: L('Hol dir in einem Monat im Kartenhaus (Aufgaben → Kartenhaus) auf den Etagen 1 bis 3 je mindestens einen Stern.', 'Earn at least one star on floors 1 to 3 of the House of Cards in one month (Tasks → House of Cards).') },
      tower_6: { emoji: '🏠', name: L('Karten\u00adkünstler/in', 'Card artist'), desc: L('6 Etagen in einem Monat geschafft', 'Cleared 6 floors in one month'),
        how: L('Hol dir in einem Monat im Kartenhaus auf den Etagen 1 bis 6 je mindestens einen Stern.', 'Earn at least one star on floors 1 to 6 of the House of Cards in one month.') },
      tower_10: { emoji: '🏠', name: L('Hoch\u00adstapler/in', 'High stacker'), desc: L('10 Etagen in einem Monat geschafft', 'Cleared 10 floors in one month'),
        how: L('Schaff in einem Monat die Etagen 1 bis 10 des Kartenhauses - die zehnte gegen drei Zen-Bots.', 'Clear floors 1 to 10 of the House of Cards in one month - the tenth against three Zen bots.') },
      tower_stars_30: { emoji: '🌠', name: L('Sternen\u00adhimmel', 'Starry sky'), desc: L('30 Sterne in einem Monat', '30 stars in one month'),
        how: L('Sammle in einem Monat im Kartenhaus 30 Sterne: drei pro Etage gibt es für klar vorn und selbst ausgemacht.', 'Collect 30 stars in the House of Cards in one month: three per floor for clearly ahead and out yourself.') },
      tower_crowned_1: { emoji: '👷', name: L('Lehrling', 'Apprentice'), desc: L('Ein Kartenhaus gekrönt: alle 20 Etagen eines Monats', 'Crowned a House of Cards: all 20 floors of a month'),
        how: L('Hol dir in einem Monat auf allen 20 Etagen des Kartenhauses mindestens einen Stern - dann kommt die Pik Dame obenauf.', 'Earn at least one star on all 20 floors of the House of Cards in one month - then the Queen of Spades goes on top.') },
      tower_crowned_3: { emoji: '👷', name: L('Polier/in', 'Foreman'), desc: L('3 Monate das Kartenhaus gekrönt', 'Crowned the House of Cards in 3 months'),
        how: L('Kröne das Kartenhaus in 3 Monaten: jedes Mal alle 20 Etagen mit mindestens einem Stern.', 'Crown the House of Cards in 3 months: every time all 20 floors with at least one star.') },
      tower_crowned_12: { emoji: '👷', name: L('Bau\u00admeister/in', 'Master Builder'), desc: L('12 Monate das Kartenhaus gekrönt', 'Crowned the House of Cards in 12 months'),
        how: L('Kröne das Kartenhaus in 12 Monaten.', 'Crown the House of Cards in 12 months.') },
    };
    return M[id] || { emoji: '🎖️', name: id, desc: '', how: '' };
  }
  // Mirrors game/Badges.js BADGE_FAMILIES: one tile per counter, tiers as
  // dots. Everything not listed here is a single badge.
  const BADGE_FAMILIES = [
    { id: 'queens', tiers: ['pd_laid', 'pd_hunter_10', 'pd_hunter_50'] },
    { id: 'games', tiers: ['marathon_10', 'marathon_50', 'marathon_100'] },
    { id: 'wins', tiers: ['first_win', 'wins_10', 'wins_50'] },
    { id: 'streak', tiers: ['streak_3', 'streak_5', 'streak_10'] },
    { id: 'handaus', tiers: ['hand_aus_win', 'hand_aus_5'] },
    { id: 'daily', tiers: ['daily_7', 'daily_30'] },
    { id: 'hearts', tiers: ['purple_heart_10', 'purple_heart_50', 'purple_heart_100'] },
    { id: 'challenger', tiers: ['challenger_7', 'challenger_30'] },
    { id: 'puzzles', tiers: ['puzzle_7', 'puzzle_30'] },
    { id: 'puzzlePerfect', tiers: ['puzzle_perfect_10', 'puzzle_perfect_30', 'puzzle_perfect_100'] },
    { id: 'tower', tiers: ['tower_3', 'tower_6', 'tower_10'] },
    { id: 'towerStars', tiers: ['tower_stars_30'] },
    { id: 'towerCrowned', tiers: ['tower_crowned_1', 'tower_crowned_3', 'tower_crowned_12'] },
  ];
  const BADGE_SINGLES = [
    'pd_caught', 'round_300', 'score_500', 'pd_triple', 'double_queen_round',
    'comeback', 'zen_slayer', 'zen_trio', 'ring_run', 'run_13', 'pile_glutton', 'no_joker_win',
    'quick_start', 'joker_king', 'landslide', 'challenge_champ', 'queen_magnet_day', 'stammtisch_10', 'night_owl',
    'near_miss', 'cold_shower', 'rock_bottom', 'red_lantern', 'royal_flush', 'pik_royal',
  ];
  let globalStatsData = null;
  let lastGameProgress = null; // XP + lifetime record of the match just finished
  let myGameHistory = null; // null = noch nicht angefragt, [] = angefragt und leer // anonyme Server-Zähler (Partien, Pik Damen, ...)
  // --- Fortschritt über Partien hinweg ------------------------------------
  // dailyQuests: {date, ids} kommt IMMER vom Server (alle Spieler weltweit
  // arbeiten an denselben drei Aufgaben); die Beschriftungen leben hier,
  // weil sie zweisprachig sind. questProgress zählt den heutigen Stand.
  let dailyQuests = null;
  let questProgress = {};
  let myProgress = null;      // {xp, level:{level,into,need,total}}
  let myStreak = null;        // {streak, best, event, graceFree} - from the last 'progress' message
  let stammtischInfo = null;  // {code, name} when this session is bound to a Stammtisch
  let stammtischSummary = null; // standings / pairwise / series from the server
  let accountProgress = null; // {xp, seasonXp, season, games, wins, rank}
  let seasonAwards = [];        // account: finished seasons with an award, newest first
  let lastSeasonResult = null;  // account: place in the last finished season, or null

  // icon = sprite id (i-…): emoji are content, never icons.
  function questMeta(id) {
    const M = {
      finish_game: { icon: 'flag', text: L('Eine Partie zu Ende spielen', 'Finish one match') },
      win_game: { icon: 'trophy', text: L('Eine Partie gewinnen', 'Win a match') },
      win_rounds_3: { icon: 'target', text: L('3 Runden gewinnen', 'Win 3 rounds') },
      meld_queen: { icon: 'spade', text: L('Eine Pik Dame auslegen', 'Meld a Queen of Spades') },
      meld_jokers_3: { icon: 'crown', text: L('3 Joker auslegen', 'Meld 3 jokers') },
      round_150: { icon: 'bolt', text: L('Eine Runde mit 150+ Punkten', 'Score 150+ in one round') },
      clean_hands: { icon: 'shield', text: L('Partie ohne erwischte Pik Dame', 'Finish a match never caught with the Queen') },
      hand_aus: { icon: 'rocket', text: L('Eine Runde mit „Hand aus“ gewinnen', 'Win a round with "out in one"') },
      score_400: { icon: 'trend', text: L('400+ Punkte Endstand', 'Finish a match with 400+ points') },
      beat_zen: { icon: 'swords', text: L('Eine Partie gegen einen Zen-Bot gewinnen', 'Beat a table with a zen bot') },
    };
    return M[id] || { icon: 'cards', text: id };
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
    updateThemeName();
  }
  // The swatch title is the translated name (applyStaticLang), so reuse it.
  function updateThemeName() {
    const out = document.getElementById('themeNameValue');
    const theme = document.documentElement.getAttribute('data-theme');
    const btn = document.querySelector(`.prefSwatches .themeBtn[data-theme-choice="${theme}"]`);
    if (out) out.textContent = btn ? btn.title : '';
  }

  document.querySelectorAll('.themeBtn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const theme = btn.dataset.themeChoice;
      if (!themeUnlocked(theme)) {
        showToast(`🔒 ${themeName(theme)}: ${L(`ab Stufe ${THEME_LEVELS[theme]}`, `from level ${THEME_LEVELS[theme]}`)}`);
        return;
      }
      applyTheme(theme);
    });
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
      if (music && music.isActive()) return; // background music needs the context running
      if (audioCtx && audioCtx.state === 'running') audioCtx.suspend().catch(() => {});
    }, 3000);
  }
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && audioCtx && audioCtx.state === 'running') {
      audioCtx.suspend().catch(() => {});
    } else if (!document.hidden && music) {
      music.wake();
    }
  });

  // --- Background music: public/music-player.js plays what scripts/render-music.js composed.
  // Without the module or Web Audio the settings hide and nothing plays.
  const MUSIC_LEVEL_KEY = 'pikdame_music_level';
  const MUSIC_CHOICE_KEY = 'pikdame_music_track';
  const MUSIC_HINT_KEY = 'pikdame_music_hint';
  const musicLib = window.PikdameMusic || null;
  const musicSupported = !!(musicLib && (window.AudioContext || window.webkitAudioContext));
  let musicPrefs = musicLib
    ? musicLib.resolvePrefs({
      level: storageGet(MUSIC_LEVEL_KEY),
      choice: storageGet(MUSIC_CHOICE_KEY),
      soundOff: storageGet(SOUND_KEY) === 'off',
      saveData: !!(navigator.connection && navigator.connection.saveData),
    })
    : { level: 'off', choice: 'mix', explicit: false };
  let music = null;
  try {
    if (musicSupported) {
      music = musicLib.createPlayer({
        getContext: getAudioCtx,
        fetchImpl: (url, opts) => fetch(url, opts),
        cachesImpl: window.caches || null, // only in secure contexts; plain fetch otherwise
        onStart: () => {
          if (musicPrefs.explicit || storageGet(MUSIC_HINT_KEY) === '1') return;
          if (Date.now() < toastLockUntil) return; // a priority toast would swallow it: next start
          storageSet(MUSIC_HINT_KEY, '1');
          showToast(L('Musik läuft leise – ändern unter Optionen › Musik', 'Music plays quietly – change it under Options › Music'), { duration: 6000 });
        },
      });
      music.setChoice(musicPrefs.choice);
      music.setLevel(musicPrefs.level);
      // iOS starts audio only inside a gesture; unlock() is cheap to repeat.
      const unlockMusic = () => { try { music.unlock(); } catch (e) { /* music is never critical */ } };
      for (const type of ['pointerup', 'touchend', 'keydown']) document.addEventListener(type, unlockMusic, { capture: true, passive: true });
    }
  } catch (e) {
    music = null;
  }

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

  // A sliding tone through a moving band pass: reads as a short "miau".
  function playMeow() {
    if (!soundEnabled) return;
    const ctx = getAudioCtx();
    if (!ctx) return;
    if (ctx.state === 'suspended') ctx.resume();
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    const band = ctx.createBiquadFilter();
    const gain = ctx.createGain();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(480, t);
    osc.frequency.linearRampToValueAtTime(780, t + 0.12);
    osc.frequency.linearRampToValueAtTime(440, t + 0.5);
    band.type = 'bandpass';
    band.Q.value = 3;
    band.frequency.setValueAtTime(900, t);
    band.frequency.linearRampToValueAtTime(1500, t + 0.15);
    band.frequency.linearRampToValueAtTime(800, t + 0.5);
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(0.12, t + 0.04);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.55);
    osc.connect(band).connect(gain).connect(ctx.destination);
    osc.start(t);
    osc.stop(t + 0.6);
    scheduleAudioSuspend();
  }

  const sound = {
    pikdame: () => { playTone([98, 147, 98], 520, 'sawtooth', 0.06); vibrate([60, 40, 60, 40, 120]); },
    turn: () => { playTone([523, 659], 180, 'sine', 0.06); vibrate([30, 60, 30]); },
    draw: () => { playTone([320], 90, 'triangle', 0.05); vibrate(8); },
    discard: () => { playTone([260, 180], 110, 'triangle', 0.05); vibrate(12); },
    meld: () => { playTone([440, 554, 660], 220, 'sine', 0.06); vibrate([10, 30, 10]); },
    error: () => { playTone([140], 160, 'square', 0.05); vibrate(40); },
    roundEnd: () => { playTone([392, 494, 587, 784], 420, 'sine', 0.07); vibrate([15, 40, 15, 40]); },
    meow: () => { playMeow(); vibrate([12, 60, 12]); },
  };

  // Occasion days on the start screen: the signed-in account's greeting day
  // (server: PIKDAME_BIRTHDAY, via /api/me) and holidays for everyone (/statusz).
  // The server sends windows; this side only compares instants and never knows a date.
  const GREETING_EMOTE = '🎂'; // = GREETING_EMOTE in game/Emotes.js (contract test)
  // = HOLIDAY_EMOTES in game/Emotes.js (contract test)
  const HOLIDAY_EMOTES = { halloween: '🎃', nikolaus: '🎅', christmas: '🎄', silvester: '🎆', newyear: '🎆', easter: '🐣' };
  const OCCASIONS = {
    birthday: { icon: 'i-cake', particles: 'confetti', line: () => L(`Alles Gute zum Geburtstag, ${greetingName}!`, `Happy birthday, ${greetingName}!`) },
    halloween: { icon: 'i-pumpkin', particles: 'bats', line: () => L('Süßes oder Saures!', 'Trick or treat!') },
    nikolaus: { icon: 'i-mitre', particles: '', line: () => L('Frohen Nikolaus!', "Happy St. Nicholas' Day!") }, // the December snow is enough
    christmas: { icon: 'i-tree', particles: 'stars', line: () => L('Frohe Weihnachten!', 'Merry Christmas!') },
    silvester: { icon: 'i-sparkle', particles: 'fireworks', line: () => L('Guten Rutsch!', "Happy New Year's Eve!") },
    newyear: { icon: 'i-sparkle', particles: 'fireworks', line: () => L('Frohes neues Jahr!', 'Happy New Year!') },
    easter: { icon: 'i-egg', particles: 'blossoms', line: () => L('Frohe Ostern!', 'Happy Easter!') },
  };
  let greetingWindow = null; // { from, until } in epoch ms
  let greetingName = '';
  let holidayWindows = []; // [{ id, from, until }]
  let holidayRefreshAt = 0;
  let holidayRefreshTimer = null;
  let occasionTimer = null;
  let occasionCatCheck = null; // the cat below re-checks at the windows' edges
  const inWindow = (w, now) => !!w && now >= w.from && now < w.until;
  const validWindow = (w) => !!w && Number.isFinite(w.from) && Number.isFinite(w.until) && w.until > w.from;
  // The greeting day wins over a holiday on the same day.
  function currentOccasion(now = Date.now()) {
    if (inWindow(greetingWindow, now)) return 'birthday';
    const h = holidayWindows.find((w) => inWindow(w, now));
    return h ? h.id : null;
  }
  function setGreeting(win, name) {
    greetingWindow = validWindow(win) ? { from: win.from, until: win.until } : null;
    greetingName = String(name || '');
    applyOccasion();
  }
  function setHolidays(status) {
    const list = status && Array.isArray(status.windows) ? status.windows : [];
    holidayWindows = list.filter((w) => validWindow(w) && w.id !== 'birthday' && OCCASIONS[w.id])
      .map((w) => ({ id: w.id, from: w.from, until: w.until }));
    holidayRefreshAt = status && Number.isFinite(status.refreshAt) ? status.refreshAt : 0;
    clearTimeout(holidayRefreshTimer);
    const wait = holidayRefreshAt - Date.now();
    // Spread over ten minutes: every open client asks again after midnight.
    if (wait > 0) holidayRefreshTimer = setTimeout(refreshHolidays, Math.min(wait + Math.random() * 600000, 0x7fffffff));
    applyOccasion();
  }
  function refreshHolidays() {
    return fetch('/statusz').then((r) => r.json()).then((s) => setHolidays(s && s.occasions)).catch(() => {});
  }
  function applyOccasion() {
    clearTimeout(occasionTimer);
    // One instant for the decision AND the next edge: read twice, an edge passing
    // in between was skipped and the decor stuck until the following one.
    const now = Date.now();
    const id = currentOccasion(now);
    const occ = id ? OCCASIONS[id] : null;
    document.body.classList.toggle('greetingDay', !!occ);
    if (occ) document.body.dataset.occasion = id;
    else delete document.body.dataset.occasion;
    const text = el('greetLineText');
    if (text) text.textContent = occ ? occ.line() : '';
    const icon = el('greetLineIcon');
    if (icon && occ) icon.setAttribute('href', `#${occ.icon}`);
    document.querySelectorAll('.heroCostume, .heroDeco').forEach((g) => {
      g.classList.toggle('on', !!id && (g.getAttribute('data-for') || '').split(' ').includes(id));
    });
    renderOccasionParticles(occ ? occ.particles : '');
    renderOccasionEmote(id === 'birthday' ? GREETING_EMOTE : (id && HOLIDAY_EMOTES[id]) || null);
    if (occasionCatCheck) occasionCatCheck();
    const edges = [greetingWindow, ...holidayWindows].filter(Boolean)
      .flatMap((w) => [w.from, w.until]).filter((t) => t > now);
    if (edges.length) occasionTimer = setTimeout(applyOccasion, Math.min(Math.min(...edges) - now + 50, 0x7fffffff));
  }
  // Built once per switch; positions in %, motion in CSS (gone with reduced motion).
  function renderOccasionParticles(kind) {
    const box = el('greetConfetti');
    if (!box) return;
    let still = false;
    try { still = window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { /* old browser */ }
    if (still) kind = '';
    if ((box.dataset.kind || '') === kind) return;
    box.textContent = '';
    box.dataset.kind = kind;
    const rnd = (a, b) => a + Math.random() * (b - a);
    const piece = (cls, symbol) => {
      const p = document.createElement('i');
      if (cls) p.className = cls;
      if (symbol) p.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><use href="#${symbol}"/></svg>`;
      box.appendChild(p);
      return p;
    };
    const colors = ['#f6c453', '#ff8fa3', '#8ab4ff', '#b28dff', '#7ee0c3'];
    if (kind === 'confetti') {
      for (let i = 0; i < 18; i++) {
        const c = piece('', '');
        c.style.left = `${rnd(0, 100)}%`;
        c.style.background = colors[i % colors.length];
        c.style.animationDuration = `${rnd(7, 13)}s`;
        c.style.animationDelay = `-${rnd(0, 13)}s`;
      }
    } else if (kind === 'bats') {
      for (let i = 0; i < 6; i++) {
        const b = piece(i % 2 ? 'occBat back' : 'occBat', 'i-bat');
        b.style.top = `${rnd(4, 62)}%`;
        b.style.animationDuration = `${rnd(10, 16)}s`;
        b.style.animationDelay = `-${rnd(0, 16)}s`;
      }
    } else if (kind === 'stars') {
      for (let i = 0; i < 12; i++) {
        const s = piece('occStar', 'i-twinkle');
        s.style.left = `${rnd(2, 96)}%`;
        s.style.top = `${rnd(2, 78)}%`;
        s.style.setProperty('--s', rnd(0.6, 1.15).toFixed(2));
        s.style.animationDelay = `-${rnd(0, 3)}s`;
      }
    } else if (kind === 'fireworks') {
      // The sides first: the middle carries the wordmark and the greeting.
      [10, 88, 24, 74, 50].forEach((x, i) => {
        const burst = piece('occBurst', '');
        burst.style.left = `${x + rnd(-5, 5)}%`;
        burst.style.top = `${rnd(8, 52)}%`;
        burst.style.color = colors[i % colors.length];
        burst.style.animationDelay = `-${rnd(0, 3.4).toFixed(2)}s`;
        for (let k = 0; k < 10; k++) {
          const spark = document.createElement('b');
          spark.style.setProperty('--a', `${k * 36}deg`);
          burst.appendChild(spark);
        }
      });
    } else if (kind === 'blossoms') {
      const petals = ['#ffc2d6', '#fff3e6', '#f6e07a', '#c9f0d2'];
      for (let i = 0; i < 14; i++) {
        const p = piece('occPetal', 'i-blossom');
        p.style.left = `${rnd(0, 100)}%`;
        p.style.color = petals[i % petals.length];
        p.style.animationDuration = `${rnd(8, 14)}s`;
        p.style.animationDelay = `-${rnd(0, 14)}s`;
      }
    }
  }
  function renderOccasionEmote(emoji) {
    const bar = el('emoteBar');
    if (!bar) return;
    const old = bar.querySelector('.greetEmote');
    if (old && old.dataset.emote === emoji) return;
    if (old) old.remove();
    // The seasonal set may already show it (🎃 in October, 🎆 around New Year).
    if (!emoji || [...bar.querySelectorAll('button[data-emote]')].some((b) => b.dataset.emote === emoji)) return;
    const sample = bar.querySelector('button[data-emote]');
    if (!sample) return;
    const b = sample.cloneNode(false);
    b.className = 'emoteChoice emoteSpecial greetEmote';
    b.dataset.emote = emoji;
    b.textContent = emoji;
    b.addEventListener('click', () => {
      send({ type: 'emote', emoji });
      bar.classList.add('hidden');
    });
    bar.appendChild(b);
  }
  // A PWA may sleep across an edge: the timers then fire late or never.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    if (holidayRefreshAt && Date.now() >= holidayRefreshAt) refreshHolidays();
    applyOccasion();
  });

  // A present for a cat lover, deliberately in no CHANGELOG, doc or commit message: five quick
  // taps on the start screen's card fan bring out a cat; on an occasion day it is out all day.
  (() => {
    const hero = document.querySelector('.lobbyHero');
    if (!hero) return;
    const says = hero.querySelector('.heroCatBubble text');
    let taps = [];
    let hushTimer = null;
    const speak = () => {
      if (says) says.textContent = L('Miau!', 'Meow!');
      hero.classList.add('catOut', 'catTalk');
      clearTimeout(hushTimer);
      hushTimer = setTimeout(() => {
        hero.classList.remove('catTalk');
        if (!currentOccasion()) hero.classList.remove('catOut');
      }, 3500);
    };
    hero.addEventListener('click', () => {
      if (hero.classList.contains('catTalk')) return;
      const now = Date.now();
      taps = taps.filter((at) => now - at < 2500).concat(now);
      if (taps.length < 5 && !currentOccasion()) return;
      taps = [];
      speak();
      sound.meow();
    });
    // Waits for the intro; also runs at the window's edges and when the app returns.
    const checkDay = () => {
      if (!currentOccasion()) {
        if (!hero.classList.contains('catTalk')) hero.classList.remove('catOut');
      } else if (!hero.classList.contains('catOut')) {
        if (document.getElementById('studioSplash')) setTimeout(checkDay, 500);
        else speak();
      }
    };
    occasionCatCheck = checkDay;
    setTimeout(checkDay, 900);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) checkDay(); });
  })();

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
    const box = el('soundCheckbox');
    if (box) box.checked = enabled;
  }
  setSoundEnabled(soundEnabled);

  const MUSIC_LEVELS = ['off', 'low', 'mid', 'high'];
  function musicLevelName(level) {
    return { off: L('Aus', 'Off'), low: L('Leise', 'Quiet'), mid: L('Mittel', 'Medium'), high: L('Laut', 'Loud') }[level];
  }
  function musicChoiceName(choice) {
    return {
      mix: L('Wechselnd', 'Shuffle'),
      kaffeehaus: L('Kaffeehaus', 'Coffee house'),
      lounge: L('Lounge-Bossa', 'Lounge bossa'),
      kaetzchen: L('Kätzchen', 'Kitten'),
    }[choice];
  }
  function updateMusicSetting() {
    el('musicItem').classList.toggle('hidden', !musicSupported);
    el('musicToggle').classList.toggle('hidden', !musicSupported);
    const levelSel = el('musicLevelSelect');
    for (const opt of levelSel.options) opt.textContent = musicLevelName(opt.value) || opt.textContent;
    levelSel.value = musicPrefs.level;
    const choiceSel = el('musicTrackSelect');
    for (const opt of choiceSel.options) opt.textContent = musicChoiceName(opt.value) || opt.textContent;
    choiceSel.value = musicPrefs.choice;
    setRowValue(el('musicToggle'), musicPrefs.level === 'off'
      ? musicLevelName('off')
      : `${musicLevelName(musicPrefs.level)} · ${musicChoiceName(musicPrefs.choice)}`);
    try { syncSegments(); } catch (e) { /* segments are cosmetic */ }
  }
  function setMusicLevel(level) {
    if (!MUSIC_LEVELS.includes(level)) return;
    musicPrefs = { ...musicPrefs, level, explicit: true };
    storageSet(MUSIC_LEVEL_KEY, level);
    if (music) {
      music.setLevel(level);
      if (level === 'off') scheduleAudioSuspend(); // the context may sleep again
      else music.unlock();
    }
    updateMusicSetting();
  }
  function setMusicChoice(choice) {
    if (!musicChoiceName(choice)) return;
    musicPrefs = { ...musicPrefs, choice };
    storageSet(MUSIC_CHOICE_KEY, choice);
    if (music) music.setChoice(choice);
    updateMusicSetting();
  }
  function cycleMusicLevel() {
    const next = MUSIC_LEVELS[(MUSIC_LEVELS.indexOf(musicPrefs.level) + 1) % MUSIC_LEVELS.length];
    setMusicLevel(next);
    showToast(L(`Musik: ${musicLevelName(next)}`, `Music: ${musicLevelName(next)}`));
  }
  try { updateMusicSetting(); } catch (e) { /* settings are comfort */ }

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
    const tipsBox = document.getElementById('aidTipsCheckbox');
    if (tipsBox) tipsBox.checked = enabled;
  }
  setTipsEnabled(gameTipsEnabled);

  // Spielhilfen (per device, like the tips): two aids that take over a check
  // experienced players like to do themselves. The tutorial always has both.
  //   - discard hint: does the top discard fit my hand? (server truth)
  //   - lay-off hint: green frames on melds the selected card fits
  // Defaults: discard hint OFF (new in 2.37, so nobody loses a habit), lay-off
  // hint ON (it has always been there). Nothing here changes a rule - the
  // server stays the only judge of every move.
  //   - low-card warning (2.62, default OFF): marks opponents down to 1-2 cards;
  //     counting them yourself is part of the game, so the tutorial leaves it alone.
  const AID_DISCARD_KEY = 'pikdame_aid_discard';
  const AID_LAYOFF_KEY = 'pikdame_aid_layoff';
  const AID_LOWCARDS_KEY = 'pikdame_aid_lowcards';
  let aidDiscard = storageGet(AID_DISCARD_KEY) === 'on';
  let aidLayOff = storageGet(AID_LAYOFF_KEY) !== 'off';
  let aidLowCards = storageGet(AID_LOWCARDS_KEY) === 'on';
  const inTutorial = () => !!(lastState && lastState.tutorialMode);
  const discardAidOn = () => aidDiscard || inTutorial();
  const layOffAidOn = () => aidLayOff || inTutorial();
  function renderAidControls() {
    for (const [btnId, boxId, on, onTxt, offTxt] of [
      ['aidDiscardToggle', 'aidDiscardCheckbox', aidDiscard,
        L('Ablage-Hinweis ausblenden', 'Hide discard hint'), L('Ablage-Hinweis anzeigen', 'Show discard hint')],
      ['aidLayOffToggle', 'aidLayOffCheckbox', aidLayOff,
        L('Anlege-Hinweis ausblenden', 'Hide lay-off hint'), L('Anlege-Hinweis anzeigen', 'Show lay-off hint')],
      ['aidLowCardsToggle', 'aidLowCardsCheckbox', aidLowCards,
        L('Hinweis bei wenigen Karten ausblenden', 'Hide low-card warning'), L('Hinweis bei wenigen Karten anzeigen', 'Show low-card warning')],
    ]) {
      const btn = document.getElementById(btnId);
      if (btn) {
        setRowValue(btn, on ? L('An', 'On') : L('Aus', 'Off'));
        btn.title = on ? onTxt : offTxt;
      }
      const box = document.getElementById(boxId);
      if (box) box.checked = on;
    }
    const tipsBox = document.getElementById('aidTipsCheckbox');
    if (tipsBox) tipsBox.checked = gameTipsEnabled;
  }
  function setAid(which, enabled) {
    if (which === 'discard') {
      aidDiscard = enabled;
      storageSet(AID_DISCARD_KEY, enabled ? 'on' : 'off');
    } else if (which === 'lowcards') {
      aidLowCards = enabled;
      storageSet(AID_LOWCARDS_KEY, enabled ? 'on' : 'off');
    } else {
      aidLayOff = enabled;
      storageSet(AID_LAYOFF_KEY, enabled ? 'on' : 'off');
    }
    renderAidControls();
    if (typeof render === 'function' && lastState) render();
  }
  renderAidControls();

  function wsUrl() {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const port = window.location.port ? `:${window.location.port}` : '';
    return `${proto}//${window.location.hostname}${port}`;
  }

  // Wiederverbindung mit wachsenden Abstaenden. Vorher wurde stur alle 2
  // Sekunden neu versucht - bei fehlender Netzverbindung (z. B. Mobilfunk-
  // Wechsel, DNS noch nicht auflösbar: ERR_NAME_NOT_RESOLVED) erzeugte das
  // eine Fehlermeldung nach der anderen in der Konsole, ohne dass ein
  // schneller Neuversuch irgendetwas gebracht haette.
  let reconnectAttempt = 0;
  let reconnectTimer = null;
  const RECONNECT_STEPS_MS = [1000, 2000, 4000, 8000, 15000, 30000];

  // --- Liveness watchdog (train/EDGE connections) --------------------------
  // In a tunnel or during a cell handover the TCP connection often dies
  // without a close event: readyState stays OPEN for minutes, every tap goes
  // into the void and the table looks frozen. Browsers cannot see the
  // server's protocol pings, so the client probes on its own: a socket that
  // has been silent for a while (or right after the player acted and got no
  // answer) gets an app-level ping; no pong within PONG_TIMEOUT_MS means the
  // socket is written off and a fresh one is opened at once.
  const IDLE_PROBE_MS = 10000;    // silent this long -> probe
  const ACTION_PROBE_MS = 3000;   // player acted, no answer this long -> probe
  const PONG_TIMEOUT_MS = 8000;   // probe unanswered this long -> dead
  const WATCHDOG_TICK_MS = 1000;
  // A handshake lost in a dead zone can hang in CONNECTING for minutes
  // (TCP SYN retries). Give up after this and retry with backoff.
  const CONNECT_TIMEOUT_MS = 12000;
  let lastRxAt = 0;
  let lastActionAt = 0;
  let pingSentAt = 0;
  let watchdogTimer = null;

  // Runs only while a socket is OPEN: nothing to watch otherwise, and the
  // reconnect timers own the disconnected phase.
  function startWatchdog() {
    clearInterval(watchdogTimer);
    watchdogTimer = setInterval(watchdogTick, WATCHDOG_TICK_MS);
  }
  function stopWatchdog() {
    clearInterval(watchdogTimer);
    watchdogTimer = null;
  }

  function watchdogTick() {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    // A backgrounded tab gets throttled timers; judging liveness there
    // would only produce false alarms. 'visibilitychange' re-checks.
    if (document.visibilityState === 'hidden') return;
    const now = Date.now();
    if (pingSentAt) {
      if (now - pingSentAt > PONG_TIMEOUT_MS) abandonSocket();
      return;
    }
    const idle = now - lastRxAt;
    const unanswered = lastActionAt > lastRxAt && now - lastActionAt > ACTION_PROBE_MS;
    if (idle > IDLE_PROBE_MS || unanswered) {
      pingSentAt = now;
      try { ws.send('{"type":"ping"}'); } catch (e) { abandonSocket(); }
    }
  }

  /** Writes off a socket that is OPEN on paper but dead in practice. Its
   *  handlers are detached (via the `sock !== ws` guards) so a close event
   *  that trickles in minutes later cannot start a second reconnect. */
  function abandonSocket(opts = {}) {
    const dead = ws;
    ws = null;
    pingSentAt = 0;
    stopWatchdog();
    try { if (dead) dead.close(); } catch (e) { /* already gone */ }
    updateNetBanner();
    // A socket that WAS working died: retry at once. A handshake that never
    // completed: keep backing off, the network is evidently not there yet.
    if (opts.backoff) {
      scheduleReconnect();
    } else {
      reconnectAttempt = 0;
      connect();
    }
  }

  // Persistent hint during a game: without it a dead connection only showed
  // up in the lobby's status line - at the table taps just did nothing.
  function updateNetBanner() {
    const banner = el('netBanner');
    if (!banner) return;
    const inSession = !!(sessionCode && playerId);
    const open = !!(ws && ws.readyState === WebSocket.OPEN);
    banner.classList.toggle('hidden', !inSession || open);
    if (inSession && !open) {
      el('netBannerText').textContent = navigator.onLine === false
        ? L('Offline - warte auf Netz …', 'Offline - waiting for network …')
        : L('Verbindung weg - verbinde neu …', 'Connection lost - reconnecting …');
    }
  }

  // The lobby status line only speaks up when something is wrong: a
  // permanent "Connected." cost a full line of the start screen for no news.
  // data-state drives the visibility (CSS hides 'ok').
  function setConnStatus(text, state) {
    const cs = el('connStatus');
    if (!cs) return;
    cs.textContent = text;
    cs.dataset.state = state;
  }

  function scheduleReconnect() {
    clearTimeout(reconnectTimer);
    updateNetBanner();
    // Offline: gar nicht erst versuchen. Der 'online'-Ereignishandler unten
    // startet sofort, sobald das Geraet wieder Netz hat.
    if (navigator.onLine === false) {
      setConnStatus(L('Offline - warte auf Netz...', 'Offline - waiting for a network...'), 'error');
      return;
    }
    const wait = RECONNECT_STEPS_MS[Math.min(reconnectAttempt, RECONNECT_STEPS_MS.length - 1)];
    reconnectAttempt += 1;
    const seconds = Math.round(wait / 1000);
    setConnStatus(L(
      `Verbindung verloren - neuer Versuch in ${seconds}s...`,
      `Connection lost - retrying in ${seconds}s...`
    ), 'error');
    // Streuung, damit nach einem Serverneustart nicht alle Geraete exakt
    // gleichzeitig anklopfen.
    reconnectTimer = setTimeout(connect, wait + Math.floor(Math.random() * 400));
  }

  function reconnectNow() {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
    clearTimeout(reconnectTimer);
    reconnectAttempt = 0;
    connect();
  }

  // Netz zurueck oder App wieder im Vordergrund: sofort versuchen, statt den
  // laufenden Wartezeitgeber abzuwarten.
  window.addEventListener('online', reconnectNow);
  window.addEventListener('offline', updateNetBanner);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    reconnectNow();
    // Back from the background: the socket may have died unnoticed while
    // the timers were throttled - probe it right away.
    if (ws && ws.readyState === WebSocket.OPEN && !pingSentAt) {
      pingSentAt = Date.now();
      try { ws.send('{"type":"ping"}'); } catch (e) { abandonSocket(); }
    }
  });

  function connect() {
    clearTimeout(reconnectTimer);
    if (navigator.onLine === false) { scheduleReconnect(); return; }
    const sock = new WebSocket(wsUrl());
    ws = sock;
    pingSentAt = 0;
    const connectTimer = setTimeout(() => {
      if (sock === ws && sock.readyState === WebSocket.CONNECTING) abandonSocket({ backoff: true });
    }, CONNECT_TIMEOUT_MS);
    setConnStatus(L('Verbinde...', 'Connecting...'), 'pending');

    // Every handler below ignores events of a socket that has since been
    // replaced (abandonSocket / a newer connect()).
    sock.addEventListener('open', () => {
      clearTimeout(connectTimer);
      if (sock !== ws) return;
      lastRxAt = Date.now();
      lastActionAt = 0;
      startWatchdog();
      updateNetBanner();
      setConnStatus(L('Verbunden.', 'Connected.'), 'ok');
      // Profile + Tagesaufgaben sofort holen: der Startbildschirm zeigt den
      // heutigen Aufgaben-Fortschritt, und der steht im eigenen Profil - ohne
      // diese Anfrage stünde dort bis zum Beitritt immer 0/3.
      ws.send(JSON.stringify({ type: 'listProfiles' }));
      // A new connection asks for the year review again (the profiles reply triggers it).
      yearReviewName = '';
      // Stammtisch chips on the start screen: series state per remembered code.
      try { renderStammtischRecent(); } catch (e) { /* cosmetic */ }
      // Automatischer Wiedereintritt NUR, wenn wir bereits Teil einer
      // Session waren (Reconnect nach Verbindungsabbruch oder geteilter
      // Link mit gespeicherter playerId). Ohne Code entscheidet der Nutzer
      // im UI: neues Spiel erstellen oder Code eingeben.
      if (sessionCode && playerId) {
        // accountToken is required: the server rejects a registered name without it.
        ws.send(JSON.stringify({ type: 'joinSession', code: sessionCode, playerId, playerToken: storageGet(tokenKeyFor(sessionCode)) || undefined, name: myName, accountToken: accountToken() || undefined }));
      } else {
        // Start screen: only offer 'resume' if that game still exists - and
        // learn whether this device still holds a seat there (one game at a time).
        probeOpenGame();
        const next = storageGet('pikdame_after_tutorial');
        if (next) {
          storageRemove('pikdame_after_tutorial');
          afterTutorial = next;
          el('createGameBtn').click();
        }
        // Back from a finished Kartenhaus floor (leaveTowerFor): the house or the next try.
        const towerNext = storageGet('pikdame_after_tower');
        if (towerNext) {
          storageRemove('pikdame_after_tower');
          afterTower(towerNext);
        }
      }
    });

    sock.addEventListener('open', () => { if (sock === ws) reconnectAttempt = 0; });

    sock.addEventListener('close', () => {
      clearTimeout(connectTimer);
      if (sock !== ws) return;
      stopWatchdog();
      scheduleReconnect();
    });

    sock.addEventListener('error', () => {
      if (sock !== ws) return;
      // No retry of its own here: 'error' is ALWAYS followed by 'close',
      // otherwise two timers would run in parallel. Only update the display.
      setConnStatus(navigator.onLine === false
        ? L('Offline - warte auf Netz...', 'Offline - waiting for a network...')
        : L('Verbindungsfehler.', 'Connection error.'), 'error');
    });

    sock.addEventListener('message', (ev) => {
      if (sock !== ws) return;
      lastRxAt = Date.now();
      pingSentAt = 0;
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
      // Arms the action probe: no answer within ACTION_PROBE_MS -> ping.
      lastActionAt = Date.now();
      return;
    }
    // Not queued on purpose: replaying a stale move after a reconnect could
    // act on a table that changed meanwhile. Say so instead of swallowing it.
    showToast(L('Keine Verbindung - Aktion nicht gesendet. Verbinde neu …', 'No connection - action not sent. Reconnecting …'), { priority: true });
    reconnectNow();
  }

  function handleMessage(msg) {
    if (msg.type === 'pong') return; // liveness only, see watchdogTick
    if (msg.type === 'joined') {
      stammtischInfo = msg.stammtisch || null;
      if (stammtischInfo) rememberStammtisch(stammtischInfo);
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
      // A finished match (winner decided) is not offered for resuming; the
      // code stays remembered, the results are still reachable by typing it.
      if (msg.exists && !msg.finished && msg.code === last && !sessionCode) {
        resumeCode = msg.code;
        resumeIsChallenge = !!msg.challenge;
      } else {
        if (!msg.exists && msg.code === last) storageRemove('pikdame_last_session');
        resumeCode = null;
        resumeIsChallenge = false;
        resumeIsTutorial = false;
      }
      // Beschriftung kommt aus updateResumeBtn(), damit ein SPAeTERER
      // Sprachwechsel sie mitnimmt - vorher wurde sie hier einmalig gesetzt
      // und blieb danach in der alten Sprache stehen (Nutzer-Report).
      updateResumeBtn();
      if (msg.code === last) setOpenGame(msg);
      return;
    }
    if (msg.type === 'sessionAbandoned') {
      onSessionAbandoned(msg);
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
      // A refused celebration choice: the select shows the stored one again.
      if (/Siegesjubel/.test(msg.error || '')) {
        try { updateCelebrationSetting(); } catch (e) { /* cosmetic */ }
      }
      // Tutorial: a refusal is the best teaching moment - the rule behind it
      // goes into the coach card, alone (the centred toast covered the card).
      const why = tutorialActive ? tutorialExplainError(msg.error || '') : null;
      if (why) {
        sound.error();
        coachNote(why, 'error');
        return;
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
      if (lastState.phase !== 'gameOver') lastGameProgress = null;
      else quoteShownForRound = null; // the next game's round 1 gets its quote again
      // Solo-Spiel abgebrochen (Challenge/Tutorial, nicht rechtzeitig
      // zurueckgekehrt): klar ansagen, den Wiederaufnehmen-Code wegwerfen -
      // die Sitzung existiert serverseitig nicht mehr.
      if (lastState.abandoned) {
        try { storageRemove('pikdame_last_session'); } catch (e) { /* egal */ }
        resumeCode = null;
        resumeIsChallenge = false;
        resumeIsTutorial = false;
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
      // After "Tutorial geschafft": the new game exists - start it with bots
      // straight away, or leave the lobby open for sharing the code.
      if (afterTutorial && lastState.phase === 'lobby' && lastState.isHost) {
        const next = afterTutorial;
        afterTutorial = null;
        if (next === 'bots') el('startBtn').click();
        else showToast(L('Teile den Code mit deinen Freunden – sie spielen dann mit.', 'Share the code with your friends – then they join in.'), { duration: 6000 });
      }
      return;
    }
    if (msg.type === 'stammtisch') {
      stammtischSummary = msg.summary || null;
      try { renderStammtisch(); } catch (e) { /* never critical */ }
      // One toast for everything this match settled: the series, the week, the level.
      const said = [];
      const ev = msg.seriesEvent;
      if (ev && ev.type === 'won') {
        const w = msg.summary && msg.summary.series && msg.summary.series.wins;
        const scores = w ? Object.values(w).sort((a, b) => b - a) : [];
        said.push(`🏆 ${trs(`${ev.winner} gewinnt die Serie ${scores[0] || 0}:${scores[1] || 0}!`)}`);
      }
      for (const g of msg.goalEvents || []) said.push(stammtischGoalEventText(g));
      if (said.length) showToast(said.filter(Boolean).join(' · '), { duration: 6000, priority: true });
      if (!el('resultOverlay').classList.contains('hidden')) renderResultOverlay();
      return;
    }
    if (msg.type === 'stammtischList') {
      try { renderStammtischList(msg.tables || []); } catch (e) { /* never critical */ }
      return;
    }
    if (msg.type === 'stammtischInfo') {
      try { updateStammtischChip(msg); } catch (e) { /* cosmetic */ }
      return;
    }
    if (msg.type === 'puzzle' || msg.type === 'puzzleResult' || msg.type === 'puzzleSolution' || msg.type === 'puzzleMeldCheck') {
      try { handlePuzzleMessage(msg); } catch (e) { /* a broken puzzle never breaks the client */ }
      try { renderToday(); } catch (e) { /* cosmetic */ }
      return;
    }
    if (msg.type === 'yearReview') {
      try { handleYearReview(msg); } catch (e) { /* the review never breaks the client */ }
      return;
    }
    if (msg.type === 'challengeBoard') {
      lastChallengeBoard = msg;
      renderChallengeBoard();
      if (lastState && lastState.phase === 'gameOver' && !el('resultOverlay').classList.contains('hidden')) renderResultMe(true);
      return;
    }
    if (msg.type === 'towerInfo') {
      towerInfo = { ...msg, forName: towerAskedFor };
      renderTower();
      renderTowerTile();
      if (lastState && lastState.towerStage) { try { renderTowerTable(); } catch (e) { /* cosmetic */ } }
      if (!el('progressOverlay').classList.contains('hidden')) renderProgressSheet();
      return;
    }
    if (msg.type === 'towerResult') {
      lastTowerResult = msg;
      // For the house's next opening: a missed floor wobbles there (after the reload).
      storageSet(TOWER_LAST_KEY, JSON.stringify({ name: myName || '', month: msg.month, stage: msg.stage, stars: msg.stars }));
      const pr = msg.progress;
      if (pr && towerInfo && towerInfo.month === msg.month) {
        Object.assign(towerInfo, { best: pr.best, stars: pr.stars, cleared: pr.cleared, unlocked: pr.unlocked, crowned: pr.crowned, totalStars: pr.totalStars });
      }
      try { renderTowerTile(); } catch (e) { /* cosmetic */ }
      // A floor's first star pays XP: same level bookkeeping as the solved puzzle.
      if (msg.xp && msg.level) {
        const total = msg.level.total || 0;
        myProgress = { xp: Math.max((myProgress && myProgress.xp) || 0, total), level: msg.level };
        const from = levelFromXpClient(total - msg.xp).level;
        if (msg.level.level > from) showLevelUp(from, msg.level.level, msg.xp, total - msg.xp);
        try { renderQuests(); renderEmoteLocks(); } catch (e) { /* cosmetic */ }
      }
      renderTowerResult();
      return;
    }
    if (msg.type === 'badges') {
      lastEarnedBadges = msg.earned || null;
      if (!el('resultOverlay').classList.contains('hidden')) renderResultOverlay();
      return;
    }
    if (msg.type === 'gameHistory') {
      myGameHistory = msg.games || [];
      if (!el('statsOverlay').classList.contains('hidden')) renderStatsMe();
      if (!el('statsOverlay').classList.contains('hidden') && !el('statsPaneHistory').classList.contains('hidden')) {
        renderGameHistory();
      }
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
      try { updateCelebrationSetting(); } catch (e) { /* cosmetic */ }
      if (!publicMode && !towerInfo) requestTower();
      try { renderTowerTile(); } catch (e) { /* cosmetic */ }
      if (msg.quests) dailyQuests = msg.quests;
      try { fetchChallengeToday(); } catch (e) { /* cosmetic */ }
      // My own counters live on my profile (name-based, like every other
      // statistic) - no extra round trip and no extra server state.
      if (dailyQuests) {
        const mine = myProfile();
        questProgress = (mine && mine.quests && mine.quests[dailyQuests.date]) || {};
      }
      renderQuests();
      try { renderEmoteLocks(); } catch (e) { /* cosmetic */ }
      try { requestYearReview(); } catch (e) { /* cosmetic */ }
      if (!el('statsOverlay').classList.contains('hidden')) renderStats();
      return;
    }
    if (msg.type === 'progress') {
      // End of a match: experience, level and the daily quests that ticked.
      myProgress = { xp: msg.xp, level: msg.level };
      lastGameProgress = { gainedXp: msg.gainedXp || 0, welcomeBack: !!msg.welcomeBack, record: msg.record || null, streak: msg.streak || null };
      if (msg.streak) myStreak = msg.streak;
      if (msg.quests) {
        dailyQuests = { date: msg.quests.date, ids: msg.quests.ids };
        questProgress = msg.quests.progress || {};
      }
      renderQuests();
      celebrateProgress(msg);
      if (lastState && lastState.phase === 'gameOver' && !el('resultOverlay').classList.contains('hidden')) renderResultOverlay();
      try { renderEmoteLocks(); } catch (e) { /* cosmetic */ }
      return;
    }
    if (msg.type === 'accountProgress') {
      accountProgress = msg.progress || null;
      renderAccountProgress();
      // Sent right after a finished match: its season place joins the result strip.
      if (lastGameProgress && accountProgress && lastState && lastState.phase === 'gameOver') {
        lastGameProgress.seasonRank = accountProgress.rank || null;
        if (!el('resultOverlay').classList.contains('hidden')) renderResultMe(true);
      }
      return;
    }
    if (msg.type === 'emote') {
      if (tutorialHintsOn() && msg.playerId !== playerId) return; // bots stay quiet in the tutorial
      showEmote(msg.playerId, msg.emoji);
      return;
    }
    if (msg.type === 'quip') {
      showQuip(msg.playerId, msg.moment);
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
  // Pokal für den PARTIE-Gewinn - bewusst eine eigene Form statt der Krone
  // wiederzuverwenden, die schon jeden Rundengewinn markiert. Ohne diese
  // Trennung sah "eine Runde gewonnen" optisch identisch zu "die ganze
  // Partie gewonnen" aus (Feature-Wunsch, nach dem Vorbild von Codenames:
  // ein Pokal nur für den eigentlichen Sieg). Geometrie berechnet und als
  // PNG bei mehreren Größen und auf hellem wie dunklem Grund geprüft, bevor
  // sie hier landete - Henkel als echte SVG-Bögen, Kelch/Stiel/Sockel mit
  // 0.15-0.35 Einheiten Überlappung gegen Anti-Aliasing-Nähte zwischen den
  // gestapelten Formen.
  const TROPHY_MARK_SVG =
    '<svg class="trophyMark" viewBox="0 0 24 24" aria-hidden="true">' +
    '<path d="M5.2 3H18.8C18.8 8 16.4 12.4 13 13.2V14.85H11V13.2C7.6 12.4 5.2 8 5.2 3Z"/>' +
    '<path d="M3.76 3.61A2.7 2.7 0 1 1 3.76 8.99L3.89 7.60A1.3 1.3 0 1 0 3.89 5.00Z" fill-rule="evenodd"/>' +
    '<path d="M19.76 3.61A2.7 2.7 0 1 1 19.76 8.99L19.89 7.60A1.3 1.3 0 1 0 19.89 5.00Z" fill-rule="evenodd"/>' +
    '<path d="M11 14.6H13L13.4 17.4H10.6Z"/>' +
    '<path d="M9.8 17.15H14.2L14.7 19.1H9.3Z"/>' +
    '<path d="M8.4 18.85H15.6L16.2 21H7.8Z"/>' +
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
            .map((p) => `${nameWithHeart(p.name)}${p.isBot ? ' (Bot)' : ''}${!p.isBot && ready.has(p.id) ? ` (${L('bereit', 'ready')})` : ''}`)
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
    // Stammtisch = group table: the server rejects a start with one human.
    const needsSecond = !!stammtischInfo && seatedHumans.length < 2;
    el('startBtn').classList.toggle('hidden', !isHost); // only the organizer starts
    el('startBtn').disabled = humanCount === 0 || !allReady || needsSecond;
    el('startBtn').textContent = needsSecond
      ? L('Mindestens 2 Spieler nötig', 'At least 2 players needed')
      : multiHuman
        ? L(`Spiel starten (${readyCount}/${seatedHumans.length} bereit)`, `Start game (${readyCount}/${seatedHumans.length} ready)`)
        : L('Spiel starten', 'Start game');
    // The sticky bar only exists while it has something to show - an empty
    // pinned strip at the bottom of the start screen would be pure noise.
    el('lobbyActions').classList.toggle(
      'hidden',
      el('startBtn').classList.contains('hidden') && readyBtn.classList.contains('hidden')
    );

    const hasJoined = lastState.players.some((p) => p.id === playerId);
    // Seated players read the seating list (names, ready ticks); the plain
    // text line is only for someone looking at the table from outside.
    el('lobbyPlayers').classList.toggle('hidden', hasJoined);
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
    setCtl('ruleBotPace', hr.botPace || 'normal');
    // Bot strength: the bots' common level, "Gemischt" once one bot differs.
    const botLevels = new Set(lastState.players.filter((p) => p.isBot).map((p) => p.botDifficulty || 'zen'));
    setCtl('ruleBotLevel', botLevels.size === 0 ? (lastState.botLevel || 'medium') : botLevels.size === 1 ? [...botLevels][0] : 'mixed');
    // House rules are read-only for non-hosts.
    el('houseRulesSection').querySelectorAll('input, select, button').forEach((ctrl) => {
      ctrl.disabled = !isHost;
    });
    syncSegments();

    document.querySelectorAll('.seatCountBtn').forEach((btn) => {
      const count = Number(btn.dataset.seatCount);
      btn.classList.toggle('active', count === lastState.maxSeats);
      // non-hosts cannot change the seat count; hosts cannot go below joined humans
      btn.disabled = !isHost || count < humanCount;
    });

    renderSeatingList(isHost);
    try { renderStammtisch(); } catch (e) { /* never critical */ }
  }

  // Drag state of the seating list. A state broadcast in mid-drag must not
  // rebuild the list under the finger; the rebuild waits for the drop.
  let seatDrag = null;
  let seatListPending = null;

  function renderSeatingList(isHost) {
    if (seatDrag) { seatListPending = isHost; return; }
    const list = el('seatingList');
    list.innerHTML = '';
    const canEdit = isHost !== false; // default true when called without arg
    const ready = new Set(lastState.lobbyReady || []);
    const multiHuman = lastState.players.filter((p) => !p.isBot).length > 1;
    const count = lastState.players.length;
    lastState.players.forEach((p, idx) => {
      const row = document.createElement('div');
      row.className = 'seatRow';
      const isDealer = p.id === lastState.dealerId;
      // Per-bot difficulty (bots only), as a labelled chip - the emoji alone
      // (🌱🙂🧘) said nothing to anyone who had not opened the picker yet.
      // Non-hosts see it read-only.
      const diff = BOT_DIFF[p.botDifficulty] || BOT_DIFF.zen;
      const diffTitle = canEdit
        ? L('Schwierigkeit ändern', 'Change difficulty')
        : L(`Schwierigkeit: ${diff.short()}`, `Difficulty: ${diff.short()}`);
      const diffChip = p.isBot
        ? `<button class="seatDiff tapExpand${canEdit ? '' : ' readonly'}" title="${diffTitle}">${levelIconHtml(diff)}<span>${diff.short()}</span></button>`
        : '';
      const readyMark = multiHuman && !p.isBot && ready.has(p.id)
        ? `<span class="seatReady" title="${L('bereit', 'ready')}"><svg class="icon" aria-hidden="true"><use href="#i-check"/></svg></span>`
        : '';
      // Dealer: a filled chip on the dealer's row; the host gets an outline
      // star on the others to move it. Non-hosts only see who deals.
      const dealerBtn = isDealer || canEdit
        ? `<button class="btn-icon seatDealer tapExpand${isDealer ? ' active' : ''}" ${canEdit ? '' : 'disabled'} aria-pressed="${isDealer}" title="${isDealer ? L('Gibt die erste Runde', 'Deals the first round') : L('Als Geber festlegen', 'Make dealer')}"><svg class="icon" aria-hidden="true"><use href="#i-star"/></svg>${isDealer ? `<span>${L('Geber', 'Dealer')}</span>` : ''}</button>`
        : '';
      const grip = canEdit && count > 1
        ? `<button class="seatGrip" title="${L('Ziehen zum Umsortieren', 'Drag to reorder')}" aria-label="${L(`Platz ${idx + 1} verschieben (Pfeiltasten)`, `Move seat ${idx + 1} (arrow keys)`)}"><svg class="icon" aria-hidden="true"><use href="#i-grip"/></svg></button>`
        : '';
      // Lobby: only the badges a player chose themselves, no level title (#317).
      row.innerHTML = `${grip}<span class="seatName">${nameWithHeart(p.name)}${p.isBot ? '' : favoriteBadgesHtml(profileByName(p.name))}${botMark(p)}${readyMark}</span><span class="seatControls">${diffChip}${dealerBtn}</span>`;
      if (canEdit) {
        const dealer = row.querySelector('.seatDealer');
        if (dealer && !isDealer) dealer.addEventListener('click', () => send({ type: 'setDealer', playerId: p.id }));
        if (p.isBot) row.querySelector('.seatDiff').addEventListener('click', () => openBotDiffOverlay(p));
        const g = row.querySelector('.seatGrip');
        if (g) {
          g.addEventListener('pointerdown', (ev) => startSeatDrag(ev, row, idx));
          g.addEventListener('keydown', (ev) => {
            if (ev.key === 'ArrowUp' && idx > 0) { ev.preventDefault(); moveSeatTo(idx, idx - 1); }
            else if (ev.key === 'ArrowDown' && idx < count - 1) { ev.preventDefault(); moveSeatTo(idx, idx + 1); }
          });
        }
      }
      list.appendChild(row);
    });
  }

  function moveSeatTo(from, to) {
    const order = lastState.players.map((p) => p.id);
    if (from === to || to < 0 || to >= order.length) return;
    const [id] = order.splice(from, 1);
    order.splice(to, 0, id);
    send({ type: 'reorderSeats', order });
  }

  // Pointer drag on the grip (mouse and touch alike). The row follows the
  // pointer, the others slide aside; the new order goes to the server on drop.
  function startSeatDrag(ev, row, fromIdx) {
    if (ev.button !== undefined && ev.button !== 0) return;
    const grip = ev.currentTarget;
    const rows = [...el('seatingList').querySelectorAll('.seatRow')];
    if (rows.length < 2) return;
    ev.preventDefault();
    const rects = rows.map((r) => r.getBoundingClientRect());
    const pitch = rects[1].top - rects[0].top;
    seatDrag = { row, rows, rects, pitch, fromIdx, toIdx: fromIdx, startY: ev.clientY };
    row.classList.add('dragging');
    try { grip.setPointerCapture(ev.pointerId); } catch (e) { /* older engines */ }
    const onMove = (e) => {
      const d = seatDrag;
      if (!d) return;
      const minDy = rects[0].top - rects[fromIdx].top;
      const maxDy = rects[rects.length - 1].top - rects[fromIdx].top;
      const dy = Math.max(minDy, Math.min(maxDy, e.clientY - d.startY));
      d.row.style.transform = `translateY(${dy}px)`;
      d.toIdx = Math.max(0, Math.min(rows.length - 1, fromIdx + Math.round(dy / d.pitch)));
      rows.forEach((r, i) => {
        if (i === fromIdx) return;
        let shift = 0;
        if (fromIdx < d.toIdx && i > fromIdx && i <= d.toIdx) shift = -d.pitch;
        if (fromIdx > d.toIdx && i < fromIdx && i >= d.toIdx) shift = d.pitch;
        r.style.transform = shift ? `translateY(${shift}px)` : '';
      });
    };
    const onEnd = () => {
      grip.removeEventListener('pointermove', onMove);
      grip.removeEventListener('pointerup', onEnd);
      grip.removeEventListener('pointercancel', onEnd);
      const d = seatDrag;
      seatDrag = null;
      if (!d) return;
      rows.forEach((r) => { r.style.transform = ''; r.classList.remove('dragging'); });
      if (d.toIdx !== d.fromIdx) moveSeatTo(d.fromIdx, d.toIdx);
      if (seatListPending !== null) {
        const host = seatListPending;
        seatListPending = null;
        renderSeatingList(host);
      }
    };
    grip.addEventListener('pointermove', onMove);
    grip.addEventListener('pointerup', onEnd);
    grip.addEventListener('pointercancel', onEnd);
  }


  function collectHouseRules() {
    return {
      handAusDoubles: el('ruleHandAus').checked,
      strictThreshold: el('ruleStrict1000').checked,
      turnTimerSeconds: Number(el('ruleTurnTimer').value),
      botPace: el('ruleBotPace').value,
    };
  }
  // Rides along with every message that may open a NEW table; the server
  // validates it like the lobby controls and ignores it for existing tables.
  function tablePrefs() {
    try {
      const v = JSON.parse(storageGet(TABLE_PREFS_KEY) || 'null');
      return v && typeof v === 'object' ? v : undefined;
    } catch (e) { return undefined; }
  }
  function rememberTablePrefs(patch) {
    storageSet(TABLE_PREFS_KEY, JSON.stringify({ ...(tablePrefs() || {}), ...patch }));
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
    // Opponent seats sit right under the top bar: starting at their top edge,
    // the 46px rise ended on the pause/settings buttons. Start mid-seat.
    pop.style.top = mine ? `${Math.max(r.top + 8, 60)}px` : `${r.top + r.height / 2 - 6}px`;
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
    // Same "<b>n</b> Pkt" format as the opponent chips; a negative total
    // keeps its minus sign, red only reinforces it.
    const scoreEl = el('myScore');
    scoreEl.innerHTML = `<b>${myTotal}</b> ${L('Pkt', 'pts')}`;
    scoreEl.classList.toggle('scoreNegative', myTotal < 0);
    // Progress towards the 1000-point finish line (negatives clamp to 0)
    el('myScoreBar').querySelector('i').style.width =
      `${Math.max(0, Math.min(100, (myTotal / SCORE_TARGET) * 100))}%`;
    const dealer = lastState.players.find((p) => p.id === lastState.dealerId);
    const iAmDealer = dealer && dealer.id === playerId;
    // Star alone, as on the opponent chips; the title names it.
    el('roundInfo').innerHTML = iAmDealer
      ? `R${lastState.roundNumber} <svg class="icon dealerIcon" aria-hidden="true"><use href="#i-star"/></svg>`
      : `R${lastState.roundNumber}`;
    el('roundInfo').title = iAmDealer ? L('Du gibst diese Runde', 'You deal this round') : '';
    const isMyTurn = lastState.currentPlayerId === playerId;
    updateTurnTitleNotice(isMyTurn && lastState.phase === 'playing');
    el('turnStatus').innerHTML = turnStatusHtml(lastState, playerId);

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
    // Guests see the level badge only when the bots differ (three equal tags were
    // noise); the host always keeps it, it is the control to change one bot.
    const levelsDiffer = new Set(lastState.players.filter((p) => p.isBot).map((p) => p.botDifficulty || 'zen')).size > 1;
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
        // Gave the game up for good (one game at a time): a bot plays the seat.
        const leftGame = !p.isBot && !!p.leftGame;
        const reconnecting = !p.isBot && p.controlledByBot && !leftGame;
        const opTotal = (lastState.totals && lastState.totals[p.id]) || 0;
        const dealerStar = p.id === lastState.dealerId ? `<span class="opDealer" title="${L('Geber dieser Runde', 'Dealer this round')}"><svg class="icon dealerIcon" aria-hidden="true"><use href="#i-star"/></svg></span>` : '';
        const cardsText = p.handCount === 1 ? L('1 Karte', '1 card') : L(`${p.handCount} Karten`, `${p.handCount} cards`);
        d.title = L(`${cardsText} · ${opTotal} Punkte`, `${cardsText} · ${opTotal} points`);
        const opProgress = Math.max(0, Math.min(100, (opTotal / 1000) * 100));
        if (reconnecting || leftGame) d.classList.add('disconnected');
        // Play aid "low-card warning" (default off): a tag on the chip's edge,
        // so the chip keeps its height and the melds below do not jump.
        const lowCards = aidLowCards && !leftGame && lastState.phase === 'playing' && p.handCount > 0 && p.handCount <= 2;
        if (lowCards) d.classList.add('lowCards');
        // The same edge slot says who gave the game up (the name row would truncate it).
        const lowTag = leftGame
          ? `<span class="opLowTag opLeftTag"><span>${L('hat verlassen', 'left')}</span></span>`
          : lowCards
            ? `<span class="opLowTag"><svg class="icon" aria-hidden="true"><use href="#i-alert"/></svg><span>${p.handCount === 1 ? L('Letzte Karte!', 'Last card!') : L('Noch 2 Karten!', '2 cards left!')}</span></span>`
            : '';
        d.innerHTML = `<div class="opName">${avatarFor(p.name, p.isBot)}${nameWithHeart(p.name)}${dealerStar}${reconnecting ? ` <span class="reconnectTag">${L('getrennt', 'offline')}</span>` : ''}</div><div class="opCount"><span class="opCards" title="${cardsText}"><svg class="icon" aria-hidden="true"><use href="#i-cards"/></svg><b>${p.handCount}</b></span><b class="opPts" title="${L(`${opTotal} Punkte`, `${opTotal} points`)}">${opTotal}</b></div><div class="scoreBar" title="${L('Fortschritt bis 1000 Punkte', 'Progress towards 1000 points')}"><i style="width:${opProgress}%"></i></div>${lowTag}`;
        // Daily challenge: the level is fixed and deliberately not shown.
        // Badge lives OUTSIDE the name div: inside it, the name ellipsis on
        // narrow chips (3 bots, portrait) swallowed the button.
        if (p.isBot && !lastState.challengeDate && (levelsDiffer || lastState.isHost)) {
          const meta = BOT_DIFF[p.botDifficulty] || BOT_DIFF.zen;
          const badgeBtn = document.createElement('button');
          badgeBtn.className = 'botDiffBadge tapExpand';
          // In the game the spade rating alone; the level's name is in title + aria-label.
          badgeBtn.innerHTML = levelIconHtml(meta);
          // Kartenhaus: the floor fixes the bots, so the badge only tells.
          if (lastState.isHost && !lastState.towerStage) {
            badgeBtn.title = L(`Schwierigkeit ändern (${meta.short()})`, `Change difficulty (${meta.short()})`);
            badgeBtn.addEventListener('click', (ev) => {
              ev.stopPropagation(); // chip click keeps its meld-filter role
              openBotDiffOverlay(p);
            });
          } else {
            // Non-hosts see the difficulty read-only (clearly visible, not tappable).
            badgeBtn.classList.add('readonly');
            badgeBtn.title = L(`Schwierigkeit: ${meta.short()}`, `Difficulty: ${meta.short()}`);
          }
          badgeBtn.setAttribute('aria-label', badgeBtn.title);
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
      bar.textContent = filterOwner.id === playerId
        ? L('Nur deine Auslagen – tippen für alle', 'Only your melds – tap for all')
        : L(
            `Auslagen von ${filterOwner.name} und dir – tippen für alle`,
            `${filterOwner.name}'s melds and yours – tap for all`
          );
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
      // Beim Filtern auf einen MITSPIELER bleiben die eigenen Auslagen
      // sichtbar: Wer entscheidet, was er gefahrlos abwerfen kann, braucht
      // beide Seiten gleichzeitig - was der Nachbar anlegen koennte UND was
      // die eigene Auslage aufnimmt (Nutzer-Report). Filtert man auf sich
      // selbst, bleibt es bei der reinen Eigenansicht.
      const keepMine = meldFilterPlayerId && meldFilterPlayerId !== playerId && owner.id === playerId;
      if (meldFilterPlayerId && owner.id !== meldFilterPlayerId && !keepMine) return;
      const ownerMelds = lastState.tableMelds.filter((m) => m.ownerId === owner.id);
      if (ownerMelds.length === 0) {
        // Hinweis auch fuer die eigene, mitangezeigte (leere) Auslage - sonst
        // waere unklar, ob sie fehlt oder nur leer ist.
        if (meldFilterPlayerId === owner.id || keepMine) {
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
        : L(`<span class="ownerWord">Auslagen von </span>${escapeHtml(owner.name)}${botMark(owner)}`, `${escapeHtml(owner.name)}<span class="ownerWord">'s melds</span>${botMark(owner)}`);
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
        if (isMine && isMyTurn && lastState.turnPhase === 'meld' && layOffAidOn()) {
          // PFLICHTKARTE (gerade vom Ablagestapel genommen): WEDER einfaches
          // ANLEGEN NOCH JOKER-TAUSCH erfüllen die Pflicht noch - der Server
          // lehnt beides ab, weil die Aufnahme durch eine HAND-Kombination
          // gerechtfertigt wurde und genau die jetzt gelegt werden muss
          // (Spieler-Report: Dame durfte nicht einfach an den bestehenden
          // Damen-Drilling angelegt werden; Tischentscheidung danach:
          // dieselbe Umgehung gilt auch für den Tausch). Ein grüner Rahmen
          // an einer BESTEHENDEN Auslage darf die Pflichtkarte deshalb nie
          // mehr markieren - einzig eine neue Kombination (3+ Karten
          // auswählen, "Auslegen") erfüllt sie.
          const isMustCard = singleSelectedCard && lastState.mustLayOffCardId === singleSelectedCard.id;
          // EINE Karte: markieren, sobald mindestens eine Platzierung
          // moeglich ist - auch bei Mehrdeutigkeit. Der Server LEHNT hier
          // naemlich nicht ab, sondern fragt per Auswahldialog nach
          // ("Joker oben oder unten anlegen?", showJokerChoice). Der gruene
          // Rahmen verspricht also nichts Falsches.
          // Der strenge Eindeutigkeits-Test bleibt der MEHRKARTEN-Auswahl
          // vorbehalten - dort weist der Server Mehrdeutiges wirklich zurueck.
          // Vorher blieb ein Joker an jeder FOLGE ungruen (zwei Enden = zwei
          // Ergebnisse), obwohl das Anlegen problemlos funktioniert
          // (Spieler-Report).
          const jokerFits = !isMustCard && singleSelectedCard && singleSelectedCard.isJoker &&
            layOffPlacementCount(meld, singleSelectedCard) >= 1;
          // One card left = it must be discarded: neither lay-off nor joker
          // swap is allowed, so no green frame (false positives are banned).
          const singleFits = !isMustCard && singleSelectedCard && meForHints.hand.length > 1 && cardFitsMeld(meld, singleSelectedCard);
          if (singleFits || jokerFits) {
            group.classList.add('layOffTarget');
          } else if (selectedCardIds.size > 1 && meForHints && meForHints.hand && !selectedCardIds.has(lastState.mustLayOffCardId)) {
            // Mehrfach-Auswahl per Anlegen: ist die Pflichtkarte darunter,
            // würde derselbe Server-Guard greifen - dann gar nicht erst
            // markieren (die Aktion würde ohnehin abgelehnt).
            const sel = meForHints.hand.filter((cd) => selectedCardIds.has(cd.id));
            if (sel.length === selectedCardIds.size && cardsFitMeldTogether(meld, sel)) {
              group.classList.add('layOffTarget');
            }
          }
        }
        if (DND_ENABLED && isMine && isMyTurn && lastState.turnPhase === 'meld') {
          attachDropTarget(group, (cardIds) => layOffToMeld(meld, cardIds));
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
    // Server truth: glow the discard only when taking it is actually legal.
    // `null`/missing (older server, no answer) keeps the old optimistic glow.
    // A Kartenhaus floor without the discard pile shows it blocked even with the aid off.
    const noDiscardFloor = !!(lastState.towerMods && lastState.towerMods.includes('noDiscard'));
    const discardBlocked = (discardAidOn() || noDiscardFloor) && canDraw && !!lastState.discardTop && lastState.discardTakeable === false;
    el('discardPile').classList.toggle('glow', canDraw && !!lastState.discardTop && !discardBlocked);
    el('discardPile').classList.toggle('noTake', discardBlocked);
    try { renderTowerTable(); } catch (e) { /* the floor card never breaks the table */ }

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
      el('handCount').innerHTML = `<svg class="icon" aria-hidden="true"><use href="#i-cards"/></svg><b>${myPlayer.hand.length}</b>`;
      const sorted = myPlayer.hand.slice().sort((a, b) => {
        // ZWEI Joker: stabil nach id sortieren statt 0 zurueckzugeben.
        // '0' heisst "diese beiden sind aus Sortier-Sicht gleich" - deren
        // Platz im Faecher haengt dann von der Sortier-Stabilitaet der
        // JS-Engine ab und kann sich beim naechsten Rendern unterscheiden,
        // besonders sobald zwischen zwei Zuegen eine dritte Karte entfernt
        // oder hinzugefuegt wurde. Zwei optisch identische Joker tauschten
        // dadurch scheinbar Position - fuer den Spieler sah es so aus, als
        // waere EIN Joker ploetzlich "etwas anderes" geworden, dabei stand
        // nur der ANDERE Joker jetzt an seiner Stelle (Spieler-Report).
        if (a.isJoker && b.isJoker) return String(a.id).localeCompare(String(b.id));
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
        if (DND_ENABLED && isMyTurn && lastState.turnPhase === 'meld') attachDragSource(cEl, card);
        // Gerade gezogene/aufgenommene Karte sichtbar machen
        if (freshCardIds.has(card.id)) cEl.classList.add('just-drawn');
        if (towerSpotOn && card.rank === 'Q' && card.suit === 'S') cEl.classList.add('towerSpot');
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
        // Undo a previous two-row pass first (the same cards can be laid out
        // twice when renders overlap) - cards go back to the flat fan.
        const cards = [...handDiv.querySelectorAll('.card')];
        if (handDiv.querySelector('.handRow')) {
          cards.forEach((c) => {
            if (c.dataset.fan !== undefined) c.style.transform = c.dataset.fan;
            handDiv.appendChild(c);
          });
          handDiv.querySelectorAll('.handRow').forEach((r) => r.remove());
        }
        handDiv.classList.remove('handRows');
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
        // Narrow screens (phone portrait): a dense hand goes into TWO rows
        // instead of one 19-26 px strip per card. Every card keeps a ~40 px
        // tap strip and nothing scrolls. The second row overlaps the first
        // one's lower part - only the index corner of row 1 is needed.
        const parentW = handDiv.parentElement.clientWidth;
        const rowLen = Math.ceil(cards.length / 2);
        const rowAvail = parentW - 44;
        const rowVisible = rowLen > 1 ? Math.min(naturalVisible, (rowAvail - cardWidth) / (rowLen - 1)) : naturalVisible;
        const twoRows = parentW > 0 && parentW < 560 && cards.length >= 14 && fitVisible < 24 && rowVisible >= 22;
        if (twoRows) {
          handDiv.classList.remove('handScroll');
          handDiv.classList.add('handRows');
          const rows = [cards.slice(0, rowLen), cards.slice(rowLen)].map((rowCards) => {
            const row = document.createElement('div');
            row.className = 'handRow';
            rowCards.forEach((c, i) => {
              if (c.dataset.fan === undefined) c.dataset.fan = c.style.transform;
              c.style.transform = 'none';
              c.style.marginLeft = i === 0 ? '0' : `${rowVisible - cardWidth}px`;
              row.appendChild(c);
            });
            return row;
          });
          handDiv.append(...rows);
          const cardH = cards[0].offsetHeight || 88;
          rows[1].style.marginTop = `${-(cardH - 46)}px`; // row 1 keeps its top 46 px visible
          return;
        }
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
    // Joker preview: the tap order decides what a joker stands for in a run
    // (server rule), so say it BEFORE 'Auslegen' - on the phone nobody can
    // tell from the fan which card was tapped first.
    let jokerPreview = '';
    if (showMeldControls && meForHints && meForHints.hand) {
      const sel = [...selectedCardIds].map((id) => meForHints.hand.find((cd) => cd.id === id)).filter(Boolean);
      if (sel.length === selectedCardIds.size && sel.some((cd) => cd.isJoker)) {
        const byOrder = jokerRunByOrder(sel);
        if (byOrder) {
          const reals = sel.filter((cd) => !cd.isJoker);
          jokerPreview = sel
            .filter((cd) => cd.isJoker)
            .map((cd) => `Joker = ${byOrder[cd.id]}${suitSymbol(reals[0].suit)}`)
            .join(', ');
          if (reals.every((cd) => cd.rank === reals[0].rank)) {
            jokerPreview += L(' (Folge) - oder ein Satz? Du wirst gefragt.', ' (run) - or a set? You will be asked.');
          }
        }
      }
    }
    el('jokerPreview').textContent = jokerPreview;
    el('jokerPreview').classList.toggle('hidden', !jokerPreview);

    const showDiscardBtn =
      isMyTurn && lastState.turnPhase === 'meld' && selectedCardIds.size === 1 && !lastState.mustLayOffCardId;
    el('discardBtn').classList.toggle('hidden', !showDiscardBtn);

    el('clearSelectionBtn').classList.toggle('hidden', selectedCardIds.size === 0);
    // Mis-tap escape: undo the pile take while the mandatory card is not yet
    // laid (server validates; the flag is only true for me). The button sits
    // on the discard pile, which stays un-dimmed around it via .undoable.
    el('undoPileBtn').classList.toggle('hidden', !lastState.canUndoPileTake);
    el('discardPile').classList.toggle('undoable', !!lastState.canUndoPileTake);
    el('undoMeldBtn').classList.toggle('hidden', !lastState.canUndoMeld);
    // The slot row keeps hidden buttons' space; only drop it when it would
    // be all empty (otherwise a blank 44px row above the hint).
    el('actionSlots').classList.toggle(
      'hidden',
      !showMeldControls && !showDiscardBtn && selectedCardIds.size === 0 && !lastState.canUndoMeld
    );
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

    if (lastState.mustLayOffCardId && isMyTurn && tutorialHintsOn()) {
      clearHintIfNotError(); // the coach card names the combination instead
    } else if (lastState.mustLayOffCardId && isMyTurn) {
      // WICHTIG bleibt persistent sichtbar
      showHint(L('Pflicht: Die aufgenommene Ablagekarte muss zuerst in einer neuen Kombination mit Handkarten ausgelegt werden.', 'Required: the picked-up discard must first be melded in a new combination with hand cards.'), false);
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
        gameTipsEnabled && !tutorialHintsOn() &&
        tipShownForTurn !== turnKey &&
        selectedCardIds.size === 0 &&
        tipSeenCount < TIP_MAX_SHOWS
      ) {
        tipShownForTurn = turnKey;
        tipSeenCount += 1;
        storageSet(TIP_SEEN_KEY, String(tipSeenCount));
        showToast(layOffAidOn()
          ? L('Tipp: 3+ Karten auswählen zum Auslegen, 1 Karte + „Abwerfen“, oder Karte wählen und auf eine grün markierte Auslage tippen.', 'Tip: select 3+ cards to meld, 1 card + "Discard", or select a card and tap a green-highlighted meld.')
          : L('Tipp: 3+ Karten auswählen zum Auslegen, 1 Karte + „Abwerfen“, oder Karte wählen und auf eine deiner Auslagen tippen.', 'Tip: select 3+ cards to meld, 1 card + "Discard", or select a card and tap one of your melds.'));
      }
    } else {
      clearHintIfNotError();
    }

    // Platz sparen: die Action-Leiste komplett einklappen, wenn sie nichts
    // Sichtbares enthaelt (der Aufgeben-Button lebt jetzt ueber der Hand).
    // WICHTIG: erst NACH der Hint-Logik pruefen, sonst zaehlt der alte Text.
    const actionBarEmpty =
      !showMeldControls && !showDiscardBtn && selectedCardIds.size === 0 && !lastState.canUndoMeld &&
      !el('hint').textContent;
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

  // Mirror of Rules.runAssignmentByOrder (server truth, fuzzed against it in
  // test/client-contract.test.js): what each joker becomes when the TAPPED
  // ORDER is read as a run - null when the order spells out no run. Feeds
  // only the preview line; the server decides.
  function jokerRunByOrder(orderedCards) {
    const RING = 13;
    const RANKS_RING = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
    const idx = (r) => RANKS_RING.indexOf(r);
    const cards = orderedCards.slice();
    const reals = cards.filter((c) => !c.isJoker);
    const jokers = cards.filter((c) => c.isJoker);
    if (reals.length === 0 || jokers.length === 0 || cards.length < 3 || cards.length > RING) return null;
    if (!reals.every((c) => c.suit === reals[0].suit)) return null;
    const seen = new Set(reals.map((c) => c.rank));
    if (seen.size !== reals.length) return null;
    if (reals.length >= 2) {
      const a = idx(reals[0].rank);
      const b = idx(reals[1].rank);
      const forward = (((b - a) % RING) + RING) % RING;
      const backward = (((a - b) % RING) + RING) % RING;
      if (forward === 0) return null;
      if (backward < forward) cards.reverse();
    }
    const firstRealPos = cards.findIndex((c) => !c.isJoker);
    const base = idx(cards[firstRealPos].rank) - firstRealPos;
    const out = {};
    for (let i = 0; i < cards.length; i++) {
      const expected = (((base + i) % RING) + RING) % RING;
      if (cards[i].isJoker) out[cards[i].id] = RANKS_RING[expected];
      else if (idx(cards[i].rank) !== expected) return null;
    }
    return out;
  }
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
  /**
   * Wie viele UNTERSCHIEDLICHE Ergebnisse gibt es, diese eine Karte hier
   * anzulegen? 0 = passt nicht, 1 = eindeutig, 2 = mehrdeutig (z. B. Joker
   * an beiden Enden einer Folge). Gedeckelt bei 2, mehr interessiert nicht.
   */
  function layOffPlacementCount(meld, card) {
    const signature = (m) =>
      m.slots
        .map((s) => (s.real ? `${s.real.rank}${s.real.suit}` : `J:${s.representsRank}${s.representsSuit}`))
        .sort()
        .join('|');
    const results = new Set();
    for (const next of layOffOptionsFor({ ...meld, slots: meld.slots.slice() }, card)) {
      results.add(signature(next));
      if (results.size > 1) break;
    }
    return results.size;
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
    if (cardMatchesJokerInMeld(meld, card)) return true;
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
  // Isolierter Joker-Tausch-Test (keine Anlege-Prüfung): wird für die
  // PFLICHTKARTE gebraucht, seit einfaches Anlegen sie nicht mehr entladen
  // darf - siehe cardFitsMeldPureAdd/layOffCard-Kommentar im Server.
  function cardMatchesJokerInMeld(meld, card) {
    return !!card && !card.isJoker &&
      meld.slots.some((s) => s.joker && s.representsRank === card.rank && s.representsSuit === card.suit);
  }

  // Topbar status. On my turn the three steps of a turn, current one marked
  // (the old "(Karte ziehen)" bracket wrapped to two lines on a phone);
  // otherwise who is on turn. Returns markup; names are escaped.
  function turnStatusHtml(st, me) {
    if (st.phase === 'roundEnd') return escapeHtml(L('Runde vorbei', 'Round over'));
    if (st.phase === 'gameOver') return escapeHtml(L('Partie vorbei', 'Game over'));
    const who = (id) => st.players.find((p) => p.id === id) || null;
    if (st.phase === 'cutting') {
      const cutter = who(st.cutterId);
      if (st.cutterId === me) return escapeHtml(L('Du hebst ab', 'Your cut'));
      const name = nameWithHeart(cutter ? cutter.name : '?');
      return `<span class="turnWho">${L(`${name} hebt ab`, `${name} cuts the deck`)}</span>`;
    }
    if (st.currentPlayerId !== me) {
      const cp = who(st.currentPlayerId);
      if (!cp) return '–';
      const name = nameWithHeart(cp.name);
      return `${avatarFor(cp.name, cp.isBot)}<span class="turnWho">${L(`${name} ist dran`, `${name}'s turn`)}</span>`;
    }
    const draw = st.turnPhase === 'draw';
    // Took the discard top: it must be laid before anything else, discarding included.
    const mustLay = !draw && !!st.mustLayOffCardId;
    const steps = [
      [L('Ziehen', 'Draw'), draw ? 'current' : 'done'],
      [L('Legen', 'Meld'), draw ? 'todo' : 'current'],
      [L('Abwerfen', 'Discard'), draw || mustLay ? 'todo' : 'next'],
    ];
    const said = draw ? L('Du bist am Zug: Karte ziehen', 'Your turn: draw a card')
      : mustLay ? L('Du bist am Zug: die aufgenommene Karte legen', 'Your turn: lay the card you took')
        : L('Du bist am Zug: auslegen, anlegen oder abwerfen', 'Your turn: meld, lay off or discard');
    const check = '<svg class="icon" aria-hidden="true"><use href="#i-check"/></svg>';
    const sep = '<svg class="icon turnStepSep" aria-hidden="true"><use href="#i-chevron"/></svg>';
    const html = steps.map(([label, state]) =>
      `<span class="turnStep ${state}">${state === 'done' ? check : ''}<span class="turnStepLabel">${label}</span></span>`).join(sep);
    return `<span class="turnSteps" aria-hidden="true">${html}</span><span class="visuallyHidden">${said}</span>`;
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

  // --- Victory celebrations (game/Celebrations.js) ---------------------------
  // A band at the top of a card, drawn behind its text: it never takes a tap
  // and is gone after a few seconds. Reduced motion gets a still picture.
  const CELEBRATION_MS = 3400;
  const FX_COLORS = ['#2fd6b0', '#8f90f8', '#ff9f5a', '#ff7d8c', '#f5d76e'];
  const CAT_FURS = ['#e8913a', '#9aa0a6', '#3a3a3a', '#f3ece2'];
  /** The special celebration the whole table sees, or null (none, bot, forfeit). */
  function winnerCelebration(st) {
    const over = st.phase === 'gameOver' ? st.gameOverInfo : null;
    if (over && over.forfeited) return null;
    const winnerId = (over && over.winnerId) || st.lastRoundWinnerId;
    const seat = winnerId ? (st.players || []).find((p) => p.id === winnerId) : null;
    const id = seat && !seat.isBot ? seat.celebration : null;
    return id && id !== 'standard' && CELEBRATIONS.some((c) => c.id === id) ? id : null;
  }
  function fxCatSvg(fur) {
    const eye = fur === '#3a3a3a' ? '#f6d36b' : '#2b2b2b';
    return `<svg viewBox="-17 -23 34 32" aria-hidden="true"><path d="M-14-6-11-21-2-10Z M14-6 11-21 2-10Z" fill="${fur}"/>` +
      `<ellipse rx="15" ry="12.5" fill="${fur}" stroke="rgba(0,0,0,0.35)"/>` +
      `<ellipse cx="-5.5" cy="-1.5" rx="2.2" ry="2.9" fill="${eye}"/><ellipse cx="5.5" cy="-1.5" rx="2.2" ry="2.9" fill="${eye}"/>` +
      '<path d="M-1.6 3.4h3.2l-1.6 1.8z" fill="#e57b8c"/></svg>';
  }
  function celebrationMarkup(id, still) {
    const r = (a, b) => (a + Math.random() * (b - a)).toFixed(2);
    const pick = (arr, i) => arr[i % arr.length];
    let html = '';
    if (id === 'cats') {
      const n = still ? 5 : 16;
      for (let i = 0; i < n; i++) {
        const x = still ? 46 + i * 10 : r(2, 92); // still: a row right of the title
        html += `<span class="fxCat" style="--x:${x}%;--sz:${r(24, 34)}px;--delay:${r(0, 1.8)}s;--dur:${r(1.4, 2.2)}s;` +
          `--spin:${r(-200, 200)}deg;--drift:${r(-30, 30)}px;--tilt:${r(-14, 14)}deg">${fxCatSvg(pick(CAT_FURS, i))}</span>`;
      }
    } else if (id === 'fireworks') {
      const bursts = still ? [[56, 36], [74, 56], [88, 32]] : [[18, 48], [50, 34], [82, 50], [34, 62], [66, 40]];
      bursts.forEach(([x, y], b) => {
        let sparks = '';
        for (let i = 0; i < 12; i++) sparks += `<i style="--a:${i * 30}deg;--c:${pick(FX_COLORS, b + i)}"></i>`;
        html += `<span class="fxBurst" style="--x:${x}%;--y:${y}%;--delay:${(b * 0.45).toFixed(2)}s">${sparks}</span>`;
      });
    } else if (id === 'cardfan') {
      [['A', '♠'], ['K', '♥'], ['Q', '♠'], ['J', '♦'], ['10', '♣']].forEach(([rank, suit], i) => {
        const red = suit === '♥' || suit === '♦';
        html += `<span class="fxCard${red ? ' red' : ''}" style="--r:${(i - 2) * 16}deg;--i:${i}"><b>${rank}</b><em>${suit}</em></span>`;
      });
    } else if (id === 'goldqueen') {
      for (let i = 0; i < 12; i++) {
        html += `<i class="fxGlint" style="--x:${r(8, 92)}%;--y:${r(10, 85)}%;--delay:${r(0.4, 2.2)}s;--sz:${r(6, 12)}px"></i>`;
      }
      html += '<span class="fxQueen"><svg class="icon fxCrown" aria-hidden="true"><use href="#i-crown"/></svg><b>Q</b><em>♠</em></span>';
    } else {
      // 'standard' in the preview: the confetti the winner sees, in small.
      for (let i = 0; i < 26; i++) {
        html += `<i class="fxBit" style="--x:${r(2, 98)}%;--c:${pick(FX_COLORS, i)};--delay:${r(0, 1.4)}s;--dur:${r(1.1, 1.8)}s;--spin:${r(-300, 300)}deg"></i>`;
      }
    }
    return html;
  }
  function playCelebration(id, host) {
    if (!host || !CELEBRATIONS.some((c) => c.id === id)) return;
    const old = [...host.children].find((c) => c.classList.contains('celebrationBand'));
    if (old) old.remove();
    const still = reducedMotion;
    const band = document.createElement('div');
    band.className = `celebrationBand fx-${id}${still ? ' still' : ''}`;
    band.setAttribute('aria-hidden', 'true');
    band.innerHTML = celebrationMarkup(id, still);
    host.prepend(band);
    host.classList.add('celebrating');
    setTimeout(() => {
      band.remove();
      if (![...host.children].some((c) => c.classList.contains('celebrationBand'))) host.classList.remove('celebrating');
    }, still ? 2400 : CELEBRATION_MS);
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

  // Seat order is lastState.players as sent; 'points' keeps the caller's ranking.
  function orderResultPlayers(byPoints) {
    const players = lastState.players.slice();
    return resultSortMode === 'seat' ? players : players.sort(byPoints);
  }
  function buildResultSortControl(onChange) {
    const wrap = document.createElement('div');
    wrap.className = 'resultSort';
    wrap.setAttribute('role', 'group');
    wrap.setAttribute('aria-label', L('Sortierung', 'Sort order'));
    const btns = [['points', L('Punkte', 'Points')], ['seat', L('Reihenfolge', 'Seat order')]].map(([mode, label]) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'resultSortBtn';
      b.dataset.mode = mode;
      b.textContent = label;
      b.addEventListener('click', () => {
        if (resultSortMode === mode) return;
        resultSortMode = mode;
        storageSet(RESULT_SORT_KEY, mode);
        sync();
        onChange();
      });
      return b;
    });
    const sync = () => btns.forEach((b) => {
      const on = b.dataset.mode === resultSortMode;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    sync();
    wrap.append(...btns);
    return wrap;
  }

  function renderResultOverlay() {
    const forfeited = lastState.phase === 'gameOver' && lastState.gameOverInfo && lastState.gameOverInfo.forfeited;
    if (!lastState.lastRoundResult && !forfeited) return;
    el('resultOverlay').classList.remove('hidden');
    // Once per round: the winner's own celebration for the whole table,
    // otherwise the classic confetti for the winner alone.
    const winKey = `${lastState.roundNumber}`;
    const myResult = lastState.lastRoundResult && lastState.lastRoundResult[playerId];
    if (confettiShownForRound !== winKey) {
      const fx = winnerCelebration(lastState);
      if (fx) {
        confettiShownForRound = winKey;
        playCelebration(fx, el('resultOverlay').querySelector('.overlay-card'));
      } else if (myResult && myResult.breakdown && myResult.breakdown.isWinner) {
        confettiShownForRound = winKey;
        launchConfetti();
      }
    }
    const isGameOver = lastState.phase === 'gameOver';
    el('resultOverlay').classList.toggle('isFinal', isGameOver); // desktop: two columns
    el('resultTitle').textContent = forfeited
      ? L('Spiel aufgegeben', 'Game forfeited')
      : isGameOver && lastState.towerStage ? `${towerName()} · ${L(`Etage ${lastState.towerStage}`, `floor ${lastState.towerStage}`)}`
        : isGameOver ? L('Spielende!', 'Game over!') : L('Rundenende', 'End of round');

    const body = el('resultBody');
    body.innerHTML = '';

    // Zwei Reiter: „Ergebnis“ (Standard) und „Statistik“ (Detail-Tabelle,
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
      // The panes differ in height, so the fade edge must follow the swap.
      updateResultScrollEdges();
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
      const fList = document.createElement('div');
      const fillForfeit = () => {
        fList.innerHTML = '';
        orderResultPlayers((a, b) => (fTotals[b.id] || 0) - (fTotals[a.id] || 0)).forEach((p) => {
          const row = document.createElement('div');
          row.className = 'resultRow';
          row.innerHTML = `<span>${nameWithHeart(p.name)}${botMark(p)}</span><span>${L('Gesamt', 'Total')}: ${fTotals[p.id] || 0}</span>`;
          fList.appendChild(row);
        });
      };
      fillForfeit();
      paneResult.append(buildResultSortControl(fillForfeit), fList);
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

      // Round end: the delta leads, the total is context. Game over: the
      // standing is the result, so total and rank lead, the delta recedes.
      const list = document.createElement('div');
      list.className = 'resultList' + (isGameOver ? ' isFinal' : '');
      // EVERY player stays in the list, the winner included: a 4-player game
      // showing three rows read as a missing player (report).
      const deltaOf = (pl) => (lastState.lastRoundResult[pl.id] ? lastState.lastRoundResult[pl.id].roundScore : 0);
      const totalOf = (pl) => lastState.totals[pl.id] || 0;
      // One scale for every bar. Round end: up to the 1000 goal (tick marks
      // it). Game over: the goal is reached, bars only compare the players,
      // so the scale is the best total and there is no tick (read as a
      // per-player marker).
      const scaleMax = Math.max(isGameOver ? 1 : SCORE_TARGET, ...lastState.players.map((pl) => Math.max(totalOf(pl), totalOf(pl) - deltaOf(pl))));
      const pctOf = (v) => Math.max(0, Math.min(100, (v / scaleMax) * 100));
      // Points order by default; the viewer may switch to seat order (#322).
      const fillList = () => {
        list.innerHTML = '';
        orderResultPlayers((a, b) => (isGameOver
          ? totalOf(b) - totalOf(a)
          : deltaOf(b) - deltaOf(a) || totalOf(b) - totalOf(a)))
          .forEach((p) => {
            const r = lastState.lastRoundResult[p.id];
            const total = totalOf(p);
            const delta = r ? r.roundScore : 0;
            const prev = total - delta;
            const row = document.createElement('div');
            row.className = 'resultRow' + (r && r.breakdown.isWinner ? ' winner' : '') +
              (p.id === playerId ? ' isMe' : '');
            // Colour = sign only (green on a -170 read as "well done").
            const deltaCls = delta > 0 ? ' pos' : delta < 0 ? ' neg' : '';
            const rank = 1 + lastState.players.filter((o) => totalOf(o) > total).length;
            const lo = pctOf(Math.min(prev, total));
            const hi = pctOf(Math.max(prev, total));
            // Solid = where the player stood, ghost = what this round moved.
            const bar =
              `<div class="resultRowBar" style="--pc:${playerColor(p.id)}">` +
              `<i class="barSolid" style="width:${delta >= 0 ? pctOf(prev) : lo}%"></i>` +
              (hi > lo ? `<i class="barGhost ${delta >= 0 ? 'gain' : 'loss'}" style="left:${lo}%;width:${hi - lo}%"></i>` : '') +
              (isGameOver ? '' : `<span class="barGoal" style="left:${pctOf(SCORE_TARGET)}%"></span>`) +
              `</div>`;
            row.innerHTML = isGameOver
              ? `<div class="resultRowTop">` +
                `<span class="resultRank">${rank}.</span>` +
                `<span class="resultName">${nameWithHeart(p.name)}${botMark(p)}</span>` +
                `<span class="resultDelta resultDeltaSmall${deltaCls}">${fmtSigned(delta)}</span>` +
                `<span class="resultTotal resultTotalBig">${fmtNum(total)}</span>` +
                `</div>` + bar
              : `<div class="resultRowTop">` +
                `<span class="resultName">${nameWithHeart(p.name)}${botMark(p)}</span>` +
                `<span class="resultTotal">${L('gesamt', 'total')} ${fmtNum(total)}</span>` +
                `<span class="resultDelta${deltaCls}">${fmtSigned(delta)}</span>` +
                `</div>` + bar;
            // Per-card breakdown: MY row only (an opponent's leftover hand is
            // not even sent), and not at game over - the match is decided then.
            const stats = p.id === playerId && !isGameOver ? (lastState.lastRoundStats || []).find((s) => s.id === p.id) : null;
            if (stats && (stats.laidLines || stats.handLines)) {
              const det = document.createElement('details');
              det.className = 'resultBreakdown';
              // Folded: four rows must fit on a phone. The summary carries the
              // two sums, the per-card lines open on tap.
              det.open = false;
              const lineText = (ln) => {
                const label = {
                  pikdame: '♠Q', joker: L('Joker', 'Joker'), ace: L('Ass', 'Ace'),
                  face: L('10/B/D/K', '10/J/Q/K'), low: '2–9',
                }[ln.kind] || ln.kind;
                return `${ln.count > 1 ? `${ln.count}×${NBSP}` : ''}${label} ${ln.points}`;
              };
              const plus = (stats.laidLines || []).map(lineText).join(', ');
              const minus = (stats.handLines || []).map(lineText).join(', ');
              const plusSum = (stats.laidLines || []).reduce((a, ln) => a + ln.points, 0);
              const minusSum = (stats.handLines || []).reduce((a, ln) => a + ln.points, 0);
              const isWinner = !!(r && r.breakdown && r.breakdown.isWinner);
              const mult = r && r.breakdown && r.breakdown.multiplier > 1 ? r.breakdown.multiplier : 1;
              det.innerHTML =
                `<summary><span>${L('Aufschlüsselung', 'Breakdown')}</span><svg class="icon" aria-hidden="true"><use href="#i-chevron"/></svg> <span class="bdSums"><span class="bdSumPlus">+${fmtNum(plusSum)}</span>${isWinner ? '' : ` <span class="bdSumMinus">${MINUS}${fmtNum(minusSum)}</span>`}</span></summary>` +
                `<div class="bdLine bdPlus"><span>${L('Ausgelegt', 'Melded')}</span><span>${plus ? escapeHtml(plus) : '–'}</span><b>+${fmtNum(plusSum)}</b></div>` +
                (isWinner
                  ? `<div class="bdLine bdNote"><span>${L('Rundensieg: keine Minuspunkte', 'Round winner: no minus points')}</span><span></span><b></b></div>`
                  : `<div class="bdLine bdMinus"><span>${L('Auf der Hand', 'In hand')}</span><span>${minus ? escapeHtml(minus) : '–'}</span><b>${MINUS}${fmtNum(minusSum)}</b></div>`) +
                (mult > 1 ? `<div class="bdLine bdNote"><span>${L(`Hand aus: ×${mult}`, `Out in one: ×${mult}`)}</span><span></span><b></b></div>` : '');
              row.appendChild(det);
            }
            list.appendChild(row);
          });
      };
      fillList();
      paneResult.append(buildResultSortControl(() => { fillList(); updateResultScrollEdges(); }), list);
    }

    // Round details: four numeric columns, right-aligned. Melded ♠Q/jokers
    // are rare, so they ride as marks on the name instead of zero columns.
    if (!forfeited && lastState.lastRoundStats) {
      const statsTable = document.createElement('table');
      statsTable.className = 'statsTable';
      const marks = (s) =>
        (s.pikDameLaidOut ? `<span class="statMark" title="${L('Pik Dame ausgelegt', 'Queen of Spades melded')}">♠Q${s.pikDameLaidOut > 1 ? `×${s.pikDameLaidOut}` : ''}</span>` : '') +
        (s.jokersLaidOut ? `<span class="statMark" title="${L('Joker ausgelegt', 'Jokers melded')}">${JOKER_MARK_SVG}${s.jokersLaidOut > 1 ? `×${s.jokersLaidOut}` : ''}</span>` : '');
      // Own row = edge line + bold (.isMe), round winner = check chip: the two
      // used to share one green row and read as the same thing.
      const winMark = `<span class="winChip" title="${L('Rundensieg', 'Round win')}">${iconHtml('check')}<span>${L('Sieg', 'Win')}</span></span>`;
      statsTable.innerHTML = `
        <thead><tr><th>${L('Spieler', 'Player')}</th><th>${L('Runde', 'Round')}</th><th>${L('Ausgelegt', 'Melded')}</th><th>${L('Hand', 'Hand')}</th></tr></thead>
        <tbody>${lastState.lastRoundStats
          .map((s) => {
            const r = lastState.lastRoundResult && lastState.lastRoundResult[s.id];
            const delta = r ? r.roundScore : null;
            const deltaCell = delta === null
              ? '–'
              : `<span class="${delta > 0 ? 'deltaUp' : delta < 0 ? 'deltaDown' : ''}">${delta === 0 ? '±0' : fmtSigned(delta)}</span>`;
            const win = s.id === lastState.lastRoundWinnerId;
            return `<tr${s.id === playerId ? ' class="isMe"' : ''}><td><span class="statName">${escapeHtml(s.name)}</span>${marks(s)}${win ? winMark : ''}</td><td>${deltaCell}</td><td>${s.laidOutCount}</td><td>${s.handCount}</td></tr>`;
          })
          .join('')}</tbody>`;
      paneStats.appendChild(statsTable);
    }

    // Punkteverlauf über alle Runden als kleines SVG-Chart (ab 2 Runden)
    // At game over the chart IS the story of the match: on the result pane.
    const history = lastState.scoreHistory || [];
    const chart = history.length >= 2 ? renderScoreChart(history) : null;
    if (chart && !isGameOver) paneStats.appendChild(chart);

    if (isGameOver && !forfeited && lastState.gameOverInfo) {
      const winner = lastState.players.find((p) => p.id === lastState.gameOverInfo.winnerId);
      // The match winner belongs at the TOP. It used to be a line of body text
      // below four score rows - the single most important sentence on the
      // screen, and you had to read past everything else to reach it.
      const iWon = !!winner && winner.id === playerId;
      // One line, no score: the total is in the list right below. The trophy
      // (not the round's crown) marks the match; my own win gets the gold banner.
      const head = document.createElement('div');
      head.className = 'resultWinner resultWinnerGame' + (iWon ? ' isMe' : '');
      head.innerHTML =
        `<span class="resultWinnerTrophy">${TROPHY_MARK_SVG}</span>` +
        (iWon ? '' : `<span class="resultWinnerName">${nameWithHeart(winner ? winner.name : '?')}${winner ? botMark(winner) : ''}</span>`) +
        `<span class="resultWinnerSub">${
          lastState.towerStage
            ? iWon ? L('Du schaffst die Etage!', 'You clear the floor!') : L('hält dich auf dieser Etage', 'holds you on this floor')
            : iWon
              ? L('Du gewinnst die Partie!', 'You win the match!')
              : L('gewinnt die Partie', 'wins the match')
        }</span>`;
      paneResult.insertBefore(head, paneResult.firstChild);
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
              kind: 'bad', swing: `${MINUS}100`,
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
              kind: 'good', swing: fmtSigned(h.score),
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
      if (chart) paneResult.insertBefore(chart, paneResult.querySelector('.matchMoments'));
      // Small facts of the match: chips, not three loose lines of prose.
      const gi = lastState.gameOverInfo;
      const facts = [];
      if (typeof gi.totalTurns === 'number') {
        const rounds = gi.totalRounds || 0;
        facts.push(`<b>${fmtNum(gi.totalTurns)}</b>${NBSP}${unitWord(gi.totalTurns, 'turn')}`);
        facts.push(`<b>${fmtNum(rounds)}</b>${NBSP}${unitWord(rounds, 'round')}`);
      }
      const ft = gi.funTitle;
      if (ft && ft.type === 'queenMagnet') {
        facts.push(L(
          `Damen-Magnet: <b>${escapeHtml(ft.name)}</b> (${ft.count}×)`,
          `Queen magnet: <b>${escapeHtml(ft.name)}</b> (${ft.count}×)`
        ));
      }
      if (facts.length) {
        const box = document.createElement('div');
        box.className = 'matchFacts';
        box.innerHTML = `<h4>${L('Partie in Zahlen', 'Match in numbers')}</h4>` +
          facts.map((f) => `<span class="factChip">${f}</span>`).join('');
        paneResult.appendChild(box);
      }
    }

    if (isGameOver && stammtischInfo && stammtischSummary && stammtischSummary.series) {
      const box = document.createElement('div');
      box.className = 'resultSeries';
      box.innerHTML = seriesLineHtml(stammtischSummary);
      paneResult.appendChild(box);
    }
    el('exportGameBtn').classList.toggle('hidden', !(isGameOver && lastState.hasExportableGame));
    el('replayBtn').classList.toggle('hidden', !(isGameOver && lastState.hasExportableGame));
    if (isGameOver) renderChallengeBoard();
    if (isGameOver) renderTowerResult();
    // Toggleable game totals: how many Queens of Spades / jokers each
    // player melded across the WHOLE game.
    const oldTotals = el('resultBody').querySelector('.gameTotalsBox');
    if (oldTotals) oldTotals.remove();
    if (isGameOver && lastState.gameStatsTotals && Object.keys(lastState.gameStatsTotals).length > 0) {
      const box = document.createElement('div');
      box.className = 'gameTotalsBox';
      const tBtn = document.createElement('button');
      tBtn.className = 'btn-secondary';
      const totalsLabel = (hidden) => (lang === 'en'
        ? `<span>${hidden ? 'Show' : 'Hide'} game totals ♠Q &amp;</span> ${JOKER_MARK_SVG}`
        : `<span>♠Q &amp;</span> ${JOKER_MARK_SVG} <span>${hidden ? 'der Partie anzeigen' : 'ausblenden'}</span>`);
      tBtn.innerHTML = totalsLabel(true);
      const tbl = document.createElement('table');
      tbl.className = 'statsTable hidden';
      const rows = (lastState.players || [])
        .map((p) => ({ name: p.name, t: lastState.gameStatsTotals[p.id] || { pikDames: 0, jokers: 0 } }))
        .sort((a, b) => b.t.pikDames - a.t.pikDames || b.t.jokers - a.t.jokers)
        .map((r) => `<tr><td>${escapeHtml(r.name)}</td><td>${r.t.pikDames > 0 ? '♠'.repeat(r.t.pikDames) : '–'}</td><td>${r.t.jokers > 0 ? `<span class="statMark">${JOKER_MARK_SVG}×${r.t.jokers}</span>` : '–'}</td></tr>`)
        .join('');
      tbl.innerHTML = `<thead><tr><th>${L('Spieler', 'Player')}</th><th>${L('♠Q ausgelegt', '♠Q melded')}</th><th><span class="statMark">${JOKER_MARK_SVG}</span> <span>${L('ausgelegt', 'melded')}</span></th></tr></thead><tbody>${rows}</tbody>`;
      tBtn.addEventListener('click', () => {
        const nowHidden = tbl.classList.toggle('hidden');
        tBtn.innerHTML = totalsLabel(nowHidden);
      });
      box.appendChild(tBtn);
      box.appendChild(tbl);
      paneStats.appendChild(box);
    }
    // Frisch verdiente Erfolge feiern (kommen per Server-Nachricht)
    const oldBadgeBox = el('resultBody').querySelector('.badgeBox');
    if (oldBadgeBox) oldBadgeBox.remove();
    const stripShown = renderResultMe(isGameOver && !forfeited);
    const mySeat = (lastState.players || []).find((p) => p.id === playerId);
    const myName = String((mySeat && mySeat.name) || '').toLowerCase();
    // Mine are chips in the result strip; the box keeps the table's other badges.
    const tableBadges = (lastEarnedBadges || []).filter((e) => !stripShown || String(e.name || '').toLowerCase() !== myName);
    if (isGameOver && tableBadges.length > 0) {
      const box = document.createElement('div');
      box.className = 'badgeBox';
      box.innerHTML = `<h3>${iconHtml('medal')}<span>${L('Neue Erfolge', 'New achievements')}</span></h3>`;
      for (const entry of tableBadges) {
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
    // At game over the way home sits next to the rematch; unfolding "Mehr"
    // instead pushed half the ranking below the fold.
    el('resultHomeBtn').classList.toggle('hidden', isGameOver);
    el('resultHomeQuickBtn').classList.toggle('hidden', !isGameOver || !!lastState.challengeDate);
    const moreBox = el('resultMore');
    if (moreBox) moreBox.open = false;
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
      // Challenge: one attempt per day, so the primary action leads home.
      const ser = stammtischInfo && stammtischSummary && stammtischSummary.series;
      contBtn.textContent = lastState.challengeDate
        ? L('Zum Hauptmenü', 'Main menu')
        : lastState.towerStage
          ? L('Zum Kartenhaus', 'To the House of Cards')
          : ser
          ? ser.winner
            ? L('Neue Serie starten', 'Start a new series')
            : L(`Revanche (Spiel ${ser.games + 1} von ${ser.bestOf})`, `Rematch (game ${ser.games + 1} of ${ser.bestOf})`)
          : L('Neue Partie (Rematch)', 'New game (rematch)');
    } else {
      const humans = (lastState.players || []).filter((p) => !p.isBot && p.connected);
      const ready = new Set(lastState.nextRoundReady || []);
      const iAmReady = ready.has(playerId);
      contBtn.disabled = iAmReady;
      if (humans.length <= 1) {
        // Tutorial: this button leads to "Tutorial geschafft", not to round 2.
        contBtn.textContent = tutorialHintsOn() ? L('Weiter', 'Continue') : L('Nächste Runde', 'Next round');
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

  // Own result first (game over): place and gap, XP with the level bar, then
  // chips for what is new. Pinned above "Neue Partie"; landscape/desktop: right column.
  function renderResultMe(isFinal) {
    const box = el('resultMe');
    if (!box) return false;
    const me = isFinal && lastState && !lastState.towerStage
      ? (lastState.players || []).find((p) => p.id === playerId && !p.isBot)
      : null;
    if (!me) {
      box.classList.add('hidden');
      box.innerHTML = '';
      return false;
    }
    const totalOf = (p) => (lastState.totals && lastState.totals[p.id]) || 0;
    const myTotal = totalOf(me);
    const ranked = lastState.players.slice().sort((a, b) => totalOf(b) - totalOf(a));
    const place = 1 + lastState.players.filter((o) => totalOf(o) > myTotal).length;
    const rival = place === 1 ? ranked.find((p) => p.id !== me.id) : ranked[0];
    const gap = rival ? Math.abs(myTotal - totalOf(rival)) : 0;
    const rn = rival ? escapeHtml(rival.name) : '';
    const gapText = !rival ? ''
      : gap === 0 ? L(`gleichauf mit ${rn}`, `level with ${rn}`)
        : place === 1 ? L(`${fmtNum(gap)} vor ${rn}`, `${fmtNum(gap)} ahead of ${rn}`)
          : L(`${fmtNum(gap)} hinter ${rn}`, `${fmtNum(gap)} behind ${rn}`);
    const gp = lastGameProgress;
    const xp = gp && gp.gainedXp > 0
      ? `<span class="rmXp">+${fmtNum(gp.gainedXp)} ${L('EP', 'XP')}${gp.welcomeBack ? ' (×2)' : ''}</span>`
      : '';
    // Level bar: solid = before this match, green = what it brought (from 0 after a level-up).
    let level = '';
    if (gp && myProgress && typeof myProgress.xp === 'number') {
      const now = levelFromXpClient(myProgress.xp);
      const before = levelFromXpClient(myProgress.xp - (gp.gainedXp || 0));
      const pct = (lv) => Math.round((lv.into / lv.need) * 100);
      const from = before.level === now.level ? pct(before) : 0;
      const to = pct(now);
      level = `<div class="rmLevel"><span class="rmLv">${L('Stufe', 'Level')} ${now.level}</span>` +
        `<span class="rmBar" role="img" aria-label="${escapeHtml(L(`${now.into} von ${now.need} EP zur nächsten Stufe`, `${now.into} of ${now.need} XP to the next level`))}">` +
        `<i class="rmOld" style="width:${from}%"></i><i class="rmGain" style="left:${from}%;width:${Math.max(0, to - from)}%"></i></span>` +
        `<span class="rmNext">${L(`noch ${fmtNum(now.need - now.into)} EP`, `${fmtNum(now.need - now.into)} XP to go`)}</span></div>`;
    }
    const chips = [];
    const myName = String(me.name || '').toLowerCase();
    for (const entry of lastEarnedBadges || []) {
      if (String(entry.name || '').toLowerCase() !== myName) continue;
      for (const id of entry.badges || []) {
        const m = badgeMeta(id);
        // The emoji IS the badge (content, as in the trophy cabinet), not an icon.
        chips.push(`<span class="rmChip isNew" title="${escapeHtml(m.desc)}"><span class="rmChipEmoji" aria-hidden="true">${m.emoji}</span><span>${L('Neu', 'New')}: ${escapeHtml(m.name)}</span></span>`);
      }
    }
    const cb = lastChallengeBoard;
    if (lastState.challengeDate && cb && cb.date === lastState.challengeDate && cb.yourRank) {
      chips.push(`<span class="rmChip"><svg class="icon" aria-hidden="true"><use href="#i-podium"/></svg><span>${L(`Tages-Challenge: Platz ${cb.yourRank}`, `Daily challenge: rank ${cb.yourRank}`)}</span></span>`);
    }
    const st = gp && gp.streak;
    if (st && (st.event === 'extended' || st.event === 'bridged') && st.streak >= 2) {
      chips.push(`<span class="rmChip"><svg class="icon" aria-hidden="true"><use href="#i-flame"/></svg><span>${L(`${st.streak} Tage in Folge`, `${st.streak} days in a row`)}</span></span>`);
    }
    if (gp && gp.seasonRank) {
      chips.push(`<span class="rmChip"><svg class="icon" aria-hidden="true"><use href="#i-trend"/></svg><span>${L(`Saison: Platz ${gp.seasonRank}`, `Season: rank ${gp.seasonRank}`)}</span></span>`);
    }
    if (gp && gp.record && gp.record.played > 0) {
      const r = gp.record;
      chips.push(`<span class="rmChip" title="${escapeHtml(L(`${r.won} Siege in ${r.played} Partien`, `${r.won} wins in ${r.played} games`))}"><span>${L(`Bilanz ${r.won}/${r.played}`, `Record ${r.won}/${r.played}`)}</span></span>`);
    }
    box.innerHTML =
      `<div class="rmTop"><span class="rmPlace">${L(`Platz ${place} von ${lastState.players.length}`, `Place ${place} of ${lastState.players.length}`)}</span>` +
      (gapText ? `<span class="rmGap">· ${gapText}</span>` : '') + xp + `</div>` +
      level +
      (chips.length ? `<div class="rmChips">${chips.join('')}</div>` : '');
    box.classList.remove('hidden');
    return true;
  }

  function updateResultScrollEdges() {
    const b = el('resultBody');
    if (!b) return;
    b.classList.toggle('canScrollDown', b.scrollHeight - b.clientHeight - b.scrollTop > 8);
  }
  el('resultBody').addEventListener('scroll', updateResultScrollEdges, { passive: true });
  // The body can start overflowing without any scroll: unfolding "Mehr" in
  // the pinned footer shrinks it (on a phone that pushed the winner's row out
  // of view with no fade), and so does rotating or resizing the viewport.
  el('resultMore').addEventListener('toggle', updateResultScrollEdges);
  // Reactions live behind a button: the 15-emote bar used to take three
  // rows of a card that is mainly about the scores.
  el('resultEmoteToggle').addEventListener('click', () => {
    const bar = el('resultEmoteBar');
    const show = bar.classList.contains('hidden');
    if (show) arrangeEmoteBar(bar);
    bar.classList.toggle('hidden', !show);
    el('resultEmoteToggle').setAttribute('aria-expanded', String(show));
    updateResultScrollEdges();
  });
  if (typeof ResizeObserver === 'function') {
    new ResizeObserver(() => updateResultScrollEdges()).observe(el('resultBody'));
  }

  // --- Interaktion ---------------------------------------------------------

  // --- Desktop drag-and-drop ------------------------------------------------
  // Mouse users drag a hand card onto one of their melds (lay-off / joker
  // swap) or onto the discard pile. Phones keep tap-to-target: HTML5 drag
  // needs a fine pointer, and the fan is a scroll surface there.
  const DND_ENABLED = !!(window.matchMedia && window.matchMedia('(hover: hover) and (pointer: fine)').matches);
  let dragCardId = null;
  function attachDragSource(cEl, card) {
    cEl.draggable = true;
    cEl.addEventListener('dragstart', (ev) => {
      dragCardId = card.id;
      try {
        ev.dataTransfer.setData('text/plain', String(card.id));
        ev.dataTransfer.effectAllowed = 'move';
      } catch (e) { /* jsdom & co. */ }
      cEl.classList.add('dragging');
      document.body.classList.add('dndActive');
    });
    cEl.addEventListener('dragend', () => {
      cEl.classList.remove('dragging');
      document.body.classList.remove('dndActive');
      document.querySelectorAll('.dropHover').forEach((n) => n.classList.remove('dropHover'));
      dragCardId = null;
    });
  }
  // The dragged card plus the rest of the selection when it is part of it -
  // so a three-card lay-off is one drag, like it is one tap.
  function draggedCardIds() {
    if (!dragCardId) return [];
    return selectedCardIds.has(dragCardId) && selectedCardIds.size > 1 ? [...selectedCardIds] : [dragCardId];
  }
  function attachDropTarget(node, onDrop) {
    node.addEventListener('dragover', (ev) => {
      if (!dragCardId) return;
      ev.preventDefault();
      try { ev.dataTransfer.dropEffect = 'move'; } catch (e) { /* ignore */ }
      node.classList.add('dropHover');
    });
    node.addEventListener('dragleave', () => node.classList.remove('dropHover'));
    node.addEventListener('drop', (ev) => {
      ev.preventDefault();
      node.classList.remove('dropHover');
      const ids = draggedCardIds();
      if (ids.length) onDrop(ids);
    });
  }
  // The discard pile takes exactly one card - the dragged one, whatever
  // else is selected (a discard is never a batch).
  if (DND_ENABLED) {
    attachDropTarget(el('discardPile'), () => {
      if (!lastState || lastState.currentPlayerId !== playerId || lastState.turnPhase !== 'meld') return;
      if (dragCardId) requestDiscard(dragCardId);
    });
  }

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
    layOffToMeld(meld, [...selectedCardIds]);
  }

  // Lay one or several hand cards onto one of MY melds. Tap-to-target and
  // desktop drag-and-drop both end up here.
  function layOffToMeld(meld, cardIds) {
    if (cardIds.length === 1) {
      const cardId = cardIds[0];
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
    } else if (cardIds.length > 1) {
      // Multiple cards: lay them all off in one tap (server validates
      // all-or-nothing and finds the working order, e.g. J before Q).
      send({ type: 'layOffMulti', meldId: meld.id, cardIds });
    } else {
      showHint(L('Wähle mindestens eine Handkarte aus, um sie an diese Auslage anzulegen (mehrere passende Karten gehen mit einem Tipp).', 'Select at least one hand card to add it to this meld (several fitting cards go in one tap).'), false);
    }
  }

  el('nameInput').value = myName;
  if (sessionCode) el('codeInput').value = sessionCode;

  // Identity chip: a returning player sees avatar + name; a tap swaps in the
  // input. First-time players (no stored name) get the input straight away.
  // In a session both stay hidden; the name is set on the start screen.
  let editingName = false;
  // accountUsername is declared further down; the first render runs before
  // that line, where touching it would throw (temporal dead zone).
  function signedInName() {
    try { return accountUsername || null; } catch (e) { return null; }
  }
  function renderIdentity() {
    const inSession = !!sessionCode && !!playerId;
    const account = signedInName();
    const locked = !!account;
    const name = locked ? account : myName;
    const showInput = editingName || (!inSession && !name);
    el('nameInput').classList.toggle('hidden', !showInput);
    const chip = el('identityChip');
    chip.classList.toggle('hidden', showInput || inSession || !name);
    chip.classList.toggle('locked', locked);
    const nameBtn = el('identityNameBtn');
    nameBtn.disabled = locked;
    nameBtn.title = locked
      ? L('Name ist durch dein Konto festgelegt', 'Name is fixed by your account')
      : L('Namen ändern', 'Change name');
    if (name) {
      el('identityAvatar').innerHTML = avatarFor(name, false);
      el('identityName').textContent = name;
      try { renderIdentityProgress(); } catch (e) { /* cosmetic */ }
    }
  }
  function startNameEdit() {
    if (signedInName()) return;
    editingName = true;
    renderIdentity();
    const input = el('nameInput');
    input.focus();
    try { input.select(); } catch (e) { /* not every engine */ }
  }
  function commitNameEdit() {
    if (!editingName) return;
    editingName = false;
    const typed = el('nameInput').value.trim();
    const changed = !!typed && typed !== myName;
    if (typed) {
      myName = typed;
      storageSet(NAME_KEY, myName);
    } else {
      el('nameInput').value = myName;
    }
    renderIdentity();
    if (changed) { try { requestYearReview(); } catch (e) { /* cosmetic */ } }
    // Kartenhaus progress is per name: clear the old name's tile until the new data arrives.
    if (changed && !publicMode) { try { requestTower(); renderTowerTile(); } catch (e) { /* cosmetic */ } }
  }
  el('identityNameBtn').addEventListener('click', startNameEdit);
  el('identityAvatarBtn').addEventListener('click', () => openProgressSheet());
  el('nameInput').addEventListener('blur', () => { try { commitNameEdit(); } catch (e) { /* cosmetic */ } });

  function currentName() {
    myName = el('nameInput').value.trim() || `Spieler${Math.floor(Math.random() * 1000)}`;
    storageSet(NAME_KEY, myName);
    el('nameInput').value = myName;
    return myName;
  }

  el('createGameBtn').addEventListener('click', () => {
    guardOpenGame('create', () => send({ type: 'createSession', name: currentName(), accountToken: accountToken() || undefined, tablePrefs: tablePrefs() }));
  });

  // Desktop-Tastatur: Enter im Code-Feld tritt bei, Enter im Namensfeld
  // erstellt ein Spiel (bzw. tritt bei, wenn schon ein Code eingegeben ist).
  el('codeInput').addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') el('joinGameBtn').click();
  });
  // iOS standalone PWAs focus the first visible text field on launch/resume
  // without any touch (keyboard pops up). Only a recent gesture may focus it.
  let lastGestureAt = 0;
  ['pointerdown', 'touchstart', 'mousedown', 'keydown', 'click'].forEach((type) => {
    document.addEventListener(type, () => { lastGestureAt = Date.now(); }, { capture: true, passive: true });
  });
  ['codeInput', 'nameInput'].forEach((id) => {
    el(id).addEventListener('focus', () => {
      if (Date.now() - lastGestureAt > 1500) el(id).blur();
    });
  });
  el('nameInput').addEventListener('keydown', (ev) => {
    if (ev.key !== 'Enter') return;
    if (editingName) { ev.preventDefault(); el('nameInput').blur(); return; }
    if (el('codeInput').value.trim()) el('joinGameBtn').click();
    else el('createGameBtn').click();
  });

  el('joinGameBtn').addEventListener('click', () => {
    const code = el('codeInput').value.trim().toUpperCase();
    if (!code) {
      showHint(L('Bitte den Spiel-Code eingeben.', 'Please enter the game code.'), true);
      return;
    }
    guardOpenGame('join', () => {
      const storedId = storageGet(playerKeyFor(code));
      send({ type: 'joinSession', code, name: currentName(), playerId: storedId || undefined, playerToken: storageGet(tokenKeyFor(code)) || undefined, accountToken: accountToken() || undefined, tablePrefs: tablePrefs() });
    }, code);
  });

  el('shareCodeBtn').addEventListener('click', async () => {
    if (!sessionCode) return;
    const url = new URL(window.location.href);
    const shareCode = stammtischInfo ? stammtischInfo.code : sessionCode;
    url.searchParams.set('session', shareCode);
    const shareData = {
      title: 'Pik Dame',
      text: stammtischInfo ? `Stammtisch „${stammtischInfo.name}“ - Code: ${shareCode}` : `Spiel mit! Code: ${shareCode}`,
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
      // At a Stammtisch the GROUP code is the one to hand around - it works
      // forever, while the live session's code dies with the evening.
      el('sessionCodeText').textContent = stammtischInfo ? stammtischInfo.code : sessionCode;
      const label = el('sessionBanner').querySelector('.session-code-label');
      if (label) {
        label.textContent = stammtischInfo
          ? L(`Stammtisch „${stammtischInfo.name}“ - Code gilt für immer`, `Regulars table "${stammtischInfo.name}" - code works forever`)
          : L('Spiel-Code – zum Mitspielen weitergeben', 'Game code – share it to play together');
      }
      el('startBtn').disabled = false;
    }
    // Session lobby layout hook (desktop: two columns).
    el('lobby').classList.toggle('inSession', inSession);
    try { renderIdentity(); } catch (e) { /* cosmetic */ }
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
  el('langBtn').addEventListener('click', cycleLang);
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
    // Kartenhaus "Ohne Ablage": explain instead of a silent tap or a server refusal.
    if (el('discardPile').classList.contains('towerLocked')) { explainTowerLock(); return; }
    if (el('discardPile').classList.contains('disabled')) return;
    // Known-illegal take: still ask the server (it explains WHY in its
    // error toast) but skip the sound and the card flying to the hand - they
    // would announce a take that is about to be refused.
    if (el('discardPile').classList.contains('noTake')) {
      send({ type: 'drawFromDiscard' });
      return;
    }
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
    requestDiscard([...selectedCardIds][0]);
  });

  // Discard with the safety net for the two cards nobody throws away by
  // accident: the Queen of Spades (100 points) and a joker. Shared by the
  // button and the desktop drag-and-drop onto the pile.
  function requestDiscard(cardId) {
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
  }

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

  // Starting a forfeit vote asks first (in-app dialog); agreeing to an
  // existing proposal or withdrawing just toggles.
  function toggleForfeit(phase) {
    if (!lastState || lastState.phase !== phase) return;
    if (!lastState.players.some((p) => p.id === playerId && !p.isBot)) return;
    const votes = lastState.forfeitVotes || [];
    if (!votes.includes(playerId) && votes.length === 0) {
      el('confirmForfeitOverlay').classList.remove('hidden');
      return;
    }
    sendForfeitVote();
  }
  function sendForfeitVote() {
    sound.discard();
    send({ type: 'forfeitRound' }); // toggles my forfeit vote
  }
  el('forfeitBtn').addEventListener('click', () => toggleForfeit('playing'));
  el('confirmForfeitYesBtn').addEventListener('click', () => {
    el('confirmForfeitOverlay').classList.add('hidden');
    if (lastState && (lastState.phase === 'playing' || lastState.phase === 'roundEnd')) sendForfeitVote();
  });
  el('confirmForfeitNoBtn').addEventListener('click', () => el('confirmForfeitOverlay').classList.add('hidden'));

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
  el('aidDiscardToggle').addEventListener('click', () => setAid('discard', !aidDiscard));
  el('aidLayOffToggle').addEventListener('click', () => setAid('layoff', !aidLayOff));
  el('aidDiscardCheckbox').addEventListener('change', () => setAid('discard', el('aidDiscardCheckbox').checked));
  el('aidLayOffCheckbox').addEventListener('change', () => setAid('layoff', el('aidLayOffCheckbox').checked));
  el('aidLowCardsToggle').addEventListener('click', () => setAid('lowcards', !aidLowCards));
  el('aidLowCardsCheckbox').addEventListener('change', () => setAid('lowcards', el('aidLowCardsCheckbox').checked));
  el('aidTipsCheckbox').addEventListener('change', () => {
    if (el('aidTipsCheckbox').checked !== gameTipsEnabled) el('tipsToggle').click();
  });
  el('soundToggle').addEventListener('click', () => {
    setSoundEnabled(!soundEnabled);
  });
  el('soundCheckbox').addEventListener('change', () => setSoundEnabled(el('soundCheckbox').checked));
  el('musicToggle').addEventListener('click', cycleMusicLevel);
  el('musicLevelSelect').addEventListener('change', () => setMusicLevel(el('musicLevelSelect').value));
  el('musicTrackSelect').addEventListener('change', () => setMusicChoice(el('musicTrackSelect').value));

  // Segment buttons write their hidden <select> and fire its change event, so
  // the select stays the one source of truth; syncSegments() mirrors it back.
  function syncSegments() {
    document.querySelectorAll('.segmented[data-select]').forEach((group) => {
      const sel = document.getElementById(group.dataset.select);
      if (!sel) return;
      group.querySelectorAll('.segBtn').forEach((btn) => {
        const on = btn.dataset.value === sel.value;
        btn.classList.toggle('active', on);
        btn.setAttribute('aria-pressed', String(on));
        btn.disabled = sel.disabled;
      });
    });
    const mixed = el('ruleBotLevel').value === 'mixed';
    el('ruleBotLevelMixed').classList.toggle('hidden', !mixed);
  }
  document.querySelectorAll('.segmented[data-select]').forEach((group) => {
    group.addEventListener('click', (ev) => {
      const btn = ev.target.closest('.segBtn');
      const sel = document.getElementById(group.dataset.select);
      if (!btn || !sel || sel.disabled || btn.disabled || sel.value === btn.dataset.value) return;
      sel.value = btn.dataset.value;
      syncSegments();
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    });
  });
  syncSegments();

  // Host changes to house rules sync LIVE so every player sees them and the
  // bots follow immediately (sound is per device and lives in the settings).
  el('ruleBotLevel').addEventListener('change', () => {
    const level = el('ruleBotLevel').value;
    if (lastState && lastState.isHost && !lastState.challengeDate && level !== 'mixed') {
      send({ type: 'setAllBotDifficulty', difficulty: level });
      rememberTablePrefs({ botLevel: level });
    }
  });
  ['ruleHandAus', 'ruleStrict1000', 'ruleTurnTimer', 'ruleBotPace'].forEach((id) => {
    el(id).addEventListener('change', () => {
      if (lastState && lastState.isHost && !lastState.challengeDate) {
        const houseRules = collectHouseRules();
        send({ type: 'setHouseRules', houseRules });
        rememberTablePrefs({ houseRules });
      }
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
    if (!lastState || !lastState.turnDeadline) return;
    // Own span next to the status: the status is markup now (turn steps).
    const remaining = Math.max(0, Math.ceil((lastState.turnDeadline - Date.now()) / 1000));
    el('turnTimer').textContent = `⏱${remaining}s`;
    el('turnTimer').classList.toggle('timerUrgent', remaining <= 10);
  }
  function updateCountdownTimer() {
    if (countdownWanted()) {
      if (!countdownTimer) {
        tickCountdown(); // paint immediately, don't wait a second
        countdownTimer = setInterval(tickCountdown, 1000);
      }
      return;
    }
    if (countdownTimer) {
      clearInterval(countdownTimer);
      countdownTimer = null;
    }
    el('turnTimer').textContent = '';
    el('turnTimer').classList.remove('timerUrgent');
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
    // Solo tables (tutorial, challenge) have no bot takeover: say what really happens.
    const mode = lastState && lastState.tutorialMode ? 'homeTutorial' : lastState && lastState.challengeDate ? 'homeChallenge'
      : lastState && lastState.towerStage ? 'homeTower' : 'homeTable';
    for (const cls of ['homeTable', 'homeTutorial', 'homeChallenge', 'homeTower']) {
      el('homeOverlay').querySelectorAll(`.${cls}`).forEach((n) => n.classList.toggle('hidden', cls !== mode));
    }
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
    const btn = el('resumeBtn');
    btn.classList.add('hidden');
    if (!sessionCode) probeOpenGame();
  }
  el('resumeBtn').addEventListener('click', () => {
    const last = storageGet(LAST_SESSION_KEY);
    if (last) window.location.href = `${window.location.pathname}?session=${encodeURIComponent(last)}`;
  });

  // --- One game at a time ------------------------------------------------------
  // The device's open game as the server reports it (sessionStatus.seat). While
  // it runs, creating or joining another table asks to give it up first; the
  // daily challenge and the puzzle stay separate, an open tutorial never blocks.
  let openGame = null;
  let openGameCheck = null; // a probe in flight: gated taps wait for its answer
  let pendingStart = null; // what the sheet continues with after giving up
  let pendingAfterAbandon = null;
  function probeOpenGame() {
    const last = storageGet(LAST_SESSION_KEY);
    if (!last || !ws || ws.readyState !== WebSocket.OPEN) return;
    let done;
    const promise = new Promise((resolve) => { done = resolve; });
    const timer = setTimeout(() => settleOpenGameCheck(promise), 2500); // no answer: never lock the start screen
    openGameCheck = { promise, done: () => { clearTimeout(timer); done(); } };
    ws.send(JSON.stringify({
      type: 'checkSession', code: last,
      playerId: storageGet(playerKeyFor(last)) || undefined,
      playerToken: storageGet(tokenKeyFor(last)) || undefined,
    }));
  }
  function settleOpenGameCheck(promise) {
    if (!openGameCheck || (promise && openGameCheck.promise !== promise)) return;
    const check = openGameCheck;
    openGameCheck = null;
    check.done();
  }
  function forgetSession(code) {
    storageRemove(playerKeyFor(code));
    storageRemove(tokenKeyFor(code));
    if (storageGet(LAST_SESSION_KEY) === code) storageRemove(LAST_SESSION_KEY);
    if (resumeCode === code) {
      resumeCode = null;
      resumeIsChallenge = false;
      resumeIsTutorial = false;
      updateResumeBtn();
    }
  }
  function setOpenGame(status) {
    const seat = status.seat;
    const live = !!(status.exists && !status.finished && !status.challenge && seat && !seat.left
      && ['lobby', 'playing', 'roundEnd', 'cutting'].includes(seat.phase));
    openGame = live ? { ...seat, code: status.code } : null;
    resumeIsTutorial = !!(seat && seat.tutorial && resumeCode === status.code);
    updateResumeBtn();
    if (seat && seat.left) forgetSession(status.code); // given up elsewhere: never offered again
    renderOpenGame();
    settleOpenGameCheck();
  }
  function renderOpenGame() {
    // A real open game makes "back to the game" the main action of the start screen.
    const blocking = !!(openGame && !openGame.tutorial);
    el('sessionSetup').classList.toggle('hasOpenGame', blocking);
    el('resumeBtn').classList.toggle('btn-primary', blocking);
    el('resumeBtn').classList.toggle('btn-secondary', !blocking);
    el('createGameBtn').classList.toggle('btn-primary', !blocking);
    el('createGameBtn').classList.toggle('btn-secondary', blocking);
  }
  /** Runs start() unless the open game blocks it - then the sheet asks first.
   *  targetCode: joining that same table (or its Stammtisch) is just resuming. */
  function guardOpenGame(intent, start, targetCode) {
    if (openGameCheck) {
      openGameCheck.promise.then(() => guardOpenGame(intent, start, targetCode));
      return;
    }
    const og = openGame;
    const code = targetCode ? String(targetCode).trim().toUpperCase() : null;
    if (!og || (code && (code === og.code || code === og.stammtisch))) { start(); return; }
    if (og.tutorial) { abandonOpenGame(start); return; } // practice never blocks
    openOpenGameSheet(intent, start);
  }
  function abandonOpenGame(after) {
    const og = openGame;
    if (!og) { after(); return; }
    pendingAfterAbandon = { code: og.code, run: after };
    send({
      type: 'abandonSession', code: og.code, name: myName,
      playerId: storageGet(playerKeyFor(og.code)) || undefined,
      playerToken: storageGet(tokenKeyFor(og.code)) || undefined,
    });
  }
  function onSessionAbandoned(msg) {
    forgetSession(msg.code);
    if (openGame && openGame.code === msg.code) openGame = null;
    renderOpenGame();
    // Another tab gave up the game this tab still sits at: back to the start.
    if (sessionCode && sessionCode === msg.code) {
      window.location.href = window.location.pathname;
      return;
    }
    const next = pendingAfterAbandon && pendingAfterAbandon.code === msg.code ? pendingAfterAbandon.run : null;
    pendingAfterAbandon = null;
    el('openGameOverlay').classList.add('hidden');
    if (next) next();
  }
  function disarmTap(btn) {
    if (!btn.dataset.armed) return;
    clearTimeout(Number(btn.dataset.timer));
    delete btn.dataset.armed;
    btn.classList.remove('armed');
  }
  function openOpenGameSheet(intent, start) {
    const og = openGame;
    pendingStart = start;
    el('openGameSummary').textContent = og.tower
      ? `${towerName()} · ${L(`Etage ${og.tower}`, `floor ${og.tower}`)}`
      : og.phase === 'lobby'
        ? L(`Spiel ${og.code} · noch in der Lobby`, `Game ${og.code} · still in the lobby`)
        : L(`Spiel ${og.code} · Runde ${og.round} · ${og.score} Punkte`, `Game ${og.code} · round ${og.round} · ${og.score} points`);
    el('openGameConsequence').textContent = og.tower
      ? L('Die Stufe endet ohne Sterne - du kannst sie jederzeit neu starten.', 'The stage ends without stars - you can restart it any time.')
      : og.phase === 'lobby'
        ? L('Dein Platz in der Lobby wird frei.', 'Your seat in the lobby is freed.')
        : og.alone
          ? L('Die Partie endet und wird nicht gewertet.', 'The match ends and is not scored.')
          : L('Ein Bot übernimmt deinen Platz bis zum Ende, die anderen spielen weiter. Du kannst nicht zurück. Für dich wird die Partie nicht gewertet.',
            'A bot takes your seat until the end, the others play on. You cannot come back. The match is not scored for you.');
    const target = intent === 'tutorial' ? L('Tutorial', 'tutorial')
      : intent === 'tower' ? L('Kartenhaus', 'House of Cards')
        : intent === 'join' ? L('beitreten', 'join') : L('neues Spiel', 'new game');
    const btn = el('openGameGiveUpBtn');
    disarmTap(btn);
    btn.disabled = false;
    setLabelText(btn, og.phase === 'lobby'
      ? L(`Lobby verlassen & ${target}`, `Leave the lobby & ${target}`)
      : L(`Aufgeben & ${target}`, `Give up & ${target}`));
    el('openGameOverlay').classList.remove('hidden');
  }
  el('openGameResumeBtn').addEventListener('click', () => {
    if (openGame) window.location.href = `${window.location.pathname}?session=${encodeURIComponent(openGame.code)}`;
  });
  confirmByTap(el('openGameGiveUpBtn'), L('Wirklich?', 'Sure?'), () => {
    const start = pendingStart;
    pendingStart = null;
    el('openGameGiveUpBtn').disabled = true; // one request; the answer closes the sheet
    abandonOpenGame(() => { if (start) start(); });
  });
  el('openGameCancelBtn').addEventListener('click', () => {
    pendingStart = null;
    el('openGameOverlay').classList.add('hidden');
  });
  el('openGameOverlay').addEventListener('click', (ev) => {
    if (ev.target === el('openGameOverlay')) el('openGameCancelBtn').click();
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
  for (const id of ['resultHomeBtn', 'resultHomeQuickBtn']) {
    el(id).addEventListener('click', () => {
      window.location.href = window.location.pathname;
    });
  }

  // Lobby verlassen: Server räumt den Sitz, wir vergessen die Zugangsdaten
  // (sonst würde der Auto-Resume sofort wieder in die Session springen) und
  // laden das Hauptmenü. Vorher gab es aus einer erstellten Lobby KEINEN Weg
  // zurück ins Hauptmenü.
  el('leaveLobbyBtn').addEventListener('click', () => {
    if (!lastState || lastState.phase !== 'lobby') return;
    send({ type: 'leaveLobby' });
  });

  // Forfeit from the round-end overview: same unanimous vote as in the menu.
  el('resultForfeitBtn').addEventListener('click', () => toggleForfeit('roundEnd'));

  // --- Per-bot difficulty ---------------------------------------------------
  // Weakest first, like game/Bot.js BOT_LEVELS; `icon` is the spade rating in the sprite.
  // One name per level everywhere (seat chip, picker, house rules, log).
  const BOT_DIFF = {
    easy: { icon: 'i-lvl-1', short: () => L('Leicht', 'Easy'), hint: () => L('macht Anfängerfehler', 'makes beginner mistakes') },
    medium: { icon: 'i-lvl-2', short: () => L('Mittel', 'Medium'), hint: () => L('solides Familienspiel', 'solid family play') },
    hard: { icon: 'i-lvl-3', short: () => L('Schwer', 'Hard'), hint: () => L('zählt die Karten mit', 'counts the cards') },
    zen: { icon: 'i-lvl-zen', short: () => L('Zen', 'Zen'), hint: () => L('spielt am stärksten', 'plays strongest') },
  };
  // A fixed-size slot per icon; the Zen crown rises above it unless the context reserves it (CSS).
  function levelIconHtml(meta) {
    return `<span class="lvlSlot"><svg class="icon lvlIcon${meta.icon === 'i-lvl-zen' ? ' lvlZen' : ''}" aria-hidden="true"><use href="#${meta.icon}"/></svg></span>`;
  }
  function openBotDiffOverlay(bot) {
    // Tages-Challenge: Bot-Stärke ist fest (mittel für alle) - Menü gar nicht anbieten.
    if (lastState && lastState.challengeDate) return;
    el('botDiffTitle').textContent = L(`Schwierigkeit: ${bot.name}`, `Difficulty: ${bot.name}`);
    const box = el('botDiffOptions');
    box.innerHTML = '';
    for (const [key, meta] of Object.entries(BOT_DIFF)) {
      const btn = document.createElement('button');
      if (key === bot.botDifficulty) btn.classList.add('current');
      btn.innerHTML = `${levelIconHtml(meta)}<span>${meta.short()}<small>${meta.hint()}</small></span>`;
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

  // --- Tutorial: a guided first game (tutorial sessions only) --------------
  // The server deals a fixed deck (seed 22) and flags the session. Hints,
  // marks and rule explanations exist only there and end with the scoring of
  // round 1. Progress belongs to that session, so a reload resumes it and
  // nothing leaks into a normal game (the old global switch did).
  const TUTORIAL_KEY = 'pikdame_tutorial_progress';
  storageRemove('pikdame_tutorial');
  storageRemove('pikdame_tutorial_seen');
  let tutorialProgress = null;
  try { tutorialProgress = JSON.parse(storageGet(TUTORIAL_KEY) || 'null'); } catch (e) { tutorialProgress = null; }
  let tutorialActive = false; // hints on right now (see tutorialHintsOn)
  let tutorialCurrentStep = null;
  let tutorialBaseline; // what the current action step measures against
  let tutorialNoteTimer = null;
  let afterTutorial = null; // 'bots' | 'invite': the next game after "Tutorial geschafft"

  function saveTutorial() { storageSet(TUTORIAL_KEY, JSON.stringify(tutorialProgress)); }
  // Progress of the CURRENT tutorial session; a new session starts fresh.
  function tutorialSessionProgress() {
    if (!lastState || !lastState.tutorialMode || !sessionCode) return null;
    if (!tutorialProgress || tutorialProgress.code !== sessionCode) {
      tutorialProgress = { code: sessionCode, done: [], skipped: [], off: false, finished: false };
      saveTutorial();
    }
    if (!Array.isArray(tutorialProgress.skipped)) tutorialProgress.skipped = [];
    return tutorialProgress;
  }
  function tutorialHintsOn() {
    const prog = tutorialSessionProgress();
    return !!(prog && !prog.off && !prog.finished);
  }

  // Card words for the coach lines: the fixed deck lets them name real cards.
  const T_SUITS = { S: '♠', H: '♥', D: '♦', C: '♣' };
  const T_RANKS = {
    2: ['Zweien', 'twos', 'eine Zwei', 'a two'], 3: ['Dreien', 'threes', 'eine Drei', 'a three'],
    4: ['Vieren', 'fours', 'eine Vier', 'a four'], 5: ['Fünfen', 'fives', 'eine Fünf', 'a five'],
    6: ['Sechsen', 'sixes', 'eine Sechs', 'a six'], 7: ['Siebenen', 'sevens', 'eine Sieben', 'a seven'],
    8: ['Achten', 'eights', 'eine Acht', 'an eight'], 9: ['Neunen', 'nines', 'eine Neun', 'a nine'],
    10: ['Zehnen', 'tens', 'eine Zehn', 'a ten'], J: ['Buben', 'jacks', 'einen Buben', 'a jack'],
    Q: ['Damen', 'queens', 'eine Dame', 'a queen'], K: ['Könige', 'kings', 'einen König', 'a king'],
    A: ['Asse', 'aces', 'ein Ass', 'an ace'],
  };
  const T_COUNT = { 2: ['zwei', 'two'], 3: ['drei', 'three'], 4: ['vier', 'four'], 5: ['fünf', 'five'], 6: ['sechs', 'six'] };
  const tCard = (cd) => (cd.isJoker ? L('Joker', 'joker') : `${cd.rank}${T_SUITS[cd.suit] || ''}`);
  function tList(cards) {
    const names = cards.map(tCard);
    if (names.length < 2) return names.join('');
    return `${names.slice(0, -1).join(', ')} ${L('und', 'and')} ${names[names.length - 1]}`;
  }
  // "die vier Dreien" for a set, "5♥, 6♥ und 7♥" for anything else.
  function tCombo(cards) {
    const real = cards.filter((cd) => !cd.isJoker);
    const words = T_RANKS[real[0] && real[0].rank];
    if (real.length === cards.length && words && real.every((cd) => cd.rank === real[0].rank) && T_COUNT[real.length]) {
      return L(`die ${T_COUNT[real.length][0]} ${words[0]}`, `the ${T_COUNT[real.length][1]} ${words[1]}`);
    }
    return tList(cards);
  }

  const tByIds = (hand, ids) => ids.map((id) => hand.find((cd) => cd.id === id)).filter(Boolean);
  const isSpadeQueen = (cd) => !!cd && cd.rank === 'Q' && cd.suit === 'S';
  // The queens wait for their own lesson while it is still to come.
  const reservesQueens = (hand) => hand.some(isSpadeQueen) && hand.filter((cd) => cd.rank === 'Q').length >= 3;

  /**
   * ONE combination for the meld mark: the biggest set first (ties: the lower
   * rank), then plain runs. Conservative on purpose - no jokers, no ring runs
   * (K-A-2): better no mark than a wrong one. The server stays the judge.
   */
  function findTutorialMeld(hand, { skipQueens = false } = {}) {
    const real = hand.filter((cd) => !cd.isJoker && !(skipQueens && cd.rank === 'Q'));
    let best = null;
    const byRank = {};
    for (const cd of real) (byRank[cd.rank] = byRank[cd.rank] || []).push(cd);
    for (const cards of Object.values(byRank)) {
      const perSuit = {};
      const pick = cards.filter((cd) => (perSuit[cd.suit] = (perSuit[cd.suit] || 0) + 1) <= 2);
      if (pick.length < 3) continue;
      const better = !best || pick.length > best.length ||
        (pick.length === best.length && RANK_ORDER.indexOf(pick[0].rank) < RANK_ORDER.indexOf(best[0].rank));
      if (better) best = pick;
    }
    if (best) return best.slice(0, 8).map((cd) => cd.id);
    const bySuit = {};
    for (const cd of real) (bySuit[cd.suit] = bySuit[cd.suit] || new Map()).set(cd.rank, cd);
    for (const m of Object.values(bySuit)) {
      let run = [];
      for (const r of RANK_ORDER) {
        if (m.has(r)) {
          run.push(m.get(r));
          if (run.length >= 3) return run.slice(-3).map((cd) => cd.id);
        } else run = [];
      }
    }
    return null;
  }

  /** A pair (or a run with one gap) that a joker completes: the joker lesson. */
  function findTutorialJokerMeld(hand) {
    const joker = hand.find((cd) => cd.isJoker);
    if (!joker) return null;
    const real = hand.filter((cd) => !cd.isJoker && !(reservesQueens(hand) && cd.rank === 'Q'));
    const byRank = {};
    for (const cd of real) (byRank[cd.rank] = byRank[cd.rank] || []).push(cd);
    let pair = null;
    for (const cards of Object.values(byRank)) {
      if (cards.length !== 2) continue; // three of a kind needs no joker
      const distinct = cards[0].suit !== cards[1].suit;
      const better = !pair || (distinct && !pair.distinct) ||
        (distinct === pair.distinct && RANK_ORDER.indexOf(cards[0].rank) > RANK_ORDER.indexOf(pair.cards[0].rank));
      if (better) pair = { cards, distinct };
    }
    if (pair) return { cardIds: [...pair.cards.map((cd) => cd.id), joker.id], cards: pair.cards, rank: pair.cards[0].rank };
    for (const a of real) {
      const b = real.find((cd) => cd.suit === a.suit && RANK_ORDER.indexOf(cd.rank) === RANK_ORDER.indexOf(a.rank) + 2);
      if (b) return { cardIds: [a.id, joker.id, b.id], cards: [a, b], rank: RANK_ORDER[RANK_ORDER.indexOf(a.rank) + 1] };
    }
    return null;
  }

  /** The combination that settles a taken discard: the duty card plus hand cards. */
  function findTutorialDutyMeld(hand, dutyId) {
    const duty = hand.find((cd) => cd.id === dutyId);
    if (!duty || duty.isJoker) return null;
    const others = hand.filter((cd) => cd.id !== dutyId && !cd.isJoker);
    const same = others.filter((cd) => cd.rank === duty.rank);
    if (same.length >= 2 && hand.length - 3 >= 1) return [duty, ...same.slice(0, 2)];
    const at = (r) => others.find((cd) => cd.suit === duty.suit && cd.rank === r);
    const i = RANK_ORDER.indexOf(duty.rank);
    for (const [x, y] of [[i - 2, i - 1], [i - 1, i + 1], [i + 1, i + 2]]) {
      const a = x >= 0 && at(RANK_ORDER[x]);
      const b = y < RANK_ORDER.length && at(RANK_ORDER[y]);
      if (a && b && hand.length - 3 >= 1) return [a, b, duty].sort((p, q) => RANK_ORDER.indexOf(p.rank) - RANK_ORDER.indexOf(q.rank));
    }
    return null;
  }

  /**
   * ONE hand card that goes onto an OWN meld. Plain adds first; a joker joins
   * an own set (never a run - that would ask which card it plays). Never the
   * last card: that one is discarded to go out.
   */
  function findTutorialLayOff(st, me) {
    if (!me || !me.hand || me.hand.length <= 1) return null;
    const mine = (st.tableMelds || []).filter((m) => m.ownerId === me.id);
    for (const meld of mine) {
      // The card a joker in this meld stands for swaps on tap (layOffToMeld), it does not lay off.
      const jokersCard = (cd) => (meld.slots || []).some((s) => s.joker && s.representsRank === cd.rank && s.representsSuit === cd.suit);
      const fit = me.hand.find((cd) => cardFitsMeldPureAdd(meld, cd) && !jokersCard(cd));
      if (fit) return { cardId: fit.id, meldId: meld.id, card: fit };
    }
    const joker = me.hand.find((cd) => cd.isJoker);
    const set = mine.find((m) => m.type === 'set' && m.slots.length < 8);
    if (joker && set) return { cardId: joker.id, meldId: set.id, card: joker };
    return null;
  }

  /** Hand card that is exactly what a joker in an OWN meld stands for. */
  function findTutorialJokerSwap(st, me) {
    if (!me || !me.hand || me.hand.length <= 1) return null; // last card is discarded
    for (const meld of st.tableMelds || []) {
      if (meld.ownerId !== me.id) continue;
      for (const slot of meld.slots || []) {
        if (!slot.joker || !slot.representsRank) continue;
        const fit = me.hand.find(
          (cd) => !cd.isJoker && cd.rank === slot.representsRank && cd.suit === slot.representsSuit
        );
        if (fit) return { cardId: fit.id, meldId: meld.id, card: fit };
      }
    }
    return null;
  }

  /** The card that helps least: no partner of its rank, no neighbour in its suit. Never a joker or the ♠Q. */
  function suggestTutorialDiscard(hand) {
    const pool = hand.filter((cd) => !cd.isJoker && !isSpadeQueen(cd));
    if (!pool.length) return null;
    const links = (cd) => pool.filter((o) => o !== cd && (o.rank === cd.rank ||
      (o.suit === cd.suit && Math.abs(RANK_ORDER.indexOf(o.rank) - RANK_ORDER.indexOf(cd.rank)) <= 2))).length;
    return pool.reduce((best, cd) => (links(cd) < links(best) ? cd : best), pool[0]);
  }

  // What the steps look at.
  function tutorialContext() {
    const st = lastState;
    const me = (st.players || []).find((p) => p.id === playerId) || null;
    const hand = (me && me.hand) || [];
    const myMelds = (st.tableMelds || []).filter((m) => me && m.ownerId === me.id);
    const myTurn = st.phase === 'playing' && st.currentPlayerId === playerId;
    return {
      st, me, hand, myMelds, myTurn,
      playing: st.phase === 'playing',
      drawPhase: myTurn && st.turnPhase === 'draw',
      meldPhase: myTurn && st.turnPhase === 'meld',
      duty: myTurn ? st.mustLayOffCardId : null,
      meldedCards: myMelds.reduce((n, m) => n + (m.slots || []).length, 0),
      queenLaid: myMelds.some((m) => (m.slots || []).some((s) => isSpadeQueen(s.real))),
      jokerLaid: myMelds.some((m) => (m.slots || []).some((s) => s.joker)),
    };
  }
  const freeToMeld = (c) => c.meldPhase && !c.duty;
  /** The top discard and its hand partners when taking it is legal now (server truth). */
  function tutorialPileFit(c) {
    const top = c.st.discardTop;
    if (!c.drawPhase || !c.st.discardTakeable || !top || top.faceDown) return null;
    const combo = findTutorialDutyMeld([...c.hand, top], top.id);
    return combo ? { top, partners: combo.filter((cd) => cd.id !== top.id) } : null;
  }
  /** Sets and plain runs (3+) already in the hand - conservative like findTutorialMeld. */
  function tutorialHandCombos(hand) {
    const real = hand.filter((cd) => !cd.isJoker);
    const combos = [];
    const byRank = {};
    for (const cd of real) (byRank[cd.rank] = byRank[cd.rank] || []).push(cd);
    for (const cards of Object.values(byRank)) {
      const perSuit = {};
      const pick = cards.filter((cd) => (perSuit[cd.suit] = (perSuit[cd.suit] || 0) + 1) <= 2);
      if (pick.length >= 3) combos.push({ type: 'set', cards: pick });
    }
    const bySuit = {};
    for (const cd of real) (bySuit[cd.suit] = bySuit[cd.suit] || new Map()).set(cd.rank, cd);
    for (const m of Object.values(bySuit)) {
      let run = [];
      for (const r of [...RANK_ORDER, null]) {
        if (r && m.has(r)) { run.push(m.get(r)); continue; }
        if (run.length >= 3) combos.push({ type: 'run', cards: run });
        run = [];
      }
    }
    return combos;
  }
  /** What taking the pile would break: a hand combination that loses a partner card. */
  function tutorialPileCost(hand, fit) {
    const used = new Set(fit.partners.map((cd) => cd.id));
    const after = new Set(tutorialHandCombos(hand.filter((cd) => !used.has(cd.id))).flatMap((x) => x.cards.map((cd) => cd.id)));
    for (const combo of tutorialHandCombos(hand)) {
      const lost = combo.cards.find((cd) => used.has(cd.id));
      if (lost && combo.cards.some((cd) => !used.has(cd.id) && !after.has(cd.id))) return { card: lost, combo };
    }
    return null;
  }
  // "deine drei Fünfen" / "your three fives"; a run is named card by card.
  function tutorialYourCombo(combo) {
    const w = T_RANKS[combo.cards[0].rank];
    const n = T_COUNT[combo.cards.length];
    if (combo.type === 'set' && w) return n ? [`deine ${n[0]} ${w[0]}`, `your ${n[1]} ${w[1]}`] : [`deine ${w[0]}`, `your ${w[1]}`];
    return [`deine Folge ${tList(combo.cards)}`, `your run ${tList(combo.cards)}`];
  }
  /** The first draw: the pile when it fits for free, else the stock - explained when the pile would cost a combination. */
  function tutorialFirstDraw(c) {
    const fit = tutorialPileFit(c);
    const cost = fit && tutorialPileCost(c.hand, fit);
    return { mode: !fit ? 'stock' : cost ? 'explain' : 'pile', fit, cost };
  }
  const tutorialJokersLaid = (c) => c.myMelds.reduce((n, m) => n + (m.slots || []).filter((s) => s.joker).length, 0);
  const jokerOntoOwnSet = (c) => c.hand.length > 1 && c.hand.some((cd) => cd.isJoker) &&
    c.myMelds.some((m) => m.type === 'set' && (m.slots || []).length < 8);

  /**
   * The lessons, in order. A step is shown while `when` holds; `done` proves it
   * from the table (actions) or "Weiter" ends it (info). `block` steps are the
   * guided first turn: nothing after them shows before they are done, so no
   * mandatory lesson can be skipped by playing ahead. `gone` drops a step that
   * can no longer happen (the ♠Q discarded, the round over).
   */
  const TUTORIAL_STEPS = [
    {
      // First on purpose: a taken pile's top card must go out at once, in a NEW
      // combination - that outranks every lesson (named, not a "Pflicht" line).
      key: 'pileDuty', optional: true,
      when: (c) => !!c.duty,
      done: (c, base) => base !== undefined && !c.duty,
      highlight: (c) => {
        const combo = findTutorialDutyMeld(c.hand, c.duty);
        return { cardIds: combo ? combo.map((cd) => cd.id) : [c.duty], targets: ['confirmMeldBtn'] };
      },
      title: () => L('Ablage genommen', 'Pile taken'),
      text: (c) => {
        const duty = c.hand.find((cd) => cd.id === c.duty);
        const combo = findTutorialDutyMeld(c.hand, c.duty);
        const rest = combo ? combo.filter((cd) => cd.id !== c.duty) : [];
        return combo
          ? L(`Leg die ${tCard(duty)} jetzt aus – zusammen mit ${tList(rest)}.`, `Meld the ${tCard(duty)} now – together with ${tList(rest)}.`)
          : L('Leg die markierte Karte jetzt in einer neuen Kombination aus.', 'Meld the marked card now, in a new combination.');
      },
      success: () => L('Erledigt – jetzt ist der Weg frei.', 'Done – the way is clear now.'),
    },
    {
      key: 'welcome', info: true, block: true,
      when: (c) => c.playing,
      title: () => L('Willkommen am Tisch', 'Welcome to the table'),
      text: () => L('Leg deine Karten aus und wirf die letzte ab – dann gewinnst du die Runde.',
        'Meld your cards and discard the last one – that wins you the round.'),
    },
    {
      // A fitting top discard is never ignored silently: taken when free, explained
      // when it costs a hand combination (seed 22: the 7♥ would take the fives' 5♥).
      key: 'draw', block: true,
      when: (c) => c.drawPhase,
      done: (c) => (c.myTurn && !c.drawPhase) || c.st.turnIndexInRound > 0,
      highlight: (c) => {
        const d = tutorialFirstDraw(c);
        return d.mode === 'pile' ? { cardIds: d.fit.partners.map((cd) => cd.id), targets: ['discardPile'] } : { targets: ['drawPile'] };
      },
      title: (c) => (tutorialFirstDraw(c).mode === 'pile' ? L('Die Ablage', 'The discard pile') : L('Karte ziehen', 'Draw a card')),
      text: (c) => {
        const { mode, fit, cost } = tutorialFirstDraw(c);
        if (mode === 'explain') {
          const [mine, mineEn] = tutorialYourCombo(cost.combo);
          const with2 = fit.partners.map(tCard).join(' ');
          return L(`Die ${tCard(fit.top)} passt zu ${with2} – aber dann fehlt dir die ${tCard(cost.card)} für ${mine}. Zieh lieber vom Stapel.`,
            `The ${tCard(fit.top)} fits your ${with2} – but then ${mineEn} lose the ${tCard(cost.card)}. Draw from the stock instead.`);
        }
        return mode === 'pile'
          ? L(`Die ${tCard(fit.top)} auf der Ablage passt zu deiner ${tList(fit.partners)}. Tippe auf die Ablage – dann legst du sie sofort mit beiden aus.`,
            `The ${tCard(fit.top)} on the discard pile fits your ${tList(fit.partners)}. Tap the pile – then you meld it with both at once.`)
          : L('Tippe auf den verdeckten Stapel und zieh eine Karte.', 'Tap the face-down stock to draw a card.');
      },
    },
    {
      key: 'firstSet', block: true,
      when: (c) => freeToMeld(c) && !!findTutorialMeld(c.hand, { skipQueens: reservesQueens(c.hand) }),
      // A set, not just any meld: the pile lesson already laid a run.
      done: (c) => c.myMelds.some((m) => m.type === 'set'),
      highlight: (c) => ({ cardIds: findTutorialMeld(c.hand, { skipQueens: reservesQueens(c.hand) }), targets: ['confirmMeldBtn'] }),
      title: () => L('Dein erster Satz', 'Your first set'),
      text: (c) => {
        const combo = tByIds(c.hand, findTutorialMeld(c.hand, { skipQueens: reservesQueens(c.hand) }) || []);
        return L(`Tippe ${tCombo(combo)} an und dann auf „Auslegen“.`, `Tap ${tCombo(combo)}, then “Meld”.`);
      },
      success: () => L('Gut gemacht – ein Satz: gleicher Wert, verschiedene Farben.', 'Well done – a set: same rank, different suits.'),
    },
    {
      key: 'pikdame', info: true, block: true,
      when: (c) => c.hand.some(isSpadeQueen) || c.queenLaid,
      highlight: (c) => ({ cardIds: c.hand.filter(isSpadeQueen).map((cd) => cd.id) }),
      title: () => L('Die Pik Dame', 'The queen of spades'),
      text: (c) => (c.queenLaid
        ? L('Sie liegt schon aus: +100 für dich. Auf der Hand hätte sie dich am Ende 100 gekostet.',
          'She is already down: +100 for you. Left in your hand she would have cost you 100.')
        : L('Leg sie aus: +100. Bleibt sie am Rundenende auf der Hand: −100.',
          'Meld her: +100. Still in your hand at round end: −100.')),
    },
    {
      key: 'queenSet', block: true,
      when: (c) => freeToMeld(c) && c.hand.some(isSpadeQueen) && c.hand.filter((cd) => cd.rank === 'Q').length >= 3,
      done: (c) => c.queenLaid,
      gone: (c) => !c.queenLaid && !c.hand.some(isSpadeQueen),
      highlight: (c) => ({ cardIds: c.hand.filter((cd) => cd.rank === 'Q').map((cd) => cd.id), targets: ['confirmMeldBtn'] }),
      title: () => L('Damen auslegen', 'Meld the queens'),
      text: () => L('Tippe die drei Damen an und leg sie aus – die Pik Dame ist dabei.',
        'Tap the three queens and meld them – the queen of spades is one of them.'),
      success: () => L('Stark – die Pik Dame zählt jetzt +100 für dich.', 'Great – the queen of spades now scores +100 for you.'),
    },
    {
      key: 'joker', block: true,
      when: (c) => freeToMeld(c) && (!!findTutorialJokerMeld(c.hand) || jokerOntoOwnSet(c)),
      done: (c) => c.jokerLaid,
      gone: (c) => !c.jokerLaid && !c.hand.some((cd) => cd.isJoker),
      highlight: (c) => {
        const jm = findTutorialJokerMeld(c.hand);
        if (jm) return { cardIds: jm.cardIds, targets: ['confirmMeldBtn'] };
        const joker = c.hand.find((cd) => cd.isJoker);
        const set = c.myMelds.find((m) => m.type === 'set');
        return { cardIds: joker ? [joker.id] : [], meldIds: set ? [set.id] : [] };
      },
      title: () => L('Der Joker', 'The joker'),
      text: (c) => {
        const jm = findTutorialJokerMeld(c.hand);
        if (jm && jm.cards[0].rank === jm.cards[1].rank) {
          const w = T_RANKS[jm.rank];
          return L(`Er ersetzt jede Karte. Leg die zwei ${w[0]} mit dem Joker aus.`, `It stands in for any card. Meld the two ${w[1]} with the joker.`);
        }
        if (jm) return L(`Er ersetzt jede Karte. Leg ${tList(jm.cards)} mit dem Joker dazwischen aus.`, `It stands in for any card. Meld ${tList(jm.cards)} with the joker in between.`);
        return L('Er ersetzt jede Karte. Tippe ihn an und dann deine markierte Auslage.', 'It stands in for any card. Tap it, then your marked meld.');
      },
      success: (c) => {
        const slot = c.myMelds.flatMap((m) => m.slots || []).find((s) => s.joker && s.representsRank);
        const w = slot && T_RANKS[slot.representsRank];
        return w
          ? L(`Der Joker spielt jetzt ${w[2]}.`, `The joker now plays ${w[3]}.`)
          : L('Der Joker liegt jetzt in deiner Auslage.', 'The joker is in your meld now.');
      },
    },
    {
      // Bonus: the rest of the deal still holds a set - lay it too.
      key: 'moreMelds', optional: true,
      when: (c) => freeToMeld(c) && c.myMelds.length > 0 && (() => {
        const ids = findTutorialMeld(c.hand, { skipQueens: reservesQueens(c.hand) });
        return !!ids && c.hand.length - ids.length >= 1;
      })(),
      done: (c, base) => base !== undefined && c.myMelds.length > base,
      metric: (c) => c.myMelds.length,
      highlight: (c) => ({ cardIds: findTutorialMeld(c.hand, { skipQueens: reservesQueens(c.hand) }), targets: ['confirmMeldBtn'] }),
      title: () => L('Noch eine Auslage', 'One more meld'),
      text: (c) => {
        const combo = tByIds(c.hand, findTutorialMeld(c.hand, { skipQueens: reservesQueens(c.hand) }) || []);
        return L(`Leg auch ${tCombo(combo)} aus – jede Auslage zählt Punkte.`, `Meld ${tCombo(combo)} too – every meld scores.`);
      },
      success: () => L('Gut – nur noch wenige Karten auf der Hand.', 'Good – only a few cards left in your hand.'),
    },
    {
      key: 'discard', block: true,
      when: (c) => freeToMeld(c) && c.hand.length > 1,
      done: (c, base) => base !== undefined && !c.myTurn,
      highlight: (c) => {
        const pick = suggestTutorialDiscard(c.hand);
        return { cardIds: pick ? [pick.id] : [], targets: ['discardBtn'] };
      },
      title: () => L('Zug beenden', 'End your turn'),
      text: (c) => {
        const pick = suggestTutorialDiscard(c.hand);
        return pick
          ? L(`Wirf eine Karte ab, die dir wenig bringt – zum Beispiel die ${tCard(pick)}.`, `Discard a card you need least – the ${tCard(pick)}, for example.`)
          : L('Wähle eine Karte und tippe auf „Abwerfen“.', 'Pick a card and tap “Discard card”.');
      },
      success: () => L('Zug beendet – jetzt sind die Bots dran.', 'Turn over – the bots play now.'),
    },
    {
      key: 'pile', info: true, optional: true,
      when: (c) => c.drawPhase && !!c.st.discardTakeable,
      highlight: () => ({ targets: ['discardPile'] }),
      title: () => L('Die Ablage', 'The discard pile'),
      text: () => L('Leuchtet sie, passt ihre oberste Karte zu dir. Nimmst du sie, legst du diese Karte sofort aus.',
        'When it glows, its top card fits your hand. Take it and you meld that card at once.'),
    },
    {
      key: 'layOff',
      when: (c) => freeToMeld(c) && !!findTutorialLayOff(c.st, c.me),
      done: (c, base) => base !== undefined && c.meldedCards > base,
      metric: (c) => c.meldedCards,
      gone: (c) => !c.playing,
      highlight: (c) => {
        const hit = findTutorialLayOff(c.st, c.me);
        return hit ? { cardIds: [hit.cardId], meldIds: [hit.meldId] } : null;
      },
      title: () => L('Anlegen', 'Lay off'),
      text: (c) => {
        const hit = findTutorialLayOff(c.st, c.me);
        return hit && hit.card.isJoker
          ? L('Tippe den Joker an und dann deine markierte Auslage.', 'Tap the joker, then your marked meld.')
          : L(`Tippe die ${tCard(hit.card)} an und dann deine markierte Auslage.`, `Tap the ${tCard(hit.card)}, then your marked meld.`);
      },
      success: () => L('Angelegt – so wirst du einzelne Karten los.', 'Laid off – that is how single cards leave your hand.'),
    },
    {
      key: 'jokerSwap', optional: true,
      when: (c) => freeToMeld(c) && !!findTutorialJokerSwap(c.st, c.me),
      // The freed joker leaves the game (engine rule), so count the jokers left in own melds.
      done: (c, base) => base !== undefined && tutorialJokersLaid(c) < base,
      metric: (c) => tutorialJokersLaid(c),
      highlight: (c) => {
        const hit = findTutorialJokerSwap(c.st, c.me);
        return hit ? { cardIds: [hit.cardId], meldIds: [hit.meldId] } : null;
      },
      title: () => L('Joker tauschen', 'Swap the joker'),
      text: (c) => {
        const hit = findTutorialJokerSwap(c.st, c.me);
        return L(`Tippe die ${tCard(hit.card)} an und dann die Auslage – sie ersetzt den Joker, der aus dem Spiel geht.`,
          `Tap the ${tCard(hit.card)}, then the meld – it replaces the joker, which leaves the game.`);
      },
      success: () => L('Getauscht – der Joker zählt in der Auslage trotzdem 20.', 'Swapped – the joker still counts 20 in that meld.'),
    },
    {
      key: 'endgame', info: true,
      when: (c) => c.playing && c.hand.length > 0 && c.hand.length <= 2 && !c.drawPhase,
      gone: (c) => !c.playing,
      title: () => L('Fast geschafft', 'Almost there'),
      text: () => L('Du machst aus, indem du deine letzte Karte abwirfst.', 'You go out by discarding your last card.'),
    },
    {
      // Shown inside the round-end sheet (#resultCoach), never over it.
      key: 'roundend', info: true,
      when: (c) => c.st.phase === 'roundEnd',
      title: () => L('So wird gewertet', 'How scoring works'),
      text: () => L('Ausgelegtes zählt plus, Karten auf der Hand minus. Ab 1000 Punkten ist die Partie vorbei.',
        'Melded cards count plus, cards in hand minus. The match ends at 1000 points.'),
    },
  ];
  const TUTORIAL_MANDATORY = TUTORIAL_STEPS.filter((s) => !s.optional);

  const tutorialPassed = (prog, key) => prog.done.includes(key) || prog.skipped.includes(key);
  function tutorialPick(c, prog) {
    const roundOver = c.st.phase === 'roundEnd';
    for (const s of TUTORIAL_STEPS) {
      if (tutorialPassed(prog, s.key)) continue;
      const wasCurrent = tutorialCurrentStep === s.key;
      if (s.done && s.done(c, wasCurrent ? tutorialBaseline : undefined)) {
        prog.done.push(s.key);
        saveTutorial();
        if (wasCurrent && s.success) {
          coachNote(s.success(c), 'success');
          vibrate([12, 40, 12]);
        }
        continue;
      }
      // Could not happen (or the round is over before it did): passed, not ticked.
      if ((roundOver && s.key !== 'roundend') || (s.gone && s.gone(c))) {
        prog.skipped.push(s.key);
        saveTutorial();
        continue;
      }
      if (s.when(c)) return s;
      if (s.block) return null;
    }
    return null;
  }

  /** Explains the rule behind a refusal - tutorial only, inside the coach card. */
  function tutorialExplainError(error) {
    const RULES = [
      [/SOFORT gelegt|zuerst in einer neuen Kombination|NEUEN Kombination mit deinen Handkarten/i, L(
        'Wer die Ablage nimmt, legt deren oberste Karte zuerst aus – in einer neuen Kombination mit Handkarten. Erst danach geht alles andere.',
        'Whoever takes the pile melds its top card first – in a new combination with hand cards. Everything else comes after.')],
      [/abzuwerfen|abwerfen übrig|keine Karte zum Abwerfen|letzte Karte abwerfen/i, L(
        'Ausmachen geht nur mit dem Abwurf deiner letzten Karte. Darum muss nach jedem Zug eine Karte übrig bleiben.',
        'You can only go out by discarding your last card. So one card must be left after every move.')],
      [/passt zu keiner Kombination/i, L(
        'Die oberste Ablagekarte darfst du nur nehmen, wenn sie sofort eine neue Kombination mit deiner Hand bildet.',
        'You may only take the top discard if it forms a new combination with your hand right away.')],
      [/EIGENEN Auslagen|fremde Stapel/i, L(
        'Anlegen geht nur an deine eigenen Auslagen – so bleibt jedem sein Punktestand.',
        'You can only lay off onto your own melds – that keeps everyone’s score their own.')],
      [/mindestens (drei|3)|zu kurz|keine gültige/i, L(
        'Eine Kombination braucht mindestens drei Karten: gleicher Wert oder eine Folge in einer Farbe.',
        'A combination needs at least three cards: the same rank, or a run in one suit.')],
      // The most common beginner mistake: mixing suits into a run.
      [/dieselbe Farbe|gleiche Farbe|zusammenhängend|lückenlos|keine Reihe/i, L(
        'Eine Folge läuft lückenlos in einer Farbe, etwa 5♥ 6♥ 7♥. Gleiche Werte in verschiedenen Farben sind ein Satz.',
        'A run climbs without gaps in one suit, like 5♥ 6♥ 7♥. Same ranks in different suits are a set.')],
      [/nur EIN|bereits einen Satz|schon einen Satz/i, L(
        'Pro Wert gibt es nur einen Satz. Weitere Karten dieses Werts legst du an ihn an.',
        'There is one set per rank. Further cards of that rank go onto it.')],
      [/nicht am Zug|bist nicht dran/i, L(
        'Warte, bis du dran bist – oben steht immer, wer gerade spielt.',
        'Wait for your turn – the top line always shows who is playing.')],
    ];
    for (const [pattern, explanation] of RULES) if (pattern.test(error)) return explanation;
    return null;
  }

  // A short line in the card: praise after a right move, the rule after a refused one.
  function coachNote(text, kind, ms = kind === 'error' ? 8000 : 3200) {
    const note = el('coachNote');
    if (!note || !text) return;
    el('coachNoteText').textContent = text;
    note.classList.toggle('error', kind === 'error');
    const use = note.querySelector('use');
    if (use) use.setAttribute('href', kind === 'error' ? '#i-alert' : '#i-check');
    note.classList.remove('hidden');
    clearTimeout(tutorialNoteTimer);
    tutorialNoteTimer = setTimeout(() => { note.classList.add('hidden'); syncTutorialLayout(); }, ms);
    syncTutorialLayout();
  }

  let tutorialHighlight = null;
  function applyTutorialHighlight(hl) {
    document.querySelectorAll('.tutorialGlow').forEach((n) => n.classList.remove('tutorialGlow'));
    document.querySelectorAll('.tutorialGlowMeld').forEach((n) => n.classList.remove('tutorialGlowMeld'));
    // Targets (stock, buttons, own melds) exist only in the tutorial, never in a normal game.
    document.querySelectorAll('.tutorialGlowTarget').forEach((n) => n.classList.remove('tutorialGlowTarget'));
    if (hl && Array.isArray(hl.targets) && tutorialActive) {
      for (const id of hl.targets) {
        const node = document.getElementById(id);
        if (node && !node.classList.contains('hidden')) node.classList.add('tutorialGlowTarget');
      }
    }
    let marked = 0;
    if (hl && tutorialActive) {
      for (const id of hl.cardIds || []) {
        const n = document.querySelector(`#hand [data-card-id="${CSS.escape(String(id))}"]`);
        if (n) { n.classList.add('tutorialGlow'); marked += 1; }
      }
      for (const id of hl.meldIds || []) {
        const n = document.querySelector(`[data-meld-id="${CSS.escape(String(id))}"]`);
        if (n) n.classList.add('tutorialGlowMeld');
      }
    }
    // The rest of the fan dims, so the marked cards stand out (F5).
    el('hand').classList.toggle('coachSpot', marked > 0);
  }

  /** Landscape/desktop: the corner card sits over the melds - keep their scroll room. */
  function syncTutorialLayout() {
    const coach = el('tutorialCoach');
    const open = !coach.classList.contains('hidden');
    el('table').classList.toggle('coachOpen', open);
    document.body.classList.toggle('coachOpen', open); // toasts make room (style.css)
    el('table').style.setProperty('--coach-h', open ? `${Math.ceil(coach.getBoundingClientRect().height)}px` : '0px');
  }
  window.addEventListener('resize', () => { try { syncTutorialLayout(); } catch (e) { /* never break the table */ } });

  function hideCoach() {
    el('tutorialCoach').classList.add('hidden');
    el('resultCoach').classList.add('hidden');
    tutorialCurrentStep = null;
    tutorialHighlight = null;
    syncTutorialLayout();
    requestAnimationFrame(() => applyTutorialHighlight(null));
  }

  // Lines between lessons: who is on, what you can do - no counter jump, no button.
  function passiveCoachLine(c) {
    if (!c.playing) return null;
    if (!c.myTurn) {
      return { title: L('Die Bots sind dran', 'The bots are playing'), text: L('Schau zu, was sie auslegen – gleich bist du wieder dran.', 'Watch what they meld – your turn comes next.') };
    }
    // Offer the pile only when it costs no hand combination - same rule as the first draw.
    const draw = tutorialFirstDraw(c);
    if (draw.mode === 'pile') {
      return {
        title: L('Du bist dran', 'Your turn'),
        text: L(`Nimm die ${tCard(draw.fit.top)} von der Ablage – oder zieh vom Stapel.`, `Take the ${tCard(draw.fit.top)} from the pile – or draw from the stock.`),
        highlight: { targets: ['discardPile', 'drawPile'] },
      };
    }
    if (c.drawPhase) return { title: L('Du bist dran', 'Your turn'), text: L('Zieh eine Karte vom Stapel.', 'Draw a card from the stock.'), highlight: { targets: ['drawPile'] } };
    if (c.duty) return null;
    if (c.hand.length === 1) {
      return {
        title: L('Ausmachen', 'Go out'),
        text: L('Wirf deine letzte Karte ab – dann ist die Runde deine.', 'Discard your last card – and the round is yours.'),
        highlight: { cardIds: [c.hand[0].id], targets: ['discardBtn'] },
      };
    }
    // Later turns follow the glow too: lay off, meld, else a discard tip - never an unmarked turn.
    const turn = (text, highlight) => ({ title: L('Du bist dran', 'Your turn'), text, highlight });
    const hit = findTutorialLayOff(c.st, c.me);
    if (hit) {
      const what = hit.card.isJoker ? L('den Joker', 'the joker') : L(`die ${tCard(hit.card)}`, `the ${tCard(hit.card)}`);
      return turn(L(`Leg ${what} an deine markierte Auslage an.`, `Lay ${what} off onto your marked meld.`), { cardIds: [hit.cardId], meldIds: [hit.meldId] });
    }
    const ids = findTutorialMeld(c.hand, { skipQueens: reservesQueens(c.hand) });
    if (ids && c.hand.length - ids.length >= 1) {
      return turn(L(`Leg ${tCombo(tByIds(c.hand, ids))} aus.`, `Meld ${tCombo(tByIds(c.hand, ids))}.`), { cardIds: ids, targets: ['confirmMeldBtn'] });
    }
    const pick = suggestTutorialDiscard(c.hand);
    if (pick) {
      return turn(L(`Wirf eine Karte ab – zum Beispiel die ${tCard(pick)}.`, `Discard a card – the ${tCard(pick)}, for example.`), { cardIds: [pick.id], targets: ['discardBtn'] });
    }
    return turn(L('Leg aus, leg an oder wirf eine Karte ab.', 'Meld, lay off or discard a card.'));
  }

  function updateTutorial() {
    tutorialActive = tutorialHintsOn();
    const menuRow = el('tutorialHintsBtn');
    if (menuRow) menuRow.classList.toggle('hidden', !(tutorialProgress && lastState && lastState.tutorialMode && tutorialProgress.code === sessionCode && tutorialProgress.off && !tutorialProgress.finished));
    if (!tutorialActive || !lastState) { hideCoach(); return; }
    const prog = tutorialProgress;
    // The tutorial ends with the scoring of round 1 - also when the next round
    // was started from elsewhere.
    if (lastState.phase === 'gameOver' || (lastState.roundNumber > 1 && lastState.phase !== 'cutting')) {
      finishTutorial();
      return;
    }
    const c = tutorialContext();
    const step = tutorialPick(c, prog);
    const doneCount = TUTORIAL_MANDATORY.filter((s) => tutorialPassed(prog, s.key)).length;
    const counter = `${Math.min(doneCount + 1, TUTORIAL_MANDATORY.length)} / ${TUTORIAL_MANDATORY.length}`;
    el('coachCountText').textContent = counter;
    el('tutorialProgressBtn').setAttribute('aria-label', L(`Schritt ${counter} – Fortschritt anzeigen`, `Step ${counter} – show progress`));

    // Round end: the scoring lesson docks in the sheet instead of covering it.
    const atRoundEnd = lastState.phase === 'roundEnd';
    el('resultCoach').classList.toggle('hidden', !(atRoundEnd && step && step.key === 'roundend'));
    if (atRoundEnd && step && step.key === 'roundend') {
      el('resultCoachTitle').textContent = step.title(c);
      el('resultCoachText').textContent = step.text(c);
    }
    const shown = atRoundEnd ? null : step || passiveCoachLine(c);
    const coach = el('tutorialCoach');
    if (!shown) {
      coach.classList.add('hidden');
      if (step && tutorialCurrentStep !== step.key) tutorialCurrentStep = step.key;
      tutorialHighlight = null;
      syncTutorialLayout();
      requestAnimationFrame(() => applyTutorialHighlight(null));
      return;
    }
    const key = step ? step.key : null;
    if (step && tutorialCurrentStep !== key) {
      tutorialCurrentStep = key;
      tutorialBaseline = step.metric ? step.metric(c) : 0;
    }
    if (!step) tutorialCurrentStep = null;
    el('coachTitle').textContent = step ? step.title(c) : shown.title;
    el('tutorialText').textContent = step ? step.text(c) : shown.text;
    coach.dataset.step = key || 'passive';
    coach.classList.toggle('passive', !step);
    el('tutorialNextBtn').classList.toggle('hidden', !(step && step.info));
    coach.classList.remove('hidden');
    syncTutorialLayout();
    // Marks after the synchronous render (rAF): hand and melds are rebuilt on every state.
    tutorialHighlight = step ? (typeof step.highlight === 'function' ? step.highlight(c) : null) : (shown.highlight || null);
    requestAnimationFrame(() => applyTutorialHighlight(tutorialHighlight));
  }

  function finishTutorial() {
    const prog = tutorialSessionProgress();
    if (!prog || prog.finished) return;
    prog.finished = true;
    if (!prog.done.includes('roundend')) prog.done.push('roundend');
    saveTutorial();
    tutorialActive = false;
    hideCoach();
    el('tutorialDoneOverlay').classList.remove('hidden');
  }

  function stopTutorial() {
    const prog = tutorialSessionProgress();
    if (!prog) return;
    prog.off = true;
    saveTutorial();
    tutorialActive = false;
    hideCoach();
    showToast(L('Tutorial beendet. Die Hinweise holst du im Menü zurück.', 'Tutorial ended. You can bring the hints back from the menu.'));
    try { updateTutorial(); } catch (e) { /* menu row only */ }
  }

  // --- Sharing results (Wordle style): emoji are content here, not icons ---
  function shareDay(iso) {
    return fmtDay(iso, { day: 'numeric', month: 'short', timeZone: 'UTC' });
  }
  // The system share sheet where it exists, else the clipboard.
  async function shareResult(text) {
    const url = `${window.location.origin}/`;
    if (navigator.share) {
      try {
        await navigator.share({ title: 'Pik Dame', text, url });
        return;
      } catch (e) {
        if (e && e.name === 'AbortError') return; // the player closed the sheet
      }
    }
    try {
      await navigator.clipboard.writeText(`${text}\n${url}`);
      showHint(L('Ergebnis kopiert - jetzt einfügen und teilen.', 'Result copied - paste it to share.'), false);
    } catch (e) {
      showHint(L('Teilen ist hier nicht möglich.', 'Sharing is not available here.'), true);
    }
  }
  function challengeShareText(r) {
    const queens = r.queens > 0
      ? L(`♠Q ${r.queens}× erwischt`, `♠Q caught ${r.queens}×`)
      : L('♠Q nie erwischt', '♠Q never caught');
    const place = r.players ? L(`Platz ${r.rank} von ${r.players}`, `Rank ${r.rank} of ${r.players}`) : L(`Platz ${r.rank}`, `Rank ${r.rank}`);
    return `${L('Pik Dame · Tages-Challenge', 'Pik Dame · Daily challenge')} ${shareDay(r.date)}\n${place} · ${r.score} ${L('Punkte', 'points')} · ${queens}`;
  }
  const shareBtnHtml = (cls, de, en) =>
    `<button type="button" class="btn-secondary shareBtn ${cls}"><svg class="icon" aria-hidden="true"><use href="#i-share"/></svg><span>${L(de, en)}</span></button>`;

  let lastChallengeBoard = null;
  let challengeIntroResult = null; // today's ranked result in the intro sheet, for sharing
  const magnetText = (m) => L(`Damen-Magnet des Tages: ${m.name} (${m.queens}×)`, `Queen magnet of the day: ${m.name} (${m.queens}×)`);
  const withIcon = (name, text) => `${iconHtml(name)} <span>${escapeHtml(text)}</span>`;
  function renderChallengeBoard() {
    if (!lastChallengeBoard) return;
    const body = el('resultBody');
    if (!body) return;
    const old2 = body.querySelector('.challengeBoardBox');
    if (old2) old2.remove();
    const b = lastChallengeBoard;
    const box = document.createElement('div');
    box.className = 'challengeBoardBox';
    // Own row: by name; by rank only when the name is not on the board.
    const myName = (currentName() || '').toLowerCase();
    const byName = (b.board || []).some((e) => (e.name || '').toLowerCase() === myName);
    const isMine = (e) => (byName ? (e.name || '').toLowerCase() === myName : !!b.yourRank && e.rank === b.yourRank);
    const ownRowShown = (b.board || []).some(isMine);
    const rows = (b.board || [])
      .map((e) => `<tr${isMine(e) ? ' class="isMe"' : ''}><td>${e.rank}.</td><td class="nameCell">${escapeHtml(e.name)}</td><td>${fmtNum(e.score)}</td></tr>`)
      .join('');
    // '7 Tage sichtbar' jetzt wörtlich: kompakter Rückblick auf die letzten
    // Tage (Tagessieger + eigener Platz), aufklappbar unter der Tagesliste.
    const past = (b.history || []).filter((d) => d.date !== b.date && (d.players > 0 || d.yourScore != null));
    const histRows = past
      .map((d) => {
        const win = d.top && d.top[0]
          ? `${iconHtml('medal')} <span>${escapeHtml(d.top[0].name)} · ${fmtNum(d.top[0].score)}</span>`
          : escapeHtml(L('keine Teilnahmen', 'no entries'));
        const mine = d.yourScore != null
          ? ` — ${L(`du: ${fmtNum(d.yourScore)} (Platz ${d.yourRank})`, `you: ${fmtNum(d.yourScore)} (rank ${d.yourRank})`)}`
          : '';
        const magnet = d.magnet ? ` · ${iconHtml('magnet')} <span>${escapeHtml(d.magnet.name)}</span>` : '';
        return `<div class="challengeHistDay"><span>${escapeHtml(fmtDay(d.date, { day: 'numeric', month: 'short', timeZone: 'UTC' }))}</span><span>${win}${magnet}${escapeHtml(mine)}</span></div>`;
      })
      .join('');
    const histBlock = histRows
      ? `<details class="challengeHistory"><summary>${L('Vergangene Tage', 'Past days')} (${past.length})</summary>${histRows}</details>`
      : '';
    // Wochenwertung: beste 5 Tages-Scores der laufenden Woche (Mo-So).
    const wk = b.weekly;
    const weeklyBlock = wk && wk.players > 0
      ? `<div class="challengeWeekly"><h4>${iconHtml('calendar')}<span>${L('Wochenwertung', 'Weekly ranking')}</span> <span class="weekRange">${escapeHtml(wk.week)}</span></h4>` +
        wk.top.map((e) => `<div class="challengeHistDay"><span>#${e.rank} ${escapeHtml(e.name)}</span><span>${fmtNum(e.weekScore)} ${L('Pkt', 'pts')} · ${fmtCount(e.days, 'day')}</span></div>`).join('') +
        (wk.yourRank && wk.yourRank > wk.top.length
          ? `<div class="challengeHistDay"><span>#${wk.yourRank} ${L('du', 'you')}</span><span>${fmtNum(wk.yourScore)} ${L('Pkt', 'pts')}</span></div>`
          : '') +
        `<p class="weeklyHint">${L('Deine besten 5 Tage der Woche zählen.', 'Your best 5 days of the week count.')}</p></div>`
      : '';
    // The table row already says rank and score; the line only helps when
    // the own row is not on the board.
    const yourLine = L(`Dein Ergebnis: ${fmtNum(b.yourScore)} Punkte${b.yourRank ? ` · Platz ${b.yourRank}` : ''}`, `Your result: ${fmtNum(b.yourScore)} points${b.yourRank ? ` · rank ${b.yourRank}` : ''}`);
    const yourBlock = ownRowShown || b.yourScore == null ? '' : `<p class="challengeYour">${escapeHtml(yourLine)}</p>`;
    const magnetBlock = b.magnet ? `<p class="challengeMagnet">${withIcon('magnet', magnetText(b.magnet))}</p>` : '';
    const shareBlock = b.yourRank ? shareBtnHtml('challengeShareBtn', 'Ergebnis teilen', 'Share result') : '';
    box.innerHTML = `<h3>${iconHtml('podium')}<span>${L('Tages-Challenge', 'Daily challenge')} ${escapeHtml(fmtDay(b.date))}</span></h3>
      ${yourBlock}${shareBlock}
      <table class="statsTable challengeTable"><tbody>${rows}</tbody></table>${magnetBlock}${weeklyBlock}${histBlock}`;
    const shareBtn = box.querySelector('.challengeShareBtn');
    if (shareBtn) {
      shareBtn.addEventListener('click', () => shareResult(challengeShareText({
        date: b.date, rank: b.yourRank, players: b.players, score: b.yourScore, queens: b.yourQueens,
      })));
    }
    body.appendChild(box);
  }

  // --- Daily challenge --------------------------------------------------------
  el('challengeBtn').addEventListener('click', () => {
    // Today's challenge is still running (app was minimised or closed):
    // the tile continues it instead of dealing a fresh game.
    if (resumeCode && resumeIsChallenge) {
      window.location.href = `${window.location.pathname}?session=${encodeURIComponent(resumeCode)}`;
      return;
    }
    // Explain first, play second: the cold start straight into a running
    // game left people wondering what was going on.
    el('challengeTopLine').textContent = '…';
    el('challengePlayedNote').classList.add('hidden');
    el('challengeShareBtn').classList.add('hidden');
    el('challengeStartBtn').classList.remove('hidden');
    el('challengeCancelBtn').textContent = L('Abbrechen', 'Cancel');
    el('challengeMagnetLine').classList.add('hidden');
    el('challengeIntroOverlay').classList.remove('hidden');
    el('challengeWeekLine').textContent = '';
    challengeTrendData = null;
    renderChallengeTrend();
    const trendName = el('nameInput').value.trim();
    fetchChallengeBoard(trendName)
      .then((d) => {
        challengeTrendData = (d && d.trend) || { dates: [], me: null, top: [] };
        renderChallengeTrend();
        const top = d && d.board && d.board[0];
        // Before your own game the server sends only how many played today.
        const hidden = !!d && d.revealed === false && d.players > 0;
        el('challengeTopLine').textContent = hidden
          ? L(`Die Punkte siehst du nach deinem Spiel – heute ${d.players === 1 ? 'hat schon 1 Person' : `haben schon ${d.players} Leute`} gespielt.`,
            `You see the scores after your game – ${d.players} played today so far.`)
          : top
            ? `🥇 ${top.name} – ${top.score} ${L('Punkte', 'points')}${d.board[1] ? `  ·  🥈 ${d.board[1].name} – ${d.board[1].score}` : ''}`
            : L('Noch niemand - sichere dir Platz 1!', 'Nobody yet - claim first place!');
        // Attempt used: no start, the sheet is the day's board.
        const played = !!(d && d.attempted);
        el('challengePlayedNote').classList.toggle('hidden', !played);
        challengeIntroResult = d && d.you ? { ...d.you, date: d.date } : null;
        el('challengeShareBtn').classList.toggle('hidden', !challengeIntroResult);
        el('challengeStartBtn').classList.toggle('hidden', played);
        if (played) el('challengeCancelBtn').textContent = L('Schließen', 'Close');
        el('challengeMagnetLine').classList.toggle('hidden', !(d && d.magnet));
        if (d && d.magnet) el('challengeMagnetLine').innerHTML = withIcon('magnet', magnetText(d.magnet));
        // Wochenwertung: beste 5 von 7 Tagen - belohnt Regelmaessigkeit statt
        // eines einzelnen Gluckstreffers.
        // ACHTUNG: getWeekly liefert das Feld "top" (nicht "board" wie die
        // Tagesliste) - mit dem falschen Namen bliebe die Zeile still leer.
        const week = (d && d.weekly && d.weekly.top) || [];
        el('challengeWeekLine').textContent = week.length
          ? week.slice(0, 3).map((e, i) => `${['🥇', '🥈', '🥉'][i]} ${e.name} – ${e.weekScore}`).join('  ·  ')
            + (hidden ? L(' (ohne heute)', ' (without today)') : '')
          : L('Diese Woche noch offen.', 'Nothing this week yet.');
      })
      .catch(() => {
        el('challengeTopLine').textContent = L('Bestenliste gerade nicht erreichbar.', 'Leaderboard unavailable right now.');
        el('challengeWeekLine').textContent = '';
      });
  });
  /** Today's board for `name`; the account token proves the name, so the
   *  server reveals today's scores only to whoever really played. */
  function fetchChallengeBoard(name) {
    const token = accountToken();
    return fetch(`/challengeboardz${name ? `?name=${encodeURIComponent(name)}` : ''}`, token ? { headers: { 'X-Account-Token': token } } : undefined)
      .then((r) => (r.ok ? r.json() : null));
  }
  el('challengeShareBtn').addEventListener('click', () => {
    if (challengeIntroResult) shareResult(challengeShareText(challengeIntroResult));
  });
  // My points vs. the top 5 others of the last 14 days. Optional: collapsed
  // unless opened before (remembered); uPlot loads only when it opens.
  const TREND_KEY = 'pikdame_challenge_trend';
  let challengeTrendData = null; // null = loading, else {dates, me, top}
  let challengeTrendPlot = null;
  let chartLibPromise = null;
  function loadScriptOnce(src) {
    return new Promise((resolve) => {
      const tag = document.createElement('script');
      tag.src = src;
      tag.addEventListener('load', () => resolve(true));
      tag.addEventListener('error', () => resolve(false));
      document.head.appendChild(tag);
    });
  }
  function loadChartLib() {
    if (typeof uPlot === 'function' && typeof window.uplotTouch === 'function') return Promise.resolve(true);
    if (chartLibPromise) return chartLibPromise;
    const css = document.createElement('link');
    css.rel = 'stylesheet';
    css.href = '/vendor-uplot.css';
    document.head.appendChild(css);
    chartLibPromise = loadScriptOnce('/vendor-uplot.js')
      .then((ok) => ok && loadScriptOnce('/uplot-touch.js'))
      .then((ok) => {
        if (!ok) chartLibPromise = null; // offline: try again next time
        return !!ok && typeof uPlot === 'function';
      });
    return chartLibPromise;
  }
  function renderChallengeTrend() {
    const open = storageGet(TREND_KEY) === 'on';
    const box = el('challengeTrend');
    el('challengeTrendBtn').setAttribute('aria-expanded', String(open));
    box.classList.toggle('hidden', !open);
    if (challengeTrendPlot) { challengeTrendPlot.destroy(); challengeTrendPlot = null; }
    if (!open) return;
    const trend = challengeTrendData;
    if (!trend) { box.textContent = '…'; return; }
    if (!trend.me && !trend.top.length) {
      box.textContent = L('In den letzten 14 Tagen hat noch niemand die Challenge gespielt.', 'Nobody has played the challenge in the last 14 days.');
      return;
    }
    box.textContent = '';
    loadChartLib().then((ok) => {
      if (!ok || storageGet(TREND_KEY) !== 'on' || challengeTrendData !== trend) return;
      if (challengeTrendPlot) challengeTrendPlot.destroy();
      challengeTrendPlot = buildTrendPlot(box, trend);
    }).catch(() => { box.textContent = L('Diagramm gerade nicht verfügbar.', 'Chart unavailable right now.'); });
  }
  // Fixed categorical order by rank in the window (validated light palette;
  // the overlay card is light in every theme). "Me" is ink, never a hue.
  const TREND_COLORS = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4'];
  function buildTrendPlot(box, trend) {
    const css = getComputedStyle(box);
    const muted = css.getPropertyValue('--text-muted').trim() || 'rgba(0,0,0,0.56)';
    const ink = css.getPropertyValue('--card-ink').trim() || '#1d1d1f';
    // Game days as UTC midnights (labels in UTC too): ticks sit on the points
    // and no local DST shift can move a label to the neighbouring day.
    const xs = trend.dates.map((d) => Date.parse(`${d}T00:00:00Z`) / 1000);
    const dayLabel = (ts) => fmtDate(ts * 1000, { day: 'numeric', month: 'numeric', timeZone: 'UTC' });
    const people = trend.top.map((p, i) => ({ ...p, color: TREND_COLORS[i], me: false }));
    if (trend.me) people.push({ ...trend.me, name: L('Du', 'You'), color: ink, me: true });
    const axis = { stroke: muted, grid: { stroke: 'rgba(0,0,0,0.08)', width: 1 }, ticks: { show: false }, font: '11px sans-serif' };
    const plotBox = document.createElement('div');
    const table = document.createElement('table');
    table.className = 'trendTable';
    box.append(plotBox, table);
    // Legend + table view in one: name, value on the selected day, 14-day sum.
    const renderTable = (idx) => {
      const head = idx == null ? L('Tag', 'Day') : dayLabel(xs[idx]);
      table.innerHTML = `<thead><tr><th></th><th>${escapeHtml(head)}</th><th>${escapeHtml(L('14 Tage', '14 days'))}</th></tr></thead><tbody>` +
        people.map((p) => `<tr class="${p.me ? 'me' : ''}"><td><i style="background:${p.color}"></i>${escapeHtml(p.name)}</td>` +
          `<td>${idx == null || p.scores[idx] == null ? '–' : fmtNum(p.scores[idx])}</td><td>${fmtNum(p.total)}</td></tr>`).join('') +
        '</tbody>';
    };
    renderTable(null);
    const xRange = [xs[0] - 21600, xs[xs.length - 1] + 21600];
    return new uPlot({
      width: Math.max(240, box.clientWidth || 300),
      height: 160,
      padding: [8, 8, 0, 0],
      cursor: { drag: { x: true, y: false } },
      legend: { show: false },
      scales: {
        x: { time: false, range: () => xRange },
        y: { range: (u, min, max) => [0, Math.max(100, (max || 0) * 1.1)] },
      },
      axes: [
        { ...axis, space: 34, values: (u, vals) => vals.map(dayLabel), incrs: [86400, 172800, 345600, 604800] },
        { ...axis, size: 40 },
      ],
      series: [
        {},
        ...people.map((p) => ({
          label: p.name,
          stroke: p.color,
          width: p.me ? 3 : 1.5,
          points: { size: p.me ? 8 : 6, fill: p.color, stroke: '#fff', width: 1 },
          spanGaps: true,
        })),
      ],
      hooks: { setCursor: [(u) => renderTable(u.cursor.idx)] },
      plugins: typeof window.uplotTouch === 'function'
        ? [window.uplotTouch({ onReset: (u) => u.setScale('x', { min: xRange[0], max: xRange[1] }) })]
        : [],
    }, [xs, ...people.map((p) => p.scores)], plotBox);
  }
  el('challengeTrendBtn').addEventListener('click', () => {
    storageSet(TREND_KEY, storageGet(TREND_KEY) === 'on' ? 'off' : 'on');
    renderChallengeTrend();
  });
  el('challengeStartBtn').addEventListener('click', () => {
    el('challengeIntroOverlay').classList.add('hidden');
    send({ type: 'startChallenge', name: currentName(), accountToken: accountToken() || undefined });
  });
  // --- Stammtisch ------------------------------------------------------------
  const STAMMTISCH_KEY = 'pikdame_stammtische';
  const stammtischChipInfo = {}; // code -> latest stammtischInfo (chip + sheet)
  let stammtischSheetCode = null;
  const winsText = (n) => fmtCount(n, 'win');
  const gamesText = (n) => fmtCount(n, 'game');
  function recentStammtische() {
    try { const v = JSON.parse(storageGet(STAMMTISCH_KEY) || '[]'); return Array.isArray(v) ? v : []; } catch (e) { return []; }
  }
  function rememberStammtisch(info) {
    const list = recentStammtische().filter((t) => t.code !== info.code);
    list.unshift({ code: info.code, name: info.name, at: Date.now() });
    storageSet(STAMMTISCH_KEY, JSON.stringify(list.slice(0, 3)));
    renderStammtischRecent();
  }
  function renderStammtischRecent() {
    const box = el('stammtischRecent');
    if (!box) return;
    const list = recentStammtische();
    box.classList.toggle('hidden', list.length === 0);
    box.innerHTML = list
      .map((t) => `<button type="button" class="stRecentRow" data-code="${escapeHtml(t.code)}" aria-haspopup="dialog" title="${escapeHtml(L('Bilanz ansehen', 'View the record'))}">` +
        `<svg class="icon" aria-hidden="true"><use href="#i-group"/></svg><span class="stName">${escapeHtml(t.name)}</span>` +
        `<small class="stChipInfo"></small><svg class="icon stGo" aria-hidden="true"><use href="#i-chevron"/></svg></button>`)
      .join('');
    box.querySelectorAll('button[data-code]').forEach((btn) => {
      btn.addEventListener('click', () => openStammtischSheet(btn.dataset.code));
      const known = stammtischChipInfo[btn.dataset.code]; // e.g. after a language switch
      if (known) btn.querySelector('.stChipInfo').textContent = stammtischLeadText(known);
    });
    // Ask for the record so the chip names the leader without a tap.
    for (const t of list) send({ type: 'getStammtisch', code: t.code });
  }
  /** The chip's one-liner: who leads the overall record (not the best-of-3 series). */
  function stammtischLeadText(info) {
    const ranked = (info.members || []).filter((m) => m.games > 0).sort((a, b) => b.wins - a.wins);
    const top = ranked[0];
    if (!info.gamesPlayed) return L('Noch keine Partie', 'No game yet');
    if (!top || !top.wins) return gamesText(info.gamesPlayed);
    if (ranked.length === 1) return `${top.name} · ${winsText(top.wins)}`;
    if (ranked[1].wins === top.wins) return L(`Gleichstand · je ${winsText(top.wins)}`, `Tied · ${winsText(top.wins)} each`);
    return L(`${top.name} führt · ${winsText(top.wins)}`, `${top.name} leads · ${winsText(top.wins)}`);
  }
  function updateStammtischChip(info) {
    const btn = document.querySelector(`#stammtischRecent button[data-code="${CSS.escape(info.code)}"]`);
    if (!info.exists) {
      delete stammtischChipInfo[info.code];
      if (stammtischSheetCode === info.code) closeStammtischSheet();
      if (!btn) return;
      // Gone (pruned after months of silence): forget it quietly.
      storageSet(STAMMTISCH_KEY, JSON.stringify(recentStammtische().filter((t) => t.code !== info.code)));
      btn.remove();
      if (!el('stammtischRecent').children.length) el('stammtischRecent').classList.add('hidden');
      return;
    }
    stammtischChipInfo[info.code] = info;
    if (btn) btn.querySelector('.stChipInfo').textContent = stammtischLeadText(info);
    if (stammtischSheetCode === info.code) renderStammtischSheet();
  }
  function seriesLineHtml(sum) {
    const ser = sum.series;
    const byKey = {};
    for (const m of sum.members || []) byKey[m.name.toLowerCase()] = m.name;
    const parts = Object.entries(ser.wins || {})
      .sort((a, b) => b[1] - a[1])
      .map(([k, n]) => `${escapeHtml(byKey[k] || k)} ${n}`);
    const score = parts.length ? parts.join(' – ') : L('noch 0:0', 'still 0:0');
    if (ser.winner) {
      return `<svg class="icon" aria-hidden="true"><use href="#i-trophy"/></svg> <span>${escapeHtml(L(`${ser.winner} hat Serie ${ser.no} gewonnen`, `${ser.winner} won series ${ser.no}`))}</span><small>${score}</small>`;
    }
    return `${escapeHtml(L(`Serie ${ser.no} · Best of ${ser.bestOf}`, `Series ${ser.no} · best of ${ser.bestOf}`))}: ${score}<small>${escapeHtml(
      L(`${fmtCount(ser.needed, 'win')} ${ser.needed === 1 ? 'entscheidet' : 'entscheiden'} · Spiel ${ser.games + 1} von ${ser.bestOf}`, `${fmtCount(ser.needed, 'win')} ${ser.needed === 1 ? 'decides' : 'decide'} · game ${ser.games + 1} of ${ser.bestOf}`)
    )}</small>`;
  }
  function renderStammtisch() {
    const box = el('stammtischSection');
    if (!box) return;
    if (!stammtischInfo || !stammtischSummary) {
      box.classList.add('hidden');
      return;
    }
    box.classList.remove('hidden');
    const sum = stammtischSummary;
    // Pairwise record for the humans at THIS table: "who finished ahead".
    const humans = ((lastState && lastState.players) || []).filter((p) => !p.isBot).map((p) => p.name);
    box.querySelector('#stammtischBody').innerHTML =
      `<div class="stName">🍻 ${escapeHtml(sum.name)} <span class="stCode">${escapeHtml(sum.code)}</span> <small>· ${gamesText(sum.gamesPlayed)}</small></div>` +
      stammtischStatsHtml(sum, { pairNames: humans });
  }
  /** Head-to-head pairs. Given names: those, in seat order (lobby); else all
   *  members, closest records first (chip sheet). */
  function stammtischPairs(sum, names) {
    const list = names || (sum.members || []).map((m) => m.name);
    const out = [];
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const pw = sum.pairwise && sum.pairwise[list[i].toLowerCase()];
        const rec = pw && pw[list[j].toLowerCase()];
        if (rec && rec.ahead + rec.behind > 0) out.push({ a: list[i], b: list[j], rec });
      }
    }
    if (!names) {
      const gap = (p) => Math.abs(p.rec.ahead - p.rec.behind);
      out.sort((x, y) => gap(x) - gap(y) || (y.rec.ahead + y.rec.behind) - (x.rec.ahead + x.rec.behind));
    }
    return out;
  }
  function stammtischGoalEventText(g) {
    if (g.type === 'week') {
      return g.streak > 1
        ? L(`Wochenziel geschafft – ${g.streak} Wochen in Folge!`, `Weekly goal reached – ${g.streak} weeks in a row!`)
        : L(`Wochenziel geschafft: ${fmtCount(g.goal, 'game')} diese Woche!`, `Weekly goal reached: ${fmtCount(g.goal, 'game')} this week!`);
    }
    if (g.type === 'level') return L(`Stammtisch-Stufe ${g.level} erreicht!`, `Stammtisch level ${g.level} reached!`);
    return '';
  }
  /** The group's level, this week's target and the streak of reached weeks. */
  function stammtischGoalsHtml(goals) {
    if (!goals || !goals.week) return '';
    const wk = goals.week;
    const games = Math.max(0, Number(wk.games) || 0);
    const goal = Math.max(1, Number(wk.goal) || 1);
    const pct = Math.min(100, Math.round((games / goal) * 100));
    const weekText = wk.reached
      ? L(`Wochenziel geschafft · ${games}/${goal}`, `Weekly goal reached · ${games}/${goal}`)
      : L(`${games}/${goal} Partien diese Woche`, `${games}/${goal} games this week`);
    const extra = [];
    if (goals.streak > 1) extra.push(L(`${goals.streak} Wochen in Folge`, `${goals.streak} weeks in a row`));
    if (goals.weeksReached) extra.push(L(`${goals.weeksReached}× geschafft`, `reached ${goals.weeksReached}×`));
    return `<div class="stGoals">` +
      `<div class="stGoalLevel"><svg class="icon" aria-hidden="true"><use href="#i-crown"/></svg>` +
      `<b>${escapeHtml(L(`Stufe ${goals.level}`, `Level ${goals.level}`))}</b>` +
      `<small>${escapeHtml(L(`${goals.into}/${goals.need} Punkte`, `${goals.into}/${goals.need} points`))}</small></div>` +
      `<div class="stGoalWeek${wk.reached ? ' reached' : ''}">` +
      `<svg class="icon" aria-hidden="true"><use href="#i-${wk.reached ? 'check' : 'target'}"/></svg>` +
      `<span>${escapeHtml(weekText)}</span>` +
      (extra.length ? `<small>${escapeHtml(extra.join(' · '))}</small>` : '') +
      `<span class="stWeekBar" role="progressbar" aria-valuemin="0" aria-valuemax="${goal}" aria-valuenow="${Math.min(games, goal)}"` +
      ` aria-label="${escapeHtml(L('Wochenziel', 'Weekly goal'))}"><i style="width:${pct}%"></i></span>` +
      `</div></div>`;
  }
  /** Series, standings and head-to-head: one renderer for the lobby and the chip sheet. */
  function stammtischStatsHtml(sum, { pairNames = null, maxPairs = Infinity } = {}) {
    const members = sum.members || [];
    const rows = members
      .map((m) => `<tr><td class="stName">${nameWithHeart(m.name)}</td><td>${m.wins}</td><td>${m.games}</td><td>${m.avg}</td></tr>`)
      .join('');
    const pairs = stammtischPairs(sum, pairNames).slice(0, maxPairs)
      .map(({ a, b, rec }) => `<b>${escapeHtml(a)}</b> ${rec.ahead}:${rec.behind} <b>${escapeHtml(b)}</b>`);
    return stammtischGoalsHtml(sum.goals) +
      (sum.series ? `<div class="stSeries">${seriesLineHtml(sum)}</div>` : '') +
      (members.some((m) => m.games > 0)
        ? `<table class="stTable"><thead><tr><th>${L('Spieler', 'Player')}</th><th>${L('Siege', 'Wins')}</th><th>${L('Partien', 'Games')}</th><th>Ø</th></tr></thead><tbody>${rows}</tbody></table>`
        : `<p class="lobby-hint">${L('Noch keine Partie gespielt - die Bilanz beginnt mit der ersten.', 'No match yet - the record starts with the first one.')}</p>`) +
      (pairs.length ? `<div class="stPairs">${L('Direktvergleich', 'Head to head')}: ${pairs.join(' · ')}</div>` : '');
  }
  // Start-screen chip -> its record, with the way to the table one tap further.
  function renderStammtischSheet() {
    const code = stammtischSheetCode;
    if (!code) return;
    const info = stammtischChipInfo[code];
    const known = recentStammtische().find((t) => t.code === code);
    el('stammtischSheetName').textContent = (info && info.name) || (known && known.name) || code;
    el('stammtischSheetMeta').textContent = info ? `Code ${code} · ${gamesText(info.gamesPlayed || 0)}` : `Code ${code}`;
    el('stammtischSheetBody').innerHTML = info
      ? stammtischStatsHtml(info, { maxPairs: 3 })
      : `<p class="lobby-hint">${escapeHtml(L('Bilanz wird geladen …', 'Loading the record …'))}</p>`;
  }
  function openStammtischSheet(code) {
    stammtischSheetCode = code;
    renderStammtischSheet();
    el('stammtischSheetOverlay').classList.remove('hidden');
    send({ type: 'getStammtisch', code }); // fresh standings; a known code is never a failed attempt
  }
  function closeStammtischSheet() {
    stammtischSheetCode = null;
    el('stammtischSheetOverlay').classList.add('hidden');
  }
  el('stammtischSheetJoinBtn').addEventListener('click', () => {
    const code = stammtischSheetCode;
    closeStammtischSheet();
    if (code) guardOpenGame('join', () => send({ type: 'joinSession', code, name: currentName(), accountToken: accountToken() || undefined, tablePrefs: tablePrefs() }), code);
  });
  el('stammtischSheetCloseBtn').addEventListener('click', closeStammtischSheet);
  el('stammtischSheetOverlay').addEventListener('click', (ev) => {
    if (ev.target === el('stammtischSheetOverlay')) closeStammtischSheet();
  });
  // With accounts on the server, founding and "my tables" need a sign-in
  // (the account owns the table); joining by code stays open for guests.
  el('stammtischBtn').addEventListener('click', () => {
    const needsLogin = accountsServer && !accountUsername;
    const mine = accountsServer && !!accountUsername;
    el('stammtischNameInput').value = '';
    el('stammtischLoginBox').classList.toggle('hidden', !needsLogin);
    el('stammtischFound').classList.toggle('hidden', needsLogin);
    el('stammtischMine').classList.toggle('hidden', !mine);
    if (mine) {
      el('stammtischList').innerHTML = '<p class="stEmpty">…</p>';
      send({ type: 'listStammtische', name: currentName(), accountToken: accountToken() || undefined });
    }
    el('stammtischOverlay').classList.remove('hidden');
  });
  el('stammtischLoginBtn').addEventListener('click', () => {
    el('stammtischOverlay').classList.add('hidden');
    el('accountBtn').click();
  });
  function stammtischAge(ms) {
    const days = Math.floor((Date.now() - ms) / 86400000);
    if (days <= 0) return L('heute', 'today');
    if (days === 1) return L('gestern', 'yesterday');
    return L(`vor ${days} Tagen`, `${days} days ago`);
  }
  function renderStammtischList(tables) {
    const box = el('stammtischList');
    box.innerHTML = '';
    if (!tables.length) {
      box.innerHTML = `<p class="stEmpty">${escapeHtml(L('Noch keine - gründe unten deinen ersten.', 'None yet - found your first one below.'))}</p>`;
      return;
    }
    for (const t of tables) {
      const row = document.createElement('div');
      row.className = 'stRow';
      const players = L(`${t.members.length} Spieler`, `${t.members.length} players`);
      row.innerHTML =
        `<button type="button" class="stJoin"><b>🍻 ${escapeHtml(t.name)}</b>` +
        `<span>${escapeHtml(`${t.code} · ${players} · ${stammtischAge(t.lastActivity)}`)}</span>` +
        `<span>${escapeHtml(t.members.join(', '))}</span></button>` +
        `<button type="button" class="stAction"><span>${escapeHtml(t.isOwner ? L('Löschen', 'Delete') : L('Verlassen', 'Leave'))}</span></button>`;
      row.querySelector('.stJoin').addEventListener('click', () => {
        el('stammtischOverlay').classList.add('hidden');
        guardOpenGame('join', () => send({ type: 'joinSession', code: t.code, name: currentName(), accountToken: accountToken() || undefined, tablePrefs: tablePrefs() }), t.code);
      });
      confirmByTap(row.querySelector('.stAction'), L('Wirklich?', 'Sure?'), () => {
        send({ type: t.isOwner ? 'deleteStammtisch' : 'leaveStammtisch', code: t.code, name: currentName(), accountToken: accountToken() || undefined });
        if (t.isOwner) {
          // Deleted for everyone: drop it from the start-screen chips too.
          storageSet(STAMMTISCH_KEY, JSON.stringify(recentStammtische().filter((r) => r.code !== t.code)));
          renderStammtischRecent();
        }
      });
      box.appendChild(row);
    }
  }
  el('stammtischCancelBtn').addEventListener('click', () => el('stammtischOverlay').classList.add('hidden'));
  el('stammtischOverlay').addEventListener('click', (ev) => {
    if (ev.target === el('stammtischOverlay')) el('stammtischOverlay').classList.add('hidden');
  });
  el('stammtischCreateBtn').addEventListener('click', () => {
    const stammtischName = el('stammtischNameInput').value.trim();
    if (!stammtischName) {
      showToast(L('Bitte einen Namen für den Stammtisch eingeben.', 'Please enter a name for the table.'));
      return;
    }
    el('stammtischOverlay').classList.add('hidden');
    guardOpenGame('create', () => send({ type: 'createStammtisch', stammtischName, name: currentName(), accountToken: accountToken() || undefined, tablePrefs: tablePrefs() }));
  });
  el('stammtischNameInput').addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') el('stammtischCreateBtn').click();
  });
  try { renderStammtischRecent(); } catch (e) { /* cosmetic */ }

  // --- Daily puzzle --------------------------------------------------------
  // One hand, one question, the engine grades. The kind rotates by weekday
  // (game/DailyPuzzle.js): one meld, a whole turn, or going out. The arrows
  // browse past days: graded too, but no XP and nothing stored.
  let puzzleData = null; // {date, kind, hand, targetPoints, status, archive, today, epoch}
  const puzzleSelected = new Set();
  let puzzleLayPending = null; // ids awaiting the server's check before they become a group
  let puzzleGroups = []; // laid melds of a 'turn'/'out' puzzle (card id arrays)
  let puzzleBadGroup = 0; // 1-based meld the server rejected
  let puzzleSolutionIds = null;
  let puzzleSolutionMelds = null;
  const PUZZLE_KINDS = {
    meld: {
      name: () => L('Beste Auslage', 'Best meld'),
      question: () => L('Welche Karten ergeben zusammen die wertvollste Auslage? Tippe sie an und prüfe - die Regeln entscheiden.', 'Which cards together make the most valuable meld? Tap them and check - the rules decide.'),
    },
    turn: {
      name: () => L('Bester Zug', 'Best turn'),
      question: () => L('Lege jede Auslage einzeln aus (erst Karten wählen, dann „Auslegen“), so viele Punkte wie möglich. Eine Karte bleibt zum Abwerfen.', 'Lay each meld separately (pick its cards, then "Meld"), as many points as you can. One card stays for the discard.'),
    },
    out: {
      name: () => L('Ausmachen', 'Go out'),
      question: () => L('Lege jede Auslage einzeln aus - die letzte Karte wirfst du ab.', 'Lay each meld out separately - the last card is your discard.'),
    },
  };
  const puzzleKind = () => (puzzleData && PUZZLE_KINDS[puzzleData.kind] ? puzzleData.kind : 'meld');
  // Mirrors game/DailyPuzzle.js STAR_TRIES: [max tries for 3 stars, for 2].
  const PUZZLE_STAR_TRIES = { meld: [1, 2], turn: [1, 3], out: [1, 3] };
  function puzzleStarsFor(kind, tries) {
    const [three, two] = PUZZLE_STAR_TRIES[kind] || PUZZLE_STAR_TRIES.meld;
    if (!(tries >= 1)) return 0;
    return tries <= three ? 3 : tries <= two ? 2 : 1;
  }
  // Sprite stars: filled = earned; `possible` draws the still reachable ones as outlines.
  function puzzleStarsEl(n, possible) {
    const box = document.createElement('span');
    box.className = `puzzleStars${possible ? ' possible' : ''}`;
    box.setAttribute('role', 'img');
    box.setAttribute('aria-label', possible ? L(`${n} von 3 Sternen möglich`, `${n} of 3 stars possible`) : L(`${n} von 3 Sternen`, `${n} of 3 stars`));
    for (let i = 1; i <= 3; i++) box.insertAdjacentHTML('beforeend', `<svg class="icon${i <= n ? ' on' : ''}" aria-hidden="true"><use href="#i-star"/></svg>`);
    return box;
  }
  // Today: the stars still possible, then the earned ones plus the perfect run.
  // An archive day shows what was earned on the day itself.
  function renderPuzzleStars() {
    const row = el('puzzleStars');
    row.innerHTML = '';
    const st = puzzleData.status || {};
    let stars = 0;
    let possible = false;
    let text = '';
    if (puzzleData.archive) {
      stars = puzzleData.dayStars || 0;
      text = L('am Tag selbst', 'on the day itself');
    } else if (st.stars) {
      stars = st.stars;
      text = stars === 3 ? L('Perfekt - im ersten Versuch', 'Perfect - first try') : stars === 2 ? L('Gut gelöst', 'Well solved') : L('Gelöst', 'Solved');
    } else if (puzzleData.starsOn && !puzzleLocked(st, puzzleSolutionIds)) {
      stars = puzzleStarsFor(puzzleKind(), (st.tries || 0) + 1);
      possible = true;
      text = L('möglich', 'possible');
    }
    row.classList.toggle('hidden', !stars);
    if (!stars) return;
    row.appendChild(puzzleStarsEl(stars, possible));
    const label = document.createElement('span');
    label.textContent = text;
    row.appendChild(label);
    const run = !puzzleData.archive && st.stars === 3 && puzzleData.perfectStreak ? puzzleData.perfectStreak.current : 0;
    if (run >= 2) {
      const r = document.createElement('span');
      r.className = 'puzzleRun';
      r.textContent = L(`${run} Tage in Folge perfekt`, `${run} perfect days in a row`);
      row.appendChild(r);
    }
  }
  function openPuzzle() {
    el('puzzleOverlay').classList.remove('hidden');
    loadPuzzle(null);
  }
  // null = today, else an archive day (YYYY-MM-DD).
  function loadPuzzle(date) {
    puzzleSelected.clear();
    puzzleGroups = [];
    puzzleLayPending = null;
    puzzleBadGroup = 0;
    puzzleSolutionIds = null;
    puzzleSolutionMelds = null;
    puzzleData = null;
    el('puzzleHand').innerHTML = '';
    el('puzzleMelds').classList.add('hidden');
    el('puzzleTarget').textContent = '…';
    setPuzzleStatus('', '');
    send({ type: 'getPuzzle', name: currentName(), ...(date ? { date } : {}) });
  }
  // Calendar arithmetic on the date string (no 24-hour steps, see GameDay.js).
  function shiftDay(iso, n) {
    const [y, m, d] = String(iso).split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
  }
  function setPuzzleStatus(text, cls) {
    const n = el('puzzleStatus');
    n.textContent = text;
    n.className = `puzzleStatus${cls ? ` ${cls}` : ''}`;
  }
  // Solved or revealed (server status, so it survives a reload) ends today's
  // puzzle; a new day brings a fresh status without either flag.
  function puzzleLocked(status, solutionIds) {
    const st = status || {};
    return !!st.solved || !!st.revealed || !!solutionIds;
  }
  // Same order as the own hand at the table (suit or rank, see the toggle).
  function puzzleSort(a, b) {
    const dr = RANK_ORDER.indexOf(a.rank) - RANK_ORDER.indexOf(b.rank);
    if (handSortMode === 'rank') return dr || a.suit.localeCompare(b.suit);
    return a.suit.localeCompare(b.suit) || dr;
  }
  function puzzleTargetText() {
    const kind = puzzleKind();
    if (kind === 'out') return L('Ziel: alle Karten bis auf eine auslegen', 'Target: lay out every card but one');
    if (kind === 'turn') return L(`Ziel: ${puzzleData.targetPoints} Punkte in einem Zug`, `Target: ${puzzleData.targetPoints} points in one turn`);
    return L(`Ziel: ${puzzleData.targetPoints} Punkte in einer Auslage`, `Target: ${puzzleData.targetPoints} points in one meld`);
  }
  function renderPuzzle() {
    if (!puzzleData) return;
    const st = puzzleData.status || {};
    const kind = puzzleKind();
    const multi = kind !== 'meld';
    const done = puzzleLocked(st, puzzleSolutionIds);
    el('puzzleOverlay').dataset.kind = kind;
    el('puzzleQuestion').textContent = PUZZLE_KINDS[kind].question();
    el('puzzleDay').textContent = `${puzzleData.archive ? shareDay(puzzleData.date) : L('Heute', 'Today')} · ${PUZZLE_KINDS[kind].name()}`;
    el('puzzlePrevBtn').disabled = puzzleData.date <= puzzleData.epoch;
    el('puzzleNextBtn').disabled = !puzzleData.archive;
    el('puzzlePrevBtn').setAttribute('aria-label', L('Vorheriger Tag', 'Previous day'));
    el('puzzleNextBtn').setAttribute('aria-label', L('Nächster Tag', 'Next day'));
    el('puzzleTarget').textContent = puzzleTargetText()
      + (st.tries ? ` · ${L(`${st.tries}. Versuch`, `attempt ${st.tries}`)}` : '')
      + (puzzleData.archive ? ` · ${L('Archiv, ohne EP', 'archive, no XP')}` : '');
    // Laid melds of a multi-meld puzzle; after "Lösung zeigen" the solution.
    const groups = multi && puzzleSolutionMelds ? puzzleSolutionMelds : puzzleGroups;
    const meldsBox = el('puzzleMelds');
    meldsBox.innerHTML = '';
    meldsBox.classList.toggle('hidden', !multi || groups.length === 0);
    groups.forEach((ids, gi) => {
      const g = document.createElement('button');
      g.type = 'button';
      g.className = `puzzleMeld${puzzleBadGroup === gi + 1 ? ' bad' : ''}`;
      g.disabled = done;
      g.setAttribute('aria-label', L(`Auslage ${gi + 1}: zurück auf die Hand`, `Meld ${gi + 1}: back to the hand`));
      for (const id of ids) {
        const card = puzzleData.hand.find((c) => c.id === id);
        if (card) g.appendChild(cardEl(card, {}));
      }
      g.addEventListener('click', () => {
        puzzleGroups = puzzleGroups.filter((_, i) => i !== gi);
        puzzleBadGroup = 0;
        setPuzzleStatus('', '');
        renderPuzzle();
      });
      meldsBox.appendChild(g);
    });
    const laid = new Set(groups.flat());
    const box = el('puzzleHand');
    box.innerHTML = '';
    for (const card of puzzleData.hand.slice().sort(puzzleSort)) {
      if (laid.has(card.id)) continue;
      const cEl = cardEl(card, {
        selectable: !done,
        selected: puzzleSelected.has(card.id),
        onClick: () => {
          if (done) return;
          if (puzzleSelected.has(card.id)) puzzleSelected.delete(card.id);
          else puzzleSelected.add(card.id);
          renderPuzzle();
        },
      });
      if (puzzleSolutionIds && puzzleSolutionIds.includes(card.id)) cEl.classList.add('solution');
      box.appendChild(cEl);
    }
    el('puzzleLayBtn').classList.toggle('hidden', !multi || done);
    el('puzzleLayBtn').disabled = puzzleSelected.size < 3;
    el('puzzleCheckBtn').disabled = done || (multi ? puzzleGroups.length === 0 : puzzleSelected.size < 3);
    el('puzzleRevealBtn').classList.toggle('hidden', done);
    el('puzzleShareBtn').classList.toggle('hidden', puzzleData.archive || !(st.solved || st.revealed));
    // Reopened after a solve: say so - but never overwrite the fresh
    // "Gelöst! +30 EP" line right after the winning check.
    if (st.solved && !puzzleSolutionIds && !el('puzzleStatus').textContent) {
      setPuzzleStatus(`✅ ${L('Heute schon gelöst - morgen gibt es ein neues.', 'Solved today - a new one comes tomorrow.')}`, 'ok');
    } else if (st.revealed && !puzzleSolutionIds && !el('puzzleStatus').textContent) {
      setPuzzleStatus(L('Lösung heute schon angezeigt - morgen gibt es ein neues.', 'Solution already shown today - a new one comes tomorrow.'), '');
    }
    renderPuzzleStars();
  }
  // Wordle style: one red square per miss, green for the solve.
  function puzzleShareText() {
    const st = puzzleData.status || {};
    const tries = Math.max(1, st.tries || 1);
    const stars = st.stars ? ` ${'★'.repeat(st.stars)}${'☆'.repeat(3 - st.stars)}` : '';
    const line = st.solved
      ? `${L(`Gelöst im ${tries}. Versuch`, `Solved on try ${tries}`)} ${'🟥'.repeat(tries - 1)}🟩${stars}`
      : `${L('Lösung angesehen', 'Looked at the solution')} ${'🟥'.repeat(st.tries || 0)}⬛`;
    return `${L('Pik Dame · Tagesrätsel', 'Pik Dame · Daily puzzle')} ${shareDay(puzzleData.date)} (${PUZZLE_KINDS[puzzleKind()].name()})\n${line}`;
  }
  el('puzzleBtn').addEventListener('click', openPuzzle);
  el('puzzleCloseBtn').addEventListener('click', () => el('puzzleOverlay').classList.add('hidden'));
  el('puzzleOverlay').addEventListener('click', (ev) => {
    if (ev.target === el('puzzleOverlay')) el('puzzleOverlay').classList.add('hidden');
  });
  el('puzzlePrevBtn').addEventListener('click', () => {
    if (puzzleData && puzzleData.date > puzzleData.epoch) loadPuzzle(shiftDay(puzzleData.date, -1));
  });
  el('puzzleNextBtn').addEventListener('click', () => {
    if (!puzzleData || !puzzleData.archive) return;
    const next = shiftDay(puzzleData.date, 1);
    loadPuzzle(next >= puzzleData.today ? null : next);
  });
  el('puzzleLayBtn').addEventListener('click', () => {
    if (puzzleSelected.size < 3 || !puzzleData || puzzleLayPending) return;
    // The server validates (no second rules implementation here); the group is
    // only laid when it answers valid, see 'puzzleMeldCheck'.
    puzzleLayPending = [...puzzleSelected];
    send({ type: 'checkPuzzleMeld', name: currentName(), date: puzzleData.date, cardIds: puzzleLayPending });
  });
  el('puzzleCheckBtn').addEventListener('click', () => {
    if (!puzzleData) return;
    // The login token lets a solve also count for the account and its season.
    const base = { type: 'solvePuzzle', name: currentName(), date: puzzleData.date, accountToken: accountToken() || undefined };
    if (puzzleKind() !== 'meld') {
      if (puzzleGroups.length) send({ ...base, melds: puzzleGroups });
      return;
    }
    if (puzzleSelected.size < 3) return;
    send({ ...base, cardIds: [...puzzleSelected] });
  });
  el('puzzleRevealBtn').addEventListener('click', () => {
    send({ type: 'revealPuzzle', name: currentName(), ...(puzzleData ? { date: puzzleData.date } : {}) });
  });
  el('puzzleShareBtn').addEventListener('click', () => {
    if (puzzleData) shareResult(puzzleShareText());
  });
  function handlePuzzleMessage(msg) {
    if (msg.type === 'puzzle') {
      puzzleData = {
        date: msg.date, kind: msg.kind || 'meld', hand: msg.hand || [], targetPoints: msg.targetPoints || 0,
        status: msg.status || {}, archive: !!msg.archive, today: msg.today || msg.date, epoch: msg.epoch || msg.date,
        // Stars need a stored profile: the server sends dayStars only then.
        starsOn: msg.dayStars !== undefined, dayStars: msg.dayStars || 0, perfectStreak: msg.perfectStreak || null,
      };
      renderPuzzle();
      try { renderToday(); } catch (e) { /* cosmetic */ }
      return true;
    }
    // Answers for another day (navigated away meanwhile) are stale.
    if (!puzzleData || (msg.date && msg.date !== puzzleData.date)) return true;
    if (msg.perfectStreak) puzzleData.perfectStreak = msg.perfectStreak;
    if (msg.type === 'puzzleMeldCheck') {
      const ids = puzzleLayPending;
      puzzleLayPending = null;
      if (!ids) return true;
      if (!msg.valid) {
        setPuzzleStatus(`❌ ${trs(msg.reason || '')}`, 'bad');
        return true;
      }
      puzzleGroups.push(ids);
      for (const id of ids) puzzleSelected.delete(id);
      puzzleBadGroup = 0;
      setPuzzleStatus('', '');
      renderPuzzle();
      return true;
    }
    if (msg.type === 'puzzleResult') {
      puzzleData.status = msg.status || puzzleData.status;
      puzzleBadGroup = 0;
      if (!msg.valid) {
        puzzleBadGroup = msg.badMeld || 0;
        const where = msg.badMeld ? L(`Auslage ${msg.badMeld}: `, `Meld ${msg.badMeld}: `) : '';
        setPuzzleStatus(`❌ ${where}${trs(msg.reason || '')}`, 'bad');
      } else if (msg.solved) {
        sound.meld();
        const what = puzzleKind() === 'out'
          ? L('Ausgemacht! Die letzte Karte wirfst du ab.', 'Out! The last card is your discard.')
          : L(`Gelöst! ${msg.points} Punkte`, `Solved! ${msg.points} points`);
        setPuzzleStatus(`✅ ${what}${msg.xp ? ` · +${msg.xp} ${L('EP', 'XP')}` : ''}`, 'ok');
        if (msg.level) myProgress = { xp: myProgress ? Math.max(myProgress.xp || 0, (msg.level.total || 0)) : (msg.level.total || 0), level: msg.level };
        if (msg.level && msg.xp) {
          const from = levelFromXpClient((msg.level.total || 0) - msg.xp).level;
          if (msg.level.level > from) showLevelUp(from, msg.level.level, msg.xp, (msg.level.total || 0) - msg.xp);
        }
        if (msg.streak) myStreak = msg.streak;
        try { renderQuests(); renderEmoteLocks(); } catch (e) { /* cosmetic */ }
        if (msg.badges && msg.badges.length) {
          showToast(`🏅 ${L('Neuer Erfolg', 'New badge')}: ${msg.badges.map((id) => `${badgeMeta(id).emoji} ${badgeMeta(id).name}`).join(', ')}`);
        }
      } else if (puzzleKind() === 'out') {
        setPuzzleStatus(
          L(`Gültig, aber noch ${msg.left} Karten übrig - nur eine darf bleiben.`, `Valid, but ${msg.left} cards are left - only one may stay.`),
          'bad'
        );
      } else {
        setPuzzleStatus(
          L(`Gültig, aber nur ${msg.points} von ${msg.targetPoints} Punkten - da geht mehr.`, `Valid, but only ${msg.points} of ${msg.targetPoints} points - there is more.`),
          'bad'
        );
      }
      renderPuzzle();
      return true;
    }
    if (msg.type === 'puzzleSolution') {
      puzzleSolutionIds = msg.cardIds || [];
      puzzleSolutionMelds = Array.isArray(msg.melds) ? msg.melds : [puzzleSolutionIds];
      puzzleData.status = msg.status || puzzleData.status;
      puzzleSelected.clear();
      if (puzzleKind() === 'meld') for (const id of puzzleSolutionIds) puzzleSelected.add(id);
      const what = puzzleKind() === 'out'
        ? L('Lösung: so geht es raus (markiert).', 'Solution: this is the way out (highlighted).')
        : L(`Lösung: ${msg.points} Punkte (markiert).`, `Solution: ${msg.points} points (highlighted).`);
      setPuzzleStatus(puzzleData.archive ? what : `${what} ${L('Ohne EP - morgen gibt es ein neues.', 'No XP - a new one comes tomorrow.')}`, '');
      renderPuzzle();
      return true;
    }
    return false;
  }

  el('challengeCancelBtn').addEventListener('click', () => el('challengeIntroOverlay').classList.add('hidden'));
  el('challengeIntroOverlay').addEventListener('click', (ev) => {
    if (ev.target === el('challengeIntroOverlay')) el('challengeIntroOverlay').classList.add('hidden');
  });

  el('lobbyReadyBtn').addEventListener('click', () => send({ type: 'lobbyReady' }));
  el('undoPileBtn').addEventListener('click', (ev) => {
    // Inside #discardPile: the pile's own click (take) must not fire too.
    ev.stopPropagation();
    send({ type: 'undoPileTake' });
  });
  el('undoMeldBtn').addEventListener('click', () => send({ type: 'undoMeld' }));

  // Tutorial button: its own session with a FIXED deck (server: startTutorial),
  // so the lessons meet the cards they name. Unfinished progress is not
  // dropped silently: the first tap says so. One game at a time still applies.
  let tutorialArmTimer = null;
  el('tutorialBtn').addEventListener('click', () => {
    const btn = el('tutorialBtn');
    const unfinished = !!(tutorialProgress && !tutorialProgress.finished && !tutorialProgress.off &&
      (tutorialProgress.done || []).length > 1);
    const disarm = () => {
      clearTimeout(tutorialArmTimer);
      delete btn.dataset.armed;
      btn.classList.remove('armed');
      setLabelText(btn, L('Tutorial', 'Tutorial'));
    };
    if (unfinished && btn.dataset.armed !== '1') {
      btn.dataset.armed = '1';
      btn.classList.add('armed');
      setLabelText(btn, L('Von vorn beginnen?', 'Start over?'));
      clearTimeout(tutorialArmTimer);
      tutorialArmTimer = setTimeout(disarm, 4000);
      return;
    }
    disarm();
    guardOpenGame('tutorial', startTutorial);
  });
  function startTutorial() {
    tutorialProgress = null;
    storageRemove(TUTORIAL_KEY);
    // A seat called "Spieler417" (the random stand-in) in every log line of a
    // first game labels the learner with a number: name it after what it is.
    const typed = el('nameInput').value.trim();
    const auto = !typed || /^Spieler\d{1,3}$/.test(typed);
    send({
      type: 'startTutorial',
      name: auto ? L('Neuling', 'Rookie') : typed,
      accountToken: accountToken() || undefined,
    });
  }
  el('tutorialNextBtn').addEventListener('click', () => {
    const prog = tutorialSessionProgress();
    if (prog && tutorialCurrentStep && !prog.done.includes(tutorialCurrentStep)) {
      prog.done.push(tutorialCurrentStep);
      saveTutorial();
    }
    tutorialCurrentStep = null;
    updateTutorial();
  });
  const TUTORIAL_LABELS = {
    welcome: () => L('Das Ziel des Spiels', 'The goal of the game'),
    draw: () => L('Karte aufnehmen', 'Take a card'),
    pileDuty: () => L('Ablage nehmen und auslegen', 'Take the pile and meld'),
    firstSet: () => L('Einen Satz auslegen', 'Meld a set'),
    pikdame: () => L('Pik Dame: +100 oder −100', 'Queen of spades: +100 or −100'),
    queenSet: () => L('Pik Dame auslegen', 'Meld the queen of spades'),
    joker: () => L('Joker einsetzen', 'Use a joker'),
    moreMelds: () => L('Weitere Auslagen', 'More melds'),
    discard: () => L('Zug mit Abwerfen beenden', 'End the turn by discarding'),
    pile: () => L('Die Ablage lesen', 'Read the discard pile'),
    layOff: () => L('An eigene Auslage anlegen', 'Lay off onto your meld'),
    jokerSwap: () => L('Joker tauschen', 'Swap a joker'),
    endgame: () => L('Ausmachen: letzte Karte abwerfen', 'Go out: discard the last card'),
    roundend: () => L('Wertung verstehen', 'Understand the scoring'),
  };
  function renderTutorialChecklist() {
    const list = document.getElementById('tutorialChecklist');
    if (!list) return;
    list.innerHTML = '';
    const prog = tutorialSessionProgress() || tutorialProgress || { done: [] };
    let done = 0;
    // Bonus steps sort to the bottom and never count: they hang on a table
    // situation nobody can force.
    const ordered = [
      ...TUTORIAL_STEPS.filter((s) => !s.optional),
      ...TUTORIAL_STEPS.filter((s) => s.optional),
    ];
    for (const step of ordered) {
      const label = TUTORIAL_LABELS[step.key];
      if (!label) continue;
      const seen = (prog.done || []).includes(step.key);
      if (!step.optional && seen) done += 1;
      const li = document.createElement('li');
      if (seen) li.className = 'done';
      // Done = check in a filled disc, open = an empty ring (CSS): shape, not colour.
      const tick = document.createElement('span');
      tick.className = 'tick';
      tick.setAttribute('aria-hidden', 'true');
      if (seen) tick.innerHTML = '<svg class="icon" aria-hidden="true"><use href="#i-check"/></svg>';
      const txt = document.createElement('span');
      txt.textContent = label();
      li.append(tick, txt);
      if (step.optional) {
        const bonus = document.createElement('span');
        bonus.className = 'bonus';
        bonus.textContent = L('Bonus', 'Bonus');
        li.append(bonus);
      }
      li.setAttribute('aria-label', `${label()}: ${seen ? L('erledigt', 'done') : L('offen', 'open')}`);
      list.appendChild(li);
    }
    // The heading keeps its sprite icon: only the label span is rewritten.
    const title = document.querySelector('#tutorialChecklistTitle span');
    if (title) title.textContent = `${L('Dein Fortschritt', 'Your progress')} ${done}/${TUTORIAL_MANDATORY.length}`;
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

  // "Überspringen": two taps, then the hints stop; the menu brings them back.
  confirmByTap(el('tutorialOffBtn'), L('Tutorial beenden?', 'End the tutorial?'), stopTutorial);
  el('tutorialHintsBtn').addEventListener('click', () => {
    const prog = tutorialSessionProgress();
    if (prog) { prog.off = false; saveTutorial(); }
    el('gameSettingsOverlay').classList.add('hidden');
    updateTutorial();
  });

  // "Tutorial geschafft": where to go next. 'bots'/'invite' create a new game on
  // the start screen after the reload (afterTutorial, picked up in connect()).
  const AFTER_TUTORIAL_KEY = 'pikdame_after_tutorial';
  function leaveTutorialFor(next) {
    if (next) storageSet(AFTER_TUTORIAL_KEY, next);
    else storageRemove(AFTER_TUTORIAL_KEY);
    if (sessionCode && storageGet('pikdame_last_session') === sessionCode) storageRemove('pikdame_last_session');
    window.location.href = window.location.pathname;
  }
  el('tutorialDoneBotsBtn').addEventListener('click', () => leaveTutorialFor('bots'));
  el('tutorialDoneInviteBtn').addEventListener('click', () => leaveTutorialFor('invite'));
  // Plain start screen: no follow-up game, and without the last session no resume offer.
  el('tutorialDoneMenuBtn').addEventListener('click', () => leaveTutorialFor(null));
  el('tutorialDoneStayBtn').addEventListener('click', () => {
    el('tutorialDoneOverlay').classList.add('hidden');
    // Practice on without hints: the next round starts like after any round end.
    if (lastState && lastState.phase === 'roundEnd') {
      send({ type: 'nextRound' });
      el('resultContinueBtn').disabled = true;
    }
  });

  el('resultContinueBtn').addEventListener('click', () => {
    // Tutorial: "Weiter" after the scoring of round 1 is the ending, not round 2.
    if (tutorialActive && lastState && lastState.phase === 'roundEnd') { finishTutorial(); return; }
    const isGameOver = lastState && lastState.phase === 'gameOver';
    if (isGameOver && lastState.challengeDate) { window.location.href = window.location.pathname; return; }
    if (isGameOver && lastState.towerStage) { leaveTowerFor('open'); return; }
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
  // One colour per seat, shared by the result bars and the chart. Validated
  // for colour-blind separation; teal is left out, it is the default --accent.
  const PLAYER_COLORS = ['#2a78d6', '#eb6834', '#4a3aa7', '#e87ba4'];
  function playerColor(id) {
    const i = lastState && lastState.players ? lastState.players.findIndex((p) => p.id === id) : -1;
    return PLAYER_COLORS[Math.max(0, i) % PLAYER_COLORS.length];
  }
  /** opts.players / opts.meId: a stored game (history); default the live table. */
  function renderScoreChart(history, opts = {}) {
    const wrap = document.createElement('div');
    wrap.className = 'scoreChart';
    const title = document.createElement('div');
    title.className = 'scoreChartTitle';
    title.textContent = L('Punkteverlauf', 'Score history');
    wrap.appendChild(title);

    const TARGET = 1000;
    const W = 320;
    const H = 150;
    // Right padding holds the end labels (they replace the legend).
    const PAD = { l: 34, r: 92, t: 8, b: 20 };
    const players = opts.players || lastState.players;
    const meId = opts.meId !== undefined ? opts.meId : playerId;
    const colorOf = (id) => PLAYER_COLORS[Math.max(0, players.findIndex((p) => p.id === id)) % PLAYER_COLORS.length];
    const valueAt = (h, p) => h.totals[p.id] || 0;
    const allValues = history.flatMap((h) => players.map((p) => valueAt(h, p)));
    // The goal is always on the chart: "how close is it?" is the question.
    const maxV = Math.max(TARGET, ...allValues);
    const minV = Math.min(0, ...allValues);
    const x = (i) => PAD.l + (i / Math.max(1, history.length - 1)) * (W - PAD.l - PAD.r);
    const y = (v) => PAD.t + (1 - (v - minV) / (maxV - minV || 1)) * (H - PAD.t - PAD.b);

    const svgParts = [];
    for (let v = 0; v <= maxV; v += 250) {
      const goal = v === TARGET;
      svgParts.push(`<line x1="${PAD.l}" y1="${y(v)}" x2="${W - PAD.r}" y2="${y(v)}" class="${goal ? 'goalLine' : 'gridLine'}"/>`);
      svgParts.push(`<text x="${PAD.l - 4}" y="${y(v) + 3}" class="axisLabel${goal ? ' goal' : ''}" text-anchor="end">${fmtNum(v)}</text>`);
    }
    // Others first (thinner, full colour: a translucent line failed contrast), mine last and on top.
    const order = players.slice().sort((a, b) => (a.id === meId) - (b.id === meId));
    order.forEach((p) => {
      const color = colorOf(p.id);
      const mine = p.id === meId;
      const points = history.map((h, i) => `${x(i).toFixed(1)},${y(valueAt(h, p)).toFixed(1)}`).join(' ');
      svgParts.push(`<polyline points="${points}" fill="none" stroke="${color}" stroke-width="${mine ? 3 : 1.6}" stroke-linejoin="round" stroke-linecap="round" class="${mine ? 'mine' : 'other'}"/>`);
      const last = history[history.length - 1];
      svgParts.push(`<circle cx="${x(history.length - 1).toFixed(1)}" cy="${y(valueAt(last, p)).toFixed(1)}" r="${mine ? 4 : 3.2}" fill="${color}" class="endDot"/>`);
    });
    // Direct end labels, nudged apart so close finishes stay readable.
    const last = history[history.length - 1];
    const labels = players
      .map((p) => ({ p, v: valueAt(last, p), y: y(valueAt(last, p)) }))
      .sort((a, b) => a.y - b.y);
    const GAP = 12;
    for (let i = 1; i < labels.length; i++) labels[i].y = Math.max(labels[i].y, labels[i - 1].y + GAP);
    const overflow = labels.length ? labels[labels.length - 1].y - (H - PAD.b) : 0;
    if (overflow > 0) labels.forEach((l) => { l.y -= overflow; });
    for (let i = labels.length - 2; i >= 0; i--) labels[i].y = Math.min(labels[i].y, labels[i + 1].y - GAP);
    const lx = W - PAD.r + 8;
    for (const l of labels) {
      const name = l.p.name.length > 8 ? `${l.p.name.slice(0, 7)}…` : l.p.name;
      svgParts.push(
        `<text x="${lx}" y="${(l.y + 3.5).toFixed(1)}" class="endLabel${l.p.id === meId ? ' mine' : ''}">` +
        `<tspan fill="${colorOf(l.p.id)}">●</tspan> ${escapeHtml(name)} <tspan class="endValue">${fmtNum(l.v)}</tspan></text>`
      );
    }
    // Every round labelled while it fits, otherwise first/last and a few between.
    const step = Math.ceil(history.length / 8);
    history.forEach((h, i) => {
      if (i % step !== 0 && i !== history.length - 1) return;
      svgParts.push(`<text x="${x(i)}" y="${H - 4}" class="axisLabel" text-anchor="middle">R${h.round}</text>`);
    });

    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', L('Punkteverlauf', 'Score history') + ': ' +
      labels.map((l) => `${l.p.name} ${fmtNum(l.v)}`).join(', '));
    svg.classList.add('scoreChartSvg');
    svg.innerHTML = svgParts.join('');
    // Chart text stays at --fs-micro on screen: --k = viewBox units per CSS px.
    const fit = () => {
      const w = svg.getBoundingClientRect().width;
      if (w > 0) svg.style.setProperty('--k', (W / w).toFixed(3));
    };
    try { if (typeof ResizeObserver === 'function') new ResizeObserver(fit).observe(svg); } catch (e) { /* cosmetic */ }
    wrap.appendChild(svg);
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
        // Die Endspurt-Ansage ist wichtig genug fuer eine laengere Anzeige
        const isWarning = latest.text.startsWith('⚠️');
        // My own moves need no echo: I just made them, and the toast sat
        // right on top of the melds I was looking at (playthrough finding).
        // In the tutorial the coach card answers them, the final discard too.
        const me = lastState.players && lastState.players.find((p) => p.id === playerId);
        const ownMove = !isWarning && me && latest.text.startsWith(`${me.name} `) &&
          (lastState.currentPlayerId === playerId || tutorialHintsOn());
        if (!chipStatus && !ownMove) {
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
        // Sheets always open at the top, not where they were left.
        r.target.scrollTop = 0;
        const card = r.target.querySelector('.overlay-card');
        if (card) card.scrollTop = 0;
        hideToast();
      }
    }
  });
  document.querySelectorAll('.overlay').forEach((o) =>
    overlayToastWatcher.observe(o, { attributes: true, attributeFilter: ['class'], attributeOldValue: true }));

  // Phone sheets: swiping a dialog down presses its own close button (named in
  // data-sheet-close), so the gesture never dismisses what a tap could not.
  const SHEET_QUERY = '(max-width: 600px) and (orientation: portrait)';
  function initSheetSwipe(overlay) {
    const card = overlay.querySelector('.overlay-card');
    if (!card) return;
    const grip = document.createElement('div');
    grip.className = 'sheetGrabber';
    grip.setAttribute('aria-hidden', 'true');
    card.prepend(grip);
    let drag = null;
    let resetTimer = null;
    const reset = () => {
      card.style.transform = '';
      card.style.transition = '';
      overlay.classList.remove('sheetDragging');
      overlay.style.removeProperty('--sheet-fade');
    };
    card.addEventListener('touchstart', (ev) => {
      drag = null;
      if (ev.touches.length !== 1 || !window.matchMedia || !window.matchMedia(SHEET_QUERY).matches) return;
      const t = ev.target;
      if (!grip.contains(t)) {
        // Off the grip only from the top of the content and never on a control.
        if (t.closest && t.closest('input, textarea, select, canvas')) return;
        for (let n = t; n && n !== overlay; n = n.parentElement) if (n.scrollTop > 0) return;
      }
      drag = { x: ev.touches[0].clientX, y: ev.touches[0].clientY, at: Date.now(), dy: 0, on: false };
    }, { passive: true });
    card.addEventListener('touchmove', (ev) => {
      if (!drag) return;
      const dx = ev.touches[0].clientX - drag.x;
      const dy = ev.touches[0].clientY - drag.y;
      if (!drag.on) {
        if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
        if (dy <= Math.abs(dx)) { drag = null; return; } // up or sideways: the content scrolls
        drag.on = true;
        clearTimeout(resetTimer);
        card.style.transition = 'none';
        overlay.classList.add('sheetDragging');
      }
      ev.preventDefault();
      drag.dy = Math.max(0, dy);
      card.style.transform = `translateY(${drag.dy}px)`;
      overlay.style.setProperty('--sheet-fade', String(Math.max(0, 1 - drag.dy / (card.offsetHeight || 1))));
    }, { passive: false });
    const end = (cancelled) => {
      const d = drag;
      drag = null;
      if (!d || !d.on) return;
      const btn = document.getElementById(overlay.dataset.sheetClose);
      const usable = btn && !btn.disabled && !btn.closest('.hidden, [hidden]');
      const far = d.dy > Math.min(140, card.offsetHeight * 0.3);
      const flick = d.dy > 40 && d.dy / Math.max(1, Date.now() - d.at) > 0.6;
      card.style.transition = 'transform 0.2s ease-out';
      if (!cancelled && usable && (far || flick)) {
        card.style.transform = 'translateY(100%)';
        setTimeout(() => {
          btn.click();
          if (overlay.classList.contains('hidden')) { reset(); return; }
          card.style.transform = ''; // the handler kept it open: slide back
          resetTimer = setTimeout(reset, 200);
        }, 180);
      } else {
        card.style.transform = '';
        overlay.classList.remove('sheetDragging');
        resetTimer = setTimeout(reset, 200);
      }
    };
    card.addEventListener('touchend', () => end(false));
    card.addEventListener('touchcancel', () => end(true));
  }
  document.querySelectorAll('.overlay[data-sheet-close]').forEach((o) => {
    try { initSheetSwipe(o); } catch (e) { /* swiping is a convenience */ }
  });

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
  // The QR library is ~55 kB and only ever needed when this overlay opens, so
  // it is no longer a render-blocking <script> in the head: it is fetched on
  // the first click and cached in this promise afterwards. Local file, no CDN.
  let qrLibPromise = null;
  function loadQrLib() {
    if (typeof qrcode === 'function') return Promise.resolve(true);
    if (qrLibPromise) return qrLibPromise;
    qrLibPromise = new Promise((resolve) => {
      const tag = document.createElement('script');
      tag.src = '/vendor-qrcode.js';
      tag.addEventListener('load', () => resolve(typeof qrcode === 'function'));
      // Offline or blocked: no QR, but the code and the share button still work.
      tag.addEventListener('error', () => { qrLibPromise = null; resolve(false); });
      document.head.appendChild(tag);
    });
    return qrLibPromise;
  }

  el('showQrBtn').addEventListener('click', async () => {
    if (!sessionCode) return;
    if (!(await loadQrLib())) return;
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
    // Both this panel (top:42%) and the toast (top:50%) sit in the middle of
    // the screen: the log toast printed straight through "Du sicherst dir 100
    // Punkte" - the payoff line of the whole Pik-Dame moment. While the panel
    // is up the toast steps below it (margin, not transform - the toast
    // animates its own transform).
    document.body.classList.add('raidActive');
    sound.pikdame();
    setTimeout(() => {
      w.remove();
      if (!document.querySelector('.raidWarning')) document.body.classList.remove('raidActive');
    }, 2500);
  }

  // --- Benutzerkonto (nur wenn der Server Accounts anbietet) -------------------
  // In der CodeApp/im Hotspot-Betrieb meldet der Server accountsEnabled=false
  // und die komplette Konto-UI bleibt unsichtbar - dort ändert sich nichts.
  const ACC_TOKEN_KEY = 'pikdame_account_token';
  let accountUsername = null;
  let accountsServer = false; // the server offers accounts at all
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
    // The dialog is long on a phone; an error below the fold looked like
    // "nothing happened".
    if (text && isError) { try { s.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } catch (e) { /* cosmetic */ } }
  }
  function refreshAccountUi() {
    const loggedIn = !!accountUsername;
    el('accountLoggedOut').classList.toggle('hidden', loggedIn);
    el('accountLoggedIn').classList.toggle('hidden', !loggedIn);
    el('accountWhoami').textContent = loggedIn
      ? L(`Angemeldet als ${accountUsername}`, `Signed in as ${accountUsername}`)
      : '–';
    // Label span only - the button carries an <svg class="icon">.
    // Always "Konto": the name is on the identity chip already; a badge says
    // "signed in".
    setLabelText(el('accountBtn'), L('Konto', 'Account'));
    el('accountBtn').classList.toggle('signedIn', loggedIn);
    el('accountBtn').title = loggedIn ? L(`Konto: angemeldet als ${accountUsername}`, `Account: signed in as ${accountUsername}`) : L('Konto', 'Account');
    // Angemeldet: der Spielername IST der Kontoname (Fortschritt haengt dran)
    if (loggedIn) {
      el('nameInput').value = accountUsername;
      el('nameInput').disabled = true;
      el('nameInput').title = L('Name ist durch dein Konto festgelegt', 'Name is fixed by your account');
    } else {
      el('nameInput').disabled = false;
      el('nameInput').title = '';
      accountProgress = null;
      seasonAwards = [];
      lastSeasonResult = null;
      el('ladderBox').classList.add('hidden');
    }
    try { renderIdentity(); } catch (e) { /* cosmetic */ }
    renderAccountProgress();
    // The greeting belongs to the account: gone on sign-out, re-rendered on a language switch.
    if (!loggedIn) greetingWindow = null;
    applyOccasion();
    // Signing in can change the name the year review belongs to.
    try { requestYearReview(); } catch (e) { /* cosmetic */ }
  }
  let greetingFetchedAt = 0;
  async function refreshGreeting() {
    if (!accountToken()) return;
    const me = await accountApi('/api/me', { token: accountToken() });
    greetingFetchedAt = Date.now();
    if (me.ok) {
      setGreeting(me.greeting, me.username);
      applySeasonInfo(me);
    }
  }
  // A PWA can sleep for days; past a few hours the server is asked again (cheap endpoint).
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && accountUsername && Date.now() - greetingFetchedAt > 3 * 60 * 60 * 1000) refreshGreeting().catch(() => {});
  });
  async function initAccount(enabled, passkeysOn) {
    if (!enabled) return; // Button bleibt versteckt (CodeApp/Hotspot)
    accountsServer = true;
    passkeysServer = !!passkeysOn;
    el('accountBtn').classList.remove('hidden');
    // A sign-in link from the e-mail (?login=...) is redeemed before anything
    // else, then removed from the address bar so a reload does not reuse it.
    const loginLink = new URLSearchParams(window.location.search).get('login');
    if (loginLink) {
      try {
        const url = new URL(window.location.href);
        url.searchParams.delete('login');
        window.history.replaceState(null, '', url.toString());
      } catch (e) { /* cosmetic */ }
      const r = await accountApi('/api/login-link/consume', { token: loginLink });
      if (r.ok) {
        signedIn(r, { fromLink: true });
        return;
      }
      showToast(trs(r.error), { duration: 6000, priority: true });
    }
    // The link from the sign-up mail (?verify=...): confirms the address and
    // signs in, then the dialog offers "Passkey or password".
    const verifyLink = new URLSearchParams(window.location.search).get('verify');
    if (verifyLink) {
      try {
        const url = new URL(window.location.href);
        url.searchParams.delete('verify');
        window.history.replaceState(null, '', url.toString());
      } catch (e) { /* cosmetic */ }
      const r = await accountApi('/api/verify-signin', { token: verifyLink });
      if (r.ok) {
        signedIn(r, { confirmed: true });
        return;
      }
      showToast(trs(r.error), { duration: 6000, priority: true });
    }
    if (accountToken()) {
      const me = await accountApi('/api/me', { token: accountToken() });
      greetingFetchedAt = Date.now();
      if (me.ok) {
        accountUsername = me.username;
        setGreeting(me.greeting, me.username);
        applySeasonInfo(me);
      } else storageRemove(ACC_TOKEN_KEY);
    }
    refreshAccountUi();
  }
  el('accountBtn').addEventListener('click', () => {
    setAccountStatus('');
    el('accountOverlay').classList.remove('hidden');
    preparePasskeyUi().catch(() => {});
    if (accountUsername) renderLoginMethods().catch(() => {});
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
    el('accountCodeForm').classList.add('hidden');
    el('accountTabLogin').classList.add('active');
    el('accountTabRegister').classList.remove('active');
    setAccountStatus('');
  });
  el('accountTabRegister').addEventListener('click', () => {
    el('accountLoginForm').classList.add('hidden');
    // A sign-up waiting for its code stays on the code step.
    el(pendingSignupEmail ? 'accountCodeForm' : 'accountRegisterForm').classList.remove('hidden');
    el('accountTabRegister').classList.add('active');
    el('accountTabLogin').classList.remove('active');
    setAccountStatus('');
    // Registering usually means "keep the name I already play with": take it
    // over - but only a name the player chose, not the random "Spieler123"
    // stand-in, and never over something already typed here.
    const chosen = (el('nameInput').value || myName || '').trim();
    if (!el('accRegUser').value && chosen && !/^Spieler\d{1,3}$/.test(chosen)) {
      el('accRegUser').value = chosen.slice(0, 24);
    }
  });
  // Sign-up, e-mail first: name + address -> code (or link) from the mail ->
  // signed in -> "Passkey or password".
  let pendingSignupEmail = '';
  function showCodeStep(email) {
    pendingSignupEmail = email;
    el('accountRegisterForm').classList.toggle('hidden', !!email);
    el('accountCodeForm').classList.toggle('hidden', !email);
    el('accRegCode').value = '';
  }
  el('accountRegisterForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    setAccountStatus(L('Registriere...', 'Registering...'));
    const email = el('accRegEmail').value.trim();
    const r = await accountApi('/api/register-passwordless', { username: el('accRegUser').value, email });
    if (r.error) return setAccountStatus(trs(r.error), true);
    showCodeStep(email);
    // Three outcomes, not two: delivered, no relay configured, or a
    // configured relay that failed. The old two-way message blamed a
    // missing mail server even when SMTP was set up and merely broken.
    el('accCodeHint').textContent = r.mailDelivered
      ? L(`Wir haben dir einen 6-stelligen Code an ${email} geschickt. Gib ihn hier ein (15 Minuten gültig) - oder tippe auf den Link in der Mail.`,
        `We sent a 6-digit code to ${email}. Enter it here (valid for 15 minutes) - or tap the link in the e-mail.`)
      : r.mailConfigured
        ? L('Konto angelegt, aber die Mail mit dem Code konnte nicht verschickt werden. Code und Link stehen im Server-Log - bitte den Mailserver prüfen.',
          'Account created, but the e-mail with the code could not be sent. Code and link are in the server log - please check the mail server.')
        : L('Konto angelegt. Code und Link stehen im Server-Log (noch kein Mailserver eingetragen).',
          'Account created. Code and link are in the server log (no mail server configured yet).');
    setAccountStatus('');
    el('accRegCode').focus();
  });
  el('accountCodeForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const code = el('accRegCode').value.replace(/\D/g, '');
    if (code.length !== 6) return setAccountStatus(L('Bitte den 6-stelligen Code aus der Mail eingeben.', 'Please enter the 6-digit code from the e-mail.'), true);
    setAccountStatus(L('Prüfe...', 'Checking...'));
    const r = await accountApi('/api/verify-code', { email: pendingSignupEmail, code });
    if (r.error) return setAccountStatus(trs(r.error), true);
    signedIn(r, { confirmed: true });
  });
  // Complete as soon as six digits are in (also when iOS fills the code in).
  el('accRegCode').addEventListener('input', () => {
    if (el('accRegCode').value.replace(/\D/g, '').length === 6) el('accountCodeForm').requestSubmit();
  });
  el('accResendCodeBtn').addEventListener('click', async () => {
    const r = await accountApi('/api/verify-code/resend', { email: pendingSignupEmail });
    if (r.error) return setAccountStatus(trs(r.error), true);
    el('accRegCode').value = '';
    setAccountStatus(L('Ein neuer Code ist unterwegs - der alte gilt nicht mehr.', 'A new code is on its way - the old one no longer works.'));
  });
  el('accCodeBackBtn').addEventListener('click', () => {
    showCodeStep('');
    setAccountStatus('');
    el('accRegEmail').focus();
  });
  el('accountLoginForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    setAccountStatus(L('Melde an...', 'Signing in...'));
    const r = await accountApi('/api/login', {
      username: el('accLoginUser').value,
      password: el('accLoginPass').value,
    });
    if (r.error) return setAccountStatus(trs(r.error), true);
    signedIn(r);
  });
  /** After any successful sign-in (password, passkey, e-mail link, sign-up
   *  code). `confirmed`: the address was just confirmed - the dialog stays
   *  open on "Passkey or password". */
  function signedIn(r, { fromLink = false, confirmed = false } = {}) {
    storageSet(ACC_TOKEN_KEY, r.token);
    // The passkey suggestion in the username field (conditional UI) is a
    // WebAuthn request that stays open until something ends it - after
    // signing in by password, link or code nothing did, and on iOS a pending
    // request can swallow later prompts.
    try { if (window.SimpleWebAuthnBrowser) window.SimpleWebAuthnBrowser.WebAuthnAbortService.cancelCeremony(); } catch (e) { /* nothing pending */ }
    accountUsername = r.username;
    setAccountStatus('');
    // Back to the plain login form for the next sign-out.
    showCodeStep('');
    el('accountRegisterForm').classList.add('hidden');
    el('accountLoginForm').classList.remove('hidden');
    el('accountTabLogin').classList.add('active');
    el('accountTabRegister').classList.remove('active');
    refreshAccountUi();
    showToast(L(`Angemeldet als ${r.username}`, `Signed in as ${r.username}`));
    loadLadder().catch(() => {}); // fills level + season rank for next open
    refreshGreeting().catch(() => {}); // sign-in answers carry no greeting; /api/me does
    if (fromLink || confirmed) {
      // Signed in by link, usually because the passkey or password is gone -
      // or just signed up: open the dialog on the sign-in methods so one is a
      // tap away.
      el('accountOverlay').classList.remove('hidden');
      if (fromLink) setAccountStatus(L('Angemeldet über den Link. Lege jetzt einen neuen Passkey an oder setze ein Passwort.', 'Signed in via the link. Add a new passkey or set a password now.'));
      preparePasskeyUi().then(() => renderLoginMethods()).catch(() => {});
    } else {
      el('accountOverlay').classList.add('hidden');
    }
  }

  // --- Passkeys ---------------------------------------------------------------
  // The browser half of SimpleWebAuthn (public/vendor-simplewebauthn.js, 13 kB)
  // loads with the first opening of the account dialog - nobody else needs it.
  let passkeysServer = false;
  let webauthnLibPromise = null;
  function loadWebAuthnLib() {
    if (window.SimpleWebAuthnBrowser) return Promise.resolve(true);
    if (webauthnLibPromise) return webauthnLibPromise;
    webauthnLibPromise = new Promise((resolve) => {
      const tag = document.createElement('script');
      tag.src = '/vendor-simplewebauthn.js';
      tag.addEventListener('load', () => resolve(!!window.SimpleWebAuthnBrowser));
      tag.addEventListener('error', () => { webauthnLibPromise = null; resolve(false); });
      document.head.appendChild(tag);
    });
    return webauthnLibPromise;
  }
  let passkeysUsable = false;
  async function preparePasskeyUi() {
    passkeysUsable = passkeysServer && (await loadWebAuthnLib()) && window.SimpleWebAuthnBrowser.browserSupportsWebAuthn();
    el('accPasskeyLoginBtn').classList.toggle('hidden', !passkeysUsable);
    // Passkey first after sign-up; without passkeys the password is the one
    // primary choice.
    el('accSetupPasskeyBtn').classList.toggle('hidden', !passkeysUsable);
    el('accSetupPasswordBtn').classList.toggle('btn-primary', !passkeysUsable);
    el('accSetupPasswordBtn').classList.toggle('btn-secondary', passkeysUsable);
    if (passkeysUsable && !accountUsername) startPasskeyAutofill();
  }

  /** Cancelled by the person (or a newer ceremony took over): no error text. */
  function passkeyCancelled(e) {
    return e && (e.name === 'NotAllowedError' || e.name === 'AbortError' || e.code === 'ERROR_CEREMONY_ABORTED');
  }

  // Passkey suggestions right in the username field (iOS QuickType bar,
  // password managers) - runs quietly in the background while the dialog is
  // open; a click on "Mit Passkey anmelden" replaces it.
  let autofillRunning = false;
  async function startPasskeyAutofill() {
    if (autofillRunning) return;
    const lib = window.SimpleWebAuthnBrowser;
    if (!lib || !(await lib.browserSupportsWebAuthnAutofill().catch(() => false))) return;
    autofillRunning = true;
    try {
      const opt = await accountApi('/api/passkey/login/options', {});
      if (!opt.ok) return;
      const response = await lib.startAuthentication({ optionsJSON: opt.options, useBrowserAutofill: true });
      await finishPasskeyLogin(opt.flowId, response);
    } catch (e) {
      if (!passkeyCancelled(e)) setAccountStatus(L('Passkey-Anmeldung fehlgeschlagen.', 'Passkey sign-in failed.'), true);
    } finally {
      autofillRunning = false;
    }
  }

  async function finishPasskeyLogin(flowId, response) {
    setAccountStatus(L('Melde an...', 'Signing in...'));
    const r = await accountApi('/api/passkey/login/verify', { flowId, response });
    if (r.error) return setAccountStatus(trs(r.error), true);
    signedIn(r);
    syncPasskeyDetails(r.passkeyUser);
  }

  // WebAuthn Signal API (Safari 26, Chrome 132+): updates the names stored
  // with the passkey on this device - e.g. passkeys made while they still
  // carried the player name instead of the e-mail. Elsewhere a no-op.
  function syncPasskeyDetails(u) {
    try {
      if (!u || typeof PublicKeyCredential === 'undefined' || typeof PublicKeyCredential.signalCurrentUserDetails !== 'function') return;
      PublicKeyCredential.signalCurrentUserDetails({ rpId: u.rpId, userId: u.userId, name: u.name, displayName: u.displayName })
        .catch(() => {});
    } catch (e) { /* best effort */ }
  }

  el('accPasskeyLoginBtn').addEventListener('click', async () => {
    const lib = window.SimpleWebAuthnBrowser;
    if (!lib) return;
    try {
      const opt = await accountApi('/api/passkey/login/options', {});
      if (opt.error) return setAccountStatus(trs(opt.error), true);
      const response = await lib.startAuthentication({ optionsJSON: opt.options });
      await finishPasskeyLogin(opt.flowId, response);
    } catch (e) {
      setAccountStatus(passkeyCancelled(e) ? L('Abgebrochen.', 'Cancelled.') : L('Passkey-Anmeldung fehlgeschlagen.', 'Passkey sign-in failed.'), !passkeyCancelled(e));
    }
  });

  el('accLoginLinkBtn').addEventListener('click', async () => {
    const who = el('accLoginUser').value.trim();
    if (!who) {
      setAccountStatus(L('Bitte oben Benutzername oder E-Mail-Adresse eintragen, dann den Link anfordern.', 'Enter your username or e-mail address above, then request the link.'), true);
      el('accLoginUser').focus();
      return;
    }
    const r = await accountApi('/api/login-link', { usernameOrEmail: who });
    if (r.error) return setAccountStatus(trs(r.error), true);
    // Deliberately the same text whether or not the account exists.
    setAccountStatus(L('📧 Wenn es dazu ein bestätigtes Konto gibt, ist ein Anmelde-Link unterwegs. Er gilt 15 Minuten.', '📧 If a confirmed account exists for this, a sign-in link is on its way. It is valid for 15 minutes.'));
  });

  // --- Sign-in methods of the signed-in account ---------------------------------
  function fmtShortDate(ms) {
    return ms ? fmtDate(ms) : '–';
  }
  // With time: two passkeys made on the same day on the same phone are told
  // apart by it.
  function fmtDateTime(ms) {
    return ms
      ? new Date(ms).toLocaleString(localeOf(), { day: 'numeric', month: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' })
      : '–';
  }
  /** Two-tap confirmation instead of window.confirm(): iOS can suppress the
   *  native dialog silently (the tap then did nothing at all). First tap arms
   *  the button for 4 s, the second one acts. */
  function confirmByTap(btn, armedLabel, action) {
    btn.addEventListener('click', () => {
      if (btn.dataset.armed === '1') {
        clearTimeout(Number(btn.dataset.timer));
        delete btn.dataset.armed;
        btn.classList.remove('armed');
        if (btn.dataset.label) setLabelText(btn, btn.dataset.label);
        action();
        return;
      }
      btn.dataset.label = btn.textContent;
      btn.dataset.armed = '1';
      btn.classList.add('armed');
      setLabelText(btn, armedLabel);
      btn.dataset.timer = String(setTimeout(() => {
        delete btn.dataset.armed;
        btn.classList.remove('armed');
        setLabelText(btn, btn.dataset.label);
      }, 4000));
    });
  }
  async function renderLoginMethods() {
    const box = el('accountMethods');
    const m = await accountApi('/api/account/methods', { token: accountToken() });
    if (!m.ok) {
      box.classList.add('hidden');
      el('accountSetup').classList.add('hidden');
      el('accountMailPrefs').classList.add('hidden');
      return;
    }
    // Year-review mail: shown with the stored consent, never pre-ticked.
    el('accountMailPrefs').classList.toggle('hidden', typeof m.reviewMail !== 'boolean');
    el('accReviewMailCheckbox').checked = m.reviewMail === true;
    // No way to sign in yet (just confirmed, or signed up and left): the
    // setup choice replaces the list until one exists.
    const none = !m.hasPassword && !m.passkeys.length;
    el('accountSetup').classList.toggle('hidden', !none);
    box.classList.toggle('hidden', none);
    const list = el('passkeyList');
    list.innerHTML = '';
    for (const pk of m.passkeys) {
      const li = document.createElement('li');
      const label = document.createElement('span');
      label.className = 'pkLabel';
      label.innerHTML = '<svg class="icon" aria-hidden="true"><use href="#i-key"/></svg><span><span class="pkName"></span><span class="pkMeta"></span></span>';
      label.querySelector('.pkName').textContent = pk.name || 'Passkey';
      label.querySelector('.pkMeta').textContent = pk.lastUsedAt
        ? L(`zuletzt benutzt ${fmtShortDate(pk.lastUsedAt)}`, `last used ${fmtShortDate(pk.lastUsedAt)}`)
        : L(`angelegt ${fmtDateTime(pk.createdAt)}`, `added ${fmtDateTime(pk.createdAt)}`);
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'linkBtn';
      del.textContent = L('Entfernen', 'Remove');
      confirmByTap(del, L('Wirklich?', 'Sure?'), async () => {
        const r = await accountApi('/api/passkey/delete', { token: accountToken(), id: pk.id });
        if (r.error) return setAccountStatus(trs(r.error), true);
        setAccountStatus(L('Passkey entfernt.', 'Passkey removed.'));
        renderLoginMethods().catch(() => {});
      });
      li.append(label, del);
      list.appendChild(li);
    }
    el('accAddPasskeyBtn').classList.toggle('hidden', !(m.passkeysAvailable && passkeysUsable));
    el('accPasswordState').textContent = m.hasPassword
      ? L('Passwort gesetzt', 'Password set')
      : L('Kein Passwort', 'No password');
    setLabelText(el('accSetPasswordBtn'), m.hasPassword ? L('Passwort ändern', 'Change password') : L('Passwort festlegen', 'Set a password'));
    el('accRemovePasswordBtn').classList.toggle('hidden', !m.hasPassword || !m.passkeys.length);
  }

  el('accReviewMailCheckbox').addEventListener('change', async (ev) => {
    const box = ev.target;
    const want = box.checked;
    box.disabled = true;
    // The mail is written in the language the player uses while opting in.
    const r = await accountApi('/api/account/review-mail', { token: accountToken(), enabled: want, lang });
    box.disabled = false;
    if (!r.ok) {
      box.checked = !want;
      setAccountStatus(r.error === 'Nicht angemeldet.' ? trs(r.error) : L('Konnte nicht gespeichert werden – bitte später noch einmal.', 'Could not be saved – please try again later.'), true);
      return;
    }
    setAccountStatus(want
      ? L('Abgemacht: Ende Dezember schickt dir die Katze deinen Jahresrückblick.', 'Deal: at the end of December the cat mails you your year review.')
      : L('Kein Jahresrückblick per Mail mehr.', 'No more year review by mail.'));
  });
  el('accAddPasskeyBtn').addEventListener('click', () => addPasskey());
  el('accSetupPasskeyBtn').addEventListener('click', () => addPasskey());
  el('accSetupPasswordBtn').addEventListener('click', () => {
    el('accountSetup').classList.add('hidden');
    el('accountMethods').classList.remove('hidden');
    openPasswordForm();
  });
  async function addPasskey() {
    const lib = window.SimpleWebAuthnBrowser;
    if (!lib) return;
    try {
      const opt = await accountApi('/api/passkey/add/options', { token: accountToken() });
      if (opt.error) return setAccountStatus(trs(opt.error), true);
      const response = await lib.startRegistration({ optionsJSON: opt.options });
      const r = await accountApi('/api/passkey/add/verify', { token: accountToken(), flowId: opt.flowId, response });
      if (r.error) return setAccountStatus(trs(r.error), true);
      setAccountStatus(L('✅ Passkey hinzugefügt.', '✅ Passkey added.'));
      renderLoginMethods().catch(() => {});
    } catch (e) {
      setAccountStatus(passkeyCancelled(e) ? L('Abgebrochen.', 'Cancelled.') : L('Der Passkey konnte nicht angelegt werden.', 'The passkey could not be created.'), !passkeyCancelled(e));
    }
  }

  function openPasswordForm() {
    el('accSetPasswordUser').value = accountUsername || '';
    el('accSetPasswordForm').classList.remove('hidden');
    el('accNewPass').focus();
  }
  el('accSetPasswordBtn').addEventListener('click', () => {
    if (el('accSetPasswordForm').classList.contains('hidden')) openPasswordForm();
    else el('accSetPasswordForm').classList.add('hidden');
  });
  el('accSetPasswordForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const r = await accountApi('/api/password/set', { token: accountToken(), password: el('accNewPass').value });
    if (r.error) return setAccountStatus(trs(r.error), true);
    el('accNewPass').value = '';
    el('accSetPasswordForm').classList.add('hidden');
    setAccountStatus(L('✅ Passwort gespeichert.', '✅ Password saved.'));
    renderLoginMethods().catch(() => {});
  });
  confirmByTap(el('accRemovePasswordBtn'), L('Wirklich?', 'Sure?'), async () => {
    const r = await accountApi('/api/password/remove', { token: accountToken() });
    if (r.error) return setAccountStatus(trs(r.error), true);
    setAccountStatus(L('Passwort entfernt.', 'Password removed.'));
    renderLoginMethods().catch(() => {});
  });

  el('accLogoutBtn').addEventListener('click', async () => {
    await accountApi('/api/logout', { token: accountToken() });
    storageRemove(ACC_TOKEN_KEY);
    accountUsername = null;
    el('accountMethods').classList.add('hidden');
    el('accountSetup').classList.add('hidden');
    el('accountMailPrefs').classList.add('hidden');
    el('accSetPasswordForm').classList.add('hidden');
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
        el('versionValue').textContent = `v${s.version}`;
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
      initAccount(!!(s && s.accountsEnabled), !!(s && s.passkeysEnabled));
      setHolidays(s && s.occasions);
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
    if (openBtn && overlay) {
      openBtn.addEventListener('click', () => {
        try { updateCelebrationSetting(); } catch (e) { /* cosmetic */ } // sign-in may have changed
        overlay.classList.remove('hidden');
      });
    }
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
    // CHANGELOG sections are English by convention; players read them translated.
    const SECTIONS = {
      added: () => L('Neu', 'Added'),
      changed: () => L('Geändert', 'Changed'),
      fixed: () => L('Behoben', 'Fixed'),
      removed: () => L('Entfernt', 'Removed'),
      security: () => L('Sicherheit', 'Security'),
      deprecated: () => L('Veraltet', 'Deprecated'),
    };
    for (const raw of lines) {
      const line = inline(escapeHtml(raw));
      const isItem = /^\s*-\s+/.test(raw);
      // Indented lines continue the bullet above (changes/README.md).
      if (inList && !isItem && /^\s+\S/.test(raw)) {
        out[out.length - 1] = out[out.length - 1].replace(/<\/li>$/, ` ${line.trim()}</li>`);
        continue;
      }
      if (inList && !isItem) { out.push('</ul>'); inList = false; }
      const key = raw.replace(/^###\s+/, '').trim().toLowerCase();
      const section = Object.prototype.hasOwnProperty.call(SECTIONS, key) ? SECTIONS[key] : null;
      if (/^###\s+/.test(raw)) out.push(`<h4>${section ? escapeHtml(section()) : line.replace(/^###\s+/, '')}</h4>`);
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
    const paused = !!(s && s.paused);
    // The tally used to live in the title tooltip only - invisible on a
    // phone. With 2+ humans a tap therefore seemed to do nothing, and the
    // others never learned they were being asked. Now: a visible counter on
    // the button, a confirmation for the proposer and a prompt for everyone
    // else (same pattern as the forfeit vote).
    el('pauseBtn').dataset.votes = playing && !paused && votes.length ? `${votes.length}/${humans.length}` : '';
    if (playing && !paused && seated && humans.length > 1) {
      if (iVoted && !prevIVotedPause) {
        showToast(
          L(`⏸️ Pause vorgeschlagen (${votes.length}/${humans.length}) - das Spiel hält an, sobald alle zustimmen.`,
            `⏸️ Pause proposed (${votes.length}/${humans.length}) - the game stops once everyone agrees.`),
          { priority: true }
        );
      } else if (!iVoted && votes.length > prevPauseVoteCount) {
        showToast(
          L(`⏸️ Pause vorgeschlagen (${votes.length}/${humans.length}) - tippe auf ⏸️, um zuzustimmen.`,
            `⏸️ Pause proposed (${votes.length}/${humans.length}) - tap ⏸️ to agree.`),
          { priority: true }
        );
      }
    }
    prevPauseVoteCount = paused ? 0 : votes.length;
    prevIVotedPause = !paused && iVoted;
    // Pause overlay while the game is frozen.
    el('pauseOverlay').classList.toggle('hidden', !paused);
    if (paused) {
      const need = humans.length;
      const have = votes.length;
      el('pauseInfo').textContent = have
        ? L(`Weiter, sobald alle zustimmen (${have}/${need}).`, `Resumes once everyone agrees (${have}/${need}).`)
        : need > 1
          ? L('Das Spiel ist pausiert. Tippe „Fortsetzen“, um weiterzuspielen (alle müssen zustimmen).',
              'The game is paused. Tap "Resume" to continue (everyone must agree).')
          // Alone at the table there is nobody to agree with.
          : L('Das Spiel ist pausiert. Tippe „Fortsetzen“, um weiterzuspielen.',
              'The game is paused. Tap "Resume" to continue.');
      el('pauseResumeBtn').classList.toggle('active', iVoted);
      // Label span only - the button carries an <svg class="icon">.
      setLabelText(
        el('pauseResumeBtn'),
        iVoted ? L('Warte auf die anderen', 'Waiting for the others') : L('Fortsetzen', 'Resume')
      );
    }
  }

  el('emoteBtn').addEventListener('click', () => {
    const bar = el('emoteBar');
    if (bar.classList.contains('hidden')) arrangeEmoteBar(bar);
    bar.classList.toggle('hidden');
  });
  document.querySelectorAll('.emoteChoice').forEach((btn) => {
    btn.addEventListener('click', () => {
      const need = emoteUnlockLevel(btn.dataset.emote);
      if (need > myLevel()) {
        showToast(`🔒 ${L(`Dieses Emote gibt es ab Stufe ${need}.`, `This reaction unlocks at level ${need}.`)}`);
        return;
      }
      send({ type: 'emote', emoji: btn.dataset.emote });
      countEmote(btn.dataset.emote);
      el('emoteBar').classList.add('hidden');
    });
  });
  // Locked reactions stay visible (Brotato principle: what is still missing
  // motivates) - dimmed, with the level they unlock at.
  function renderEmoteLocks() {
    const level = myLevel();
    // Level-gated table colours share the hook: same level, same moment.
    document.querySelectorAll('.themeBtn[data-theme-choice]').forEach((btn) => {
      const need = THEME_LEVELS[btn.dataset.themeChoice];
      btn.classList.toggle('locked', !!need && !publicMode && level < need);
    });
    document.querySelectorAll('.emoteChoice[data-emote]').forEach((btn) => {
      const need = emoteUnlockLevel(btn.dataset.emote);
      const locked = need > level;
      btn.classList.toggle('locked', locked);
      if (locked) btn.dataset.lock = String(need);
      else delete btn.dataset.lock;
    });
  }
  // Picker order like the iPhone keyboard: the most used first (own taps, per
  // device), the rest behind a toggle in keyboard sections. Mirrors
  // KEYBOARD_ORDER/EMOTE_CATEGORIES in game/Emotes.js (contract test).
  const EMOTE_KEYBOARD = [
    ['smileys', ['😅', '😂', '🙃', '😇', '🤩', '🤔', '😬', '🙄', '😴', '🥳', '😎', '😱', '😤', '🙈', '🤞', '👍', '👏', '🤝', '🙏', '💪', '👀']],
    ['nature', ['🐢', '🍀', '🔥']],
    ['food', ['☕', '🍻']],
    ['activity', ['🎉', '🃏', 'pikdame']],
    ['objects', ['⏳']],
    ['symbols', ['❤️']],
  ];
  const EMOTE_TOP = 8;
  const EMOTE_COUNTS_KEY = 'pikdame_emote_counts';
  const EMOTE_MORE_KEY = 'pikdame_emote_more';
  // The static markup order (= EMOTE_IDS) is the default before any use.
  const EMOTE_DEFAULT_ORDER = [...el('emoteBar').querySelectorAll('.emoteChoice[data-emote]')].map((b) => b.dataset.emote);
  function emoteCounts() {
    try {
      const c = JSON.parse(storageGet(EMOTE_COUNTS_KEY) || '{}');
      return c && typeof c === 'object' ? c : {};
    } catch (e) {
      return {};
    }
  }
  function countEmote(id) {
    if (!EMOTE_DEFAULT_ORDER.includes(id)) return;
    const c = emoteCounts();
    c[id] = (Number(c[id]) || 0) + 1;
    storageSet(EMOTE_COUNTS_KEY, JSON.stringify(c));
  }
  /** Top row (most used, ties in default order; never a locked one) and the
   *  rest as keyboard sections. */
  function emoteLayout(ids, counts, isLocked, slots) {
    const top = ids
      .filter((id) => !isLocked(id))
      .map((id, i) => [id, Number(counts[id]) || 0, i])
      .sort((a, b) => b[1] - a[1] || a[2] - b[2])
      .slice(0, slots)
      .map((r) => r[0]);
    const rest = EMOTE_KEYBOARD
      .map(([cat, list]) => [cat, list.filter((id) => ids.includes(id) && !top.includes(id))])
      .filter(([, list]) => list.length);
    return { top, rest };
  }
  function setEmoteMore(bar, open) {
    bar.classList.toggle('emoteExpanded', open);
    const t = bar.querySelector('.emoteMoreBtn');
    if (!t) return;
    const label = open ? L('Weniger Reaktionen', 'Fewer reactions') : L('Mehr Reaktionen', 'More reactions');
    t.setAttribute('aria-expanded', String(open));
    t.setAttribute('aria-label', label);
    t.title = label;
  }
  function arrangeEmoteBar(bar) {
    if (!bar) return;
    renderEmoteLocks();
    const buttons = new Map([...bar.querySelectorAll('.emoteChoice[data-emote]:not(.emoteSpecial)')].map((b) => [b.dataset.emote, b]));
    const specials = [...bar.querySelectorAll('.emoteSpecial')];
    const ids = EMOTE_DEFAULT_ORDER.filter((id) => buttons.has(id));
    // One row: 40px per reaction, 44px toggle, 10px padding + border (style.css .emoteBar).
    const room = bar.id === 'emoteBar' ? Math.min(window.innerWidth - 12, 374) : (bar.parentElement.clientWidth || window.innerWidth);
    const fit = Math.min(EMOTE_TOP, Math.floor((room - 54) / 40));
    const { top, rest } = emoteLayout(ids, emoteCounts(), (id) => emoteUnlockLevel(id) > myLevel(), Math.max(4, fit - specials.length));
    bar.querySelectorAll('.emoteSep').forEach((n) => n.remove());
    let toggle = bar.querySelector('.emoteMoreBtn');
    if (!toggle) {
      toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'emoteMoreBtn';
      toggle.innerHTML = '<svg class="icon" aria-hidden="true"><use href="#i-chevron"/></svg>';
      toggle.addEventListener('click', () => {
        const open = !bar.classList.contains('emoteExpanded');
        storageSet(EMOTE_MORE_KEY, open ? '1' : '0');
        setEmoteMore(bar, open);
        if (bar.id === 'resultEmoteBar') updateResultScrollEdges();
      });
    }
    for (const id of top) {
      const b = buttons.get(id);
      b.classList.remove('emoteRest');
      bar.appendChild(b);
    }
    specials.forEach((b) => bar.appendChild(b));
    bar.appendChild(toggle);
    rest.forEach(([, list], i) => {
      if (i > 0) {
        const sep = document.createElement('span');
        sep.className = 'emoteSep emoteRest';
        sep.setAttribute('aria-hidden', 'true');
        bar.appendChild(sep);
      }
      for (const id of list) {
        const b = buttons.get(id);
        b.classList.add('emoteRest');
        bar.appendChild(b);
      }
    });
    setEmoteMore(bar, storageGet(EMOTE_MORE_KEY) === '1');
  }
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
    // Same reason as spawnPointsPopup: from a seat's top edge the rise
    // covered the top bar, so opponent emotes start mid-seat.
    bubble.style.top = fromPlayerId === playerId ? `${rect.top - 6}px` : `${rect.top + rect.height / 2 - 12}px`;
    document.body.appendChild(bubble);
    setTimeout(() => bubble.remove(), 1600);
  }

  // --- Bot lines: the server names the moment, the client picks a line ------
  // Mirrors game/BotQuips.js QUIP_MOMENTS (contract test). Per device, default off.
  const BOT_QUIPS_KEY = 'pikdame_bot_quips';
  let botQuipsOn = storageGet(BOT_QUIPS_KEY) === 'on';
  const BOT_QUIPS = {
    round_win: () => [L('Das war\'s – Karten her!', 'That\'s it – cards in!'), L('Manchmal hat man\'s einfach.', 'Sometimes you\'ve just got it.'), L('Gelernt ist gelernt.', 'Practice pays off.')],
    hand_aus: () => [L('Hand aus! Tschüss zusammen.', 'Out in one! Bye, everyone.'), L('Einmal ziehen, alles weg.', 'One draw, all gone.'), L('Hab ich gar nicht geübt, ehrlich.', 'I never even practised that, honest.')],
    game_win: () => [L('Gut gespielt, alle zusammen!', 'Well played, everyone!'), L('Revanche? Ich bin dabei.', 'Rematch? I\'m in.'), L('Das war knapper, als es aussah.', 'That was closer than it looked.')],
    queen_caught: () => [L('Schon wieder die Dame …', 'The Queen again …'), L('Die Dame mag mich einfach.', 'The Queen just likes me.'), L('Hundert Punkte weg. Na prima.', 'A hundred points gone. Lovely.')],
    queen_laid: () => [L('Hundert Punkte, danke schön!', 'A hundred points, thank you!'), L('Die Dame bleibt bei mir.', 'The Queen stays with me.'), L('Pik Dame – endlich draußen.', 'Queen of Spades – out at last.')],
    big_pile: () => [L('Den nehm ich mit.', 'I\'ll take that.'), L('Mehr Karten, mehr Möglichkeiten.', 'More cards, more chances.'), L('Hoffentlich weiß ich, was ich tue.', 'I hope I know what I\'m doing.')],
  };
  function showQuip(fromPlayerId, moment) {
    const lines = BOT_QUIPS[moment];
    const sender = ((lastState && lastState.players) || []).find((p) => p.id === fromPlayerId);
    if (!botQuipsOn || !lines || !sender || tutorialHintsOn()) return;
    const options = lines();
    const text = options[Math.floor(Math.random() * options.length)];
    // Round end: the result overlay covers the chips - the line joins the reactions there.
    if (!el('resultOverlay').classList.contains('hidden')) {
      const chip = document.createElement('span');
      chip.className = 'resultEmoteChip';
      chip.textContent = `${sender.name}: ${text}`;
      const box = el('resultEmotes');
      while (box.children.length >= 6) box.firstChild.remove();
      box.appendChild(chip);
      setTimeout(() => chip.remove(), 6000);
      return;
    }
    const anchor = document.querySelector(`#opponents .opponent[data-player-id="${CSS.escape(fromPlayerId)}"]`);
    if (!anchor) return;
    document.querySelectorAll('.quipBubble').forEach((n) => { if (n.dataset.playerId === fromPlayerId) n.remove(); });
    const rect = anchor.getBoundingClientRect();
    const bubble = document.createElement('div');
    bubble.className = 'quipBubble';
    bubble.dataset.playerId = fromPlayerId;
    bubble.textContent = text;
    document.body.appendChild(bubble);
    // Under the speaker's chip, kept inside the 16 px side gutter.
    const left = Math.max(16, Math.min(window.innerWidth - 16 - bubble.offsetWidth, rect.left + rect.width / 2 - bubble.offsetWidth / 2));
    bubble.style.left = `${left}px`;
    bubble.style.top = `${rect.bottom + 8}px`;
    setTimeout(() => bubble.remove(), 3600);
  }
  // Two switches, one setting: lobby settings (checkbox) and the in-game sheet (row).
  function setBotQuips(on) {
    botQuipsOn = on;
    storageSet(BOT_QUIPS_KEY, on ? 'on' : 'off');
    renderBotQuipsControls();
  }
  function renderBotQuipsControls() {
    el('botQuipsCheckbox').checked = botQuipsOn;
    setRowValue(el('botQuipsToggle'), botQuipsOn ? L('An', 'On') : L('Aus', 'Off'));
  }
  renderBotQuipsControls();
  el('botQuipsCheckbox').addEventListener('change', () => setBotQuips(el('botQuipsCheckbox').checked));
  el('botQuipsToggle').addEventListener('click', () => setBotQuips(!botQuipsOn));

  // --- Fortschritt: Tagesaufgaben, Erfolge-Galerie, Saison-Rangliste -------

  // The daily-task panel is a <details>: closed on a phone (it sat below
  // the fold), open on a desktop, and the last choice wins on that device.
  const QUESTS_OPEN_KEY = 'pikdame_quests_open';
  (function initQuestsPanel() {
    const box = el('questsSection');
    if (!box || box.tagName !== 'DETAILS') return;
    const saved = storageGet(QUESTS_OPEN_KEY);
    box.open = saved ? saved === '1' : !!(window.matchMedia && window.matchMedia('(min-width: 900px)').matches);
    box.addEventListener('toggle', () => storageSet(QUESTS_OPEN_KEY, box.open ? '1' : '0'));
  })();

  /** Level of the local profile, fresher myProgress included. */
  function myLevelInfo() {
    const me = myProfile();
    return levelFromXpClient(Math.max(me ? me.xp || 0 : 0, myProgress ? myProgress.xp || 0 : 0));
  }
  // Streak state from the profile; "today" is the server's game day (the
  // quests' date), never the device clock.
  function myStreakInfo() {
    const me = myProfile();
    const daily = (me && me.daily) || {};
    const today = dailyQuests && dailyQuests.date;
    const playedToday = !!(today && (daily.last === today || (myStreak && myStreak.event)));
    return {
      streak: (myStreak && myStreak.streak) || (me && me.dailyStreak) || 0,
      best: Math.max((myStreak && myStreak.best) || 0, daily.best || 0),
      graceFree: myStreak ? !!myStreak.graceFree : !daily.graceAt,
      playedToday,
    };
  }
  function progressEnabled() {
    return !publicMode && !!(dailyQuests && dailyQuests.ids && dailyQuests.ids.length);
  }
  // Lifetime progress on the identity chip: XP ring + level badge. The
  // avatar button opens the progress sheet.
  function renderIdentityProgress() {
    const av = el('identityAvatar');
    const btn = el('identityAvatarBtn');
    if (!av || !btn) return;
    const on = progressEnabled();
    const lv = myLevelInfo();
    av.classList.toggle('hasLevel', on);
    av.style.setProperty('--xp', on ? String(Math.round((lv.into / lv.need) * 100)) : '0');
    let badge = av.querySelector('.identityLevel');
    if (on && !badge) {
      badge = document.createElement('span');
      badge.className = 'identityLevel';
      av.appendChild(badge);
    }
    if (badge) {
      badge.classList.toggle('hidden', !on);
      badge.textContent = String(lv.level);
    }
    // Flame: filled once today counts, outlined while today is still open.
    const st = el('identityStreak');
    const si = myStreakInfo();
    if (st) {
      st.classList.toggle('hidden', !on || si.streak <= 0);
      st.classList.toggle('pending', !si.playedToday);
      st.innerHTML = `<svg class="icon" aria-hidden="true"><use href="#i-flame"/></svg><span>${si.streak}</span>`;
    }
    btn.disabled = !on;
    const streakText = si.streak > 0
      ? si.playedToday
        ? L(`, ${si.streak} Tage in Folge`, `, ${si.streak}-day streak`)
        : L(`, ${si.streak} Tage in Folge - heute noch nicht gespielt`, `, ${si.streak}-day streak - not played today yet`)
      : '';
    const label = on
      ? L(`Fortschritt: Stufe ${lv.level}, ${lv.into}/${lv.need} EP`, `Progress: level ${lv.level}, ${lv.into}/${lv.need} XP`) + streakText
      : L('Fortschritt', 'Progress');
    btn.title = label;
    btn.setAttribute('aria-label', label);
  }

  // Mirrors game/Progression.js (XP_BASE, XP_WIN, XP_PER_POINT) - display only.
  const XP_RULES = { base: 10, win: 50, perPoints: 10, towerFirstStar: 10, towerCrown: 50 };
  function renderProgressSheet() {
    const box = el('progressContent');
    if (!box) return;
    const lv = myLevelInfo();
    const pct = Math.round((lv.into / lv.need) * 100);
    const next = nextRewards(levelRewards(), lv.level);
    const cur = LEVEL_TITLES.reduce((idx, row, i) => (lv.level >= row[0] ? i : idx), 0);
    const ladder = LEVEL_TITLES.map(([level, de, en], i) => {
      const cls = i === cur ? 'current' : i < cur ? 'done' : '';
      return `<li class="${cls}"><span class="plLevel">${level}</span><span>${escapeHtml(L(de, en))}</span>` +
        (cls === 'current' ? `<b>${escapeHtml(L('aktuell', 'current'))}</b>` : cls === 'done' ? '<svg class="icon" aria-hidden="true"><use href="#i-check"/></svg>' : '') + `</li>`;
    }).join('');
    box.innerHTML =
      `<div class="pgHead"><span class="pgLevel">${lv.level}</span><span class="pgText"><b>${L(`Stufe ${lv.level}`, `Level ${lv.level}`)}</b><span>${escapeHtml(titleForLevel(lv.level))}</span></span></div>` +
      `<div class="levelUpBar pgBar"><i style="width:${pct}%"></i></div>` +
      `<p class="pgXp">${L(`${lv.into}/${lv.need} EP · noch ${lv.need - lv.into} bis Stufe ${lv.level + 1}`, `${lv.into}/${lv.need} XP · ${lv.need - lv.into} to level ${lv.level + 1}`)}</p>` +
      (next.length
        ? `<h3>${escapeHtml(L(`Nächste Belohnung (Stufe ${next[0].level})`, `Next reward (level ${next[0].level})`))}</h3><ul class="pgNext">${next.map((r) => `<li>${rewardHtml(r)}</li>`).join('')}</ul>`
        : '') +
      streakSectionHtml() +
      towerSectionHtml() +
      `<h3>${escapeHtml(L('So gibt es Erfahrung', 'How to earn XP'))}</h3>` +
      `<p class="pgRules">${escapeHtml(L(
        `${XP_RULES.base} EP pro beendeter Partie, +${XP_RULES.win} für einen Sieg, +1 je ${XP_RULES.perPoints} Punkte Endstand.`,
        `${XP_RULES.base} XP per finished match, +${XP_RULES.win} for a win, +1 per ${XP_RULES.perPoints} points of your final score.`
      ))}</p>` +
      `<h3>${escapeHtml(L('Titel', 'Titles'))}</h3><ol class="pgLadder">${ladder}</ol>`;
  }
  function streakSectionHtml() {
    const si = myStreakInfo();
    const status = si.streak <= 0
      ? L('Spiel heute eine Partie zu Ende oder löse das Tagesrätsel, um eine Serie zu starten.', 'Finish a match or solve the daily puzzle today to start a streak.')
      : si.playedToday
        ? L('Heute schon gespielt - die Serie läuft.', 'Played today - the streak is safe.')
        : L('Heute noch nicht gespielt - eine beendete Partie oder das gelöste Tagesrätsel hält die Serie.', 'Not played today yet - a finished match or the solved daily puzzle keeps it going.');
    return `<h3>${escapeHtml(L('Tagesserie', 'Daily streak'))}</h3>` +
      `<div class="pgStreak${si.playedToday ? '' : ' pending'}">` +
      `<span class="pgStreakNum"><svg class="icon" aria-hidden="true"><use href="#i-flame"/></svg>${si.streak}</span>` +
      `<span class="pgStreakText"><b>${escapeHtml(si.streak === 1 ? L('1 Tag in Folge', '1 day running') : L(`${si.streak} Tage in Folge`, `${si.streak} days running`))}</b>` +
      `<span>${escapeHtml(status)}</span></span></div>` +
      `<p class="pgRules">${escapeHtml(L(
        `Rekord: ${si.best} ${si.best === 1 ? 'Tag' : 'Tage'} · Joker-Tag ${si.graceFree ? 'frei' : 'diese Woche verbraucht'}. Ein verpasster Tag pro Woche wird überbrückt.`,
        `Best: ${si.best} ${si.best === 1 ? 'day' : 'days'} · grace day ${si.graceFree ? 'free' : 'used this week'}. One missed day per week is bridged.`
      ))}</p>`;
  }
  function openProgressSheet() {
    if (!progressEnabled()) return;
    if (!towerFresh()) requestTower();
    renderProgressSheet();
    el('progressOverlay').classList.remove('hidden');
  }
  el('progressCloseBtn').addEventListener('click', () => el('progressOverlay').classList.add('hidden'));
  el('progressOverlay').addEventListener('click', (ev) => {
    if (ev.target === el('progressOverlay')) el('progressOverlay').classList.add('hidden');
  });
  el('progressContent').addEventListener('click', (ev) => {
    if (ev.target.closest('[data-open-tower]')) openTowerSheet();
  });

  // --- Kartenhaus (game/BotTower.js): a monthly house of twenty floors -------
  // The server owns floors, months and stars; the client draws the house as an
  // SVG pyramid of card tents and starts a floor like the challenge (solo).
  let towerInfo = null; // 'towerInfo' + forName: month, today, stages, best, stars, cleared, unlocked, crowned, totalStars, archive
  let towerAskedFor = '';
  let towerSelected = 0; // the floor the detail shows (APEX = the top), 0 = the default
  let towerAnimate = false; // set on opening: the next render with data may animate
  let towerFxToken = 0; // a newer render cancels a pending rebuild
  let lastTowerResult = null; // 'towerResult' of the floor just played
  const AFTER_TOWER_KEY = 'pikdame_after_tower';
  const TOWER_SEEN_KEY = 'pikdame_tower_seen'; // what this device last showed: { name, month, best, crowned }
  const TOWER_LAST_KEY = 'pikdame_tower_last'; // the last verdict, for the wobble: { name, month, stage, stars }
  const APEX = 21;
  const towerName = () => L('Kartenhaus', 'House of Cards');
  // The ONLY wording of the floor modifiers (sheet, help, table): 'queen' is a
  // risk (+100 melded, -100 in hand), the others are handicaps.
  const TOWER_MODS = {
    queen: () => L('Risiko: Pik Dame auf der Hand', 'Risk: Queen of Spades in hand'),
    noDiscard: () => L('Ohne Ablage', 'No discard pile'),
    goOut: () => L('Selbst ausmachen', 'Go out yourself'),
  };
  const TOWER_MOD_RULES = {
    queen: () => L('Risiko: Pik Dame auf der Hand – ausgelegt +100, auf der Hand −100', 'Risk: Queen of Spades in hand – +100 melded, −100 in hand'),
    noDiscard: () => L('Erschwernis: keine Ablage (nur vom Stapel ziehen)', 'Handicap: no discard pile (draw from the stock only)'),
    goOut: () => L('Erschwernis: Sterne nur, wenn du selbst ausmachst', 'Handicap: stars only if you go out yourself'),
  };
  const towerModsText = (mods) => (mods || []).map((m) => (TOWER_MODS[m] ? TOWER_MODS[m]() : m)).join(' · ');
  const towerModRulesText = (mods) => (mods || []).map((m) => (TOWER_MOD_RULES[m] ? TOWER_MOD_RULES[m]() : m)).join('; ');
  function requestTower() {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    towerAskedFor = myName || '';
    ws.send(JSON.stringify({ type: 'getTower', name: towerAskedFor }));
  }
  /** Tower data for the current name (a renamed player sees their own). */
  function towerFresh() {
    return towerInfo && towerInfo.forName === (myName || '') ? towerInfo : null;
  }
  /** "Oktober" for '2026-10' (UTC mid-month, so no time zone shifts the month). */
  function towerMonthName(month, withYear = false) {
    const [y, m] = String(month || '').split('-').map(Number);
    if (!y || !m) return '';
    return new Date(Date.UTC(y, m - 1, 15)).toLocaleDateString(lang === 'en' ? 'en-GB' : 'de-DE',
      { month: 'long', ...(withYear ? { year: 'numeric' } : {}), timeZone: 'UTC' });
  }
  /** Start screen, "Aufgaben": this month's floor and stars on the wide tile.
   *  Hidden in public mode and while the data for this name is missing. */
  function renderTowerTile() {
    const tile = el('towerTile');
    if (!tile) return;
    const info = publicMode ? null : towerFresh();
    tile.classList.toggle('hidden', !info);
    if (!info) return;
    const max = info.stages.length * 3;
    const floor = Math.min(info.unlocked || 1, info.stages.length);
    const month = towerMonthName(info.month);
    const status = el('towerTileStatus');
    status.textContent = info.crowned
      ? L(`Gekrönt · ${info.stars}/${max}`, `Crowned · ${info.stars}/${max}`)
      : L(`Etage ${floor} · ${info.stars}/${max}`, `Floor ${floor} · ${info.stars}/${max}`);
    status.insertAdjacentHTML('beforeend', '<svg class="icon ttStar" aria-hidden="true"><use href="#i-star"/></svg>');
    // A fresh month calls (like a new puzzle), a crowned one rests; in between it stays calm.
    tile.dataset.state = info.crowned ? 'done' : info.stars ? '' : 'new';
    tile.setAttribute('aria-label', info.crowned
      ? L(`Kartenhaus im ${month}: gekrönt, ${info.stars} von ${max} Sternen`, `House of Cards in ${month}: crowned, ${info.stars} of ${max} stars`)
      : L(`Kartenhaus im ${month}: Etage ${floor}, ${info.stars} von ${max} Sternen`, `House of Cards in ${month}: floor ${floor}, ${info.stars} of ${max} stars`));
  }
  el('towerTile').addEventListener('click', () => openTowerSheet());
  const towerStarsHtml = (n) => [1, 2, 3]
    .map((i) => `<svg class="icon${i <= n ? ' on' : ''}" aria-hidden="true"><use href="#i-star"/></svg>`).join('');
  function towerSectionHtml() {
    const info = towerFresh();
    const size = info ? info.stages.length : 0;
    return `<h3>${escapeHtml(towerName())}</h3>` +
      `<button type="button" class="pgTower" data-open-tower="1">` +
      `<svg class="icon pgTowerIcon" aria-hidden="true"><use href="#i-cardhouse"/></svg>` +
      `<span class="pgTowerText"><b>${escapeHtml(info
        ? L(`${towerMonthName(info.month)}: ${info.stars}/${size * 3} Sterne`, `${towerMonthName(info.month)}: ${info.stars}/${size * 3} stars`)
        : towerName())}</b>` +
      `<span>${escapeHtml(info
        ? L(`${info.cleared} von ${size} Etagen · insgesamt ${info.totalStars} Sterne`, `${info.cleared} of ${size} floors · ${info.totalStars} stars in total`)
        : L('Jeden Monat neue Blätter', 'New deals every month'))}</span></span>` +
      `<svg class="icon pgTowerGo" aria-hidden="true"><use href="#i-chevron"/></svg></button>`;
  }
  // Pyramid in SVG units: rows of 6-5-4-3-2 tents and the top. The hit areas tile
  // the house; a row and a slot stay >= --tap-min even on an iPhone SE.
  const KH = { w: 26, h: 42, tilt: 15, gap: 56, row: 46 };
  const KH_ROWS = [6, 5, 4, 3, 2];
  const KH_VIEW = '-172 -282 344 290';
  function khSlots() {
    const out = [];
    let stage = 1;
    KH_ROWS.forEach((n, r) => {
      for (let i = 0; i < n; i++) out.push({ stage: stage++, row: r, x: (i - (n - 1) / 2) * KH.gap, base: -r * KH.row });
    });
    out.push({ stage: APEX, row: KH_ROWS.length, x: 0, base: -KH_ROWS.length * KH.row });
    return out;
  }
  const khNum = (v) => Math.round(v * 10) / 10;
  function khStarPoints(cx, cy, r) {
    const pts = [];
    for (let i = 0; i < 10; i++) {
      const rr = i % 2 ? r * 0.45 : r;
      const a = -Math.PI / 2 + (i * Math.PI) / 5;
      pts.push(`${khNum(cx + rr * Math.cos(a))},${khNum(cy + rr * Math.sin(a))}`);
    }
    return pts.join(' ');
  }
  /** One leaning card, rotated around its foot; `inner` is drawn on its face. */
  function khCard(x, base, rot, built, inner = '') {
    const { w, h } = KH;
    return `<g transform="translate(${khNum(x)} ${base}) rotate(${rot})">` +
      `<rect class="khCard" x="${-w / 2}" y="${-h}" width="${w}" height="${h}" rx="3"/>` +
      (built ? `<rect class="khRim" x="${-w / 2 + 2.4}" y="${-h + 2.4}" width="${w - 4.8}" height="${h - 4.8}" rx="1.6"/>` : '') +
      inner + '</g>';
  }
  /** The flat card a floor stands on, laid across the tips of the two tents
   *  below (floors of the first row stand on the ground). */
  function khPlate(slot) {
    if (slot.row === 0) return '';
    const len = KH.gap - 2;
    return `<rect class="khPlate" x="${khNum(slot.x - len / 2)}" y="${slot.base + 0.6}" width="${len}" height="4" rx="1.5"/>`;
  }
  function towerFloorState(info, stage) {
    const stars = Math.max(0, Math.min(3, Math.floor(Number(info.best[stage]) || 0)));
    if (stars) return { state: 'built', stars };
    return { state: stage === info.unlocked && !info.crowned ? 'next' : 'locked', stars: 0 };
  }
  function towerFloorLabel(s, st, info) {
    const names = s.bots.map((b) => (BOT_DIFF[b] || BOT_DIFF.zen).short()).join(', ');
    const mods = towerModsText(s.mods);
    const status = st.state === 'built'
      ? L(`${st.stars} von 3 Sternen`, `${st.stars} of 3 stars`)
      : st.state === 'next' ? L('noch kein Stern', 'no star yet') : L('gesperrt', 'locked');
    return L(
      `Etage ${s.stage}: gegen ${names}${s.handicap ? `, die Bots bekommen ${s.handicap} Punkte Vorgabe` : ''}${mods ? `, ${mods}` : ''} - ${status}`,
      `Floor ${s.stage}: against ${names}${s.handicap ? `, the bots get a ${s.handicap}-point head start` : ''}${mods ? `, ${mods}` : ''} - ${status}`
    );
  }
  /** The house as inline SVG. fx: { land: [stages], pop: { stage: starsBefore }, wobble, crown, mode } */
  function towerHouseSvg(info, fx = {}) {
    const { w, h, tilt, row } = KH;
    const lean = khNum(h * Math.sin((tilt * Math.PI) / 180));
    const byStage = Object.fromEntries(info.stages.map((s) => [s.stage, s]));
    const landAt = (stage) => (fx.land || []).indexOf(stage);
    // The ring marks a floor the player picked; the default one (next, or the top) is marked already.
    const sel = towerSelected;
    const shown = towerSelected || towerDefaultSelection(info);
    const parts = [];
    const sec = (v) => Math.round(v * 100) / 100;
    for (const slot of khSlots()) {
      const delay = (v) => ` style="--kh-delay:${sec(v)}s"`;
      if (slot.stage === APEX) {
        const crowned = !!info.crowned;
        const cls = ['khFloor', 'khApex', crowned ? 'built' : 'locked', sel === APEX ? 'sel' : '',
          crowned && fx.crown ? 'khCrowning' : '', fx.mode === 'rebuild' ? 'khRise' : '', fx.mode === 'collapse' && crowned ? 'khFall' : ''].filter(Boolean).join(' ');
        const label = crowned
          ? L('Spitze: Das Kartenhaus ist gekrönt', 'Top: the House of Cards is crowned')
          : L('Spitze: Alle 20 Etagen mit einem Stern krönen das Kartenhaus', 'Top: a star on all 20 floors crowns the House of Cards');
        const top = slot.base - 44;
        const card = crowned
          ? `<g class="khQueen"><rect class="khQueenCard" x="-15" y="${top}" width="30" height="44" rx="3.5"/>` +
            `<text class="khQueenQ" x="-10.5" y="${top + 12}">Q</text><text class="khQueenS" x="0" y="${top + 31}">♠</text></g>`
          : `<rect class="khSpitze" x="-15" y="${top}" width="30" height="44" rx="3.5"/>` +
            `<text class="khSpitzeText" x="0" y="${top + 25}">${escapeHtml(L('Spitze', 'Top'))}</text>`;
        parts.push(`<g class="${cls}" data-stage="${APEX}" role="button" tabindex="0" aria-pressed="${shown === APEX}" aria-label="${escapeHtml(label)}"` +
          `${delay(fx.mode === 'rebuild' ? 0.5 : fx.crownDelay || 0)}>` +
          `<rect class="khSel" x="-27" y="${top - 5}" width="54" height="${44 + 9}" rx="9"/>` +
          khPlate(slot) + card +
          `<rect class="khHit" x="${-KH.gap / 2}" y="${top - 6}" width="${KH.gap}" height="${44 + 11}"/></g>`);
        continue;
      }
      const s = byStage[slot.stage];
      if (!s) continue;
      const st = towerFloorState(info, slot.stage);
      const mod = !!(s.mods && s.mods.length);
      const li = landAt(slot.stage);
      const cls = ['khFloor', st.state, mod ? 'mod' : '', sel === slot.stage ? 'sel' : '',
        li > -1 ? 'khLanding' : '', fx.wobble === slot.stage ? 'khWobble' : '',
        fx.mode === 'rebuild' ? 'khRise' : '', fx.mode === 'collapse' && st.state === 'built' ? 'khFall' : ''].filter(Boolean).join(' ');
      const d = fx.mode === 'rebuild' ? slot.row * 0.08 + (slot.stage % 3) * 0.02
        : fx.mode === 'collapse' ? (KH_ROWS.length - slot.row) * 0.05 : li > -1 ? li * (fx.land.length > 4 ? 0.07 : 0.14) : 0.25;
      const popFrom = fx.pop && fx.pop[slot.stage] !== undefined ? fx.pop[slot.stage] : 3;
      const stars = st.state === 'locked' ? '' : [0, 1, 2].map((i) =>
        `<polygon class="khStar${i < st.stars ? ' on' : ''}${i < st.stars && i >= popFrom ? ' khPop' : ''}"` +
        `${i < st.stars && i >= popFrom ? delay(0.35 + (i - popFrom) * 0.15) : ''} points="${khStarPoints(-7.5 + i * 7.5, -8.5, 3.5)}"/>`).join('');
      const face = `<text class="khNum" x="0" y="${-h + 16}">${slot.stage}</text>${stars}`;
      // Collapse: every card falls its own way (fixed per floor, no randomness).
      const fall = fx.mode === 'collapse' ? `;--kh-dx:${((slot.stage * 37) % 70) - 35}px;--kh-rot:${((slot.stage * 53) % 90) - 45}deg` : '';
      parts.push(`<g class="${cls}" data-stage="${slot.stage}" role="button" tabindex="0" aria-pressed="${shown === slot.stage}"` +
        ` aria-label="${escapeHtml(towerFloorLabel(s, st, info))}" style="--kh-delay:${sec(d)}s${fall}">` +
        `<rect class="khHalo" x="${slot.x - 29}" y="${slot.base - row + 1}" width="58" height="${row + 3}" rx="11"/>` +
        `<rect class="khSel" x="${slot.x - 27.5}" y="${slot.base - row + 1.5}" width="55" height="${row + 2}" rx="10"/>` +
        khPlate(slot) +
        khCard(slot.x - lean / 2, slot.base, tilt, st.state === 'built') +
        khCard(slot.x + lean / 2, slot.base, -tilt, st.state === 'built', face) +
        `<rect class="khHit" x="${slot.x - KH.gap / 2}" y="${slot.base - row}" width="${KH.gap}" height="${row}"/></g>`);
    }
    return `<svg class="khSvg${fx.mode ? ` kh-${fx.mode}` : ''}" viewBox="${KH_VIEW}" role="group" aria-label="${escapeHtml(L(`Kartenhaus im ${towerMonthName(info.month)}`, `House of Cards in ${towerMonthName(info.month)}`))}">` +
      `<defs><pattern id="khBack" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">` +
      `<rect class="khBackBase" width="6" height="6"/><rect class="khBackLine" width="1.2" height="6"/></pattern></defs>` +
      `<line class="khGround" x1="-168" x2="168" y1="0.5" y2="0.5"/>` + parts.join('') + '</svg>';
  }
  /** The default floor of the detail: the next one, or the top once crowned. */
  function towerDefaultSelection(info) {
    return info.crowned ? APEX : Math.min(info.unlocked || 1, info.stages.length);
  }
  function towerDaysLeftText(today) {
    const [y, m, d] = String(today || '').split('-').map(Number);
    if (!y || !m || !d) return '';
    const left = new Date(Date.UTC(y, m, 0)).getUTCDate() - d;
    if (left <= 0) return L('heute letzter Tag', 'last day today');
    return left === 1 ? L('noch 1 Tag', '1 day left') : L(`noch ${left} Tage`, `${left} days left`);
  }
  /** "3 Bots: Zen, Zen, Zen · 160 Punkte Vorgabe" - the floor detail and the floor at the table. */
  function towerBotsLine(bots, handicap) {
    const names = (bots || []).map((b) => (BOT_DIFF[b] || BOT_DIFF.zen).short()).join(', ');
    const n = (bots || []).length;
    return L(`${n} Bots: ${names}`, `${n} bots: ${names}`) +
      (handicap ? L(` · ${handicap} Punkte Vorgabe`, ` · ${handicap}-point head start`) : '');
  }
  /** The detail under the house: who plays, what the floor asks, and the way in. */
  function towerDetailHtml(info, stage) {
    const max = info.stages.length;
    if (stage === APEX) {
      if (!info.crowned) {
        return `<div class="khDHead"><b class="khDTitle">${escapeHtml(L('Spitze', 'Top'))}</b></div>` +
          `<p class="khDNote">${escapeHtml(L(`Hol dir auf allen ${max} Etagen mindestens einen Stern - dann krönt die Pik Dame dein Kartenhaus (+${XP_RULES.towerCrown} EP).`,
            `Earn at least one star on all ${max} floors - then the Queen of Spades crowns your House of Cards (+${XP_RULES.towerCrown} XP).`))}</p>`;
      }
      // Still stars to collect: the highest floor that misses some.
      const missing = [...info.stages].reverse().find((s) => (Number(info.best[s.stage]) || 0) < 3);
      const gap = missing ? 3 - (Number(info.best[missing.stage]) || 0) : 0;
      const more = !missing ? L(`Alle ${max * 3} Sterne - mehr geht nicht.`, `All ${max * 3} stars - it does not get better.`)
        : gap === 1 ? L(`Auf Etage ${missing.stage} fehlt noch 1 Stern.`, `Floor ${missing.stage} still misses 1 star.`)
          : L(`Auf Etage ${missing.stage} fehlen noch ${gap} Sterne.`, `Floor ${missing.stage} still misses ${gap} stars.`);
      return `<div class="khDHead"><b class="khDTitle">${escapeHtml(L('Gekrönt!', 'Crowned!'))}</b></div>` +
        `<p class="khDNote">${escapeHtml(L(`Alle ${max} Etagen im ${towerMonthName(info.month)} geschafft. ${more}`,
          `All ${max} floors cleared in ${towerMonthName(info.month)}. ${more}`))}</p>` +
        (missing
          ? `<button type="button" class="btn-primary khPlay" data-play="${missing.stage}"><svg class="icon" aria-hidden="true"><use href="#i-play"/></svg>` +
            `<span>${escapeHtml(L(`Etage ${missing.stage} nochmal`, `Floor ${missing.stage} again`))}</span></button>`
          : '');
    }
    const s = info.stages.find((x) => x.stage === stage);
    if (!s) return '';
    const st = towerFloorState(info, stage);
    const tag = st.state === 'built'
      ? `<span class="khDStars" role="img" aria-label="${escapeHtml(L(`${st.stars} von 3 Sternen`, `${st.stars} of 3 stars`))}">${towerStarsHtml(st.stars)}</span>`
      : st.state === 'next'
        ? `<span class="khDTag next">${escapeHtml(L('als Nächstes', 'up next'))}</span>`
        : `<span class="khDTag"><svg class="icon" aria-hidden="true"><use href="#i-lock"/></svg><span>${escapeHtml(L('gesperrt', 'locked'))}</span></span>`;
    const bots = towerBotsLine(s.bots, s.handicap);
    const mods = (s.mods || []).map((m) => `<span class="khMod">${escapeHtml(TOWER_MODS[m] ? TOWER_MODS[m]() : m)}</span>`).join('');
    const note = st.state === 'locked'
      ? L(`Schaff erst Etage ${Math.min(info.unlocked || 1, max)}.`, `Clear floor ${Math.min(info.unlocked || 1, max)} first.`)
      : st.state === 'next' ? L('Ein Stern: mehr Punkte als jeder Bot samt Vorgabe.', 'One star: more points than every bot plus its head start.')
        : st.stars < 3 ? L(`Bestwert ${st.stars} von 3 - ein neuer Versuch spielt dasselbe Blatt.`, `Best ${st.stars} of 3 - a new try plays the same deal.`)
          : L('Alle drei Sterne.', 'All three stars.');
    const play = st.state === 'locked' ? ''
      : `<button type="button" class="${st.state === 'next' ? 'btn-primary' : 'btn-secondary'} khPlay" data-play="${stage}"><svg class="icon" aria-hidden="true"><use href="#i-play"/></svg>` +
        `<span>${escapeHtml(st.state === 'next' ? L(`Etage ${stage} spielen`, `Play floor ${stage}`) : L(`Etage ${stage} nochmal`, `Floor ${stage} again`))}</span></button>`;
    return `<div class="khDHead"><b class="khDTitle">${escapeHtml(L(`Etage ${stage}`, `Floor ${stage}`))}</b>${tag}</div>` +
      `<p class="khDBots">${escapeHtml(bots)}</p>` +
      (mods ? `<p class="khDMods" aria-label="${escapeHtml(towerModRulesText(s.mods))}">${mods}</p>` : '') +
      `<p class="khDNote">${escapeHtml(note)}</p>` + play;
  }
  function towerArchiveHtml(archive) {
    return archive.map((m) => {
      const label = L(`${towerMonthName(m.month, true)}: ${m.cleared} von 20 Etagen, ${m.stars} von 60 Sternen${m.crowned ? ', gekrönt' : ''}`,
        `${towerMonthName(m.month, true)}: ${m.cleared} of 20 floors, ${m.stars} of 60 stars${m.crowned ? ', crowned' : ''}`);
      return `<li class="khArchRow${m.crowned ? ' crowned' : ''}" aria-label="${escapeHtml(label)}">` +
        `<span class="khArchMonth">${escapeHtml(towerMonthName(m.month, true))}</span>` +
        `<span class="khArchFloors">${escapeHtml(L(`${m.cleared}/20 Etagen`, `${m.cleared}/20 floors`))}</span>` +
        `<span class="khArchStars">${m.stars}/60<svg class="icon" aria-hidden="true"><use href="#i-star"/></svg></span>` +
        (m.crowned ? `<span class="khArchCrown"><svg class="icon" aria-hidden="true"><use href="#i-crown"/></svg><span>${escapeHtml(L('gekrönt', 'crowned'))}</span></span>` : '') +
        '</li>';
    }).join('');
  }
  function towerMotionOk() {
    try { return !window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { return false; }
  }
  function towerStored(key) {
    try { const v = JSON.parse(storageGet(key) || 'null'); return v && typeof v === 'object' ? v : null; } catch (e) { return null; }
  }
  function towerMarkSeen(info) {
    storageSet(TOWER_SEEN_KEY, JSON.stringify({ name: myName || '', month: info.month, best: info.best || {}, crowned: !!info.crowned }));
  }
  /** What changed since this device last showed the house: new floors land,
   *  new stars pop, a lost try wobbles, a fresh crown lands on top. */
  function towerEffects(info, seen) {
    const fx = { land: [], pop: {}, wobble: 0, crown: false };
    const name = myName || '';
    const before = seen && seen.name === name && seen.month === info.month ? seen.best || {} : seen && seen.name === name ? null : {};
    if (before) {
      for (const s of info.stages) {
        const now = Math.min(3, Number(info.best[s.stage]) || 0);
        const was = Math.min(3, Number(before[s.stage]) || 0);
        if (now >= 1 && was < 1) fx.land.push(s.stage);
        else if (now > was) fx.pop[s.stage] = was;
      }
      fx.crown = !!info.crowned && !(seen && seen.name === name && seen.month === info.month && seen.crowned);
    }
    const last = towerStored(TOWER_LAST_KEY);
    storageRemove(TOWER_LAST_KEY);
    if (last && last.name === name && last.month === info.month && !last.stars && !(Number(info.best[last.stage]) >= 1)) fx.wobble = last.stage;
    fx.crownDelay = fx.land.length ? fx.land.length * (fx.land.length > 4 ? 0.07 : 0.14) + 0.55 : 0.3;
    return fx;
  }
  function renderTowerDetail(info) {
    el('towerDetail').innerHTML = info ? towerDetailHtml(info, towerSelected || towerDefaultSelection(info)) : '';
  }
  // The star levels (BotTower.starsFor): generic in the help fold, exact for a floor
  // at the table - its head start, and goOut leaves no 2-star outcome.
  function towerStarRulesHtml({ clearMargin, handicap = null, goOut = false }) {
    const stars = (k) => `<span class="khRuleStars" aria-hidden="true">${'<svg class="icon"><use href="#i-star"/></svg>'.repeat(k)}</span>`;
    const li = (k, de, en, cls = '') => `<li${cls ? ` class="${cls}"` : ''}>${stars(k)}<span>${escapeHtml(L(de, en))}</span></li>`;
    const m = clearMargin;
    const h = handicap;
    if (h === null) {
      return '<ul class="khRuleList">' +
        li(1, '1 Stern: mehr Punkte als jeder Bot samt Vorgabe', '1 star: more points than every bot plus its head start') +
        li(2, `2 Sterne: mindestens ${m} Punkte vorn`, `2 stars: at least ${m} points ahead`) +
        li(3, '3 Sterne: dazu selbst ausmachen', '3 stars: and go out yourself') + '</ul>';
    }
    const beat = h ? L(`mehr Punkte als jeder Bot samt ${h} Vorgabe`, `more points than every bot plus its ${h} head start`)
      : L('mehr Punkte als jeder Bot', 'more points than every bot');
    if (goOut) {
      return '<ul class="khRuleList">' +
        li(1, `1 Stern: selbst ausmachen und ${beat}`, `1 star: go out yourself with ${beat}`) +
        li(2, '2 Sterne: gibt es hier nicht – ohne Ausmachen kein Stern', '2 stars: not on this floor – no star without going out', 'off') +
        li(3, `3 Sterne: selbst ausmachen und mindestens ${m} Punkte vorn`, `3 stars: go out yourself at least ${m} points ahead`) + '</ul>';
    }
    return '<ul class="khRuleList">' +
      li(1, `1 Stern: ${beat}`, `1 star: ${beat}`) +
      li(2, `2 Sterne: mindestens ${m} Punkte vorn`, `2 stars: at least ${m} points ahead`) +
      li(3, '3 Sterne: dazu selbst ausmachen', '3 stars: and go out yourself') + '</ul>';
  }
  // The help fold: intro, star levels and floor-11 handicaps as lists, then the rest.
  function towerRulesHtml(info) {
    const n = info.stages.length;
    const p = (de, en) => `<p>${escapeHtml(L(de, en))}</p>`;
    return p(`Jeden Monat neue Blätter gegen dieselben Bots: ${n} Etagen, jede eine Runde.`, `New deals every month against the same bots: ${n} floors, one round each.`) +
      towerStarRulesHtml({ clearMargin: info.clearMargin }) +
      p('Ein Stern macht die nächste Etage frei. Versuche sind unbegrenzt, der beste zählt.', 'One star unlocks the next floor. Tries are unlimited, the best counts.') +
      p('Ab Etage 11 gilt eine Sonderregel – ein Risiko oder eine Erschwernis:', 'From floor 11 a special rule applies – a risk or a handicap:') +
      '<ul class="khRuleList">' +
      Object.keys(TOWER_MOD_RULES).map((m) => '<li class="dot"><span>' + escapeHtml(TOWER_MOD_RULES[m]()) + '</span></li>').join('') +
      '</ul>' +
      p(`Der erste Stern jeder Etage bringt pro Monat einmal ${XP_RULES.towerFirstStar} EP; alle ${n} Etagen krönen dein Kartenhaus (+${XP_RULES.towerCrown} EP).`,
        `The first star of each floor pays ${XP_RULES.towerFirstStar} XP once a month; all ${n} floors crown your House of Cards (+${XP_RULES.towerCrown} XP).`);
  }
  function renderTower() {
    const info = towerFresh();
    const max = info ? info.stages.length * 3 : 0;
    el('towerMonth').textContent = info ? towerMonthName(info.month, true) : '';
    const days = info ? towerDaysLeftText(info.today) : '';
    el('towerSummary').innerHTML = info
      ? `<b>${info.stars} / ${max}</b> ${escapeHtml(L('Sternen diesen Monat', 'stars this month'))}${days ? ` · ${escapeHtml(days)}` : ''}`
      : escapeHtml(L('Lädt …', 'Loading …'));
    el('towerRules').innerHTML = info ? towerRulesHtml(info) : '';
    const archive = (info && info.archive) || [];
    el('towerArchive').innerHTML = towerArchiveHtml(archive);
    el('towerArchiveBox').classList.toggle('hidden', !archive.length);
    const house = el('towerHouse');
    if (!info) { house.innerHTML = ''; renderTowerDetail(null); return; }
    const open = !el('towerOverlay').classList.contains('hidden');
    const animate = open && towerAnimate && towerMotionOk();
    if (open && towerAnimate && !animate) storageRemove(TOWER_LAST_KEY); // seen, without motion
    if (open) towerAnimate = false;
    // The same house again (a second reply, a re-render): keep the drawing, so a
    // running animation is not cut off.
    const sig = JSON.stringify([lang, info.month, info.best, info.crowned, info.unlocked, towerSelected]);
    if (!animate && house.dataset.sig === sig && house.firstChild) {
      if (open) towerMarkSeen(info);
      renderTowerDetail(info);
      return;
    }
    house.dataset.sig = sig;
    const token = ++towerFxToken;
    const seen = animate ? towerStored(TOWER_SEEN_KEY) : null;
    const name = myName || '';
    if (animate && seen && seen.name === name && seen.month && seen.month !== info.month && Object.keys(seen.best || {}).length) {
      // A new month: the last seen house collapses once, then the new one rises as a blueprint.
      const old = { ...info, month: seen.month, best: seen.best, crowned: !!seen.crowned, unlocked: 0 };
      house.innerHTML = towerHouseSvg(old, { mode: 'collapse' });
      setTimeout(() => {
        if (token !== towerFxToken) return;
        house.innerHTML = towerHouseSvg(info, { mode: 'rebuild' });
      }, 1150);
    } else {
      house.innerHTML = towerHouseSvg(info, animate ? towerEffects(info, seen) : {});
    }
    if (open) towerMarkSeen(info);
    renderTowerDetail(info);
  }
  function openTowerSheet() {
    if (publicMode) return;
    requestTower(); // fresh stars and the day count; the cached data draws meanwhile
    el('progressOverlay').classList.add('hidden');
    el('towerOverlay').classList.remove('hidden');
    towerSelected = 0;
    towerAnimate = true;
    renderTower();
  }
  function startTowerStage(stage) {
    el('towerOverlay').classList.add('hidden');
    send({ type: 'startTower', stage, name: currentName(), accountToken: accountToken() || undefined });
  }
  /** A tap or Enter on a floor shows its detail (it never starts it). */
  function selectTowerFloor(stage) {
    const info = towerFresh();
    if (!info || !stage) return;
    towerSelected = stage;
    for (const g of el('towerHouse').querySelectorAll('[data-stage]')) {
      const on = Number(g.dataset.stage) === stage;
      g.classList.toggle('sel', on);
      g.setAttribute('aria-pressed', String(on));
    }
    const house = el('towerHouse');
    house.dataset.sig = JSON.stringify([lang, info.month, info.best, info.crowned, info.unlocked, towerSelected]);
    renderTowerDetail(info);
  }
  el('towerHouse').addEventListener('click', (ev) => {
    const g = ev.target.closest && ev.target.closest('[data-stage]');
    if (g) selectTowerFloor(Number(g.dataset.stage));
  });
  el('towerHouse').addEventListener('keydown', (ev) => {
    if (ev.key !== 'Enter' && ev.key !== ' ') return;
    const g = ev.target.closest && ev.target.closest('[data-stage]');
    if (!g) return;
    ev.preventDefault();
    selectTowerFloor(Number(g.dataset.stage));
  });
  el('towerDetail').addEventListener('click', (ev) => {
    const btn = ev.target.closest('[data-play]');
    if (!btn) return;
    const stage = Number(btn.dataset.play);
    guardOpenGame('tower', () => startTowerStage(stage));
  });
  el('towerCloseBtn').addEventListener('click', () => el('towerOverlay').classList.add('hidden'));
  el('towerOverlay').addEventListener('click', (ev) => {
    if (ev.target === el('towerOverlay')) el('towerOverlay').classList.add('hidden');
  });
  /** Leaves a finished floor through a reload (the socket belongs to that table):
   *  'open' shows the house, a floor number starts that floor. */
  function leaveTowerFor(next) {
    storageSet(AFTER_TOWER_KEY, String(next));
    if (sessionCode && storageGet('pikdame_last_session') === sessionCode) storageRemove('pikdame_last_session');
    window.location.href = window.location.pathname;
  }
  function afterTower(next) {
    const stage = Number(next);
    if (Number.isInteger(stage) && stage > 0) guardOpenGame('tower', () => startTowerStage(stage));
    else openTowerSheet();
  }
  /** The floor verdict on the result sheet: stars, the sum behind them, the way on. */
  function renderTowerResult() {
    const body = el('resultBody');
    const old = body.querySelector('.towerResultBox');
    if (old) old.remove();
    const r = lastTowerResult;
    if (!r || !lastState || lastState.phase !== 'gameOver' || lastState.towerStage !== r.stage) return;
    const box = document.createElement('div');
    box.className = 'towerResultBox';
    const botLine = r.handicap
      ? L(`bester Bot ${r.bestBot} + ${r.handicap} Vorgabe = ${r.bestBot + r.handicap}`, `best bot ${r.bestBot} + ${r.handicap} head start = ${r.bestBot + r.handicap}`)
      : L(`bester Bot ${r.bestBot}`, `best bot ${r.bestBot}`);
    const verdict = r.margin > 0
      ? L(`${r.margin} Punkte vorn`, `${r.margin} points ahead`)
      : r.margin < 0
        ? L(`${-r.margin} Punkte hinten`, `${-r.margin} points behind`)
        : L('Gleichstand reicht nicht', 'a tie is not enough');
    const mustGoOut = (r.mods || []).includes('goOut');
    const hint = mustGoOut && r.margin > 0 && !r.wentOut
      ? L('Vorn, aber auf dieser Etage gibt es Sterne nur, wenn du selbst ausmachst.', 'Ahead, but on this floor stars need you to go out yourself.')
      : [
        L('Für einen Stern brauchst du mehr Punkte als jeder Bot samt Vorgabe.', 'For a star you need more points than every bot plus its head start.'),
        L(`Für zwei Sterne: mindestens ${r.clearMargin} Punkte vorn.`, `For two stars: at least ${r.clearMargin} points ahead.`),
        L('Für drei Sterne: zusätzlich selbst ausmachen.', 'For three stars: also go out yourself.'),
        L('Alle drei Sterne - besser geht es nicht.', 'All three stars - it does not get better.'),
      ][r.stars] || '';
    const pr = r.progress;
    const unlocked = pr ? pr.unlocked : (towerFresh() || {}).unlocked || r.stage;
    const best = pr && pr.best ? Number(pr.best[r.stage]) || 0 : r.stars;
    const bestLine = pr && pr.improved && r.stars
      ? L('Neuer Bestwert für diese Etage!', 'New best for this floor!')
      : best > r.stars ? L(`Dein Bestwert hier bleibt bei ${best} Sternen.`, `Your best here stays at ${best} stars.`) : '';
    box.innerHTML =
      `<div class="twResultStars" role="img" aria-label="${escapeHtml(L(`${r.stars} von 3 Sternen`, `${r.stars} of 3 stars`))}">${towerStarsHtml(r.stars)}</div>` +
      `<p class="twResultSum">${escapeHtml(L(`Du ${r.myScore} · ${botLine}`, `You ${r.myScore} · ${botLine}`))} <b>${escapeHtml(verdict)}</b></p>` +
      (bestLine ? `<p class="twResultBest">${escapeHtml(bestLine)}</p>` : '') +
      (pr && pr.crownedNow ? `<p class="twResultBest">${escapeHtml(L('Alle 20 Etagen - dein Kartenhaus ist gekrönt!', 'All 20 floors - your House of Cards is crowned!'))}</p>` : '') +
      (r.xp ? `<p class="twResultXp">${escapeHtml(pr && pr.crownedNow
        ? L(`+${r.xp} EP · erster Stern und Krone`, `+${r.xp} XP · first star and crown`)
        : L(`+${r.xp} EP · erster Stern`, `+${r.xp} XP · first star`))}</p>` : '') +
      `<p class="twResultHint">${escapeHtml(hint)}</p>` +
      `<div class="twResultActions">` +
      `<button type="button" class="btn-secondary twRetry"><svg class="icon" aria-hidden="true"><use href="#i-undo"/></svg><span>${escapeHtml(L('Nochmal', 'Try again'))}</span></button>` +
      (r.stage < unlocked
        ? `<button type="button" class="btn-secondary twNext"><svg class="icon" aria-hidden="true"><use href="#i-play"/></svg><span>${escapeHtml(L(`Etage ${r.stage + 1}`, `Floor ${r.stage + 1}`))}</span></button>`
        : '') +
      `</div>`;
    box.querySelector('.twRetry').addEventListener('click', () => leaveTowerFor(r.stage));
    const nextBtn = box.querySelector('.twNext');
    if (nextBtn) nextBtn.addEventListener('click', () => leaveTowerFor(r.stage + 1));
    const pane = body.querySelector('.resultPane') || body;
    const head = pane.querySelector('.resultWinnerGame');
    pane.insertBefore(box, head ? head.nextSibling : pane.firstChild);
    requestAnimationFrame(() => updateResultScrollEdges());
  }

  // --- Kartenhaus at the table: floor card, start card, rules sheet, hints ----
  const TOWER_INTRO_KEY = 'pikdame_tower_intro'; // the session whose start card was handled
  const TOWER_FOLD_KEY = 'pikdame_tower_fold'; // 'full' | 'compact': the player's own tap beats the automatic fold
  const TOWER_MOD_ICON = { queen: 'spade', noDiscard: 'lock', goOut: 'flag' };
  // The queen helps when melded (+100): a risk (gold), not a handicap (red edge).
  const TOWER_MOD_KIND = { queen: 'risk' };
  const towerModKind = (m) => TOWER_MOD_KIND[m] || 'handicap';
  // The floor card is narrow: a shorter name where the sheet's one is long.
  const TOWER_MOD_SHORT = { queen: () => L('Pik Dame', 'Queen of Spades') };
  // One line on the start card; the exact rule on the sheet (BotTower.js, GameManager).
  const TOWER_MOD_WHY = {
    queen: () => L('ausgelegt +100, auf der Hand −100', '+100 melded, −100 in hand'),
    noDiscard: () => L('du ziehst immer vom Stapel', 'you always draw from the stock'),
    goOut: () => L('ohne Ausmachen kein Stern, auch nicht mit Vorsprung', 'no star without going out, even when ahead'),
  };
  const TOWER_MOD_RULE = {
    queen: () => L('Du startest mit der Pik Dame auf der Hand. Ausgelegt bringt sie +100, bleibt sie auf der Hand, kostet sie −100.',
      'You start with the Queen of Spades in hand. Melded she brings +100; left in hand she costs −100.'),
    noDiscard: () => L('Du darfst die Ablage nie aufnehmen und ziehst immer vom Stapel. Die Bots dürfen sie weiter nehmen.',
      'You may never take the discard pile and always draw from the stock. The bots may still take it.'),
    goOut: () => L('Sterne gibt es nur, wenn du die Runde selbst beendest – mit dem Abwurf deiner letzten Karte. Vorsprung allein reicht nicht.',
      'Stars only if you end the round yourself – by discarding your last card. Being ahead is not enough.'),
  };
  let towerStartOpen = false;
  let towerIntroHandled = ''; // also without storage (private mode)
  let towerInfoAskedFor = '';
  let towerSpotOn = false;
  let towerSpotTimer = null;
  let towerFoldChoice = ''; // also without storage (private mode)
  let towerFoldTimer = null;
  const towerModName = (m) => (TOWER_MODS[m] ? TOWER_MODS[m]() : m);
  const towerModShort = (m) => (TOWER_MOD_SHORT[m] || TOWER_MODS[m])();
  const towerModToken = (m) => `<span class="tfTok ${towerModKind(m)}" aria-hidden="true"><svg class="icon"><use href="#i-${TOWER_MOD_ICON[m]}"/></svg></span>`;
  // Risks first, then handicaps; each group with its heading (start card, sheet, label).
  const towerModGroups = (mods) => ['risk', 'handicap']
    .map((kind) => ({ kind, mods: mods.filter((m) => towerModKind(m) === kind) })).filter((g) => g.mods.length);
  const towerModGroupHead = (g) => (g.kind === 'risk' ? L('Risiko', 'Risk')
    : g.mods.length > 1 ? L('Erschwernisse', 'Handicaps') : L('Erschwernis', 'Handicap'));

  /** The floor being played: the state is the truth, this month's best stars come from the house. */
  function towerFloor() {
    const st = lastState;
    if (!st || !st.towerStage || st.phase === 'lobby') return null;
    const info = towerFresh();
    const best = info && (!st.towerMonth || info.month === st.towerMonth) && info.best ? Number(info.best[st.towerStage]) || 0 : 0;
    return {
      stage: st.towerStage,
      handicap: Number(st.towerHandicap) || 0,
      clearMargin: Number(st.towerClearMargin) || (info && info.clearMargin) || 0,
      mods: (Array.isArray(st.towerMods) ? st.towerMods : []).filter((m) => TOWER_MODS[m]),
      bots: (st.players || []).filter((p) => p.isBot).map((p) => p.botDifficulty || 'zen'),
      best: Math.max(0, Math.min(3, Math.floor(best))),
    };
  }
  /** The floor as a playing card: its number the rank, the house the suit, the best stars at the foot. */
  function towerFloorCardHtml(f, size = '') {
    // The rim: red dashed for a handicap (as in the sheet), gold for a risk alone.
    const rim = f.mods.some((m) => towerModKind(m) === 'handicap') ? ' mod' : f.mods.length ? ' risk' : '';
    return `<span class="tfCard${rim}${size ? ` ${size}` : ''}" aria-hidden="true">` +
      `<span class="tfRank"><b>${f.stage}</b><svg class="icon"><use href="#i-cardhouse"/></svg></span>` +
      '<svg class="icon tfPip"><use href="#i-cardhouse"/></svg>' +
      `<span class="tfStars">${towerStarsHtml(f.best)}</span></span>`;
  }
  function towerFloorAria(f) {
    const stars = f.best ? L(`Bestwert ${f.best} von 3 Sternen`, `best ${f.best} of 3 stars`) : L('noch kein Stern', 'no star yet');
    const head = f.handicap ? L(`Vorgabe ${f.handicap}`, `head start ${f.handicap}`) : L('ohne Vorgabe', 'no head start');
    const mods = towerModGroups(f.mods).map((g) => `, ${towerModGroupHead(g)}: ${g.mods.map(towerModName).join(', ')}`).join('');
    return L(`Kartenhaus, Etage ${f.stage}: ${stars}, ${head}${mods}. Regeln anzeigen`,
      `House of Cards, floor ${f.stage}: ${stars}, ${head}${mods}. Show the rules`);
  }
  function renderTowerBar(f) {
    const bar = el('towerBar');
    bar.classList.toggle('hidden', !f);
    if (!f) { bar.dataset.sig = ''; bar.dataset.fold = ''; return; }
    const sig = JSON.stringify([lang, f.stage, f.handicap, f.mods, f.best]);
    if (bar.dataset.sig !== sig) {
      bar.dataset.sig = sig;
      bar.dataset.fold = '';
      const goal = f.handicap ? L(`Vorgabe <b>${f.handicap}</b>`, `Head start <b>${f.handicap}</b>`) : escapeHtml(L('Ohne Vorgabe', 'No head start'));
      const mods = f.mods.map((m) => `<span class="tfMod">${towerModToken(m)}<span class="tfLbl">${escapeHtml(towerModShort(m))}</span></span>`).join('');
      const body = '<span class="tbSlot" aria-hidden="true"></span>' +
        `<span class="tfCol"><span class="tfCap">${escapeHtml(towerName())}</span><span class="tfGoal">${goal}</span>` +
        `${mods ? `<span class="tfMods">${mods}</span>` : ''}</span>`;
      // Two targets: the card (its rules) lies on the slot of the fold button. Without tokens nothing folds.
      bar.innerHTML = `<button type="button" class="tbCard" aria-haspopup="dialog">${towerFloorCardHtml(f)}</button>` +
        (mods ? `<button type="button" class="tbFold">${body}</button>` : `<span class="tbFold">${body}</span>`);
    }
    bar.querySelector('.tbCard').setAttribute('aria-label', towerFloorAria(f));
    applyTowerFold(bar);
  }
  /** Which of my own turns this round runs or ran last: 1 = the first, 0 = not yet. */
  function towerOwnTurn(st) {
    const ps = (st && st.players) || [];
    const n = ps.length;
    const me = ps.findIndex((p) => p.id === playerId);
    if (!n || me < 0) return 0;
    const opener = (ps.findIndex((p) => p.id === st.dealerId) + 1) % n; // the seat after the dealer opens the round
    const t = (Number(st.turnIndexInRound) || 0) - ((me - opener + n) % n);
    return t < 0 ? 0 : Math.floor(t / n) + 1;
  }
  /** In full for the round's first own turn, folded from the second; the player's own tap wins from then on. */
  function applyTowerFold(bar) {
    const fold = bar.querySelector('button.tbFold');
    const own = towerFoldChoice || storageGet(TOWER_FOLD_KEY);
    const compact = !!fold && (own === 'compact' || (own !== 'full' && towerOwnTurn(lastState) >= 2));
    const now = compact ? 'compact' : 'full';
    if (bar.dataset.fold === now) return;
    // Never on the first paint: a resume mid-floor opens folded at once.
    foldTowerBar(bar, compact, !!bar.dataset.fold && towerMotionOk());
    bar.dataset.fold = now;
  }
  /** Card and tokens glide to their new places (FLIP), the words fade back in; reduced motion: at once. */
  function foldTowerBar(bar, compact, glide) {
    const fold = bar.querySelector('button.tbFold');
    const parts = glide ? [...bar.querySelectorAll('.tfCard, .tfTok')] : [];
    const from = parts.map((n) => n.getBoundingClientRect());
    bar.classList.toggle('tbCompact', compact);
    if (fold) {
      fold.setAttribute('aria-expanded', String(!compact));
      fold.title = compact ? L('Ausklappen', 'Expand') : L('Einklappen', 'Collapse');
    }
    parts.forEach((n, i) => {
      const to = n.getBoundingClientRect();
      const dx = from[i].left - to.left;
      const dy = from[i].top - to.top;
      if ((dx || dy) && typeof n.animate === 'function') {
        n.animate([{ translate: `${dx}px ${dy}px` }, { translate: '0 0' }], { duration: 320, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' });
      }
    });
    clearTimeout(towerFoldTimer);
    bar.classList.remove('tbUnfold');
    if (glide && !compact) {
      void bar.offsetWidth; // restart the fade-in
      bar.classList.add('tbUnfold');
      towerFoldTimer = setTimeout(() => bar.classList.remove('tbUnfold'), 600);
    }
  }
  /** A tap folds or unfolds; from then on that is the player's choice on every floor (one key). */
  function toggleTowerFold() {
    const bar = el('towerBar');
    if (!bar.querySelector('button.tbFold')) return;
    towerFoldChoice = bar.classList.contains('tbCompact') ? 'full' : 'compact';
    storageSet(TOWER_FOLD_KEY, towerFoldChoice);
    applyTowerFold(bar);
  }
  /** The very start of a try: the round runs, nobody moved yet, my draw. */
  function towerAtStart(st) {
    return st.phase === 'playing' && !st.turnIndexInRound && st.currentPlayerId === playerId && st.turnPhase === 'draw';
  }
  /** Once per try (a new try is a new session): shown at its start, never after a resume mid-floor. */
  function updateTowerStart(f) {
    const st = lastState;
    const code = sessionCode || '';
    if (f && code && towerIntroHandled !== code && storageGet(TOWER_INTRO_KEY) !== code) {
      const fresh = towerAtStart(st);
      if (fresh || st.phase !== 'cutting') {
        towerIntroHandled = code;
        storageSet(TOWER_INTRO_KEY, code);
        if (fresh) openTowerStart(f);
      }
    }
    if (towerStartOpen && (!f || !towerAtStart(st))) closeTowerStart(true);
  }
  function openTowerStart(f) {
    towerStartOpen = true;
    if (f.mods.includes('queen')) setTowerSpot(true);
  }
  /** "Los" lets the mark linger a moment; the first move ends it at once (cards get picked). */
  function closeTowerStart(moved = false) {
    if (!towerStartOpen) return;
    towerStartOpen = false;
    el('towerStart').classList.add('hidden');
    el('table').classList.remove('towerStartOpen');
    const bar = el('towerBar');
    if (towerMotionOk()) {
      bar.classList.add('tfEnter');
      setTimeout(() => bar.classList.remove('tfEnter'), 700);
    }
    if (towerSpotOn) setTowerSpot(!moved, 1500);
  }
  /** "Pik Dame": the dealt queen stays marked while the start card explains it. */
  function setTowerSpot(on, ms = 0) {
    clearTimeout(towerSpotTimer);
    towerSpotOn = on;
    document.querySelectorAll('#hand .card.pikdame-card').forEach((q) => q.classList.toggle('towerSpot', on));
    el('hand').classList.toggle('towerSpotOn', on); // the rest of the fan dims, as under the tutorial spotlight
    if (on && ms) towerSpotTimer = setTimeout(() => setTowerSpot(false), ms);
  }
  function renderTowerStart(f) {
    const box = el('towerStart');
    const open = towerStartOpen && !!f;
    box.classList.toggle('hidden', !open);
    el('table').classList.toggle('towerStartOpen', open);
    if (!open) { box.dataset.sig = ''; return; }
    const sig = JSON.stringify([lang, f.stage, f.handicap, f.mods, f.best]);
    if (box.dataset.sig === sig) return;
    box.dataset.sig = sig;
    el('towerStartCard').innerHTML = towerFloorCardHtml(f, 'big');
    el('towerStartTitle').textContent = L(`Etage ${f.stage}`, `Floor ${f.stage}`);
    // goOut belongs to the goal itself: no star without going out.
    const out = f.mods.includes('goOut');
    const h = `<b>${f.handicap}</b>`;
    el('towerStartGoal').innerHTML = f.handicap
      ? (out ? L(`Ziel: selbst ausmachen und mehr Punkte als jeder Bot samt ${h} Vorgabe.`, `Goal: go out yourself with more points than every bot plus its ${h} head start.`)
        : L(`Ziel: mehr Punkte als jeder Bot samt ${h} Vorgabe.`, `Goal: more points than every bot plus its ${h} head start.`))
      : escapeHtml(out ? L('Ziel: selbst ausmachen und mehr Punkte als jeder Bot.', 'Goal: go out yourself with more points than every bot.')
        : L('Ziel: mehr Punkte als jeder Bot.', 'Goal: more points than every bot.'));
    el('towerStartMods').innerHTML = towerModGroups(f.mods).map((g) =>
      `<div class="tsGroup ${g.kind}"><p class="tsModsHead">${escapeHtml(towerModGroupHead(g))}</p><ul>` +
      g.mods.map((m) => `<li><span class="tfMod ${g.kind}">${towerModToken(m)}<span>${escapeHtml(towerModName(m))}</span></span>` +
        `<span class="tsWhy">${escapeHtml(TOWER_MOD_WHY[m]())}</span></li>`).join('') + '</ul></div>').join('');
  }
  /** The floor's rules (tap on the floor card): stars, bots, head start, each handicap exactly. */
  function renderTowerFloorSheet(f) {
    const overlay = el('towerFloorOverlay');
    if (!f) { overlay.classList.add('hidden'); return; }
    if (overlay.classList.contains('hidden')) return;
    el('towerFloorTitleText').textContent = L(`Kartenhaus · Etage ${f.stage}`, `House of Cards · floor ${f.stage}`);
    const h3 = (de, en) => `<h3>${escapeHtml(L(de, en))}</h3>`;
    const p = (text, cls = '') => `<p${cls ? ` class="${cls}"` : ''}>${escapeHtml(text)}</p>`;
    const best = f.best
      ? L(`Dein Bestwert diesen Monat: ${f.best} von 3 Sternen`, `Your best this month: ${f.best} of 3 stars`)
      : L('Auf dieser Etage hast du diesen Monat noch keinen Stern.', 'No star on this floor yet this month.');
    // Sections never split (two columns in landscape).
    const sec = (html) => `<div class="tfsSec">${html}</div>`;
    el('towerFloorBody').innerHTML =
      sec(`<div class="tfsHead">${towerFloorCardHtml(f)}<p>${escapeHtml(best)}</p></div>`) +
      sec(h3('So holst du Sterne', 'How to earn stars') +
        towerStarRulesHtml({ clearMargin: f.clearMargin, handicap: f.handicap, goOut: f.mods.includes('goOut') })) +
      sec(h3('Gegner', 'Opponents') + p(towerBotsLine(f.bots, 0)) +
        (f.handicap ? p(L(`Vorgabe ${f.handicap}: Für einen Stern brauchst du mehr Punkte als der beste Bot plus ${f.handicap}.`,
          `Head start ${f.handicap}: for a star you need more points than the best bot plus ${f.handicap}.`), 'tfsNote') : '')) +
      towerModGroups(f.mods).map((g) => sec(`<h3>${escapeHtml(towerModGroupHead(g))}</h3><ul class="tfsMods">` +
        g.mods.map((m) => `<li>${towerModToken(m)}<span><b class="${g.kind}">${escapeHtml(towerModName(m))}:</b> ${escapeHtml(TOWER_MOD_RULE[m]())}</span></li>`).join('') + '</ul>')).join('') +
      sec(p(L('Jeder Versuch spielt dasselbe Blatt, der beste zählt.', 'Every try plays the same deal, the best one counts.'), 'tfsNote'));
  }
  function openTowerFloorSheet() {
    const f = towerFloor();
    if (!f) return;
    el('towerFloorOverlay').classList.remove('hidden');
    renderTowerFloorSheet(f);
  }
  /** "Ohne Ablage": a tap on the locked pile says why instead of doing nothing. */
  function explainTowerLock() {
    showToast(L('Erschwernis „Ohne Ablage“: Auf dieser Etage ziehst du immer vom Stapel – die Ablage bleibt für dich gesperrt.',
      'Handicap “No discard pile”: on this floor you always draw from the stock – the discard pile stays locked for you.'), { duration: 4500, priority: true });
    const lock = el('discardLock');
    lock.classList.remove('nudge');
    void lock.offsetWidth; // restart the nudge
    lock.classList.add('nudge');
  }
  /** Everything Kartenhaus on the table; part of every table render (and the language switch). */
  function renderTowerTable() {
    const f = towerFloor();
    el('table').classList.toggle('towerGame', !!f);
    // The best stars come with the house data: ask once per game when it is missing.
    if (f && !towerFresh() && !publicMode && towerInfoAskedFor !== `${sessionCode}|${myName}`) {
      towerInfoAskedFor = `${sessionCode}|${myName}`;
      requestTower();
    }
    updateTowerStart(f);
    renderTowerBar(f);
    renderTowerStart(f);
    renderTowerFloorSheet(f);
    const locked = !!(f && f.mods.includes('noDiscard') && lastState.phase === 'playing');
    el('discardPile').classList.toggle('towerLocked', locked);
  }
  el('towerBar').addEventListener('click', (ev) => {
    if (ev.target.closest('.tbCard')) openTowerFloorSheet();
    else if (ev.target.closest('button.tbFold')) toggleTowerFold();
  });
  el('towerStartBtn').addEventListener('click', () => closeTowerStart());
  el('towerFloorCloseBtn').addEventListener('click', () => el('towerFloorOverlay').classList.add('hidden'));
  el('towerFloorOverlay').addEventListener('click', (ev) => {
    if (ev.target === el('towerFloorOverlay')) el('towerFloorOverlay').classList.add('hidden');
  });

  // --- "Heute": status of the daily puzzle and challenge on their tiles ----
  let challengeToday = null; // {date, you:{rank,score}|null} from /challengeboardz
  let challengeTodayFetched = '';
  function fetchChallengeToday() {
    const name = currentName();
    const key = `${(dailyQuests && dailyQuests.date) || ''}|${name}`;
    if (challengeTodayFetched === key) return;
    challengeTodayFetched = key;
    fetchChallengeBoard(name)
      .then((d) => { challengeToday = d; renderToday(); })
      .catch(() => { challengeTodayFetched = ''; });
  }
  function setTileStatus(tile, statusEl, text, state) {
    statusEl.textContent = text;
    tile.dataset.state = state; // new | open | done
  }
  function renderToday() {
    const today = dailyQuests && dailyQuests.date;
    const me = myProfile();
    // Puzzle: the open overlay is freshest, else the profile (server truth).
    const ps = (puzzleData && puzzleData.date === today && puzzleData.status)
      || (me && me.puzzles && today && me.puzzles[today]) || {};
    if (ps.solved) {
      setTileStatus(el('puzzleBtn'), el('puzzleTileStatus'), L('Gelöst', 'Solved'), 'done');
      if (ps.stars) el('puzzleTileStatus').appendChild(puzzleStarsEl(ps.stars));
    } else if (ps.revealed) setTileStatus(el('puzzleBtn'), el('puzzleTileStatus'), L('Lösung angesehen', 'Solution shown'), 'done');
    else if (ps.tries) setTileStatus(el('puzzleBtn'), el('puzzleTileStatus'), L(`${ps.tries} ${ps.tries === 1 ? 'Versuch' : 'Versuche'}`, `${ps.tries} ${ps.tries === 1 ? 'try' : 'tries'}`), 'open');
    else setTileStatus(el('puzzleBtn'), el('puzzleTileStatus'), L('Neu', 'New'), 'new');
    const you = challengeToday && challengeToday.date === today ? challengeToday.you : null;
    if (resumeCode && resumeIsChallenge) setTileStatus(el('challengeBtn'), el('challengeTileStatus'), L('Läuft · fortsetzen', 'Running · resume'), 'open');
    else if (you) setTileStatus(el('challengeBtn'), el('challengeTileStatus'), L(`Platz ${you.rank} · ${you.score} Pkt`, `Rank ${you.rank} · ${you.score} pts`), 'done');
    else if (challengeToday && challengeToday.date === today && challengeToday.attempted) setTileStatus(el('challengeBtn'), el('challengeTileStatus'), L('Heute gespielt', 'Played today'), 'done');
    else if (challengeToday) setTileStatus(el('challengeBtn'), el('challengeTileStatus'), L('Noch offen', 'Still open'), 'new');
    else setTileStatus(el('challengeBtn'), el('challengeTileStatus'), '', '');
    // try: the first render runs before the year-review state further down exists.
    try { renderYearEntry(); } catch (e) { /* cosmetic */ }
  }

  function renderQuests() {
    try { renderToday(); } catch (e) { /* cosmetic */ }
    try { renderIdentityProgress(); } catch (e) { /* cosmetic */ }
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
    // Tasks only: level and streak live on the identity chip / progress sheet.
    const sum = el('questsSummary');
    if (sum) {
      const total = dailyQuests.ids.length;
      const done = dailyQuests.ids.filter((id) => (questProgress[id] || 0) >= (QUEST_NEED[id] || 1)).length;
      sum.textContent = `${done}/${total} ${L('erledigt', 'done')}`;
    }
    list.innerHTML = dailyQuests.ids
      .map((id) => {
        const meta = questMeta(id);
        const need = QUEST_NEED[id] || 1;
        const have = Math.min(questProgress[id] || 0, need);
        const done = have >= need;
        const pct = Math.round((have / need) * 100);
        return `<div class="questRow${done ? ' done' : ''}">
          <span class="questIcon"><svg class="icon" aria-hidden="true"><use href="#i-${done ? 'check' : meta.icon}"/></svg></span>
          <span class="questText">${escapeHtml(meta.text)}</span>
          <span class="questCount">${need > 1 ? `${have}/${need}` : ''}</span>
          <span class="questBar"><i style="width:${pct}%"></i></span>
        </div>`;
      })
      .join('');
  }

  // --- "Dein Pik-Dame-Jahr" (December) ----------------------------------------
  // The server decides the season (GameDay) and counts; the client tells the
  // story card by card and draws the share picture.
  let yearReview = null;
  let yearReviewName = ''; // asked for this name with this many games (refresh after own games)
  let yearReviewGames = -1;
  let yearReviewToken = '';
  let yearSlideIdx = 0;
  let yearShareFile = null; // drawn on opening: iOS only shares inside the tap itself
  let yearSwipeAt = 0;
  const YEAR_SEEN_KEY = 'pikdame_year_seen';
  // ?jahr=2026 from the review mail: opens once the server has answered.
  let yearDeepLink = null;
  try {
    const url = new URL(window.location.href);
    if (url.searchParams.has('jahr')) {
      yearDeepLink = /^\d{4}$/.test(url.searchParams.get('jahr')) ? url.searchParams.get('jahr') : null;
      url.searchParams.delete('jahr');
      window.history.replaceState(null, '', url.toString());
    }
  } catch (e) { /* cosmetic */ }

  function requestYearReview() {
    if (publicMode || !ws || ws.readyState !== WebSocket.OPEN) return;
    const name = signedInName() || myName;
    if (!name) {
      if (yearDeepLink) {
        yearDeepLink = null;
        showToast(L('Melde dich an oder gib deinen Namen ein – dann zeigt dir die Katze dein Jahr.', 'Sign in or enter your name – then the cat shows you your year.'), { duration: 6000, priority: true });
      }
      return;
    }
    const me = myProfile();
    const games = me ? me.gamesPlayed || 0 : 0;
    // Signed in, the server adds favourite opponent and Stammtisch: ask again after a sign-in.
    const token = signedInName() ? accountToken() : '';
    if (name === yearReviewName && games === yearReviewGames && token === yearReviewToken) return;
    yearReviewName = name;
    yearReviewGames = games;
    yearReviewToken = token;
    ws.send(JSON.stringify({ type: 'getYearReview', name, accountToken: token || undefined }));
  }

  function handleYearReview(msg) {
    yearReview = msg.available && msg.review && msg.review.totals ? msg.review : null;
    renderYearEntry();
    if (!yearDeepLink) return;
    yearDeepLink = null;
    if (yearReview) openYearReview();
    else if (!msg.season) showToast(L('Den Jahresrückblick zeigt die Katze nur im Dezember.', 'The cat only shows the year review in December.'), { duration: 6000, priority: true });
    else showToast(L(`Für „${yearReviewName}“ hat die Katze dieses Jahr noch keine Partie gezählt.`, `The cat has not counted a game for “${yearReviewName}” this year yet.`), { duration: 6000, priority: true });
  }

  function renderYearEntry() {
    const btn = el('yearReviewBtn');
    if (!btn) return;
    btn.classList.toggle('hidden', !yearReview);
    if (!yearReview) return;
    setLabelText(btn, L(`Dein Jahr ${yearReview.year}`, `Your ${yearReview.year}`));
    btn.dataset.state = storageGet(YEAR_SEEN_KEY) === yearReview.year ? 'seen' : 'new';
  }

  function fmtYearDay(date) {
    return fmtDay(date, { day: 'numeric', month: 'long', timeZone: 'UTC' });
  }

  /** The numbers worth a tile: always games and wins, the rest only when earned. */
  function yearShareStats(r) {
    const t = r.totals;
    const pct = t.games ? Math.round((t.wins / t.games) * 100) : 0;
    return [
      { value: fmtNum(t.games), label: unitWord(t.games, 'game').replace(/^./, (c) => c.toUpperCase()) },
      { value: fmtNum(t.wins), label: `${unitWord(t.wins, 'win').replace(/^./, (c) => c.toUpperCase())} · ${pct} %` },
      t.queensLaid > 0 && { value: `${fmtNum(t.queensLaid)}×`, label: L('Pik Dame gerettet', 'Queen of spades rescued') },
      t.bestRound > 0 && { value: `+${fmtNum(t.bestRound)}`, label: L('Beste Runde', 'Best round') },
      t.bestStreak > 1 && { value: fmtNum(t.bestStreak), label: L('Tage Serie', 'Day streak') },
      t.bestGame > 0 && { value: fmtNum(t.bestGame), label: L('Bestes Spiel', 'Best game') },
    ].filter(Boolean);
  }

  /** One fact per card; a fact without data is left out, never guessed. */
  function yearSlides(r) {
    const t = r.totals;
    const pct = t.games ? Math.round((t.wins / t.games) * 100) : 0;
    // Opponents, bots and tables are counted per year only since the counter exists.
    const since = r.breakdownSince ? L(`Gezählt seit dem ${fmtYearDay(r.breakdownSince)}.`, `Counted since ${fmtYearDay(r.breakdownSince)}.`) : '';
    const slides = [{
      tone: 'night', cat: 'big', kicker: L('Dein Pik-Dame-Jahr', 'Your Pik Dame year'), big: r.year,
      lines: [L('Die Katze hat nachgezählt.', 'The cat has done the counting.'), L('Tippen oder wischen zum Blättern.', 'Tap or swipe to flip through.')],
      note: r.totalsSince ? L(`Gezählt seit dem ${fmtYearDay(r.totalsSince)}.`, `Counted since ${fmtYearDay(r.totalsSince)}.`) : '',
    }, {
      tone: 'felt', kicker: L('Partien', 'Games'), big: fmtNum(t.games),
      lines: [
        L(`${fmtNum(t.wins)} davon gewonnen – ${pct} %.`, `${fmtNum(t.wins)} of them won – ${pct} %.`),
        // Praise follows the win rate: "great job" at 5 % would read as mockery.
        pct >= 50 ? L('Die Katze nickt anerkennend.', 'The cat nods approvingly.')
          : pct >= 25 ? L('Solide. Die Katze schnurrt.', 'Solid. The cat purrs.')
            : L('Dabei sein ist alles – sagt jedenfalls die Katze.', 'Taking part is what counts – says the cat, at least.'),
        r.activeDays > 1 && !r.breakdownSince ? L(`An ${r.activeDays} Tagen warst du am Tisch.`, `You were at the table on ${r.activeDays} days.`) : '',
      ],
    }];
    if (r.favorite) {
      const f = r.favorite;
      slides.push({
        tone: 'bordeaux', kicker: L('Lieblingsgegner', 'Favourite opponent'), big: f.name, bigText: true, note: since,
        lines: [
          L(`${fmtCount(f.games, 'game')} zusammen – ${f.wins} davon gingen an dich.`, `${fmtCount(f.games, 'game')} together – ${f.wins} of them went to you.`),
          f.wins * 2 > f.games ? L(`Ob ${f.name} das auch so entspannt sieht?`, `Does ${f.name} take it that calmly?`) : L('Revanche? Die Katze hält die Karten bereit.', 'Rematch? The cat is holding the cards.'),
        ],
      });
    }
    if (t.queensLaid || t.queensCaught) {
      slides.push({
        tone: 'gold', kicker: L('Pik Damen gerettet', 'Queens of spades rescued'), big: `${fmtNum(t.queensLaid)}×`,
        lines: [t.queensCaught
          ? L(`${fmtNum(t.queensCaught)}-mal blieb sie dir auf der Hand. Passiert den Besten.`, `${fmtNum(t.queensCaught)} ${t.queensCaught === 1 ? 'time' : 'times'} she stayed in your hand. Happens to the best of us.`)
          : L('Und kein einziges Mal blieb sie dir auf der Hand. Respekt.', 'And not once did she stay in your hand. Respect.')],
      });
    }
    if (t.bestRound > 0) {
      slides.push({
        tone: 'plum', kicker: L('Beste Runde', 'Best round'), big: `+${fmtNum(t.bestRound)}`,
        lines: [
          L('Da hat sogar die Katze kurz aufgehört, sich zu putzen.', 'Even the cat stopped grooming for a second.'),
          t.bestGame > 0 ? L(`Bestes Spiel: ${fmtNum(t.bestGame)} Punkte.`, `Best game: ${fmtNum(t.bestGame)} points.`) : '',
        ],
      });
    }
    if (r.bots && r.bots.length) {
      slides.push({
        tone: 'night', kicker: L('Gegen die Bots', 'Against the bots'), bots: r.bots, note: since,
        lines: [r.bots.some((b) => b.wins > 0) ? L('Die Bots reden nicht gern darüber.', "The bots don't like to talk about it.") : L('Die Bots lassen schön grüßen.', 'The bots send their regards.')],
      });
    }
    if (t.bestStreak > 1) {
      slides.push({
        tone: 'felt', kicker: L('Längste Serie', 'Longest streak'), big: fmtNum(t.bestStreak), unit: L('Tage', 'days'),
        lines: [L('am Stück gespielt. Die Katze hat keinen davon verschlafen – fast.', 'in a row. The cat slept through none of them – almost.')],
      });
    }
    if (r.table) {
      const s = r.table;
      slides.push({
        tone: 'bordeaux', kicker: L('Dein Stammtisch', 'Your regulars table'), big: s.name, bigText: true, note: since,
        lines: [L(`${fmtNum(s.games)}-mal gemischt – ${fmtNum(s.wins)}-mal hattest du das letzte Wort.`, `Dealt ${fmtNum(s.games)} ${s.games === 1 ? 'time' : 'times'} – you had the last word ${fmtNum(s.wins)} ${s.wins === 1 ? 'time' : 'times'}.`)],
      });
    }
    slides.push({
      tone: 'gold', cat: 'hat', summary: true, kicker: L(`Gut Blatt für ${Number(r.year) + 1}!`, `A good hand for ${Number(r.year) + 1}!`),
      lines: [L('Teil dein Jahr als Bild – die Katze posiert gern.', 'Share your year as an image – the cat loves to pose.')],
    });
    return slides;
  }

  // The start screen's cat (lobby hero), cloned: one drawing everywhere. The
  // last card gets its New Year's top hat, every other costume stays home.
  function yearCatSvg(kind) {
    const src = document.querySelector('.heroCat > g');
    if (!src) return '';
    const g = src.cloneNode(true);
    g.querySelectorAll('.heroCostume').forEach((c) => {
      if (kind === 'hat' && (c.getAttribute('data-for') || '').split(' ').includes('silvester')) c.classList.add('on');
      else c.remove();
    });
    const box = kind === 'hat' ? '-19 -32 46 48' : '-18 -22 36 38';
    return `<svg class="yrCat yrCat-${kind || 'peek'}" viewBox="${box}" aria-hidden="true">${g.innerHTML}</svg>`;
  }

  function renderYearSlide() {
    const r = yearReview;
    const stage = el('yearReviewStage');
    if (!r || !stage) return;
    const slides = yearSlides(r);
    yearSlideIdx = Math.max(0, Math.min(yearSlideIdx, slides.length - 1));
    const s = slides[yearSlideIdx];
    const bars = slides.map((_, i) => `<i class="${i <= yearSlideIdx ? 'on' : ''}"></i>`).join('');
    const bots = s.bots ? `<div class="yrBots">${s.bots.map((b) => {
      const p = b.games ? Math.round((b.wins / b.games) * 100) : 0;
      const name = BOT_DIFF[b.level] ? BOT_DIFF[b.level].short() : b.level;
      return `<div class="yrBotRow"><span class="yrBotName">${escapeHtml(name)}</span><span class="yrBotBar"><i style="width:${p}%"></i></span><span class="yrBotVal">${L(`${b.wins} von ${b.games}`, `${b.wins} of ${b.games}`)}</span></div>`;
    }).join('')}</div>` : '';
    const summary = s.summary ? `<div class="yrSummary">${yearShareStats(r).slice(0, 4).map((x) =>
      `<div><b>${escapeHtml(x.value)}</b><span>${escapeHtml(x.label)}</span></div>`).join('')}</div>` : '';
    stage.innerHTML = `<div class="yrBars" aria-hidden="true">${bars}</div>
      <article class="yrSlide" data-tone="${s.tone}">
        <p class="yrKicker">${escapeHtml(s.kicker)}</p>
        ${s.big ? `<p class="yrBig${s.bigText ? ' yrBigText' : ''}">${escapeHtml(s.big)}${s.unit ? ` <small>${escapeHtml(s.unit)}</small>` : ''}</p>` : ''}
        ${bots}${summary}
        ${s.lines.filter(Boolean).map((l) => `<p class="yrLine">${escapeHtml(l)}</p>`).join('')}
        ${s.note ? `<p class="yrNote">${escapeHtml(s.note)}</p>` : ''}
        ${yearCatSvg(s.cat)}
      </article>`;
    el('yearReviewCount').textContent = `${yearSlideIdx + 1} / ${slides.length}`;
    el('yearReviewPrevBtn').disabled = yearSlideIdx === 0;
    el('yearReviewNextBtn').disabled = yearSlideIdx === slides.length - 1;
  }

  function stepYear(delta) {
    if (!yearReview) return;
    const last = yearSlides(yearReview).length - 1;
    const next = Math.max(0, Math.min(last, yearSlideIdx + delta));
    if (next === yearSlideIdx) return;
    yearSlideIdx = next;
    renderYearSlide();
  }

  function openYearReview() {
    if (!yearReview) return;
    yearSlideIdx = 0;
    storageSet(YEAR_SEEN_KEY, yearReview.year);
    renderYearEntry();
    renderYearSlide();
    el('yearReviewOverlay').classList.remove('hidden');
    const share = el('yearReviewShareBtn');
    yearShareFile = null;
    share.disabled = true;
    buildYearImage(yearReview)
      .then((file) => { yearShareFile = file; share.disabled = false; share.classList.toggle('hidden', !file); })
      .catch(() => share.classList.add('hidden'));
  }

  // --- Share picture: drawn on a canvas, 1080x1350 (portrait for messengers).
  // Only the player's own numbers - no opponent or table names leave the app.
  function roundRectPath(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
  function fitCanvasFont(ctx, text, maxW, font, px) {
    let size = px;
    ctx.font = font(size);
    while (size > 18 && ctx.measureText(text).width > maxW) {
      size -= 4;
      ctx.font = font(size);
    }
  }
  // The hero cat once more, painted from its own path data (an SVG image on a
  // canvas can taint it in Safari, then toBlob throws).
  function drawYearCat(ctx, x, y, scale) {
    const src = document.querySelector('.heroCat > g');
    if (!src) return;
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(scale, scale);
    for (const n of src.children) {
      const num = (k) => Number(n.getAttribute(k)) || 0;
      let path = null;
      if (n.localName === 'path') path = new Path2D(n.getAttribute('d') || '');
      else if (n.localName === 'ellipse') { path = new Path2D(); path.ellipse(num('cx'), num('cy'), num('rx'), num('ry'), 0, 0, Math.PI * 2); }
      else if (n.localName === 'circle') { path = new Path2D(); path.arc(num('cx'), num('cy'), num('r'), 0, Math.PI * 2); }
      if (!path) continue; // costumes (<g>) stay off the picture
      const fill = n.getAttribute('fill');
      const stroke = n.getAttribute('stroke');
      if (fill && fill !== 'none') { ctx.fillStyle = fill; ctx.fill(path); }
      if (stroke && stroke !== 'none') {
        ctx.strokeStyle = stroke;
        ctx.lineWidth = Number(n.getAttribute('stroke-width')) || 1;
        ctx.lineCap = n.getAttribute('stroke-linecap') || 'butt';
        ctx.stroke(path);
      }
    }
    ctx.restore();
  }
  async function buildYearImage(r) {
    const canvas = document.createElement('canvas');
    if (typeof canvas.toBlob !== 'function' || typeof window.Path2D !== 'function') return null;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    const W = 1080;
    const H = 1350;
    canvas.width = W;
    canvas.height = H;
    try { await document.fonts.load('800 100px Rubik'); } catch (e) { /* the fallback face then */ }
    const display = (w, px) => `${w} ${px}px Rubik, "Rubik Fallback", Arial, sans-serif`;
    const body = (w, px) => `${w} ${px}px -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif`;
    const bg = ctx.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, '#174a3b');
    bg.addColorStop(1, '#0a231b');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);
    const glow = ctx.createRadialGradient(860, 200, 10, 860, 200, 560);
    glow.addColorStop(0, 'rgba(242, 195, 91, 0.30)');
    glow.addColorStop(1, 'rgba(242, 195, 91, 0)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#f2c35b';
    ctx.font = display(700, 44);
    ctx.fillText(L('MEIN PIK-DAME-JAHR', 'MY PIK DAME YEAR'), 90, 170);
    ctx.fillStyle = '#ffffff';
    ctx.font = display(800, 220);
    ctx.fillText(String(r.year), 80, 380);
    drawYearCat(ctx, 850, 255, 7.5);
    const stats = yearShareStats(r).slice(0, 6);
    const gap = 30;
    const tw = (W - 180 - gap) / 2;
    const th = 215;
    stats.forEach((s, i) => {
      const x = 90 + (i % 2) * (tw + gap);
      const y = 460 + Math.floor(i / 2) * (th + gap);
      ctx.fillStyle = 'rgba(255, 255, 255, 0.09)';
      roundRectPath(ctx, x, y, tw, th, 28);
      ctx.fill();
      ctx.fillStyle = '#ffffff';
      fitCanvasFont(ctx, s.value, tw - 72, (px) => display(800, px), 104);
      ctx.fillText(s.value, x + 36, y + 126);
      ctx.fillStyle = '#cfe3da';
      fitCanvasFont(ctx, s.label, tw - 72, (px) => body(600, px), 38);
      ctx.fillText(s.label, x + 36, y + 180);
    });
    ctx.fillStyle = '#cfe3da';
    ctx.font = body(500, 38);
    ctx.fillText(L('Die Katze hat nachgezählt.', 'The cat has done the counting.'), 90, H - 120);
    ctx.fillStyle = '#f2c35b';
    ctx.font = display(700, 38);
    ctx.fillText(window.location.host, 90, H - 66);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    return blob ? new File([blob], `pikdame-${r.year}.png`, { type: 'image/png' }) : null;
  }
  async function shareYearImage() {
    const file = yearShareFile;
    if (!file || !yearReview) return;
    const title = L(`Mein Pik-Dame-Jahr ${yearReview.year}`, `My Pik Dame year ${yearReview.year}`);
    // No await before share(): Safari only allows it inside the tap itself.
    if (navigator.share && navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title });
        return;
      } catch (e) {
        if (e && e.name === 'AbortError') return; // the player closed the sheet
      }
    }
    // No share sheet (desktop): save the picture instead.
    const url = URL.createObjectURL(file);
    const a = document.createElement('a');
    a.href = url;
    a.download = file.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    showToast(L('Bild gespeichert.', 'Image saved.'));
  }

  el('yearReviewBtn').addEventListener('click', () => openYearReview());
  el('yearReviewPrevBtn').addEventListener('click', () => stepYear(-1));
  el('yearReviewNextBtn').addEventListener('click', () => stepYear(1));
  el('yearReviewShareBtn').addEventListener('click', () => { shareYearImage().catch(() => {}); });
  el('yearReviewCloseBtn').addEventListener('click', () => el('yearReviewOverlay').classList.add('hidden'));
  el('yearReviewOverlay').addEventListener('click', (ev) => {
    if (ev.target === el('yearReviewOverlay')) el('yearReviewOverlay').classList.add('hidden');
  });
  // Story controls: the left third goes back, the rest forward; swipes and arrow keys too.
  el('yearReviewStage').addEventListener('click', (ev) => {
    if (Date.now() - yearSwipeAt < 500) return; // the swipe already turned the card
    const box = el('yearReviewStage').getBoundingClientRect();
    stepYear(ev.clientX - box.left < box.width / 3 ? -1 : 1);
  });
  let yearTouch = null;
  el('yearReviewStage').addEventListener('touchstart', (ev) => {
    yearTouch = ev.touches.length === 1 ? { x: ev.touches[0].clientX, y: ev.touches[0].clientY } : null;
  }, { passive: true });
  el('yearReviewStage').addEventListener('touchend', (ev) => {
    const t = yearTouch;
    yearTouch = null;
    const end = ev.changedTouches && ev.changedTouches[0];
    if (!t || !end) return;
    const dx = end.clientX - t.x;
    if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(end.clientY - t.y)) {
      yearSwipeAt = Date.now();
      stepYear(dx < 0 ? 1 : -1);
    }
  });
  document.addEventListener('keydown', (ev) => {
    if (el('yearReviewOverlay').classList.contains('hidden')) return;
    if (ev.key === 'ArrowRight') { ev.preventDefault(); stepYear(1); }
    else if (ev.key === 'ArrowLeft') { ev.preventDefault(); stepYear(-1); }
    else if (ev.key === 'Escape') el('yearReviewOverlay').classList.add('hidden');
  });

  // Ein Höhepunkt pro Partie-Ende, nicht drei gleichzeitig: erst die
  // erledigten Aufgaben, dann ein Stufenaufstieg, sonst nur die XP.
  // --- Level-up dialog (#315) ------------------------------------------------
  /** Rewards earned by climbing from level `from` to `to` (exclusive/inclusive). */
  function rewardsBetween(rewards, from, to) {
    return rewards.filter((r) => r.level > from && r.level <= to);
  }
  /** The next reward(s) above `level`: all items of the next rewarded level. */
  function nextRewards(rewards, level) {
    const next = rewards.find((r) => r.level > level);
    return next ? rewards.filter((r) => r.level === next.level) : [];
  }
  let levelUpTimer = null;
  /** @param {number} beforeXp total XP before the gain: the bar fills the finished level from there to 100 %. */
  function showLevelUp(from, to, gainedXp, beforeXp, welcomeBack = false) {
    const rewards = levelRewards();
    const got = rewardsBetween(rewards, from, to).filter((r) => r.kind !== 'title');
    const next = nextRewards(rewards, to);
    const titleNow = titleForLevel(to);
    const newTitle = titleNow !== titleForLevel(from);
    el('levelUpTitle').textContent = `⭐ ${L(`Stufe ${to}!`, `Level ${to}!`)}`;
    el('levelUpRank').textContent = newTitle ? L(`Neuer Titel: ${titleNow}`, `New title: ${titleNow}`) : titleNow;
    el('levelUpRank').classList.toggle('isNew', newTitle);
    el('levelUpXp').textContent = `${L(`Stufe ${from} → ${to}`, `Level ${from} → ${to}`)}${gainedXp ? ` · +${gainedXp} ${L('EP', 'XP')}` : ''}${welcomeBack ? ` (${L('×2 Willkommen zurück', '×2 welcome back')})` : ''}`;
    const start = levelFromXpClient(Math.max(0, beforeXp || 0));
    const list = (items) => items.map((r) => `<li>${rewardHtml(r)}</li>`).join('');
    el('levelUpRewards').innerHTML =
      (got.length ? `<h3>${escapeHtml(L('Neu freigeschaltet', 'Newly unlocked'))}</h3><ul>${list(got)}</ul>` : '') +
      (next.length ? `<h3>${escapeHtml(L(`Nächste Belohnung (Stufe ${next[0].level})`, `Next reward (level ${next[0].level})`))}</h3><ul class="next">${list(next)}</ul>` : '');
    const fill = el('levelUpBarFill');
    fill.style.transition = 'none';
    fill.style.width = `${Math.round(Math.min(1, start.into / (start.need || 1)) * 100)}%`;
    // Confetti: decoration only, skipped for reduced motion (CSS hides it too).
    const conf = el('levelUpConfetti');
    conf.innerHTML = '';
    for (let i = 0; i < 18; i++) {
      const c = document.createElement('i');
      c.style.left = `${(i * 53) % 100}%`;
      c.style.animationDelay = `${(i % 6) * 0.12}s`;
      c.style.background = ['var(--accent)', '#f5c542', '#ff7d8c', '#7fb8ff'][i % 4];
      conf.appendChild(c);
    }
    clearTimeout(levelUpTimer);
    // A moment after the result overlay, so both are seen.
    const delay = el('resultOverlay').classList.contains('hidden') ? 0 : 1200;
    levelUpTimer = setTimeout(() => {
      el('levelUpOverlay').classList.remove('hidden');
      requestAnimationFrame(() => {
        fill.style.transition = '';
        fill.style.width = '100%';
      });
    }, delay);
  }
  el('levelUpCloseBtn').addEventListener('click', () => el('levelUpOverlay').classList.add('hidden'));
  el('levelUpOverlay').addEventListener('click', (ev) => {
    if (ev.target === el('levelUpOverlay')) el('levelUpOverlay').classList.add('hidden');
  });

  let lastLevelSeen = null;
  function celebrateProgress(msg) {
    const completed = (msg.quests && msg.quests.completed) || [];
    for (const id of completed) {
      showToast(`✅ ${L('Tagesziel erreicht', 'Daily goal reached')}: ${questMeta(id).text}`);
    }
    const st = msg.streak;
    if (st && (st.event === 'extended' || st.event === 'bridged') && st.streak >= 2) {
      showToast(`🔥 ${L(`${st.streak} Tage in Folge gespielt`, `${st.streak} days in a row`)}${st.event === 'bridged' ? ` ${L('(Joker-Tag genutzt)', '(grace day used)')}` : ''}`);
    }
    const lvl = msg.level && msg.level.level;
    // The level before this game: XP minus what it brought (works for the
    // first game of a session too, when nothing was "seen" yet).
    const before = typeof msg.xp === 'number' && msg.gainedXp ? levelFromXpClient(msg.xp - msg.gainedXp).level : lastLevelSeen;
    if (lvl && before && lvl > before) {
      showLevelUp(before, lvl, msg.gainedXp, msg.xp - (msg.gainedXp || 0), !!msg.welcomeBack);
    } else if (msg.welcomeBack && msg.gainedXp > 0) {
      showToast(`👋 ${L('Willkommen zurück! Doppelte Erfahrung', 'Welcome back! Double XP')}: +${msg.gainedXp}`);
    } else if (!completed.length && msg.gainedXp > 0 && el('resultOverlay').classList.contains('hidden')) {
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
    const favKeys = canPickFavorites() ? myFavoriteKeys(me) : [];
    const favMark = (key) => (favKeys.includes(key)
      ? `<svg class="icon achFavMark" aria-hidden="true"><use href="#i-star"/></svg><span class="visuallyHidden">${escapeHtml(L('Lieblingsabzeichen', 'Favourite badge'))}</span>`
      : '');
    const singleTile = (id) => {
      const m = badgeMeta(id);
      const at = owned[id];
      const p = progress[id];
      const sub = at
        ? fmtDate(at, { day: 'numeric', month: 'numeric', year: 'numeric' })
        : p && p.need > 1
          ? `${p.have}/${p.need}`
          : L('gesperrt', 'locked');
      return `<button type="button" class="achTile${at ? ' earned' : ''}${favKeys.includes(id) ? ' fav' : ''}" data-ach="${id}" aria-expanded="false" title="${escapeHtml(m.how)}">
        <span class="achEmoji">${at ? m.emoji : '🔒'}</span>
        <span class="achName">${escapeHtml(m.name)}</span>
        <span class="achSub">${escapeHtml(sub)}</span>${favMark(id)}
      </button>`;
    };
    // A family is ONE tile: the highest earned tier gives it name and
    // emoji, the dots show the tiers, the counter shows the way to the next.
    const familyTile = (fam) => {
      const earnedTiers = fam.tiers.filter((id) => owned[id]);
      const top = earnedTiers[earnedTiers.length - 1] || null;
      const next = fam.tiers.find((id) => !owned[id]) || null;
      const m = badgeMeta(top || fam.tiers[0]);
      const p = next ? progress[next] : null;
      const dots = fam.tiers.map((id) => `<i class="${owned[id] ? 'on' : ''}"></i>`).join('');
      const sub = next
        ? p && p.need > 1 ? `${p.have}/${p.need}` : L('gesperrt', 'locked')
        : L('alle Stufen', 'all tiers');
      const title = next ? badgeMeta(next).how : m.desc;
      return `<button type="button" class="achTile achFamily${top ? ' earned' : ''}${!next ? ' maxed' : ''}${favKeys.includes(fam.id) ? ' fav' : ''}" data-ach="${fam.id}" aria-expanded="false" title="${escapeHtml(title)}">
        <span class="achEmoji">${top ? m.emoji : '🔒'}</span>
        <span class="achName">${escapeHtml(m.name)}</span>
        <span class="achTiers">${dots}</span>
        <span class="achSub">${escapeHtml(sub)}</span>${favMark(fam.id)}
      </button>`;
    };
    const total = BADGE_FAMILIES.reduce((n, f) => n + f.tiers.length, 0) + BADGE_SINGLES.length;
    const have = Object.keys(owned).filter((id) => BADGE_SINGLES.includes(id) || BADGE_FAMILIES.some((f) => f.tiers.includes(id))).length;
    const order = achievementOrder(BADGE_FAMILIES, BADGE_SINGLES, owned, progress, (id) => badgeMeta(id).name);
    const tile = (key) => {
      const fam = BADGE_FAMILIES.find((f) => f.id === key);
      return fam ? familyTile(fam) : singleTile(key);
    };
    const section = (title, keys) => (keys.length
      ? `<h4 class="achSection">${escapeHtml(title)} (${keys.length})</h4><div class="achGrid">${keys.map(tile).join('')}</div>`
      : '');
    box.classList.remove('hidden');
    // Folded: the three closest goals - a wall of 30+ locked tiles said nothing.
    const near = [...new Set([...(order.nearest || []), ...order.locked])].slice(0, 3);
    // Season badges belong to the account; folded shows the newest three.
    const seasonTiles = canPickFavorites() && seasonAwards.length
      ? `<h4 class="achSection">${escapeHtml(L('Saison-Abzeichen', 'Season badges'))} (${seasonAwards.length})</h4>` +
        `<div class="achGrid">${(achShowAll ? seasonAwards : seasonAwards.slice(0, 3)).map(seasonAwardTile).join('')}</div>`
      : '';
    const body = seasonTiles + (achShowAll
      ? section(L('Freigeschaltet', 'Unlocked'), order.unlocked) + section(L('Noch offen', 'Still open'), order.locked)
      : near.length
        ? section(L('Fast geschafft', 'Almost there'), near)
        : section(L('Zuletzt freigeschaltet', 'Recently unlocked'), order.unlocked.slice(0, 3)));
    // Favourites on top, folded too: a family tile changes name and emoji with
    // each tier, so this list is where a favourite is found and removed.
    const favs = favKeys.map((key) => ({ key, m: favoriteEmoji(me, key) })).filter((f) => f.m);
    const favChip = ({ key, m }) => {
      const name = String(m.name).replace(/­/g, '');
      return `<span class="achFavChip"><span class="achFavEmoji" aria-hidden="true">${m.emoji}</span>` +
        `<span class="achFavName">${escapeHtml(m.name)}</span>` +
        `<button type="button" class="achFavRemove" data-fav-remove="${escapeHtml(key)}" aria-label="${escapeHtml(L(`${name} entfernen`, `Remove ${name}`))}">` +
        `<svg class="icon" aria-hidden="true"><use href="#i-close"/></svg></button></span>`;
    };
    const favStrip = canPickFavorites() && (favs.length || have)
      ? `<div class="achFavStrip"><h4 class="achSection"><svg class="icon" aria-hidden="true"><use href="#i-star"/></svg>` +
        `<span>${escapeHtml(L('Lieblingsabzeichen', 'Favourite badges'))} (${favs.length}/${FAVORITES_MAX})</span></h4>` +
        (favs.length ? `<div class="achFavList">${favs.map(favChip).join('')}</div>` : '') +
        (favs.length < FAVORITES_MAX
          ? `<p class="achFavHint">${escapeHtml(L('Stehen am Tisch neben deinem Namen. Tippe ein Abzeichen an, um eins hinzuzufügen.', 'Shown next to your name at the table. Tap a badge to add one.'))}</p>`
          : '') +
        '</div>'
      : '';
    box.innerHTML =
      `<h3>${L('Erfolge', 'Achievements')} <span class="achCount">${have} / ${total}</span></h3>` + favStrip + body +
      `<button type="button" class="achAllBtn">${achShowAll ? L('Weniger anzeigen', 'Show less') : L(`Alle ${total} anzeigen`, `Show all ${total}`)}</button>`;
    // Re-render (new profile data) keeps the open detail open.
    if (openAchId) showAchDetail(openAchId, false);
  }

  // Gallery order: unlocked newest first (a family counts with its latest
  // tier), locked by progress (closest first), then by name.
  function achievementOrder(families, singles, owned, progress, nameOf) {
    const items = families.map((f) => {
      const times = f.tiers.map((id) => owned[id]).filter(Boolean);
      const next = f.tiers.find((id) => !owned[id]);
      return { key: f.id, at: times.length ? Math.max(...times) : 0, p: next && progress[next], name: nameOf(f.tiers[0]) };
    }).concat(singles.map((id) => ({ key: id, at: owned[id] || 0, p: progress[id], name: nameOf(id) })));
    const ratio = (it) => (it.p && it.p.need ? it.p.have / it.p.need : 0);
    const plain = (t) => String(t).replace(/\u00ad/g, '');
    return {
      unlocked: items.filter((it) => it.at).sort((a, b) => b.at - a.at).map((it) => it.key),
      locked: items.filter((it) => !it.at)
        .sort((a, b) => ratio(b) - ratio(a) || plain(a.name).localeCompare(plain(b.name)))
        .map((it) => it.key),
      // Next goals with real progress, next family tiers included.
      nearest: items.filter((it) => it.p && it.p.have > 0 && it.p.have < it.p.need)
        .sort((a, b) => ratio(b) - ratio(a) || plain(a.name).localeCompare(plain(b.name)))
        .map((it) => it.key),
    };
  }

  // Favourite badges (#317): tile keys (badge or family id), max 3, accounts only.
  const FAVORITES_MAX = 3;
  function favoriteEmoji(profile, key) {
    const owned = (profile && profile.badges) || {};
    const fam = BADGE_FAMILIES.find((f) => f.id === key);
    const id = fam ? fam.tiers.filter((t) => owned[t]).pop() : owned[key] ? key : null;
    return id ? badgeMeta(id) : null;
  }
  function favoriteBadgesHtml(profile) {
    const metas = ((profile && profile.favoriteBadges) || []).map((k) => favoriteEmoji(profile, k)).filter(Boolean);
    if (!metas.length) return '';
    return ` <span class="favBadges" title="${escapeHtml(metas.map((m) => m.name).join(', '))}">${metas.map((m) => m.emoji).join('')}</span>`;
  }
  // A stored tier id belongs to its family's tile - else no tile could remove it.
  function favoriteTileKey(key) {
    const fam = BADGE_FAMILIES.find((f) => f.tiers.includes(key));
    return fam ? fam.id : key;
  }
  function myFavoriteKeys(me) {
    return [...new Set(((me && me.favoriteBadges) || []).map(favoriteTileKey))];
  }
  function profileByName(name) {
    const n = String(name || '').toLowerCase();
    return (knownProfiles || []).find((p) => p.name && p.name.toLowerCase() === n) || null;
  }
  // Only the signed-in owner of the local profile may pick favourites.
  function canPickFavorites() {
    const acc = signedInName();
    return !publicMode && !!acc && !!myName && acc.toLowerCase() === myName.toLowerCase();
  }
  function favoriteToggleHtml(key) {
    const me = myProfile();
    if (!canPickFavorites() || !me || !favoriteEmoji(me, key)) return '';
    const favs = myFavoriteKeys(me);
    // The detail only adds; removing happens in the list on top of the cabinet.
    if (favs.includes(key)) return '';
    const label = L(`Als Lieblingsabzeichen zeigen (${favs.length}/${FAVORITES_MAX})`, `Show as favourite badge (${favs.length}/${FAVORITES_MAX})`);
    return `<button type="button" class="achFavBtn" data-fav="${escapeHtml(key)}"><svg class="icon" aria-hidden="true"><use href="#i-star"/></svg><span>${escapeHtml(label)}</span></button>`;
  }
  function toggleFavorite(key) {
    const me = myProfile();
    if (!me || !canPickFavorites()) return;
    const favs = myFavoriteKeys(me);
    const at = favs.indexOf(key);
    if (at >= 0) favs.splice(at, 1);
    else if (favs.length >= FAVORITES_MAX) {
      showToast(L('Höchstens 3 - entferne zuerst eins', 'At most 3 - remove one first'));
      return;
    } else favs.push(key);
    send({ type: 'setFavoriteBadges', name: myName, badges: favs, accountToken: accountToken() || undefined });
  }

  // Tap (phone) or click (desktop) on a tile: how to earn it, right below
  // its row. Hover additionally shows the same text via title.
  let openAchId = null;
  let achShowAll = false;
  function achDetailHtml(key) {
    const me = myProfile() || {};
    const owned = me.badges || {};
    const progress = badgeProgressFor(me);
    const fam = BADGE_FAMILIES.find((f) => f.id === key);
    const next = fam ? fam.tiers.find((id) => !owned[id]) : null;
    // A family is ONE badge with tiers: numbered steps on a ladder (dots as
    // on the tile), the next one to reach marked.
    const line = (id, i) => {
      const m = badgeMeta(id);
      const p = progress[id];
      const state = owned[id]
        ? `✓ ${fmtDate(owned[id], { day: 'numeric', month: 'numeric', year: 'numeric' })}`
        : p && p.need > 1 ? `${p.have}/${p.need}` : '';
      // "here" = the dot: the tier being worked on, or the last one when all are reached.
      const here = fam && (id === next || (!next && i === fam.tiers.length - 1));
      const cls = [owned[id] ? 'done' : '', id === next ? 'next' : '', here ? 'here' : ''].filter(Boolean).join(' ');
      const tier = fam
        ? `<span class="achTierNo">${escapeHtml(L(`Stufe ${i + 1}`, `Tier ${i + 1}`))}${id === next ? ` · ${escapeHtml(L('als Nächstes', 'next'))}` : ''}</span>`
        : '';
      return `<li class="${cls}">${tier}<b>${escapeHtml(m.name)}</b>` +
        `${state ? ` <span class="achDetailState">${escapeHtml(state)}</span>` : ''}<span class="achHow">${escapeHtml(m.how)}</span></li>`;
    };
    const head = badgeMeta(fam ? (fam.tiers.filter((id) => owned[id]).pop() || fam.tiers[0]) : key);
    const title = fam
      ? L(`${fam.tiers.length} Stufen - so schaffst du sie`, `${fam.tiers.length} tiers - how to earn them`)
      : L('So schaffst du es', 'How to earn it');
    return `<div class="achDetailHead"><span class="achEmoji">${head.emoji}</span>` +
      `<span>${escapeHtml(title)}</span>` +
      `<button type="button" class="achDetailClose" aria-label="${escapeHtml(L('Schließen', 'Close'))}"><svg class="icon" aria-hidden="true"><use href="#i-close"/></svg></button></div>` +
      `<ul class="${fam ? 'achTierList' : ''}">${(fam ? fam.tiers : [key]).map(line).join('')}</ul>` +
      favoriteToggleHtml(key);
  }
  function showAchDetail(key, scroll = true) {
    const box = el('achievementsBox');
    const old = box.querySelector('.achDetail');
    if (old) old.remove();
    for (const t of box.querySelectorAll('.achTile')) t.setAttribute('aria-expanded', 'false');
    const tile = key ? box.querySelector(`.achTile[data-ach="${CSS.escape(key)}"]`) : null;
    openAchId = tile ? key : null;
    if (!tile) return;
    tile.setAttribute('aria-expanded', 'true');
    const detail = document.createElement('div');
    detail.className = 'achDetail';
    detail.setAttribute('role', 'note');
    detail.innerHTML = achDetailHtml(key);
    tile.after(detail); // grid-auto-flow: dense keeps the row full, the detail goes below it
    if (scroll) detail.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
  el('achievementsBox').addEventListener('click', (ev) => {
    if (ev.target.closest('.achDetailClose')) { showAchDetail(null); return; }
    if (ev.target.closest('.achAllBtn')) { achShowAll = !achShowAll; renderAchievements(); return; }
    const fav = ev.target.closest('.achFavBtn');
    if (fav) { toggleFavorite(fav.dataset.fav); return; }
    const remove = ev.target.closest('.achFavRemove');
    if (remove) { toggleFavorite(remove.dataset.favRemove); return; }
    const tile = ev.target.closest('.achTile');
    if (!tile) return;
    showAchDetail(openAchId === tile.dataset.ach ? null : tile.dataset.ach);
  });

  // Mirrors game/Progression.js#badgeProgress - the countable badges only.
  function badgeProgressFor(p) {
    const cap = (v, n) => ({ have: Math.min(v || 0, n), need: n });
    return {
      first_win: cap(p.gamesWon, 1), wins_10: cap(p.gamesWon, 10), wins_50: cap(p.gamesWon, 50),
      pd_laid: cap(p.totalQueensLaid, 1), pd_hunter_10: cap(p.totalQueensLaid, 10), pd_hunter_50: cap(p.totalQueensLaid, 50),
      pd_caught: cap(p.totalQueensCaught, 1),
      hand_aus_win: cap(p.totalHandAus, 1), hand_aus_5: cap(p.totalHandAus, 5),
      score_500: cap(p.bestGameScore, 500),
      round_300: cap(p.bestRoundScore, 300),
      streak_3: cap(p.winStreak, 3), streak_5: cap(p.winStreak, 5), streak_10: cap(p.winStreak, 10),
      marathon_10: cap(p.gamesPlayed, 10), marathon_50: cap(p.gamesPlayed, 50), marathon_100: cap(p.gamesPlayed, 100),
      daily_7: cap(p.dailyStreak, 7), daily_30: cap(p.dailyStreak, 30),
      // Older profiles have no gamesLost yet (it is written per finished game).
      ...Object.fromEntries([10, 50, 100].map((n) => [`purple_heart_${n}`, cap(p.gamesLost != null ? p.gamesLost : (p.gamesPlayed || 0) - (p.gamesWon || 0), n)])),
      challenger_7: cap(p.totalChallenges, 7), challenger_30: cap(p.totalChallenges, 30),
      puzzle_7: cap(p.totalPuzzlesSolved, 7), puzzle_30: cap(p.totalPuzzlesSolved, 30),
      ...Object.fromEntries([10, 30, 100].map((n) => [`puzzle_perfect_${n}`, cap(p.totalPerfectPuzzles, n)])),
      tower_3: cap(p.towerCleared, 3), tower_6: cap(p.towerCleared, 6), tower_10: cap(p.towerCleared, 10),
      tower_stars_30: cap(p.towerStars, 30),
      ...Object.fromEntries([1, 3, 12].map((n) => [`tower_crowned_${n}`, cap(p.towerCrownedMonths, n)])),
      red_lantern: cap(p.lastPlaceStreak, 3),
      stammtisch_10: cap(p.totalStammtischGames, 10),
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
      `<div class="levelMeta">${L('Saison', 'Season')} ${escapeHtml(accountProgress.season ? seasonLabel(accountProgress.season) : '–')}: ` +
      `<b>${accountProgress.seasonXp}</b> ${L('EP', 'XP')}` +
      (accountProgress.rank ? ` · ${L('Platz', 'Rank')} <b>${accountProgress.rank}</b>` : '') +
      ` · ${accountProgress.wins}/${accountProgress.games}${NBSP}${unitWord(accountProgress.games, 'win')}</div>`;
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

  // --- Season finale: month names, awards and the one-time start-up hint ----
  // The emoji here ARE the badges (as in the trophy cabinet), not icons.
  const SEASON_AWARDS = {
    gold: { emoji: '🥇', name: () => L('Saisonsieg', 'Season winner'), cheer: () => L('Saisonsieg!', 'season winner!') },
    silver: { emoji: '🥈', name: () => L('Saison-Silber', 'Season silver'), cheer: () => L('Silber!', 'silver!') },
    bronze: { emoji: '🥉', name: () => L('Saison-Bronze', 'Season bronze'), cheer: () => L('Bronze!', 'bronze!') },
    top10: { emoji: '🏅', name: () => L('Saison-Top-10', 'Season top 10'), cheer: () => L('Top 10!', 'top 10!') },
    participant: { emoji: '🎟️', name: () => L('Saison-Teilnahme', 'Season participant'), cheer: () => L('danke fürs Mitspielen!', 'thanks for playing!') },
  };
  /** "2026-10" -> "Oktober 2026" / "October 2026" (a season is a month). */
  function seasonLabel(id) {
    const m = /^(\d{4})-(\d{2})$/.exec(String(id || ''));
    if (!m) return String(id || '');
    try {
      return new Intl.DateTimeFormat(L('de-DE', 'en-GB'), { month: 'long', year: 'numeric', timeZone: 'UTC' })
        .format(Date.UTC(Number(m[1]), Number(m[2]) - 1, 1));
    } catch (e) {
      return `${m[2]}/${m[1]}`;
    }
  }
  function seasonPlaceText(r) {
    return L(`Platz ${r.place} von ${r.ranked}`, `place ${r.place} of ${r.ranked}`);
  }
  function applySeasonInfo(d) {
    if (!d) return;
    if (Array.isArray(d.seasonAwards)) {
      seasonAwards = d.seasonAwards;
      try { renderAchievements(); } catch (e) { /* cosmetic */ }
    }
    if ('lastSeason' in d) lastSeasonResult = d.lastSeason || null;
    if (d.seasonResult) announceSeasonResult(d.seasonResult);
  }
  function announceSeasonResult(r) {
    if (!r || !r.season || !r.place) return;
    // After the studio intro - a toast underneath it would expire unseen.
    if (document.getElementById('studioSplash')) {
      setTimeout(() => announceSeasonResult(r), 500);
      return;
    }
    const a = SEASON_AWARDS[r.award];
    const text = L(`Saison ${seasonLabel(r.season)} beendet: `, `Season ${seasonLabel(r.season)} is over: `) +
      seasonPlaceText(r) + (a ? ` – ${a.emoji} ${a.cheer()}` : '.');
    showToast(text, { duration: 7000, priority: true });
    // Podium: the fireworks band once, behind the start screen's header (not
    // when the start finds an open game).
    const lobby = el('lobby');
    if (r.place <= 3 && !lobby.classList.contains('hidden') && !lobby.classList.contains('inSession')) {
      playCelebration('fireworks', lobby.querySelector('.lobbyHeader'));
    }
    accountApi('/api/season-result/seen', { token: accountToken(), season: r.season }).catch(() => {});
  }
  function seasonAwardChip(a) {
    const meta = SEASON_AWARDS[a.award];
    if (!meta) return '';
    const label = `${seasonLabel(a.season)} · ${L(`Platz ${a.place}`, `place ${a.place}`)}`;
    return `<span class="seasonAward" title="${escapeHtml(meta.name())}">` +
      `<span>${meta.emoji}</span><span>${escapeHtml(label)}</span></span>`;
  }
  function seasonAwardTile(a) {
    const meta = SEASON_AWARDS[a.award];
    if (!meta) return '';
    return `<div class="achTile earned achSeason" title="${escapeHtml(meta.name())}">` +
      `<span class="achEmoji">${meta.emoji}</span>` +
      `<span class="achName">${escapeHtml(seasonLabel(a.season))}</span>` +
      `<span class="achSub">${escapeHtml(seasonPlaceText(a))}</span></div>`;
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
    if (r.me) applySeasonInfo({ seasonAwards: r.seasonAwards, lastSeason: r.lastSeason });
    const rows = r.board.length
      ? r.board
          .map((e) => {
            // Shared place, as in the finale: a tie shares the medal.
            const place = 1 + r.board.filter((o) => o.seasonXp > e.seasonXp).length;
            const medal = ['🥇', '🥈', '🥉'][place - 1] || `${place}.`;
            const mine = accountUsername && e.username.toLowerCase() === accountUsername.toLowerCase();
            return `<div class="ladderRow${mine ? ' isMe' : ''}"><span>${medal} ${escapeHtml(e.username)}</span>` +
              `<b>${e.seasonXp} ${L('EP', 'XP')}</b></div>`;
          })
          .join('')
      : `<p class="lobby-hint">${L('Diese Saison hat noch niemand gepunktet - hol dir Platz 1!', 'Nobody has scored this season - claim first place!')}</p>`;
    const last = r.me && lastSeasonResult
      ? `<p class="ladderLast">${escapeHtml(L(`Letzte Saison (${seasonLabel(lastSeasonResult.season)}): `, `Last season (${seasonLabel(lastSeasonResult.season)}): `) + seasonPlaceText(lastSeasonResult))}</p>`
      : '';
    // Hall of fame: podium and top 10 only - a year of mementos would bury it.
    const fame = r.me ? seasonAwards.filter((a) => a.award !== 'participant') : [];
    const awards = fame.length
      ? `<div class="seasonAwards" aria-label="${escapeHtml(L('Saison-Abzeichen', 'Season badges'))}">${fame.map(seasonAwardChip).join('')}</div>`
      : '';
    box.innerHTML = `<h3>${L('Saison-Rangliste', 'Season ladder')} <span class="achCount">${escapeHtml(seasonLabel(r.season))}</span></h3>${rows}${last}${awards}`;
  }

  // --- Statistik ---------------------------------------------------------------
  el('statsBtn').addEventListener('click', () => {
    send({ type: 'listProfiles' }); // frische Daten anfordern
    // The "you" sparkline needs the history too; refresh it on every open.
    send({ type: 'getGameHistory', name: currentName() });
    renderStats();
    el('statsOverlay').classList.remove('hidden');
  });
  function selectStatsTab(which) {
    const board = which === 'board';
    el('statsTabBoardBtn').classList.toggle('active', board);
    el('statsTabHistoryBtn').classList.toggle('active', !board);
    el('statsPaneBoard').classList.toggle('hidden', !board);
    el('statsPaneHistory').classList.toggle('hidden', board);
    if (!board) {
      // Erst beim ersten Wechsel anfragen - kein unnoetiger Rundgang beim
      // blossen Oeffnen der Bestenliste.
      if (myGameHistory === null) send({ type: 'getGameHistory', name: currentName() });
      renderGameHistory();
    }
  }
  el('statsTabBoardBtn').addEventListener('click', () => selectStatsTab('board'));
  el('statsTabHistoryBtn').addEventListener('click', () => selectStatsTab('history'));
  // Record details: tapping a profile row expands its personal records
  // (best round, queen/joker balance, hand-aus wins) right beneath it.
  el('statsContent').addEventListener('click', (ev) => {
    const card = ev.target.closest('.boardRow');
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
      `${L('Joker', 'Jokers')}: <b>${p.totalJokersLaid || 0}</b>`,
      `${L('Hand aus', 'Out in one')}: <b>${p.totalHandAus || 0}</b>`,
    ];
    detail.innerHTML = `<div class="recordCell">${bits.join(' · ')}</div>`;
    card.after(detail);
  });

  el('statsCloseBtn').addEventListener('click', () => el('statsOverlay').classList.add('hidden'));
  el('statsOverlay').addEventListener('click', (ev) => {
    if (ev.target === el('statsOverlay')) el('statsOverlay').classList.add('hidden');
  });

  // "Meine Partien": summary, grouped cards (place, opponents, standings,
  // duration); a tap opens the score chart of that game.
  let openHistoryId = null;
  function historyDayLabel(ts) {
    const d = new Date(ts);
    const today = new Date();
    const yest = new Date();
    yest.setDate(today.getDate() - 1);
    const time = d.toLocaleTimeString(localeOf(), { hour: '2-digit', minute: '2-digit' });
    if (d.toDateString() === today.toDateString()) return L(`Heute, ${time}`, `Today, ${time}`);
    if (d.toDateString() === yest.toDateString()) return L(`Gestern, ${time}`, `Yesterday, ${time}`);
    return fmtDate(d, { weekday: 'short', day: '2-digit', month: '2-digit' });
  }
  function historyGameView(g) {
    const players = g.players || [];
    const totals = g.finalTotals || {};
    // Older records carry no ids: find "me" by name (humans only).
    const myName = (currentName() || '').toLowerCase();
    const me = (g.myId ? players.find((p) => p.id === g.myId) : players.find((p) => !p.isBot && (p.name || '').toLowerCase() === myName)) || null;
    const myTotal = me && me.id ? totals[me.id] || 0 : g.myScore || 0;
    const place = 1 + players.filter((p) => (totals[p.id] || 0) > myTotal).length;
    // Challenge games never show the bot level, here neither.
    const diffOf = (p) => (p.isBot && !g.challengeDate && BOT_DIFF[p.botDifficulty]) || null;
    const opps = players.filter((p) => p !== me).map((p) =>
      diffOf(p) ? `${p.name} (${diffOf(p).short()})` : p.name);
    const mins = g.startedAt && g.finishedAt ? Math.round((g.finishedAt - g.startedAt) / 60000) : 0;
    return { players, totals, me, myTotal, place, opps, mins, diffOf };
  }
  function renderGameHistory() {
    const box = el('historyContent');
    if (myGameHistory === null) {
      box.innerHTML = `<p class="lobby-hint">${L('Lade …', 'Loading …')}</p>`;
      return;
    }
    if (myGameHistory.length === 0) {
      box.innerHTML = `<p class="lobby-hint">${L(
        'Noch keine abgeschlossenen Partien unter diesem Namen. Gezählt wird erst eine komplett zu Ende gespielte Partie (bis 1000 Punkte).',
        'No finished games yet under this name. Only matches played to the end (1000 points) count.'
      )}</p>`;
      return;
    }
    const games = myGameHistory;
    const wins = games.filter((g) => g.won).length;
    const avg = Math.round(games.reduce((a, g) => a + (g.myScore || 0), 0) / games.length);
    const weekAgo = new Date();
    weekAgo.setDate(weekAgo.getDate() - 7);
    const card = (g) => {
      const v = historyGameView(g);
      const max = Math.max(1, ...v.players.map((p) => v.totals[p.id] || 0));
      const bars = v.players
        .slice()
        .sort((x, y) => (v.totals[y.id] || 0) - (v.totals[x.id] || 0))
        .map((p) => {
          const i = v.players.indexOf(p);
          const w = Math.max(2, Math.round(((v.totals[p.id] || 0) / max) * 100));
          return `<i class="${p === v.me ? 'me' : ''}" style="width:${w}%;background:${PLAYER_COLORS[i % PLAYER_COLORS.length]}"></i>`;
        }).join('');
      const tags = (g.challengeDate ? `<span class="historyTag historyTagChallenge">${L('Challenge', 'Challenge')}</span>` : '') +
        (g.stammtisch ? `<span class="historyTag">${L('Stammtisch', 'Stammtisch')}</span>` : '');
      const meta = [historyDayLabel(g.finishedAt), v.mins > 0 && v.mins < 24 * 60 ? `${v.mins} min` : null].filter(Boolean).join(' · ');
      const standingText = v.players.map((p) => `${p.name} ${v.totals[p.id] || 0}`).join(', ');
      const open = openHistoryId === g.id;
      return `<button type="button" class="histCard${g.won ? ' won' : ''}" data-id="${escapeHtml(g.id)}" aria-expanded="${open}">` +
        `<span class="histPlace" title="${escapeHtml(L(`Platz ${v.place} von ${v.players.length}`, `Place ${v.place} of ${v.players.length}`))}">${v.place}.</span>` +
        `<span class="histMain">` +
        `<span class="histMeta">${escapeHtml(meta)}${tags}</span>` +
        `<span class="histOpp">${escapeHtml(v.opps.length ? L(`gegen ${v.opps.join(', ')}`, `vs ${v.opps.join(', ')}`) : L('Solo', 'Solo'))}</span>` +
        `<span class="histBars" role="img" aria-label="${escapeHtml(standingText)}">${bars}</span>` +
        `</span>` +
        `<span class="histScore">${fmtNum(v.myTotal)}<small>${escapeHtml(fmtCount(g.rounds, 'round'))}</small></span>` +
        `</button>` +
        (open ? `<div class="histDetail" data-detail="${escapeHtml(g.id)}"></div>` : '');
    };
    const recent = games.filter((g) => g.finishedAt && new Date(g.finishedAt) >= weekAgo);
    const older = games.filter((g) => !recent.includes(g));
    const group = (title, list) => (list.length
      ? `<h4 class="histGroup">${escapeHtml(title)}</h4><div class="historyList">${list.map(card).join('')}</div>`
      : '');
    box.innerHTML =
      `<div class="histSummary">` +
      `<div><b>${fmtNum(games.length)}</b><span>${unitWord(games.length, 'game').replace(/^./, (c) => c.toUpperCase())}</span></div>` +
      `<div><b>${fmtNum(wins)}</b><span>${unitWord(wins, 'win').replace(/^./, (c) => c.toUpperCase())}</span></div>` +
      `<div><b>${fmtNum(avg)}</b><span>${L('Ø Punkte', 'Avg. points')}</span></div>` +
      `</div>` +
      group(L('Letzte 7 Tage', 'Last 7 days'), recent) + group(L('Früher', 'Earlier'), older);
    // The opened game: its score chart (stored totals after each round).
    const detail = box.querySelector('.histDetail');
    const g = detail && games.find((x) => x.id === detail.dataset.detail);
    if (g) {
      const v = historyGameView(g);
      const hist = (g.roundTotals || []).map((t, i) => ({ round: i + 1, totals: t }));
      if (hist.length >= 2) detail.appendChild(renderScoreChart(hist, { players: v.players, meId: g.myId }));
      const list = document.createElement('ol');
      list.className = 'histStandings';
      list.innerHTML = v.players
        .slice()
        .sort((x, y) => (v.totals[y.id] || 0) - (v.totals[x.id] || 0))
        .map((p) => `<li class="${p === v.me ? 'me' : ''}"><span>${escapeHtml(p.name)}${v.diffOf(p) ? ` <small>${escapeHtml(v.diffOf(p).short())}</small>` : ''}</span><b>${fmtNum(v.totals[p.id] || 0)}</b></li>`)
        .join('');
      detail.appendChild(list);
    }
  }
  el('historyContent').addEventListener('click', (ev) => {
    const cardEl = ev.target.closest('.histCard');
    if (!cardEl) return;
    openHistoryId = openHistoryId === cardEl.dataset.id ? null : cardEl.dataset.id;
    renderGameHistory();
  });

  function renderStats() {
    renderAchievements();
    renderStatsMe();
    const box = el('statsContent');
    // Server-wide counters: a footer with one punchline, not five bare rows.
    const gsBox = el('globalStatsBox');
    if (globalStatsData && globalStatsData.games > 0) {
      const g = globalStatsData;
      const queens = (g.pikDamesLaidOut || 0) + (g.pikDamesCaught || 0);
      const share = queens > 0 ? g.pikDamesCaught / queens : 0;
      const n = share > 0 ? Math.round(1 / share) : 0;
      const ordDe = ['', '', 'zweite', 'dritte', 'vierte', 'fünfte', 'sechste', 'siebte', 'achte', 'neunte', 'zehnte'][n] || '';
      const punch = n >= 2 && n <= 10
        ? L(`Jede ${ordDe} Pik Dame bleibt auf der Hand hängen.`, `One in ${n} Queens of Spades gets caught in hand.`)
        : queens > 0
          ? L(`${Math.round(share * 100)} % aller Pik Damen bleiben auf der Hand hängen.`, `${Math.round(share * 100)}% of all Queens of Spades get caught in hand.`)
          : '';
      const fmt = fmtNum;
      gsBox.innerHTML =
        (punch ? `<p class="gsPunch">${punch}</p>` : '') +
        `<p class="gsLine">${L(
          `Auf diesem Server: ${fmtCount(g.games, 'game')} · ${fmtCount(g.rounds, 'round')} · ${fmt(g.handAusRounds)}×${NBSP}Hand aus`,
          `On this server: ${fmtCount(g.games, 'game')} · ${fmtCount(g.rounds, 'round')} · ${fmt(g.handAusRounds)}×${NBSP}out in one`
        )}</p>`;
      gsBox.classList.remove('hidden');
    } else {
      gsBox.classList.add('hidden');
    }

    const profiles = (knownProfiles || []).filter((p) => (p.gamesPlayed || 0) > 0);
    if (profiles.length === 0) {
      // Say WHY it is empty (user question "always empty?").
      box.innerHTML = `<p class="lobby-hint">${L(
        'Noch keine abgeschlossenen Partien. Die Statistik zählt nur komplett zu Ende gespielte Partien (bis 1000 Punkte) - aufgegebene oder vorzeitig verlassene Spiele zählen nicht.',
        'No finished games yet. Statistics only count matches played to the end (1000 points) - forfeited or abandoned games do not count.'
      )}</p>`;
      return;
    }
    const sorted = profiles.slice().sort((a, b) => (b.gamesWon || 0) - (a.gamesWon || 0) || (b.totalScore || 0) - (a.totalScore || 0));
    const meName = (currentName() || '').toLowerCase();
    // Compact rank table; tapping a row still opens the personal records.
    const rows = sorted
      .map((p, i) => {
        const played = p.gamesPlayed || 0;
        const won = p.gamesWon || 0;
        const rate = played > 0 ? Math.round((won / played) * 100) : 0;
        const mine = p.name.toLowerCase() === meName;
        return `<button type="button" class="boardRow${mine ? ' isMe' : ''}" data-name="${escapeHtml(p.name)}">` +
          `<span class="boardRank">${i + 1}</span>` +
          `<span class="boardName">${nameWithHeart(p.name)}${favoriteBadgesHtml(p)}</span>` +
          `<span class="boardNum"><b>${fmtNum(won)}</b>/${fmtNum(played)}</span>` +
          `<span class="boardNum">${rate} %</span>` +
          `<span class="boardNum boardLevel">${levelFromXpClient(p.xp || 0).level}</span>` +
          `</button>`;
      })
      .join('');
    box.innerHTML =
      `<div class="boardHead"><span>#</span><span>${L('Spieler', 'Player')}</span><span>${L('Siege', 'Wins')}</span><span>${L('Quote', 'Rate')}</span><span>${L('Stufe', 'Level')}</span></div>` +
      `<div class="boardList">${rows}</div>`;
  }

  // "You" first: three numbers once, the level as a link, the last games as W/L boxes.
  el('statsMeBox').addEventListener('click', (ev) => {
    if (ev.target.closest('[data-open="progress"]')) openProgressSheet();
    if (ev.target.closest('[data-start="bots"]')) {
      // Same path as "Gegen Bots spielen" after the tutorial: new game, started with bots.
      el('statsOverlay').classList.add('hidden');
      afterTutorial = 'bots';
      el('createGameBtn').click();
    }
  });
  function renderStatsMe() {
    const box = el('statsMeBox');
    if (!box) return;
    const me = myProfile();
    if (publicMode) {
      box.classList.add('hidden');
      return;
    }
    if (!me || !(me.gamesPlayed > 0)) {
      // A new name: say what will show up here, and offer the way there.
      box.innerHTML =
        `<div class="meEmpty"><svg class="icon" aria-hidden="true"><use href="#i-chart"/></svg>` +
        `<div><b>${L('Deine Zahlen starten mit der ersten Partie', 'Your numbers start with your first game')}</b>` +
        `<span>${L('Spiel eine Partie bis 1000 Punkte, dann stehen hier deine Siege, dein Bestwert und deine letzten Partien.',
          'Play a game to 1000 points, then your wins, best score and recent games show up here.')}</span></div></div>` +
        `<button type="button" class="btn-secondary meEmptyCta" data-start="bots"><svg class="icon" aria-hidden="true"><use href="#i-play"/></svg><span>${L('Gegen Bots spielen', 'Play against bots')}</span></button>`;
      box.classList.remove('hidden');
      return;
    }
    const played = me.gamesPlayed || 0;
    const won = me.gamesWon || 0;
    const rate = played > 0 ? Math.round((won / played) * 100) : 0;
    const lv = levelFromXpClient(Math.max(me.xp || 0, myProgress ? myProgress.xp || 0 : 0));
    const kpi = (value, label) => `<div class="kpiTile"><b>${value}</b><span>${label}</span></div>`;
    // Newest first; the letter carries win/loss, the fill only repeats it.
    const games = (myGameHistory || []).slice(0, 10);
    const form = games.length
      ? `<div class="meForm"><div class="meFormHead"><span>${L('Letzte Partien', 'Recent games')}</span><span>${L('neueste links', 'newest first')}</span></div>` +
        `<ol class="meFormRow" aria-label="${escapeHtml(L('Letzte Partien, neueste zuerst', 'Recent games, newest first'))}">` +
        games.map((g) => {
          const score = String(g.myScore || 0); // no separator: ten boxes share 350 px
          const word = g.won ? L('Sieg', 'Win') : L('Niederlage', 'Loss');
          return `<li class="formBox ${g.won ? 'won' : 'lost'}" title="${escapeHtml(`${word} · ${score}`)}">` +
            `<b aria-hidden="true">${g.won ? L('S', 'W') : L('N', 'L')}</b><span class="visuallyHidden">${escapeHtml(word)}</span><small>${score}</small></li>`;
        }).join('') +
        `</ol></div>`
      : '';
    box.innerHTML =
      `<div class="meHead"><span class="meName">${nameWithHeart(me.name)}</span>` +
      `<button type="button" class="meLevelLink" data-open="progress"><span>${escapeHtml(titleForLevel(lv.level))} · ${L('Stufe', 'Level')} ${lv.level}</span>` +
      `<svg class="icon" aria-hidden="true"><use href="#i-chevron"/></svg></button></div>` +
      `<div class="kpiGrid">` +
      kpi(fmtNum(played), unitWord(played, 'game').replace(/^./, (c) => c.toUpperCase())) +
      kpi(fmtNum(won), `${unitWord(won, 'win').replace(/^./, (c) => c.toUpperCase())} · ${rate}${L(' %', '%')}`) +
      kpi(me.bestGameScore !== undefined ? fmtNum(me.bestGameScore) : '–', L('Bestwert', 'Best score')) +
      `</div>` + form;
    box.classList.remove('hidden');
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
    // Level reward: the XP bar hands out something you can SEE on the table.
    { id: 'master', label: 'Meister', labelEn: 'Master', gate: { field: 'level', min: 10, de: 'ab Stufe 10', en: 'from level 10' } },
    { id: 'emerald', label: 'Smaragd', labelEn: 'Emerald', gate: { field: 'level', min: 15, de: 'ab Stufe 15', en: 'from level 15' } },
    { id: 'purple', label: 'Purpur', labelEn: 'Royal purple', gate: { field: 'level', min: 20, de: 'ab Stufe 20', en: 'from level 20' } },
    { id: 'legend', label: 'Legende', labelEn: 'Legend', gate: { field: 'level', min: 30, de: 'ab Stufe 30', en: 'from level 30' } },
    // Seasonal (mirrors game/SeasonalBacks.js): unlocked by a finished game in the month, kept forever.
    { id: 'pumpkin', label: 'Kürbis', labelEn: 'Pumpkin', gate: { field: 'seasonal', de: 'nur im Oktober freischaltbar', en: 'unlockable in October only' } },
    { id: 'winter', label: 'Winterzauber', labelEn: 'Winter magic', gate: { field: 'seasonal', de: 'nur im Dezember freischaltbar', en: 'unlockable in December only' } },
    { id: 'christmas', label: 'Weihnachten', labelEn: 'Christmas', gate: { field: 'seasonal', de: 'nur vom 24. bis 26. Dezember freischaltbar', en: 'unlockable 24-26 December only' } },
    { id: 'easter', label: 'Ostern', labelEn: 'Easter', gate: { field: 'seasonal', de: 'nur von Karfreitag bis Ostermontag freischaltbar', en: 'unlockable Good Friday to Easter Monday only' } },
  ];
  // Level-gated table colours; every other theme is free.
  const THEME_LEVELS = { bordeaux: 25 };
  // Rank titles by level (#312), strictly ascending.
  const LEVEL_TITLES = [
    [1, 'Kiebitz', 'Kibitzer'], [3, 'Mitspieler', 'Player'], [5, 'Kartenmischer', 'Shuffler'],
    [8, 'Kartenhai', 'Card shark'], [12, 'Rommé-Fuchs', 'Rummy fox'], [16, 'Auslage-Ass', 'Meld ace'],
    [20, 'Rommé-Profi', 'Rummy pro'], [25, 'Tischmeister', 'Table master'], [30, 'Pik-Legende', 'Spade legend'],
  ];
  function titleForLevel(level) {
    let t = LEVEL_TITLES[0];
    for (const row of LEVEL_TITLES) if (level >= row[0]) t = row;
    return L(t[1], t[2]);
  }
  /** Everything the XP bar hands out, by level: emotes, card backs, theme, titles. */
  function levelRewards() {
    const out = [];
    for (const [id, level] of Object.entries(EMOTE_UNLOCK)) out.push({ level, kind: 'emote', id, label: `${id} ${L('Emote', 'emote')}` });
    for (const cb of CARDBACKS) {
      if (cb.gate && cb.gate.field === 'level') out.push({ level: cb.gate.min, kind: 'cardback', id: cb.id, label: L(`Kartenrücken „${cb.label}“`, `card back "${cb.labelEn}"`) });
    }
    for (const [id, level] of Object.entries(THEME_LEVELS)) out.push({ level, kind: 'theme', id, label: L(`Tischfarbe „${themeName(id)}“`, `table colour "${themeName(id)}"`) });
    for (const [level, de, en] of LEVEL_TITLES) if (level > 1) out.push({ level, kind: 'title', id: de, label: L(`Titel „${de}“`, `title "${en}"`) });
    for (const c of CELEBRATIONS) if (c.level > 1) out.push({ level: c.level, kind: 'celebration', id: c.id, label: L(`Siegesjubel „${c.de}“`, `victory celebration "${c.en}"`) });
    return out.sort((a, b) => a.level - b.level);
  }
  // Icons from the sprite per kind; an emote IS its emoji (content), so its label keeps it.
  const REWARD_ICONS = { cardback: 'cards', theme: 'palette', title: 'tag', celebration: 'sparkle' };
  function rewardHtml(r) {
    return REWARD_ICONS[r.kind] ? `${iconHtml(REWARD_ICONS[r.kind])}<span>${escapeHtml(r.label)}</span>` : `<span>${escapeHtml(r.label)}</span>`;
  }
  function themeName(id) {
    return ({ bordeaux: 'Bordeaux' })[id] || id;
  }
  function themeUnlocked(theme) {
    const need = THEME_LEVELS[theme];
    return !need || publicMode || myLevel() >= need;
  }
  function myProfile() {
    return (knownProfiles || []).find((p) => p.name && myName && p.name.toLowerCase() === myName.toLowerCase()) || null;
  }
  // Level of the LOCAL (name-based) profile - the same one the server checks
  // for level-gated emotes. myProgress is fresher right after a game (the
  // profile list only refreshes on the next listProfiles).
  function myLevel() {
    const p = myProfile();
    const xp = Math.max(p ? p.xp || 0 : 0, myProgress ? myProgress.xp || 0 : 0);
    return levelFromXpClient(xp).level;
  }
  // Mirrors game/Emotes.js - the server is the authority, this only draws
  // the locks. Public servers keep no profiles, so nothing is locked there.
  const EMOTE_UNLOCK = {
    '👏': 2, '🙈': 3, '🤔': 4, '🍀': 5, '😎': 6, '🔥': 8, '😴': 10, '🙏': 12, '🤩': 14, '🥳': 16, '💪': 18,
    '🃏': 20, '😅': 21, '🤞': 22, '👀': 23, '🙄': 24, '😬': 26, '🙃': 28, '🤝': 30, '😇': 32, '☕': 34, '🐢': 36, '🍻': 38, '❤️': 40,
  };
  // Mirrors game/Celebrations.js (contract test); the names live here.
  const CELEBRATIONS = [
    { id: 'standard', level: 1, de: 'Standard', en: 'Standard' },
    { id: 'cats', level: 10, de: 'Katzen-Konfetti', en: 'Cat confetti' },
    { id: 'fireworks', level: 20, de: 'Feuerwerk', en: 'Fireworks' },
    { id: 'cardfan', level: 35, de: 'Kartenfächer', en: 'Card fan' },
    { id: 'goldqueen', level: 50, de: 'Goldene Pik Dame', en: 'Golden queen of spades' },
  ];
  function emoteUnlockLevel(id) {
    return publicMode ? 1 : EMOTE_UNLOCK[id] || 1;
  }
  function cardbackUnlocked(cb) {
    if (!cb.gate) return true;
    if (cb.gate.field === 'level') return myLevel() >= cb.gate.min;
    const p = myProfile();
    if (cb.gate.field === 'seasonal') return !!p && !!(p.seasonalBacks || {})[cb.id];
    return !!p && (p[cb.gate.field] || 0) >= cb.gate.min;
  }
  function applyCardback() {
    try {
      let chosen = storageGet(CARDBACK_KEY) || 'classic';
      const def = CARDBACKS.find((x) => x.id === chosen);
      if (!def || !cardbackUnlocked(def)) chosen = 'classic';
      document.documentElement.dataset.cardback = chosen;
      const value = el('cardbackValue');
      if (value) {
        const d = CARDBACKS.find((x) => x.id === chosen);
        value.textContent = L(d.label, d.labelEn);
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
    box.innerHTML = `<h3><svg class="icon" aria-hidden="true"><use href="#i-cards"/></svg><span>${L('Kartenrücken', 'Card backs')}</span></h3>`;
    const grid = document.createElement('div');
    grid.className = 'cardbackGrid';
    for (const cb of CARDBACKS) {
      const unlocked = cardbackUnlocked(cb);
      const tile = document.createElement('button');
      tile.type = 'button';
      tile.className = `cardbackTile${cb.id === cur ? ' active' : ''}${unlocked ? '' : ' locked'}`;
      const lock = unlocked ? '' : '<svg class="icon" aria-hidden="true"><use href="#i-lock"/></svg>';
      tile.innerHTML = `<span class="cbPrev cbPrev-${cb.id}">${lock}</span>` +
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
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'btn-icon cardbackClose';
    closeBtn.setAttribute('aria-label', L('Schließen', 'Close'));
    closeBtn.title = L('Schließen', 'Close');
    closeBtn.innerHTML = '<svg class="icon" aria-hidden="true"><use href="#i-close"/></svg>';
    closeBtn.addEventListener('click', () => wrap.remove());
    box.appendChild(closeBtn);
    box.appendChild(grid);
    wrap.appendChild(box);
    wrap.addEventListener('click', (e) => { if (e.target === wrap) wrap.remove(); });
    document.body.appendChild(wrap);
    // The grid scrolls inside the box; on iOS the fade edge is the only hint.
    const edges = () => grid.classList.toggle('canScrollDown', grid.scrollHeight - grid.clientHeight - grid.scrollTop > 8);
    grid.addEventListener('scroll', edges, { passive: true });
    if (typeof ResizeObserver === 'function') new ResizeObserver(edges).observe(grid);
    requestAnimationFrame(edges);
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
        b.className = 'emoteChoice emoteSpecial';
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
      `Pik Dame ${el('versionValue') ? el('versionValue').textContent : ''}  ${new Date().toISOString().slice(11, 19)}Z`,
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
      setRowValue(el('debugBtn'), on ? L('An', 'On') : L('Aus', 'Off'));
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
  // auto = once per device, always = every load, off = never; a tap skips it.
  // Phase 2 follows the REAL end of the blade animation, not a fixed time.
  const LOGO_MODE_KEY = 'pikdame_studio_logo';
  const LOGO_MODES = ['auto', 'always', 'off'];
  // 'full' was the pre-2.71 name of 'always' (same rule as the head script).
  function logoMode() {
    const v = storageGet(LOGO_MODE_KEY);
    if (v === 'full') return 'always';
    return LOGO_MODES.includes(v) ? v : 'auto';
  }
  function logoModeLabel(mode) {
    if (mode === 'always') return L('Bei jedem Start', 'Every start');
    if (mode === 'off') return L('Aus', 'Off');
    return L('Nur einmal', 'Once only');
  }
  function updateStudioLogoBtn() {
    const sel = document.getElementById('studioLogoSelect');
    if (sel) {
      sel.value = logoMode();
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
        showToast(`🌀 ${L('Vorspann', 'Intro')}: ${logoModeLabel(next)}`);
      });
      updateStudioLogoBtn();
    }
  } catch (e) { /* Einstellung ist Komfort */ }

  // Victory celebration: kept on the profile (others see it), so only the
  // signed-in owner picks it - same rule as favourite badges.
  function myCelebration() {
    const me = myProfile();
    return (me && me.celebration) || 'standard';
  }
  function updateCelebrationSetting() {
    el('celebrationItem').classList.toggle('hidden', publicMode);
    const sel = el('celebrationSelect');
    const level = myLevel();
    for (const opt of sel.options) {
      const c = CELEBRATIONS.find((x) => x.id === opt.value);
      if (!c) continue;
      const locked = level < c.level;
      opt.disabled = locked;
      opt.textContent = locked ? `${L(c.de, c.en)} · ${L(`ab Stufe ${c.level}`, `level ${c.level}`)}` : L(c.de, c.en);
    }
    sel.value = myCelebration();
    const allowed = canPickFavorites();
    sel.disabled = !allowed;
    el('celebrationHint').textContent = allowed
      ? L('Alle am Tisch sehen ihn', 'Everyone at the table sees it')
      : L('Mit Konto wählbar', 'Sign in to choose');
  }
  try {
    el('celebrationSelect').addEventListener('change', () => {
      if (!canPickFavorites()) { updateCelebrationSetting(); return; }
      send({ type: 'setCelebration', name: myName, celebration: el('celebrationSelect').value, accountToken: accountToken() || undefined });
    });
    el('celebrationPreviewBtn').addEventListener('click', () => playCelebration(el('celebrationSelect').value, el('celebrationPreview')));
    updateCelebrationSetting();
  } catch (e) { /* Einstellung ist Komfort */ }

  try {
    const splash = el('studioSplash');
    if (splash) {
      let seen = false;
      const mode = logoMode();
      // Same rule as the head script: 'auto' = once per DEVICE and never for
      // an invite link; 'always' ignores both flags and plays on every load.
      if (mode !== 'always') {
        try { seen = sessionStorage.getItem('pikdame_splash_seen') === '1'; } catch (e) { seen = false; }
        if (storageGet(SPLASH_DEVICE_KEY) === '1') seen = true;
        if (urlSessionCode) seen = true;
      }
      const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      // The head script already decided (already seen, switched off, crawler,
      // or reduced motion). Honour it: drop the overlay out of the document
      // WITHOUT marking the intro as seen - a crawler must not leave traces in
      // sessionStorage, and a reduced-motion visitor who later switches the
      // setting to 'always' should still get the intro.
      const skipped = document.documentElement.classList.contains('noSplash');

      if (skipped || seen || mode === 'off') {
        splash.remove();
      } else {
        try { sessionStorage.setItem('pikdame_splash_seen', '1'); } catch (e) { /* egal */ }
        storageSet(SPLASH_DEVICE_KEY, '1');
        // Reduced motion gets the calm cut: blades fade in, no swirl.
        if (!reduce) splash.classList.add('fullMotion');
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

  /* Crawler bekommen KEINE WebSocket-Verbindung. Googles Renderer baut keine
     auf, der Versuch scheitert also immer: die Statuszeile wuerde
     'Verbindungsfehler' in den indexierten Text schreiben und der
     close-Handler alle 2 s ewig neu verbinden - die Seite kaeme nie zur Ruhe.
     Die Klasse setzt das Kopf-Skript in index.html (dieselbe Erkennung, die
     schon den Vorspann ueberspringt). Fuer Menschen aendert sich nichts: die
     Lobby ist statisches Markup, alles Interaktive braucht ohnehin den
     Server. Die Statuszeile wird geleert statt gefuellt - eine sichtbare
     Fehlermeldung ohne Fehler ist schlechter als gar keine. */
  if (document.documentElement.classList.contains('isCrawler')) {
    const cs = el('connStatus');
    if (cs) cs.textContent = '';
  } else {
    connect();
  }
})();

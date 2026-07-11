// public/i18n.js
// Zweisprachigkeit Deutsch/Englisch. Deutsch ist die Quellsprache (steht im
// HTML/Code), Englisch wird per Lookup übersetzt:
// - I18N_STATIC: exakte Übersetzungen für statische HTML-Texte, title- und
//   placeholder-Attribute (Blatt-Elemente werden beim Start automatisch
//   inventarisiert).
// - I18N_SERVER_PATTERNS: Muster für die dynamischen SERVER-Texte
//   (Spiel-Log, Fehlermeldungen). Der Server bleibt bewusst einsprachig -
//   verschiedene Spieler am selben Tisch können verschiedene Sprachen
//   nutzen, daher übersetzt jeder Client für sich. Unbekannte Texte bleiben
//   unübersetzt (Fallback Deutsch) statt kaputt zu gehen.
// - I18N_RULES_EN: die komplette englische Spielregeln-Ansicht.

window.I18N_STATIC = {
  // Lobby
  'Das Familien-Rommé – online mit Freunden & Bots': 'The family rummy – online with friends & bots',
  'Neues Spiel erstellen': 'Create a new game',
  'Zug-Timer': 'Turn timer',
  '🗓️ Challenge': '🗓️ Challenge',
  '🎓 Tutorial': '🎓 Tutorial',
  '👤 Konto': '👤 Account',
  '🗓️ Tages-Challenge': '🗓️ Daily challenge',
  'Heute spielen alle Spieler weltweit exakt dasselbe Kartendeck – gegen drei mittlere Bots. Wer holt die meisten Punkte aus den gleichen Karten?': 'Today every player worldwide gets the exact same deck – against three medium bots. Who squeezes the most points out of identical cards?',
  'Dein bestes Tagesergebnis landet mit deinem Spielernamen in der Bestenliste (7 Tage sichtbar). Mehrere Versuche sind erlaubt – nur der beste zählt.': 'Your best result of the day enters the leaderboard under your player name (visible for 7 days). Multiple attempts are allowed – only the best one counts.',
  'Heute führt:': 'Today\u2019s leader:',
  "Los geht's!": "Let\u2019s go!",
  'Aus': 'Off',
  '30 Sekunden': '30 seconds',
  '60 Sekunden': '60 seconds',
  '90 Sekunden': '90 seconds',
  'oder einem Spiel beitreten': 'or join a game',
  'Beitreten': 'Join',
  'Weiter': 'Continue',
  'Name': 'Name',
  'Dein Name': 'Your name',
  'SPIEL-CODE': 'GAME CODE',
  'Spiel-Code – zum Mitspielen weitergeben': 'Game code – share it to let others join',
  'Teilen': 'Share',
  'QR-Code': 'QR code',
  'Sitzordnung & Geber': 'Seating & dealer',
  'Reihenfolge mit ▲▼ anpassen, ⭐ markiert den Geber der ersten Runde.': 'Adjust the order with ▲▼, ⭐ marks the dealer of the first round.',
  'Spieleranzahl': 'Number of players',
  'Fehlende Plätze werden mit Bots aufgefüllt.': 'Empty seats are filled with bots.',
  'Hausregeln': 'House rules',
  'Hand aus zählt doppelt': 'Going out in one turn counts double',
  'Anfänger': 'Beginner',
  'Fortgeschritten': 'Advanced',
  'Zen-Meister': 'Zen master',
  '🔒 Nur der Organisator kann die Einstellungen ändern.': '🔒 Only the organizer can change the settings.',
  '⏸️ Spiel pausiert': '⏸️ Game paused',
  'Das Spiel ist pausiert. Es geht weiter, sobald alle zustimmen.': 'The game is paused. It continues once everyone agrees.',
  '▶️ Fortsetzen': '▶️ Resume',
  'Über 1000 Punkte zum Gewinnen (genau 1000 reicht nicht)': 'More than 1000 points to win (exactly 1000 is not enough)',
  'Spiel starten': 'Start game',
  '🏠 Hauptmenü': '🏠 Main menu',
  '📖 Spielregeln': '📖 How to play',
  '📊 Statistik': '📊 Statistics',
  'Impressum & Datenschutz': 'Legal notice & privacy',
  'Verbinde...': 'Connecting...',
  // Konto
  '🎬 Partie-Rückblick': '🎬 Game replay',
  '👤 Konto': '👤 Account',
  'Anmelden': 'Sign in',
  'Registrieren': 'Register',
  'Konto erstellen': 'Create account',
  'Abmelden': 'Sign out',
  'Benutzername oder E-Mail': 'Username or e-mail',
  'Passwort': 'Password',
  'Benutzername (2-24 Zeichen)': 'Username (2-24 characters)',
  'E-Mail-Adresse': 'E-mail address',
  'Passwort (mind. 8 Zeichen)': 'Password (min. 8 characters)',
  'Dein Fortschritt (Statistik, Erfolge, Siegesserien) bleibt mit einem Konto dauerhaft erhalten - und niemand sonst kann deinen Namen verwenden.': 'With an account your progress (statistics, achievements, streaks) is kept permanently - and nobody else can use your name.',

  // Topbar / Spielfeld
  'Runde –': 'Round –',
  'Nachziehen': 'Draw',
  'Ablage': 'Discard',
  'Auslegen': 'Meld',
  'Abwerfen': 'Discard card',
  'Auswahl löschen': 'Clear selection',
  '🏳️ Spiel aufgeben': '🏳️ Forfeit game',

  // Titles (Attribute)
  'Ablagestapel ansehen': 'View discard pile',
  'Anzeigegröße ändern': 'Change display size',
  'Deine Gesamtpunkte': 'Your total score',
  'Karten ein-/ausblenden': 'Show/hide cards',
  'Reaktion senden': 'Send a reaction',
  'Spiel aufgeben': 'Forfeit game',
  'Sortierung umschalten': 'Toggle sorting',
  'Sound ein/aus': 'Sound on/off',
  'Vollbild': 'Fullscreen',
  'Was ist neu?': "What's new?",
  'Spieltisch': 'Table',
  'Nacht': 'Night',
  'Herzdame': 'Queen of hearts',
  'Filz': 'Felt',

  // Overlays
  'Zum Mitspielen scannen': 'Scan to join',
  'Mit der Kamera scannen – der Spiel-Code wird automatisch übernommen.': 'Scan with your camera – the game code is filled in automatically.',
  'Wirklich abwerfen?': 'Really discard?',
  'Ja, abwerfen': 'Yes, discard',
  'Abbrechen': 'Cancel',
  'Oberste Karte zuerst – alle Karten wurden offen abgelegt.': 'Top card first – every card was discarded face up.',
  'Was soll der Joker sein?': 'What should the joker represent?',
  'Mehrere Kombinationen sind möglich – bitte wählen.': 'Several combinations are possible – please choose.',
  'Über alle Partien auf diesem Server (nach Spielernamen).': 'Across all games on this server (by player name).',
  'Schließen': 'Close',
  '📤 Spielverlauf exportieren': '📤 Export game history',
  'Rundenende': 'End of round',

  // Themes-Zeile etc.
  'Sound & Vibration': 'Sound & vibration',
};

// Muster für Server-Texte (Log + Fehler). Reihenfolge: speziell vor generisch.
// $1..$n = Capture-Groups.
window.I18N_SERVER_PATTERNS = [
  // --- Log ---
  [/^Runde (\d+) gestartet\. Geber: (.+)\.$/, 'Round $1 started. Dealer: $2.'],
  [/^🍀 Glücksgriff beim Abheben! (.+?) nimmt vor dem Verteilen sofort auf die Hand: (.+)\.$/, '🍀 Lucky cut! $1 takes straight into hand before dealing: $2.'],
  [/^(.+?) zieht eine Karte vom Stapel\.$/, '$1 draws a card from the pile.'],
  [/^(.+?) nimmt die oberste Ablagekarte \((.+?)\) - sie muss sofort gelegt werden, danach folgt der Rest des Stapels\.$/, '$1 takes the top discard ($2) – it must be melded immediately, then the rest of the pile follows.'],
  [/^(.+?) nimmt die restlichen (\d+) Karten des Ablagestapels auf\.$/, '$1 picks up the remaining $2 cards of the discard pile.'],
  [/^(.+?) legt eine neue Satz-Auslage aus\.$/, '$1 lays down a new set.'],
  [/^(.+?) legt eine neue Folge-Auslage aus\.$/, '$1 lays down a new run.'],
  [/^(.+?) legt (.+?) an eine Auslage an\.$/, '$1 adds $2 to a meld.'],
  [/^(.+?) tauscht (.+?) gegen einen Joker in einer Auslage\. Der Joker scheidet aus dem Spiel aus\.$/, '$1 swaps $2 for a joker in a meld. The joker is permanently out of the game.'],
  [/^(.+?) wirft (.+?) ab\.$/, '$1 discards $2.'],
  [/^(.+?) hat alle Karten ausgelegt - Runde endet!$/, '$1 has melded all cards – the round ends!'],
  [/^(.+?) legt die letzte Karte verdeckt ab und beendet die Runde!$/, '$1 discards the last card face down and ends the round!'],
  [/^(.+?) möchte das Spiel aufgeben \((\d+\/\d+)\)\.$/, '$1 wants to forfeit the game ($2).'],
  [/^🏳️ Spiel einvernehmlich aufgegeben.*$/, '🏳️ Game forfeited by mutual agreement - everyone agreed. Match over.'],
  [/^Hand aus! Die komplette Rundenwertung wird verdoppelt\.$/, 'Out in one! The entire round score is doubled.'],
  [/^Spiel beendet! Gewinner: (.+)$/, 'Game over! Winner: $1'],
  [/^Rundenwertung: (.+)$/, 'Round scores: $1'],
  [/^⚠️ Endspurt! (.+?) steht bei (\d+) Punkten - ab 1000 endet das Spiel\.$/, '⚠️ Final stretch! $1 is at $2 points - the game ends at 1000.'],
  [/^⚠️ Endspurt! (.+?) steht bei (\d+) Punkten - über 1000 endet das Spiel\.$/, '⚠️ Final stretch! $1 is at $2 points - the game ends above 1000.'],
  [/^Keine Karten mehr zum Ziehen - die Runde endet unentschieden\.$/, 'No cards left to draw – the round ends in a stalemate.'],
  [/^Nachziehstapel war leer - Ablagestapel \(außer oberster Karte\) wurde gemischt und neu aufgelegt\.$/, 'Draw pile was empty – the discard pile (except the top card) was shuffled and restocked.'],
  [/^(.+?) ist beigetreten\.$/, '$1 joined.'],
  [/^(.+?) hat die Verbindung verloren - ein Bot übernimmt vorerst\.$/, '$1 lost connection – a bot takes over for now.'],
  [/^(.+?) ist wieder da und übernimmt von seinem Bot\.$/, '$1 is back and takes over from the bot.'],
  // --- Options-Labels (Joker-/Anlege-Auswahl) ---
  [/^oben anlegen als (.+)$/, 'add on top as $1'],
  [/^unten anlegen als (.+)$/, 'add below as $1'],
  [/^als (.+)$/, 'as $1'],
  [/^Satz: (\d+)x (.+)$/, 'Set: $1x $2'],
  [/^Folge: (.+)$/, 'Run: $1'],
  [/^Anlegen$/, 'Add'],
  // --- Fehler ---
  // Konto-Fehler (kommen per HTTP-API oder als Join-Fehler)
  [/^Dieser Name gehört zu einem registrierten Konto - bitte zuerst anmelden, um ihn zu verwenden\.$/, 'This name belongs to a registered account - please sign in first to use it.'],
  [/^Der Benutzername muss 2-24 Zeichen lang sein \(Buchstaben, Zahlen, Leer-, Binde-, Unterstrich, Punkt\)\.$/, 'The username must be 2-24 characters (letters, digits, space, dash, underscore, dot).'],
  [/^Bitte eine gültige E-Mail-Adresse angeben\.$/, 'Please enter a valid e-mail address.'],
  [/^Das Passwort muss mindestens 8 Zeichen lang sein\.$/, 'The password must be at least 8 characters long.'],
  [/^Benutzername oder E-Mail ist bereits registriert\.$/, 'Username or e-mail is already registered.'],
  [/^Benutzername\/E-Mail oder Passwort ist falsch\.$/, 'Username/e-mail or password is incorrect.'],
  [/^Bitte zuerst die E-Mail-Adresse bestätigen \(Link in der Mail\)\.$/, 'Please confirm your e-mail address first (link in the mail).'],
  [/^Ungültiger oder bereits verwendeter Bestätigungslink\.$/, 'Invalid or already used confirmation link.'],
  [/^Zu viele Anfragen - bitte kurz warten\.$/, 'Too many requests - please wait a moment.'],
  [/^Lange Zeit keine neue Auslage - die Runde endet unentschieden\.$/, 'No new melds for a long time - the round ends in a draw.'],
  [/^(.+) ist getrennt - kehrt (.+) nicht zurück, übernimmt gleich ein Bot\.$/, '$1 is disconnected - if $2 does not return, a bot will take over shortly.'],
  [/^Joker bitte einzeln anlegen \(der Platz will gewählt sein\)\.$/, 'Please lay off jokers one at a time (their slot needs choosing).'],
  [/^Nicht alle gewählten Karten passen zusammen an diese Auslage\.$/, 'Not all selected cards fit onto this meld together.'],
  [/^Diese Kombination bitte einzeln anlegen\.$/, 'Please lay off this combination one card at a time.'],
  [/^Keine Karten gewählt\.$/, 'No cards selected.'],
  [/^Dieser Platz ist geschützt - er gehört einem anderen Gerät\.$/, 'This seat is protected - it belongs to another device.'],
  [/^⏰ Zeit abgelaufen - der Zug von (.+) wird automatisch zu Ende gespielt\.$/, "⏰ Time is up - $1's turn is finished automatically."],
  [/^(.+) ist bereit\.$/, '$1 is ready.'],
  [/^(.+) ist doch noch nicht bereit\.$/, '$1 is not ready after all.'],
  [/^Noch nicht alle bereit \((\d+)\/(\d+)\)\.$/, 'Not everyone is ready yet ($1/$2).'],
  [/^Bereitschaft gibt es nur in der Lobby\.$/, 'Readiness only exists in the lobby.'],
  [/^Nur Mitspieler am Tisch können sich bereit melden\.$/, 'Only players at the table can mark themselves ready.'],
  [/^Zu viele Aktionen - bitte kurz durchatmen\.$/, 'Too many actions - please take a breath.'],
  [/^(.+) stellt (.+) auf Anfänger\.$/, '$1 sets $2 to Beginner.'],
  [/^(.+) stellt (.+) auf Fortgeschritten\.$/, '$1 sets $2 to Advanced.'],
  [/^(.+) stellt (.+) auf Zen-Meister\.$/, '$1 sets $2 to Zen master.'],
  [/^Zum Ausmachen musst du deine letzte Karte abwerfen - mindestens eine Handkarte muss übrig bleiben\.$/, 'To go out you must discard your last card - at least one hand card has to remain.'],
  [/^Du bist nicht am Zug\.$/, "It's not your turn."],
  [/^Du hast bereits gezogen\.$/, 'You have already drawn.'],
  [/^Du musst zuerst eine Karte ziehen\.$/, 'You must draw a card first.'],
  [/^Es läuft gerade keine Runde\.$/, 'No round is in progress.'],
  [/^Ablagestapel ist leer\.$/, 'The discard pile is empty.'],
  [/^Auslage nicht gefunden\.$/, 'Meld not found.'],
  [/^Spieler nicht gefunden\.$/, 'Player not found.'],
  [/^Karte nicht in der Hand gefunden\.$/, 'Card not found in your hand.'],
  [/^Karte\(n\) nicht in der Hand gefunden\.$/, 'Card(s) not found in your hand.'],
  [/^Karte passt nicht an diese Auslage\.$/, "This card doesn't fit this meld."],
  [/^Diese Karte passt nicht auf einen Joker in dieser Auslage\.$/, "This card doesn't match a joker in this meld."],
  [/^Diese Kombination ergibt keinen gültigen Satz oder keine gültige Folge\.$/, 'This combination is neither a valid set nor a valid run.'],
  [/^Die aufgenommene Ablagekarte muss SOFORT gelegt werden, bevor etwas anderes passiert\.$/, 'The picked-up discard must be melded IMMEDIATELY before anything else.'],
  [/^Die aufgenommene Ablagekarte muss zuerst ausgelegt\/angelegt werden\.$/, 'The picked-up discard must be melded first.'],
  [/^Die oberste Ablagekarte passt zu keiner Kombination mit deinen Handkarten - der Ablagestapel kann so nicht aufgenommen werden\.$/, "The top discard doesn't form any combination with your hand – the pile can't be picked up."],
  [/^Du kannst nur an deine EIGENEN Auslagen anlegen - jeder Spieler hat seinen eigenen Stapel\.$/, 'You can only add to your OWN melds – every player has their own.'],
  [/^Du kannst nur Joker aus deinen EIGENEN Auslagen tauschen - fremde Stapel sind tabu\.$/, 'You can only swap jokers in your OWN melds – other players\' melds are off limits.'],
  [/^Die Sitzordnung kann nur vor Rundenbeginn geändert werden\.$/, 'Seating can only be changed before a round starts.'],
  [/^Die Spieleranzahl kann nur vor Rundenbeginn geändert werden\.$/, 'The number of players can only be changed before a round starts.'],
  [/^Die neue Reihenfolge muss alle aktuellen Plätze enthalten\.$/, 'The new order must contain all current seats.'],
  [/^Kein Spiel mit diesem Code gefunden\. Bitte Code prüfen\.$/, 'No game found with this code. Please check it.'],
  [/^Der Server ist derzeit voll - bitte später erneut versuchen\.$/, 'The server is currently full – please try again later.'],
  [/^Mindestens 2 Spieler nötig\.$/, 'At least 2 players are required.'],
];

window.I18N_RULES_EN = `
  <h3>Goal &amp; cards</h3>
  <p>2–4 players (bots fill empty seats), 110 cards: two full decks plus 6 jokers. Everyone gets 15 cards. Whoever gets rid of all their cards first wins the round.</p>

  <h3>Dealing &amp; the lucky cut</h3>
  <ul>
    <li>The dealer rotates each round; the player after the dealer starts.</li>
    <li>Before dealing, the player to the dealer's right cuts the deck. <b>Lucky cut:</b> If the Queen of Spades or jokers sit at the cut, they go straight into that player's hand – dealing skips accordingly, so everyone ends up with 15 cards.</li>
  </ul>

  <h3>Your turn</h3>
  <ul>
    <li><b>1. Draw:</b> one card from the draw pile – OR the top discard, but only if it can form a new combination with your hand. Then you must <b>meld it immediately</b>; only afterwards do you receive the entire rest of the discard pile.</li>
    <li><b>2. Meld &amp; add</b> (as often as you like): lay down combinations, add single cards or swap jokers – <b>only on your own melds</b>. Other players' melds are off limits!</li>
    <li><b>3. Discard:</b> exactly one card onto the discard pile – your turn ends. <b>Going out:</b> your last card is discarded <b>face down</b> – nobody can pick it up. So you can never meld everything; at least one card stays for the discard.</li>
  </ul>

  <h3>Combinations</h3>
  <ul>
    <li><b>Set:</b> 3–8 cards of the same rank. Each suit at most twice (two decks!).</li>
    <li><b>Run:</b> at least 3 cards of the same suit in sequence. Runs are <b>circular</b>: after the King comes the Ace, then the 2 again – K‑A‑2 is valid. At most 13 cards, no duplicate ranks.</li>
  </ul>

  <h3>Jokers</h3>
  <ul>
    <li>A joker substitutes for any card.</li>
    <li>You can swap a joker in your meld for the real card – the joker is then <b>permanently out of the game</b>.</li>
  </ul>

  <h3>Scoring</h3>
  <ul>
    <li>2–9 = <b>5</b> points</li>
    <li>10, Jack, Queen, King = <b>10</b> points</li>
    <li>Ace &amp; Joker = <b>20</b> points</li>
    <li>Queen of Spades = <b>100</b> points</li>
    <li>End of round: the winner scores their melds. Everyone else: melds count <b>plus</b>, remaining hand cards count <b>minus</b> – a Queen of Spades left in hand costs 100!</li>
    <li><b>Out in one ("Hand aus"):</b> if the winner had nothing melded before their final turn and sheds the entire hand in one go, the round score doubles for everyone – when the house rule is active.</li>
  </ul>

  <h3>House rules (chosen when creating a game)</h3>
  <ul>
    <li><b>Bot difficulty:</b> Beginner, Advanced or Zen master – adjustable per bot, too (tap the icon on a bot).</li>
    <li><b>⏱ Turn timer:</b> 30/60/90 seconds per turn. When time runs out, the bot logic finishes that turn fairly – the table never waits forever.</li>
    <li><b>Out in one counts double</b> (see scoring).</li>
    <li><b>Strict 1000:</b> victory only once someone is above 1000 points.</li>
  </ul>

  <h3>Game end &amp; misc</h3>
  <ul>
    <li>The game ends once someone reaches 1000 points (strict house rule: only above 1000). The highest score wins.</li>
    <li>When the draw pile runs out, the discard pile (except its top card) is reshuffled and reused – but only while there are still cards for it. <b>If you can neither draw nor take the top discard card, the round ends and is scored:</b> laid-out cards count plus, the cards left in your hand count <b>minus</b> as usual (a Queen of Spades in hand costs 100!) – only the winner bonus is not awarded in this case. Use 🏳️ to forfeit the whole game - that ends the match immediately (all active players must agree).</li>
  </ul>
`;

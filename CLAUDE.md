# CLAUDE.md — Projektkontext für KI-Assistenten

Pik Dame: Online-Multiplayer-Kartenspiel (Familien-Rommé). Regeln für JEDE Änderung.
Diese Datei kurz halten: Regeln + knappes Warum; Hintergrund gehört in docs/.
**Aus Fehlern lernen:** Passiert der KI ein vermeidbarer Fehler (rot gepusht,
Werkzeug-Falle, falsche Annahme), die Ursache als kurze Regel hier oder im
passenden Skill festhalten, im selben PR, solange er offen ist.

## Sprache

- **Englisch:** Code, Kommentare, Bezeichner, Commits, Workflows, Infra, Tests,
  Repo-Doku (README, docs/; k8s/ und landing/ READMEs bei nächster Berührung).
  Deutsche Bestandskommentare beim Berühren migrieren.
- **Deutsch:** alle nutzersichtbaren Texte (Quellsprache, über i18n).
  Changelog-Fragmente: Überschriften englisch (Added/Changed/Fixed/Removed),
  Inhalt deutsch.
- **Kommentare 1–2 Zeilen**, nur Warum/Falle/Vertrag; Erklärungen in docs/,
  Commit oder PR. Lange Bestandskommentare sind kein Vorbild.

## Harte Constraints

- **Mehrdeutiger Wunsch → ERST FRAGEN:** 2–4 nummerierte Optionen statt die
  wahrscheinlichste Lesart bauen. Ausnahme: eindeutiger Bug mit Beweis.
  Bei Sicherheits-/Login-Flows die übliche Praxis großer Anbieter als
  empfohlene Option nennen.
0. **Betrieb = gehosteter Docker-Stack** (play.pikdame.online); UX und
   Architektur richten sich nach Online-Mehrspieler.
0b. **PostgreSQL ist Pflicht** (`PIKDAME_DATABASE_URL`, sonst startet der
   Server nicht); kein SQLite. `game/Database.js` = der eine Pool.
1. **Externe Pakete nur, wenn wirklich sinnvoll und nötig — nie ohne Okay.**
   Sinnvoll: Eigenbau sicherheitskritisch/fehleranfällig (Krypto, Parser,
   Diagramme) oder deutlich mehr Code; Paket etabliert, gepflegt, MIT/BSD/
   Apache, reines JS. Vorher prüfen: Lizenzen des Baums, Größe, Trivy,
   `require`. Aktuell: `ws`, `pg` und `@simplewebauthn/server` (letzteres LAZY).
   Browser-Libs werden VENDORT (`public/vendor-*.js`, unverändert, npm-Hash im
   Kopf): qrcode, uPlot, @simplewebauthn/browser. Keine nativen Module (außer
   `onnxruntime-node` NUR im Dockerfile), kein Build-Schritt. Features mit
   neueren Node-APIs (z. B. `crypto.argon2`) schalten sich auf alten
   Versionen selbst ab, statt den Start zu brechen.
2. **Kein CDN, keine fremden Hosts im Ladepfad.** Icons = Inline-SVG-Sprite
   (`<svg class="icon"><use href="#i-name"/></svg>`), keine Icon-Fonts.
   Schrift: Systemschrift, nur Logo/Titel/Punktzahlen in der vendorten Rubik
   (`--font-display`, `public/fonts/`, OFL, Hash im README; Vertragstest).
   **Emoji sind keine Icons** (nur als Inhalt: Bot-Avatare, Reaktionen,
   Abzeichen). Text neben Icon in eigenes `<span>` — `applyStaticLang()`
   überschreibt `textContent` von Blatt-Elementen. Inline-Skripte nur in
   `index.html` (CSP-Hash); andere Seiten laden Skripte als Datei (Vertragstest).
2b. **Mobile zuerst** (iPhone 393×852). Jede UI-Änderung prüfen in: hoch,
   **quer** (874×402, nur ~400 px Höhe!) und Desktop. Der letzte
   `@media (orientation: landscape) and (max-height: 540px)`-Block steht am
   ENDE von `style.css` (Vertragstest); höhere Spezifität (`#table.x
   #centerPiles`) schlägt ihn trotzdem — dort jeden Wert neu setzen.
   Tisch-Layouts: Hochformat (Flex, Stapel über Hand), Querformat ≤540 px
   und Desktop ≥1100 px (Grid, Stapel in Seitenspalte; Text dort mit
   `contain: inline-size`, sonst verbreitert er die Spalte und kostet
   Auslagen-Breite). Gleiche Grid-Spalten: `minmax(0, 1fr)` (`1fr` wächst
   bis zur längsten `<select>`-Option); `sticky` in einem gepolsterten
   Scroller zählt ab dem Innenabstand. `--accent` (Auswahl) und `--drawn`
   in jedem Theme unterscheidbar; Spielerfarben nur aus `PLAYER_COLORS`
   (CVD-geprüft, ≠ `--accent`). Startbildschirm hochkant: eine Spalte
   `--lobby-w`, passt am iPhone OHNE Scrollen — Messlatte für neue
   Elemente; quer ≤540 px (ab 720 px Breite) und Desktop ≥1100 px zwei
   Spalten (Spielen links, `.lobbyDaily` rechts). Tap-Ziele ≥ `--tap-min`
   (44 px). Größen nur aus der Skala (`--fs-*`, `--ctl-h`), nie rohe `rem`.
   **Keine nativen Dialoge** (`alert`/`confirm`/`prompt`): iOS unterdrückt sie
   still, der Tipp tut dann nichts. Bestätigen per zwei Taps (`confirmByTap`).
3. **Zweisprachig:** jeder sichtbare Text braucht einen Eintrag — HTML →
   `I18N_STATIC`, JS → `L(de, en)`, Server-Texte → `I18N_SERVER_PATTERNS`
   (Regex). Vertragstests prüfen das.
4. **Sessions überleben Neustarts** (`GameManager.serialize/deserialize`):
   Transientes (Timer, Sets, Hooks) in die Skip-Liste UND in `deserialize`
   neu anlegen (`Set` → `{}` = Crash). Snapshot minütlich bei Änderung + bei
   SIGTERM, >30 min alt wird verworfen. Timer im GameManager immer `unref()`.
5. **Exceptions töten nie den Prozess:** Server-/Client-WS-Handler und
   Konto-API mit try/catch; `localStorage` nur über `storageGet/Set/Remove`.

## Architektur

- `server.js` — HTTP (statisch, `/statusz`, `/healthz`, `/changelogz`,
  `/api/*`, `/verify`, `/admin`) + WebSocket, ein `GameManager` pro Session.
- `game/` — Logik ohne I/O: `Rules.js` (Melds, Ring-Folgen K-A-2, max 13),
  `ScoreBoard.js`, `GameManager.js` (Zustand, Bots, Snapshot), `Bot.js`
  (easy/medium/hard/zen), JSON-Stores (atomar), `PgAccountStore.js` (Konten).
  - **Schema-Änderungen nur als neue Datei in `migrations/`** (`NNN_name.sql`,
    nur vorwärts, gemergte Dateien nie ändern; `Migrations.js`, Doku
    `docs/developer/migrations.md`). Start ohne Sperre, wenn aktuell: DDL bei
    jedem Start blockierte laufende Transaktionen (v2.102.1).
  - `Mailer.js`: eigener SMTP-Client, Log-Fallback; Header RFC 2047, Body
    Quoted-Printable — nie rohes UTF-8 in Kopfzeilen.
  - `Badges.js` (Familien in `BADGE_FAMILIES`, Fakten aus `finishRound`),
    `Progression.js` (XP, Tagesaufgaben, Serie mit Joker-Tag; XP-Regeln
    spiegelt `XP_RULES` im Client, Vertragstest). UI: Stufe + Serie am
    Identitäts-Chip/Fortschritts-Blatt; Rätsel, Challenge, Kartenhaus und
    Tagesziele mit Status im Bereich „Aufgaben“.
  - `GameDay.js`: EINZIGE Definition von „heute“ (Mitternacht Europe/Berlin,
    Rechnen nur auf Datums-Strings, nie 24-h-Schritte).
  - `DailyPuzzle.js`: Ergebnisobjekt ohne `type`-Feld (wird in WS gespreadet).
    Arten im Wochentakt (meld/turn/out); Tage vor `ROTATION_START` bleiben,
    wie sie ausgespielt wurden (Archiv per `date`, ohne EP).
  - Kartenhaus-Blätter ab 2027-01 baut der Server selbst (`TowerMonths.js`, Worker):
    EINE Regel/Generator (`TowerRule.js`/`TowerGen.js`) für Server und Skript;
    nie ein unbewiesenes Blatt ausliefern (Zen-Beweis Pflicht).
  - Spielversuche nur über `PlayEvents.js` (`play_events`, Admin „Festhänger“):
    eine Zeile pro Versuch (`attempt_id`), 90 Tage, ohne await; Konto löschen löscht mit.
  - `StammtischStore.js`: Gruppen-Tische `ST…`, per Code abgeschottet (auch
    im Public-Mode aktiv). Codes nie in die Partien-Historie (per Name
    abrufbar), dort nur ein Flag. `Emotes.js`: EINZIGE Emote-Whitelist (Vertragstest).
  - `BotQuips.js`: EINZIGE Liste der Bot-Spruch-Anlässe; nur die ID geht über
    die Leitung, Texte DE/EN im Client (Vertragstest).
  - Tages-Challenge: EIN Versuch pro Name und Tag, begonnen = verbraucht
    (`ChallengeStore.beginAttempt`, atomar per Primärschlüssel in Postgres —
    vor dem Spielstart awaiten), keine Revanche; Bots immer Heuristik-Mittel.
  - `Passkeys.js`: WebAuthn; aus ohne Library oder https-`PIKDAME_BASE_URL`.
    RP-ID = deren Hostname (Domainwechsel killt alle Passkeys; Rückweg:
    Anmelde-Link). `user.name` = E-Mail, `displayName` = Spielername (sonst
    fehlt die Adresse im Passwort-Manager); Signal API zieht alte nach.
    Registrierung E-Mail-zuerst: Mail mit 6-stelligem Code (15 min,
    5 Versuche, SHA-256) + Link, beides bestätigt UND meldet an, danach
    Passkey ODER Passwort. Konten dürfen passwortlos sein (`salt = ''`), der
    letzte Anmeldeweg ist nie löschbar.
- `public/` — Vanilla-JS-Client, `i18n.js`, PWA. Studio-Vorspann ab dem
  ersten Bild per CSS sichtbar, Kopf-Skript entscheidet, CSS-Notbremse nach 9 s.
  Tischlicht nach Tageszeit: `table-light.js` schreibt nur `--tod-*`, Farben im
  CSS-Abschnitt TABLE LIGHT aus dem Filz des Themes; Mittag = Bestand, kein Text
  unter seinen Mittags-Tiefstwert (`test/table-light-css.test.js`).
- `landing/` (pikdame.online), `terraform/` (Hetzner), `docker/`, `k8s/`.
- `mcp/` — MCP-Server: LLM sitzt als normaler WS-Spieler am Tisch (eigenes
  Paket mit MCP-SDK, nicht im Image). Legale Züge prüft ein Schatten-
  `GameManager` aus der Sitz-Sicht (`LegalActions.js`) — kein Regel-Zweitcode.

### Bot-KI
- Heuristik (`Bot.js`): Kartenzählung (Schwer/Zen), Damen-Disziplin (nur easy
  wirft ♠Q sorglos), Zieh-Guards, Zähl-Endspiel, Joker-Tausch nie mit letzter Karte.
- **Regel geändert → Bot-Annahmen prüfen** (auch Kommentare): ein Abwurf-Filter
  für die alte Aufnahme-Regel kostete ~20 Pp Siegquote, bis 2.61 unentdeckt.
- Untersucht, NICHT produktiv (getestete Infrastruktur per Flag):
  `MonteCarlo.js` (Null-Effekt), `Rollout.js` (~+2 Pkt/0,8σ, nicht signifikant).
- **ONNX-Netz ist im Image Standard** (`PIKDAME_ONNX=1`, `=0` = Heuristik);
  `onnxruntime-node` nur im Dockerfile, ohne Runtime → Heuristik; jeder Fehler
  fällt auf die Heuristik zurück.
  - `StateEncoder.js`: EINZIGE Kodierung (377 Obs, 54 Aktionen) für Training
    UND Laufzeit — einseitige Änderung macht `.onnx` inkompatibel.
  - **Leiter:** Leicht < Mittel < Schwer (Heuristik) < Zen (Netz; ohne Netz =
    Schwer). Jede Stufe muss die darunter signifikant schlagen:
    `node scripts/sim-bots.js --ladder` mit aktivem ONNX (Prod-Standard);
    `onnxruntime-node` dafür außerhalb des Repos installieren
    (`--ignore-scripts`, `NODE_PATH`), sonst schaltet Auto-Modus es in `npm test` ein.
    Neue Tische starten auf Mittel, die Challenge spielt Mittel.
  - `OnnxPolicy.js` lädt nur `models/pikdame-zen.onnx`. Training in `python/`
    (MaskablePPO), Bridge `scripts/rl-env-server.js`, Doku
    `docs/developer/rl-setup.md`. Modelle werden committet, `.zip` nicht.
  - Steuer-Seams `cp.forcedDrawSource`, `cp.externalDiscard`, `_noMcts`:
    wählen nur LEGALE Aktionen, wirken nur in `runBotTurn`, nie per
    Client-Nachricht oder Snapshot setzbar (`_sanitizeControlFields`,
    `serialize` strippt sie; Tests decken beide Wege ab).

## Spielregeln-Essenz (engine-verifiziert)

110 Karten (2 Decks + 6 Joker), 15 Handkarten, 2–4 Spieler, Bots füllen auf.
Eigene Auslagen pro Spieler (Anlegen/Joker-Tausch nur dort). Folgen im Ring
(K-A-2), max 13. Zwei-Phasen-Ablage (oberste Karte sofort legen, dann Rest).
Zweiter Satz gleichen Werts wird in den eigenen gemergt (Joker → freie Farbe);
>8 Karten → liegt separat, nie ein Fehler (sonst Deadlock).
**Ausmachen nur per Abwurf der letzten Karte** (verdeckt, nicht aufnehmbar;
auch kein Joker-Tausch mit der letzten Handkarte — `swapJoker` verweigert ihn). Getauschter Joker zählt +20
in der Auslage. „Hand aus“ verdoppelt NUR mit Hausregel `handAusDoubles`
(Standard aus; Anzeige/Protokoll dürfen sonst keine Verdopplung behaupten).
**Leerer Ziehstapel: nichts nachlegen, Ablage nie mischen** — wer die oberste
Ablagekarte nicht nehmen kann, beendet die Runde (kein Sieger-Bonus).
160 Züge ohne Auslage → Unentschieden. **Ablagekarte nicht nehmbar, wenn das
Pflicht-Legen die Hand restlos verbraucht** (Ausnahmen: Reststapel folgt,
Kombination verschont eine Karte); Anlegbarkeit berechtigt nie zur Aufnahme
(`canUseDiscardTop`). Bots werfen nie
Joker ab (außer als letzte Karte). Punkte: 2–9=5, 10/B/D/K=10, Ass/Joker=20,
♠Q=100. Ende ab 1000 (Hausregel „streng“: >1000). `gameOverInfo` trägt
`totalTurns`/`totalRounds` (aus `gameTurnCount`).

**Bot-Messdisziplin:** Winrate nie aus einem kleinen Lauf; `node
scripts/sim-bots.js` mit Mittel ± Standardfehler über viele Batches. Null-/
Negativ-Effekt → nicht ausliefern, als „investigated, not shipped“ notieren.

## Workflow

1. Branch von **aktuellem `origin/main`** → bauen → `npm test` (== CI).
   Ablauf Schritt für Schritt: Skill `steward`; Browser-Check, Layout-Audit
   und PR-Screenshots: Skill `ui-shots` (eigener Temp-Datenordner);
   Design-Review nach unseren Regeln: Skill `ui-review`.
   **Sub-Agenten:** Konzept, Design-Review, Auftrags-Prompt und jede
   Design-Arbeit (sichtbare UI, auch die Umsetzung) mit Opus auf maximalem
   Aufwand; reine Umsetzung ohne Design auf mittlerem (kleine, abgegrenzte
   Aufträge: Sonnet mittel; Kosten).
2. **Changelog-Fragment, wenn sich das Spiel ändert** (`public/`, `server.js`,
   `game/`, `models/`, `docker/`, Abhängigkeiten im Image): neue Datei
   `changes/<thema>.md`, Format in `changes/README.md`. Version und
   `CHANGELOG.md` schreibt NUR der Release-PR (`release/next`, automatisch);
   CI `changelog-fragment` prüft beides. Nur Doku, Skills, Tests oder CI:
   kein Fragment. Hat sich main bewegt: erst mergen, dann pushen.
3. Push → PR → CI → Squash-Merge (macht der Nutzer) → Branch löschen.
   Release-PR, Tag, Release und GHCR-Image erzeugen die Workflows — nichts
   manuell. Abhängige Arbeit als Stack (Basis = Branch des Vorgängers),
   unabhängige PRs nie stapeln. Vor dem Merge muss der Branch auf main-Stand
   sein: ohne Konflikt per „Update branch“ (`update_pull_request_branch`).
4. **Branch-Hygiene:**
   - Vor jedem Push `gh pr view <nr> --json state`: Ist der PR schon gemergt,
     kommt der Folge-Commit auf einen NEUEN Branch von main.
   - `git log --oneline origin/main..HEAD` muss genau die eigene Arbeit zeigen.
   - Push-Ausgabe nie filtern, nie `||`-Ketten; danach prüfen:
     `git ls-remote origin <branch>` == `git rev-parse HEAD`.
   - **Nur eigene Dateien stagen, nie `git add -A`:** Trainingsläufe des
     Nutzers schreiben in `data/`, `models/`, `python/`.
   - Commits/cherry-picks/Merges immer mit `-c user.email=… -c user.name=…`
     (ein konfliktfreier `git merge` committet sofort).
5. Vor Commits `rm -f data/*.json data/crash.log`. Secrets nie
   ins Repo (nur `*.example`; `npm run secrets:check`, CI `secret-scan`).
   Gepushtes Secret zuerst ROTIEREN, dann entfernen.
6. PR-Screenshots nur, wenn die Änderung sichtbar ist (Branch `pr-screenshots`).
7. WS-Nachrichten VOR dem Session-Beitritt (Profile, Rätsel, Stammtisch)
   stehen vor der Session-Sperre und tragen `msg.name`. Stammtisch-Codes löst
   `joinSession` auf; Platz-Rückgabe per Name nur für GETRENNTE Sitze.
8. **Dependabot** (montags): `dependabot-auto.yml` legt `changes/deps-<nr>.md`
   an und mergt Minor/Patch automatisch; **Majors nie automatisch**. Läuft über
   ein GitHub-App-Token (`DEPS_BOT_APP_ID`/`DEPS_BOT_PRIVATE_KEY` im
   **Dependabot**-Speicher; `release-pr.yml` braucht sie zusätzlich als
   Actions-Secrets), weil `GITHUB_TOKEN`-Pushes keine CI/Release auslösen.
   main braucht Pflicht-Checks, keine Pflicht-Reviews. npm ist gruppiert, weil
   `dependency-check` bei jedem veralteten Paket rot wird.
9. **Compose:** alle drei Dateien in `docker/` (yml, ghcr.yml, prod.yml)
   synchron; OWASP-Härtung (cap_drop ALL, read_only, AppArmor, pids_limit)
   ist Pflicht (`docker-smoke` fährt sie hoch). Neue Schreibpfade nur nach
   `data/` oder `/tmp`.

## Tests

- **`npm test` ist parallelisierbar** (mehrere Worktrees gleichzeitig, kein Lock nötig): Test-Server nur über `freePort()` aus `test/helpers/free-port.js` (nie feste Ports) und `mkdtempSync`-Verzeichnisse; `--test-timeout=120000` lässt Hänger schnell scheitern.
- **Eigene Server nie auf `data/`:** immer `PIKDAME_DATA_DIR=<temp>` (Skill
  `ui-shots` macht das). Nach Gebrauch stoppen und
  auf das Ende warten (SIGTERM schreibt noch den Snapshot); vor `npm test`
  `pgrep -af "node server.js"`. Unbekannte Stammtisch-/Spiel-Codes zählen als
  Fehlversuch und sperren nach einigen die IP (sieht aus wie Drosseln) →
  Mocks beantworten `getStammtisch` selbst; gesperrt = Server neu starten.
- **Server-Log in Tests:** stdout kommt nach der HTTP-Antwort an. Trefferzahl
  vor der Anfrage merken, auf eine NEUE Zeile warten (`lastFromLog(re, after)`).
- **Sim-/Seed-Skripte: Logging aus** (`PIKDAME_LOG_GAMES=0` im Skript selbst),
  sonst füllt `data/human-moves.jsonl` die Platte (ein Seed-Lauf: 22 GB).
  Einzelne Testdateien nur mit `node --test --require ./test/helpers/setup.js`
  (wie `npm test`), sonst schreiben sie ebenfalls nach `data/`.
  Wer Züge selbst treibt, schaltet den Bot-Timer ab (`g.maybeRunBotTurn = () => {}`):
  er spielt sonst bei langsamer Netz-Antwort (> ~1 s) einen Zug mit (Beweise divergierten).
- Engine: E2E-Botspiele über alle 4 Stufen (Deadlocks, kein Joker-Abwurf,
  kein Doppel-Satz).
- **Kartenerhaltung** (`test/card-conservation.test.js`): nach JEDEM Zug exakt
  das 110-Karten-Deck. Planungs-/Suchfunktionen arbeiten auf Kopien (eine
  Bot-Planung schrieb einmal in echte Auslagen → doppelte Pik Damen).
- Client-Heuristiken gegen die Server-Wahrheit fuzzen: keine falschen Positiven.
  Ein Bot-Zug kommt als EIN State (Broadcast pro Tick gebündelt): Diffs zweier
  States aus Orten ableiten, nie aus Zählern (Pik-Dame-Momente, Engine-Fuzz).
- Snapshot-Änderungen: Roundtrip `JSON.stringify/parse` + Restore.
- `.canScroll*`-Klassen: wer sie gestaltet, setzt sie auch (Vertragstest;
  am iPhone die einzige Scroll-Andeutung).
- **Postgres in Tests:** `PIKDAME_TEST_PG_URL` ist Pflicht; jeder Server und
  Store bekommt `testDatabaseUrl()` (`test/helpers/test-db.js`, eigenes Schema).
  Lokale Datenbank aufsetzen: Skill `steward`.
- RL: `OBS_SIZE`/`ACTION_SIZE` sind Verträge — `test/state-encoder.test.js`
  UND `scripts/rl-env-server.js` prüfen.
- **UI im Browser prüfen**, nicht nur `npm test`: alle drei Layouts. Headless
  Chromium mit normalem User-Agent (sonst Crawler-Erkennung, kein WebSocket).
  Passkeys mit dem virtuellen CDP-Authenticator. jsdom lädt kein
  `style.css`: CSS nie per `getComputedStyle` testen, sondern per
  Quelltext-Vertrag und `ui-shots --measure` (Flächen vorher/nachher).

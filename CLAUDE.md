# CLAUDE.md — Projektkontext für KI-Assistenten

Pik Dame: Online-Multiplayer-Kartenspiel (Familien-Rommé). Regeln für JEDE Änderung.
Diese Datei kurz halten: Regeln + knappes Warum; Hintergrund gehört in docs/.

## Sprache

- **Englisch:** Code, Kommentare, Bezeichner, Commits, Workflows, Infra, Tests,
  Repo-Doku (README, docs/; k8s/ und landing/ READMEs bei nächster Berührung).
  Deutsche Bestandskommentare beim Berühren migrieren.
- **Deutsch:** alle nutzersichtbaren Texte (Quellsprache, über i18n).
  CHANGELOG: Überschriften englisch (Added/Changed/Fixed/Removed), Inhalt deutsch.
- **Kommentare 1–2 Zeilen**, nur Warum/Falle/Vertrag; Erklärungen in docs/,
  Commit oder PR. Lange Bestandskommentare sind kein Vorbild.

## Harte Constraints

- **Mehrdeutiger Wunsch → ERST FRAGEN:** 2–4 nummerierte Optionen statt die
  wahrscheinlichste Lesart bauen. Ausnahme: eindeutiger Bug mit Beweis.
  Bei Sicherheits-/Login-Flows die übliche Praxis großer Anbieter als
  empfohlene Option nennen.
0. **Betrieb = gehosteter Docker-Stack** (play.pikdame.online); UX und
   Architektur richten sich nach Online-Mehrspieler.
1. **Externe Pakete nur, wenn wirklich sinnvoll und nötig — nie ohne Okay.**
   Sinnvoll: Eigenbau sicherheitskritisch/fehleranfällig (Krypto, Parser,
   Diagramme) oder deutlich mehr Code; Paket etabliert, gepflegt, MIT/BSD/
   Apache, reines JS. Vorher prüfen: Lizenzen des Baums, Größe, Trivy,
   `require`. Aktuell: `ws`, `pg` und `@simplewebauthn/server` (beide LAZY).
   Browser-Libs werden VENDORT (`public/vendor-*.js`, unverändert, npm-Hash im
   Kopf): qrcode, uPlot, @simplewebauthn/browser. Keine nativen Module (außer
   `onnxruntime-node` NUR im Dockerfile), kein Build-Schritt. Features mit
   neueren Node-Features (z. B. `node:sqlite`, Node ≥ 22) schalten sich auf
   alten Versionen selbst ab (Factory → `null`, Client blendet aus).
2. **Kein CDN, keine fremden Hosts im Ladepfad.** Icons = Inline-SVG-Sprite
   (`<svg class="icon"><use href="#i-name"/></svg>`), keine Icon-Fonts.
   **Emoji sind keine Icons** (nur als Inhalt: Bot-Avatare, Reaktionen,
   Abzeichen). Text neben Icon in eigenes `<span>` — `applyStaticLang()`
   überschreibt `textContent` von Blatt-Elementen.
2b. **Mobile zuerst** (iPhone 393×852). Jede UI-Änderung prüfen in: hoch,
   **quer** (874×402, nur ~400 px Höhe!) und Desktop. Der letzte
   `@media (orientation: landscape) and (max-height: 540px)`-Block steht am
   ENDE von `style.css` (Vertragstest). Tisch-Layouts: Hochformat (Flex,
   Stapel über Hand), Querformat ≤540 px und Desktop ≥1100 px (Grid, Stapel
   in Seitenspalte). `--accent` (Auswahl) und `--drawn` in jedem Theme
   unterscheidbar; Spielerfarben nur aus `PLAYER_COLORS` (CVD-geprüft, ≠
   `--accent`). Startbildschirm: eine Spalte `--lobby-w`, passt am iPhone
   OHNE Scrollen — Messlatte für neue Elemente. Tap-Ziele ≥ `--tap-min`
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
  (easy/medium/hard/zen), JSON-Stores (atomar), `AccountStore.js` (SQLite) /
  `PgAccountStore.js` (Postgres, Prod) — **jede Konto-Änderung in beiden**.
  - `Mailer.js`: eigener SMTP-Client, Log-Fallback; Header RFC 2047, Body
    Quoted-Printable — nie rohes UTF-8 in Kopfzeilen.
  - `Badges.js` (Familien in `BADGE_FAMILIES`, Fakten aus `finishRound`),
    `Progression.js` (XP, Tagesaufgaben, Serie mit Joker-Tag; XP-Regeln
    spiegelt `XP_RULES` im Client, Vertragstest). UI: Stufe + Serie am
    Identitäts-Chip/Fortschritts-Blatt; Tägliches (Rätsel, Challenge,
    Aufgaben) mit Status im Bereich „Heute“.
  - `GameDay.js`: EINZIGE Definition von „heute“ (Mitternacht Europe/Berlin,
    Rechnen nur auf Datums-Strings, nie 24-h-Schritte).
  - `DailyPuzzle.js`: Ergebnisobjekt ohne `type`-Feld (wird in WS gespreadet).
  - `StammtischStore.js`: Gruppen-Tische `ST…`, per Code abgeschottet (auch
    im Public-Mode aktiv). Codes nie in die Partien-Historie (per Name
    abrufbar), dort nur ein Flag. `Emotes.js`: EINZIGE Emote-Whitelist (Vertragstest).
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
- `landing/` (pikdame.online), `terraform/` (Hetzner), `docker/`, `k8s/`.

### Bot-KI
- Heuristik (`Bot.js`): Kartenzählung, Damen-Disziplin (nur easy wirft ♠Q
  sorglos), Zieh-Guards, Zen-Endspiel, Joker-Tausch nie mit letzter Karte.
- Untersucht, NICHT produktiv (getestete Infrastruktur per Flag):
  `MonteCarlo.js` (Null-Effekt), `Rollout.js` (~+2 Pkt/0,8σ, nicht signifikant).
- **ONNX-Netz ist im Image Standard** (`PIKDAME_ONNX=1`, `=0` = Heuristik);
  `onnxruntime-node` nur im Dockerfile, ohne Runtime → Heuristik; jeder Fehler
  fällt auf die Heuristik zurück.
  - `StateEncoder.js`: EINZIGE Kodierung (377 Obs, 54 Aktionen) für Training
    UND Laufzeit — einseitige Änderung macht `.onnx` inkompatibel.
  - `OnnxPolicy.js` lädt `models/pikdame-<stufe>.onnx`. Training in `python/`
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
Anlegen an eigene Auslage, Kombination verschont eine Karte). Bots werfen nie
Joker ab (außer als letzte Karte). Punkte: 2–9=5, 10/B/D/K=10, Ass/Joker=20,
♠Q=100. Ende ab 1000 (Hausregel „streng“: >1000). `gameOverInfo` trägt
`totalTurns`/`totalRounds` (aus `gameTurnCount`).

**Bot-Messdisziplin:** Winrate nie aus einem kleinen Lauf; `node
scripts/sim-bots.js` mit Mittel ± Standardfehler über viele Batches. Null-/
Negativ-Effekt → nicht ausliefern, als „investigated, not shipped“ notieren.

## Workflow

1. Branch von **aktuellem `origin/main`** → bauen → `npm test` (== CI).
2. **SemVer-Bump + CHANGELOG-Abschnitt.** Version direkt vor dem Push aus
   `origin/main:package.json` ableiten (nach `git fetch`); offene PRs mit
   belegten Nummern beachten. Hat sich main bewegt: erst mergen, dann pushen.
3. Push → PR → CI → Squash-Merge (macht der Nutzer) → Branch löschen.
   Tag, Release und GHCR-Image erzeugt der Release-Workflow — nichts manuell.
4. **Branch-Hygiene:**
   - Vor jedem Push `gh pr view <nr> --json state`: Ist der PR schon gemergt,
     kommt der Folge-Commit auf einen NEUEN Branch von main.
   - `git log --oneline origin/main..HEAD` muss genau die eigene Arbeit zeigen.
   - Push-Ausgabe nie filtern, nie `||`-Ketten; danach prüfen:
     `git ls-remote origin <branch>` == `git rev-parse HEAD`.
   - **Nur eigene Dateien stagen, nie `git add -A`:** Trainingsläufe des
     Nutzers schreiben in `data/`, `models/`, `python/`.
   - Commits/cherry-picks immer mit `-c user.email=… -c user.name=…`.
5. Vor Commits `rm -f data/*.json data/crash.log data/users.db`. Secrets nie
   ins Repo (nur `*.example`; `npm run secrets:check`, CI `secret-scan`).
   Gepushtes Secret zuerst ROTIEREN, dann entfernen.
6. PR-Screenshots nur, wenn die Änderung sichtbar ist (Branch `pr-screenshots`).
7. WS-Nachrichten VOR dem Session-Beitritt (Profile, Rätsel, Stammtisch)
   stehen vor der Session-Sperre und tragen `msg.name`. Stammtisch-Codes löst
   `joinSession` auf; Platz-Rückgabe per Name nur für GETRENNTE Sitze.
8. **Dependabot** (montags): `dependabot-auto.yml` hängt Bump + CHANGELOG an
   und mergt Minor/Patch automatisch; **Majors nie automatisch**. Läuft über
   ein GitHub-App-Token (`DEPS_BOT_APP_ID`/`DEPS_BOT_PRIVATE_KEY` im
   **Dependabot**-Speicher, nicht bei den Actions-Secrets), weil
   `GITHUB_TOKEN`-Pushes keine CI/Release auslösen. main braucht
   Pflicht-Checks, keine Pflicht-Reviews. npm ist gruppiert, weil
   `dependency-check` bei jedem veralteten Paket rot wird.
9. **Compose:** alle drei Dateien in `docker/` (yml, ghcr.yml, prod.yml)
   synchron; OWASP-Härtung (cap_drop ALL, read_only, AppArmor, pids_limit)
   ist Pflicht (`docker-smoke` fährt sie hoch). Neue Schreibpfade nur nach
   `data/` oder `/tmp`.

## Tests

- Engine: E2E-Botspiele über alle 4 Stufen (Deadlocks, kein Joker-Abwurf,
  kein Doppel-Satz).
- **Kartenerhaltung** (`test/card-conservation.test.js`): nach JEDEM Zug exakt
  das 110-Karten-Deck. Planungs-/Suchfunktionen arbeiten auf Kopien (eine
  Bot-Planung schrieb einmal in echte Auslagen → doppelte Pik Damen).
- Client-Heuristiken gegen die Server-Wahrheit fuzzen: keine falschen Positiven.
- Snapshot-Änderungen: Roundtrip `JSON.stringify/parse` + Restore.
- `.canScroll*`-Klassen: wer sie gestaltet, setzt sie auch (Vertragstest;
  am iPhone die einzige Scroll-Andeutung).
- Konten: Tests laufen gegen SQLite UND Postgres (`PIKDAME_TEST_PG_URL`).
- RL: `OBS_SIZE`/`ACTION_SIZE` sind Verträge — `test/state-encoder.test.js`
  UND `scripts/rl-env-server.js` prüfen.
- **UI im Browser prüfen**, nicht nur `npm test`: alle drei Layouts. Headless
  Chromium mit normalem User-Agent (sonst Crawler-Erkennung, kein WebSocket).
  Passkeys mit dem virtuellen CDP-Authenticator.

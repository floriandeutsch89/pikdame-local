# CLAUDE.md — Projektkontext für KI-Assistenten

Pik Dame: Offline-/Online-Multiplayer-Kartenspiel (Familien-Rommé-Variante).
Diese Datei fasst die Regeln zusammen, die bei JEDER Änderung gelten.

## Sprachregel (verbindlich)

- **Code, Kommentare, Bezeichner, Commit-Messages der Struktur, GitHub-Workflows,
  Infra-Dateien (Dockerfile/Compose) und Testbeschreibungen: ENGLISCH.**
- **Repo-Dokumentation (README, docs/) ebenfalls ENGLISCH** — README.md,
  Ops-Doku (jetzt docs/admin/operations.md auf RTD) und SECURITY.md sind migriert; k8s/README.md und
  landing/README.md folgen bei der nächsten Berührung.
- **Nutzersichtbare Texte: DEUTSCH** als Quellsprache über das i18n-System
  (I18N_STATIC / L(de, en) / I18N_SERVER_PATTERNS) — niemals "übersetzen",
  sie sind das Produkt. CHANGELOG-Überschriften englisch (Added/Changed/Fixed),
  Inhalte deutsch.
- Bestandskommentare werden bei jeder Berührung einer Datei auf Englisch
  migriert (Boy-Scout-Regel); neue Dateien entstehen ausschließlich englisch.

## Harte Constraints (nie brechen)

- **Bei mehrdeutigen Feature-Wünschen: ERST FRAGEN, dann bauen.** Wenn ein
  Wunsch mehrere plausible Lesarten hat (z. B. "Auslage sortieren" - eigene
  Kästen? Karten im Satz? nur Anzeige?; "Ready-Check" - Rundenwechsel oder
  Spielstart?), wird NICHT die wahrscheinlichste Interpretation implementiert,
  sondern dem Nutzer werden 2-4 konkrete, nummerierte Optionen zur Auswahl
  gestellt. Raten kostet Releases und Vertrauen; eine Rückfrage kostet eine
  Nachricht. Ausnahme: eindeutige Bug-Reports mit Beweis (Screenshot/Log).
  (Vereinbart am 2026-07-05 nach zwei Fehlgriffen in einer Antwort.)

0. **Betriebsmodus ist der gehostete Docker-Stack** (play.pikdame.online).
   UX- und Architekturentscheidungen richten sich nach dem
   Online-Mehrspieler-Betrieb.
1. **Schlanke Laufzeit:** **keine neuen npm-Dependencies ohne explizites Okay**
   (aktuell: `ws` + `pg` — pg ist pure JS, wird LAZY geladen und nur mit
   gesetzter `PIKDAME_DATABASE_URL` benutzt), keine nativen Module, kein
   Build-Schritt. Features, die mehr brauchen
   (z. B. Konten via `node:sqlite`, Node ≥ 22; Docker/CI laufen auf Node 26), müssen sich auf älteren
   Node-Versionen **selbst deaktivieren** (Factory liefert `null`, Client
   blendet UI aus) — ältere Umgebungen laufen dadurch unverändert weiter.
2. **Frontend ohne CDN:** Alles wird lokal ausgeliefert - keine fremden
   Hosts im Ladepfad (Datenschutz, Ladezeit, keine Ausfaelle Dritter).
   Fremd-Bibliotheken vendoren (`public/vendor-*.js`).
   **Icons sind Inline-SVG** (`<svg class="iconSprite">`-Sprite oben in
   `index.html`, Nutzung `<svg class="icon"><use href="#i-name"/></svg>`) —
   keine Icon-Fonts, keine Downloads. **Emoji sind KEINE Icons:** sie bleiben
   nur, wo sie Inhalt sind (Bot-Avatare, Reaktions-Leiste, Abzeichen).
   Beschriftungen neben einem Icon gehören in ein eigenes `<span>` —
   `applyStaticLang()` inventarisiert nur BLATT-Elemente und schreibt
   `textContent`, was ein Geschwister-Icon sonst löscht.
2b. **Mobile zuerst:** Primärgerät ist das iPhone (393×852). Jede UI-Änderung
   wird in ALLEN Layouts geprüft: Telefon hoch, Telefon **quer** (z. B.
   874×402 - nur ~400 px Höhe!) UND Desktop. Das Querformat war bis v2.23.0
   kaum spielbar (Stapel unter der Hand, Auslagen 0 px), weil spätere
   Regeln den Querformat-Block aushebelten: Der letzte
   `@media (orientation: landscape) and (max-height: 540px)`-Block steht
   deshalb am ENDE von `style.css` (Vertragstest prüft das).
   Der Tisch hat drei Layouts: Hochformat (Flex-Spalte, Stapel über der
   Hand), Querformat bis 540 px Höhe und Desktop ab 1100 px Breite (beide
   CSS-Grid, Stapel in einer Seitenspalte neben den Auslagen).
   Auswahl (`--accent`) und „gerade gezogen“ (`--drawn`) brauchen
   unterscheidbare Farben - in jedem Theme.
   Der Startbildschirm ist EINE Spalte mit Breite `--lobby-w` (340 px, ab
   900 px Breite 400 px, nur in `#lobby` überschrieben); Modi sind eine
   Reihe Icon-Kacheln (`.menuChips`), die Tagesaufgaben ein `<details>`
   mit Zusammenfassung in der Kopfzeile - der ganze Startbildschirm passt
   am iPhone ohne Scrollen, das ist die Messlatte für neue Elemente dort.
   Tap-Ziele mindestens `--tap-min` (44 px, Apple-HIG). Schriftgrößen und
   Knopfmaße kommen aus der Skala in `:root` (`--fs-*`, `--ctl-h`) — nie
   neue rohe `rem`-Werte pro Kontext erfinden, genau daraus entstanden
   ungleich hohe Knöpfe in derselben Reihe.
3. **Zweisprachigkeit:** Deutsch ist Quellsprache. Jeder neue sichtbare Text
   braucht einen Eintrag: statisches HTML → `I18N_STATIC`, dynamisches JS →
   `L(de, en)`, **Server-Texte (Log/Fehler) → `I18N_SERVER_PATTERNS`**
   (Regex-Muster). Vertragstests prüfen die Abdeckung.
4. **Sessions überleben Neustarts:** `GameManager.serialize()/deserialize()`.
   Transiente Felder (Timer, Sets, Hooks) gehören in die Skip-Liste von
   `serialize()` UND werden in `deserialize()` frisch initialisiert
   (JSON macht aus `Set` sonst `{}` → Crash-Klasse `.add is not a function`).
   Der Snapshot wird jede Minute geschrieben (nur bei Änderung) und beim
   SIGTERM; älter als 30 min wird er beim Start verworfen.
   **Timer im `GameManager` immer `unref()`en** - der HTTP-Server hält den
   Prozess ohnehin am Leben; ohne `unref` hing jede Testdatei mit getrenntem
   Spieler 75 s auf der Übernahme-Frist (Suite 77 s statt ~18 s).
5. **Exceptions töten nie den Prozess/Durchlauf:** Server-Message-Handler,
   Client-WS-Handler und die Account-API sind mit try/catch/`.catch`
   gepanzert; `localStorage` nur über `storageGet/Set/Remove`.

## Architektur

- `server.js` — HTTP (statisch + `/statusz`, `/healthz`, `/changelogz`,
  Konto-API `/api/*`, `/verify`) + WebSocket. Pro Session ein `GameManager`.
- `game/` — reine Spiellogik ohne I/O-Abhängigkeiten (testbar):
  `Rules.js` (Melds, Ring-Folgen K-A-2, max 13), `ScoreBoard.js` (Wertung,
  1000er-Schwelle), `GameManager.js` (Zustandsmaschine, Bots-Orchestrierung,
  Snapshot), `Bot.js` (4 Schwierigkeiten: easy/medium/hard/zen),
  `PlayerStore/GameHistoryStore/GlobalStatsStore` (atomare JSON-Dateien),
  `AccountStore.js`/`PgAccountStore.js` (Konten: PostgreSQL im Docker/K8s-Stack, SQLite-Fallback via `node:sqlite`), `Mailer.js` (dependency-freier
  SMTP-Client, Log-Fallback; Header nach RFC 2047, Body Quoted-Printable -
  nie rohes UTF-8 in Kopfzeilen), `Badges.js` (reine Funktion; Familien mit
  Stufen in `BADGE_FAMILIES`, Engine-Fakten wie `ringRuns`/`longestRun`/
  `bigPileTake` kommen aus `finishRound` in den `breakdown`),
  `Progression.js` (XP/Level, Tagesaufgaben, Tagesserie mit Joker-Tag),
  `DailyPuzzle.js` (Tagesrätsel: geseedete Hand, erschöpfende Suche, die
  Engine bewertet - Ergebnisobjekt darf KEIN `type`-Feld tragen, es wird in
  die WS-Nachricht gespreadet), `StammtischStore.js` (feste Gruppen-Tische:
  Code `ST…`, Bilanz, Best-of-3-Serie; per Code abgeschottet, deshalb auch
  im Public-Mode aktiv),
  `Emotes.js` (EINZIGE Emote-Whitelist + Level; Client-Leisten und
  `EMOTE_UNLOCK` spiegeln sie, Vertragstest prüft).
- `public/` — Vanilla-JS-Client (`client.js`), `i18n.js`, PWA. Enthält auch den
  Studio-Vorspann (`#studioSplash`): Er ist ab dem ERSTEN Bild per CSS sichtbar
  (sonst blitzt die Lobby auf, weil `client.js` am Seitenende lädt), ein
  Kopf-Skript entscheidet vorab über Anzeigen/Überspringen, und eine
  CSS-Notbremse blendet ihn nach 9 s aus, falls das Skript ausfällt.
- `landing/` — statische Auswahlseite für pikdame.online.
- `terraform/` — Hetzner-Cloud-Aufbau (Ubuntu LTS, Docker, Dockge, Cloud-
  Firewall, fail2ban, Schlüssel-only-SSH). README dort auf Englisch.

### Bot-KI (Heuristik + optionales gelerntes Netz)
- **Heuristik** (`Bot.js`, 4 Stufen easy/medium/hard/zen): Kartenzählung über
  alle öffentlichen Karten, Damen-Disziplin (nur easy wirft die ♠Q sorglos),
  Zieh-Guards (Usability-Lookahead, Damen-unter-Stapel, Wertverlust-Vergleich),
  Zen-Endspiel mit Erschöpfungs-/Punktestand-Gewichtung, Joker-Tausch (nie mit
  der letzten Handkarte).
- **Untersucht, NICHT produktiv** (jeweils getestete Infrastruktur, per Flag):
  `MonteCarlo.js` (Hidden-Hand-Sampling für den Abwurf – gemessen Null-Effekt);
  `Rollout.js` (determinisierte Rollout-Suche/ISMCTS – gemessen ~+2 Pkt/0,8σ,
  nicht signifikant, ~500 ms/Zug; nur via `mctsEnabled`-Seat-Flag im Sim).
- **Gelerntes Netz (ONNX), per `PIKDAME_ONNX=1` aktivierbar** — Standardpfad
  ohne Variable unverändert, Fallback bei jedem Fehler:
  - `StateEncoder.js` — EINZIGE Kodier-Stelle (377-dim Obs + 54 Aktionen: 52
    Abwurf-Typen + Ziehstapel + Ablage-nehmen; Maske phasenabhängig via
    `{phase, pileTakeLegal}`). **Speist Training UND Laufzeit → Parität ist
    Pflicht; einseitige Änderung macht bestehende `.onnx` inkompatibel.**
  - `OnnxPolicy.js` — `onnxruntime-node` (optionale Dep), lädt
    `models/pikdame-<stufe>.onnx`, wählt Zieh- UND Abwurf-Aktion per maskiertem
    Argmax. `GameManager._runBotTurnWithOnnx` awaited am Pause-Seam.
  - Training in `python/` (Gymnasium + sb3-contrib MaskablePPO → ONNX-Export),
    Bridge `scripts/rl-env-server.js` (stdio-JSON über die ECHTE Engine),
    Doku `docs/developer/rl-setup.md` (RTD; Ubuntu 24.04, uv, RTX-5080). Modelle werden
    committet (öffentliches Repo); SB3-`.zip` bleibt gitignored.
  - **Steuer-Seams:** `cp.forcedDrawSource` ('drawPile'|'discardPile', vor dem
    Zug gesetzt, überschreibt decideDraw+Guards, danach gelöscht),
    `cp.externalDiscard` ('pause' → `runBotTurn` hält vor dem freien Abwurf an,
    setzt `_agentAwaitingDiscard={botId,legalIds}`; oder Funktion), `_noMcts`
    (Rollout-Klone spielen reine Heuristik, verhindert Rekursion).
  - **Anti-Cheat:** Diese Felder wählen nur unter LEGALEN Aktionen (kein Zugriff
    auf verdeckte Karten) und wirken nur in `runBotTurn` (Bots). Client-
    Nachrichten können sie nicht setzen (spezifische Handler, kein Mass-Assign).
    `GameManager._sanitizeControlFields` entfernt sie bei `deserialize`, und
    `serialize` persistiert sie nie (Seat-Felder + `_agentAwaitingDiscard`/
    `_noMcts` gestrippt) — kein manipulierter Snapshot kann sie einschleusen.

## Spielregeln-Essenz (engine-verifiziert, siehe Regeln-Overlay)

110 Karten (2 Decks + 6 Joker), 15 Handkarten, 2–4 Spieler, Bots füllen auf.
Jeder Spieler hat **eigene** Auslagen (Anlegen/Joker-Tausch nur dort).
Folgen laufen im Ring (K-A-2), max 13. Zwei-Phasen-Ablagestapel (oberste
Karte sofort legen, dann Rest). Ein zweiter Satz gleichen Werts wird in den
bestehenden Satz des Spielers gemergt (Joker bekommen eine freie Farbe);
passt die Vereinigung nicht mehr (>8 Karten), liegt er separat - nie ein Fehler,
sonst Deadlock mit der Pflicht-Aufnahmekarte (v1.53.1).
**Ausmachen nur per Abwurf der letzten Karte** (verdeckt abgelegt, nicht
aufnehmbar; OHNE Ausnahme - auch kein Joker-Tausch mit der letzten Handkarte,
Tischentscheidung v2.32.0; `swapJoker` verweigert ihn, Bots planen ihn nicht).
Ein getauschter Joker bleibt als +20 in der Auslage-Wertung (plus die echte
Karte). „Hand aus“ = Gewinner hatte vor seinem letzten Zug nichts ausgelegt
(verdoppelt NUR bei aktiver Hausregel `handAusDoubles`, Standard aus - Anzeige
und Protokoll dürfen ohne die Regel keine Verdopplung behaupten).
**Leerer Ziehstapel: es wird NICHTS nachgelegt, die Ablage wird NIE neu
gemischt** - wer die oberste Ablagekarte nicht nehmen kann, beendet die Runde
(normale Wertung, kein Sieger-Bonus). 160 Züge ohne Auslage → Unentschieden.
**Die Ablagekarte darf nicht genommen werden, wenn das Pflicht-Legen die Hand
restlos verbrauchen würde** (v1.85.2, Tischentscheidung: die Abwurfpflicht
gilt ausnahmslos) - erlaubt bleibt sie, wenn ein Reststapel folgt, die Karte
an eine eigene Auslage passt oder eine Kombination eine Handkarte verschont.
Bots werfen NIE Joker ab (außer als Sieges-Abwurf der letzten Karte). Punkte:
2–9=5, 10/B/D/K=10, Ass/Joker=20, Pik Dame=100. Spielende ab 1000 (Hausregel
„streng“: >1000). `gameTurnCount` zählt alle Züge der Partie; `gameOverInfo`
trägt `totalTurns`/`totalRounds` (Anzeige im Endbildschirm).

### Messdisziplin für Bot-Änderungen (hart gelernt)
Winrate-Behauptungen NIE aus einem einzelnen kleinen Lauf ableiten: `node
scripts/sim-bots.js` (Batches), für Experimente `--mc`/`--mcts` mit Mittel ±
Standardfehler über viele Batches. Ein erster +8,5 Pkt/2,8σ-Wert entpuppte sich
bei größerer Stichprobe als Varianz (real ~+2/0,8σ). Features mit Null-/
Negativ-Effekt werden NICHT ausgeliefert, sondern als „investigated, not
shipped“ im Changelog dokumentiert und als getestete Infrastruktur behalten.

## Workflow

**Branch-Hygiene (Lehre aus dem v1.22.0-Vorfall):** Vor jedem PR mit
`git log --oneline origin/main..HEAD` prüfen, dass der Branch WIRKLICH die
eigene Arbeit trägt. Niemals Push-Befehle mit `||`-Fallback-Ketten
verketten - so wurde einmal ein alter lokaler Branch als vermeintlicher
Feature-Branch gepusht und ein inhaltsleerer PR gemerged. Nach jedem Merge
lokale Feature-Branches löschen; cherry-pick/commit brauchen IMMER die
`-c user.email/-c user.name`-Identität, sonst bleibt der Stand halb
angewendet liegen. (pro Änderung)

1. Feature-Branch → Implementieren → `npm test` (== CI: `node --test test/*.test.js`).
2. **SemVer-Bump in `package.json`** + **CHANGELOG.md-Abschnitt**
   (Keep a Changelog, Kategorien **Added/Changed/Fixed/Removed**, Inhalte deutsch).
3. Push → PR → CI abwarten → Squash-Merge → Branch löschen → main pullen.
   **Tag, GitHub-Release (Notes aus dem CHANGELOG-Abschnitt) und das
   GHCR-Image erzeugt der Release-Workflow automatisch beim Push auf main** —
   nach dem Merge nur verifizieren, nichts manuell taggen.
4. Vor Commits: `rm -f data/*.json data/crash.log data/users.db`.
   Secrets nie ins Repo (nur `*.example`); `npm run secrets:check` und der
   CI-Job `secret-scan` (Dateinamen + gitleaks über die volle History)
   schlagen sonst an. Ein gepushtes Secret zuerst ROTIEREN, dann entfernen.
5. Neue Server-Texte ⇒ i18n-Pattern. Neue UI-Elemente ⇒ Vertragstests laufen mit.
   Nachrichten VOR dem Session-Beitritt (Profile, Rätsel, Stammtisch-Info)
   stehen im Handler vor der Session-Sperre und tragen `msg.name`; ein
   Stammtisch-Code wird bei `joinSession` automatisch aufgelöst (Live-Tisch
   oder neuer Tisch), Platz-Rückgabe dort per Name statt Sitz-Token - nur
   für GETRENNTE Sitze.
6. **Abhängigkeiten hebt Dependabot an** (`.github/dependabot.yml`,
   montags 03:00 UTC): npm (gruppiert), Docker-Basis-Images, Compose-Images,
   GitHub-Actions. `dependabot-auto.yml` hängt den SemVer-Bump plus die
   deutsche CHANGELOG-Zeile an den PR (ohne sie erzeugt der Release-Workflow
   nichts, weil der Tag schon existiert) und setzt **Auto-Merge für
   Minor/Patch**. **MAJOR-Updates (neues Node-Basis-Image, Postgres-Major)
   mergen NIE automatisch** - sie bekommen Label + Reviewer. Handelt über ein
   **GitHub-App-Token** (`DEPS_BOT_APP_ID`/`DEPS_BOT_PRIVATE_KEY`), weil
   Pushes/Merges mit `GITHUB_TOKEN` weder CI noch den Release-Workflow
   auslösen - der Bump-Commit bliebe ungetestet und der Merge ohne Tag/Image.
   Beide Secrets gehören in den **Dependabot**-Speicher, nicht zu den
   Actions-Secrets: die sind in Dependabot-Läufen unsichtbar. App-Token laufen
   nicht ab (der frühere `WORKFLOW_PAT` musste von Hand erneuert werden).
   Der Auto-Merge selbst ist GitHubs eigener: main braucht dafür Pflicht-Checks
   (ohne die würde GitHub SOFORT mergen), aber KEINE Pflicht-Reviews.
   Der CI-Job `dependency-check` wird rot, sobald ein Paket veraltet ist -
   deshalb ist npm gruppiert: einzelne PRs blieben sonst gegenseitig rot.
7. Compose-Änderungen IMMER in allen drei Dateien unter `docker/` (yml, ghcr.yml, prod.yml)
   synchron; die OWASP-Härtung (cap_drop ALL, read_only, AppArmor, pids_limit)
   ist Pflicht und wird vom CI-Job `docker-smoke` real hochgefahren — neue
   Schreibpfade des Servers gehören ins `data/`-Volume oder nach `/tmp` (tmpfs).

## Test-Gewohnheiten des Projekts

- Engine-Änderungen: E2E-Botspiele über alle 4 Schwierigkeiten laufen lassen
  (Deadlocks, Log-Invarianten wie „kein Joker-Abwurf“, Doppel-Satz-Verbot).
- Client-Heuristiken (z. B. Anlege-Hinweise): gegen die Server-Wahrheit fuzzen
  — falsche Positive sind verboten, falsche Negative ok.
- Snapshot-Änderungen: Roundtrip durch `JSON.stringify/parse` + Restore testen.
- **Scroll-Kanten sind Verträge:** Wer eine `.canScroll*`-Klasse gestaltet,
  muss sie auch setzen (und umgekehrt) — `test/client-contract.test.js` prüft
  beides. Hintergrund: In v1.70.0 wurde `updateHandScrollEdges` gelöscht, die
  Aufrufstelle blieb stehen; 23 Versionen lang flog bei jeder großen Hand ein
  ReferenceError und die Verlaufskanten fehlten (am iPhone die EINZIGE
  Scroll-Andeutung, weil Safari die Leiste im Ruhezustand ausblendet).
- **UI im Browser gegenprüfen, nicht nur `npm test`:** App starten und in
  allen Layouts (hoch, quer, Desktop) durchspielen. Die groben Fehler
  (überlaufende Kopfzeile, unlesbare Icons, Fenster hinter Fenstern,
  verdeckte Stapel im Querformat) fällt keine Testdatei auf. Headless-
  Chromium mit einem normalen User-Agent starten: Der Standard-UA
  („HeadlessChrome“) trifft die Crawler-Erkennung, der Client baut dann
  keine WebSocket-Verbindung auf und die Lobby wirkt tot.
- RL/Encoder: `OBS_SIZE`/`ACTION_SIZE` sind Verträge — bei Encoder-Änderungen
  Tests (`test/state-encoder.test.js`) UND die Env-Bridge (`printf … | node
  scripts/rl-env-server.js`, liefert `obs_size`/`action_size`) prüfen; ändert
  sich die Kodierung, sind bestehende `.onnx` inkompatibel (neu trainieren).
- **Kartenerhaltung ist die harte Integritätsgarantie**
  (`test/card-conservation.test.js`): Zwei Tests spielen ganze Partien
  (geseedetes Challenge-Deck und regulär) und prüfen NACH JEDEM ZUG, dass die
  Menge aller Karten exakt dem 110-Karten-Deck entspricht - nie mehr als zwei
  Pik Damen. Anlass war ein Duplikat-Fehler: Die Bot-Planung schrieb ihren
  Arbeitsstand in die ECHTEN Auslagen zurück (`meld.slots = …`), während sie
  mit einer gedachten Hand inklusive Ablagestapel rechnete. **Planungs- und
  Suchfunktionen müssen auf Kopien arbeiten** - `findLayOffs`/`findJokerSwaps`
  kopieren defensiv an der Wurzel.
- Steuer-Seams (`forced*`/`external*`/`mcts*`): dürfen weder aus Client-
  Nachrichten noch aus deserialisierten Snapshots setzbar sein — Anti-Cheat-
  Tests in `test/game-manager.test.js` decken beide Wege ab.

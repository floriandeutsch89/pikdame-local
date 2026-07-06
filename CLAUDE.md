# CLAUDE.md — Projektkontext für KI-Assistenten

Pik Dame: Offline-/Online-Multiplayer-Kartenspiel (Familien-Rommé-Variante).
Diese Datei fasst die Regeln zusammen, die bei JEDER Änderung gelten.

## Sprachregel (verbindlich)

- **Code, Kommentare, Bezeichner, Commit-Messages der Struktur, GitHub-Workflows,
  Infra-Dateien (Dockerfile/Compose) und Testbeschreibungen: ENGLISCH.**
- **Repo-Dokumentation (README, docs/) ebenfalls ENGLISCH** — README.md,
  docs/OPERATIONS.md und SECURITY.md sind migriert; k8s/README.md und
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

0. **Primärer Betriebsmodus ist der gehostete Docker-Stack**
   (play.pikdame.online). Der Hotspot-/CodeApp-Modus ist Legacy: Er bleibt
   funktionsfähig (Zero-Config-Fallbacks nicht brechen), wird aber nicht
   mehr aktiv optimiert - UX-Entscheidungen richten sich nach dem
   Online-Mehrspieler-Betrieb.
1. **iOS-CodeApp-Kompatibilität:** Der Server läuft auf dem iPhone-Hotspot in
   der CodeApp. Deshalb: **keine neuen npm-Dependencies ohne explizites Okay**
   (aktuell: `ws` + `pg` — pg ist pure JS, wird LAZY geladen und nur mit
   gesetzter `PIKDAME_DATABASE_URL` benutzt), keine nativen Module, kein
   Build-Schritt. Features, die mehr brauchen
   (z. B. Konten via `node:sqlite`, Node ≥ 22; Docker/CI laufen auf Node 24), müssen sich auf älteren
   Node-Versionen **selbst deaktivieren** (Factory liefert `null`, Client
   blendet UI aus) — der Hotspot-Betrieb bleibt unberührt.
2. **Frontend ohne CDN:** Alles wird lokal ausgeliefert (Hotspot hat kein
   Internet). Fremd-Bibliotheken vendoren (`public/vendor-*.js`).
3. **Zweisprachigkeit:** Deutsch ist Quellsprache. Jeder neue sichtbare Text
   braucht einen Eintrag: statisches HTML → `I18N_STATIC`, dynamisches JS →
   `L(de, en)`, **Server-Texte (Log/Fehler) → `I18N_SERVER_PATTERNS`**
   (Regex-Muster). Vertragstests prüfen die Abdeckung.
4. **Sessions überleben Neustarts:** `GameManager.serialize()/deserialize()`.
   Transiente Felder (Timer, Sets, Hooks) gehören in die Skip-Liste von
   `serialize()` UND werden in `deserialize()` frisch initialisiert
   (JSON macht aus `Set` sonst `{}` → Crash-Klasse `.add is not a function`).
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
  SMTP-Client, Log-Fallback), `Badges.js` (reine Funktion).
- `public/` — Vanilla-JS-Client (`client.js`), `i18n.js`, PWA.
- `landing/` — statische Auswahlseite für pikdame.online.

### Bot-KI (Heuristik + optionales gelerntes Netz)
- **Heuristik** (`Bot.js`, 4 Stufen easy/medium/hard/zen): Kartenzählung über
  alle öffentlichen Karten, Damen-Disziplin (nur easy wirft die ♠Q sorglos),
  Zieh-Guards (Usability-Lookahead, Damen-unter-Stapel, Wertverlust-Vergleich),
  Zen-Endspiel mit Erschöpfungs-/Punktestand-Gewichtung, Joker-Ausstieg.
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
    Doku `docs/RL_TRAINING.md` (Ubuntu 24.04, uv, RTX-5080). Modelle werden
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
Karte sofort legen, dann Rest). Pro Spieler nur EIN Satz je Wert.
**Ausmachen nur per Abwurf der letzten Karte** (verdeckt abgelegt, nicht
aufnehmbar; Ausnahme: Joker-Tausch mit der letzten Handkarte beendet sofort).
Ein getauschter Joker bleibt als +20 in der Auslage-Wertung (plus die echte
Karte). „Hand aus“ = Gewinner hatte vor seinem letzten Zug nichts ausgelegt
(verdoppelt bei Hausregel). Leerer Ziehstapel → Ablage (außer oberster Karte)
neu mischen; beide leer oder 160 Züge ohne Meld → Unentschieden ohne Bonus.
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
5. Neue Server-Texte ⇒ i18n-Pattern. Neue UI-Elemente ⇒ Vertragstests laufen mit.
6. Compose-Änderungen IMMER in allen drei Dateien unter `docker/` (yml, ghcr.yml, prod.yml)
   synchron; die OWASP-Härtung (cap_drop ALL, read_only, AppArmor, pids_limit)
   ist Pflicht und wird vom CI-Job `docker-smoke` real hochgefahren — neue
   Schreibpfade des Servers gehören ins `data/`-Volume oder nach `/tmp` (tmpfs).

## Test-Gewohnheiten des Projekts

- Engine-Änderungen: E2E-Botspiele über alle 4 Schwierigkeiten laufen lassen
  (Deadlocks, Log-Invarianten wie „kein Joker-Abwurf“, Doppel-Satz-Verbot).
- Client-Heuristiken (z. B. Anlege-Hinweise): gegen die Server-Wahrheit fuzzen
  — falsche Positive sind verboten, falsche Negative ok.
- Snapshot-Änderungen: Roundtrip durch `JSON.stringify/parse` + Restore testen.
- RL/Encoder: `OBS_SIZE`/`ACTION_SIZE` sind Verträge — bei Encoder-Änderungen
  Tests (`test/state-encoder.test.js`) UND die Env-Bridge (`printf … | node
  scripts/rl-env-server.js`, liefert `obs_size`/`action_size`) prüfen; ändert
  sich die Kodierung, sind bestehende `.onnx` inkompatibel (neu trainieren).
- Steuer-Seams (`forced*`/`external*`/`mcts*`): dürfen weder aus Client-
  Nachrichten noch aus deserialisierten Snapshots setzbar sein — Anti-Cheat-
  Tests in `test/game-manager.test.js` decken beide Wege ab.

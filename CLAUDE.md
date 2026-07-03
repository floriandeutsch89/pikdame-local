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

## Spielregeln-Essenz (engine-verifiziert, siehe Regeln-Overlay)

110 Karten (2 Decks + 6 Joker), 15 Handkarten, 2–4 Spieler, Bots füllen auf.
Jeder Spieler hat **eigene** Auslagen (Anlegen/Joker-Tausch nur dort).
Folgen laufen im Ring (K-A-2), max 13. Zwei-Phasen-Ablagestapel (oberste
Karte sofort legen, dann Rest). Pro Spieler nur EIN Satz je Wert.
**Ausmachen nur per Abwurf der letzten Karte.** Bots werfen NIE Joker ab
(außer als Sieges-Abwurf der letzten Karte). Punkte: 2–9=5, 10/B/D/K=10,
Ass/Joker=20, Pik Dame=100. Spielende ab 1000 (Hausregel „streng“: >1000).

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

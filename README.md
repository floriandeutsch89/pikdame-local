# ♠ Pik Dame

Multiplayer-Kartenspiel (Familien-Rommé-Variante) für 2–4 Spieler — fehlende
Plätze füllen Bots mit vier Schwierigkeitsstufen. Läuft in **zwei
Betriebsarten** mit derselben Codebasis:

| | 🏕️ Unterwegs (offline) | ☁️ Gehostet (online) |
|---|---|---|
| **Wo** | iPhone-Hotspot, CodeApp, kein Internet nötig | Eigener Server / Raspberry Pi / Kubernetes |
| **Für wen** | Familienrunde am Tisch | Spielen über Distanz, z. B. `spiel.pikdame.online` |
| **Extras** | — | Benutzerkonten mit E-Mail-Bestätigung, geschützte Namen |
| **Start** | [iPhone + CodeApp](#-iphone-hotspot-codeapp) | [Docker / Helm](#-gehostet-docker) |

Zweisprachig (Deutsch/Englisch), installierbar als PWA, komplett ohne
Build-Schritt und ohne externe Frontend-Abhängigkeiten.

---

## Features

- **Bots mit Charakter**: vier Schwierigkeiten (easy → zen mit Kartenzählung),
  menschliche Namen (Uwe, Inge, Maria …) und zufällige Emote-Reaktionen —
  inklusive gelegentlichem Pik-Dame-Bluff.
- **Statistik & Erfolge**: Spielerprofile (Partien/Siege/Punkte/Siegesserien),
  8 freischaltbare Badges, globale Server-Zähler, Rundenstatistik und
  Spielverlauf-Export als JSON.
- **Benutzerkonten** (nur gehostet): Registrierung mit E-Mail-Bestätigung,
  Login mit 90-Tage-Sitzung — der eigene Name ist damit vor Fremdnutzung
  geschützt und der Fortschritt bleibt dauerhaft erhalten. Im Hotspot-Betrieb
  automatisch deaktiviert und unsichtbar.
- **Robust im Betrieb**: Reconnect mit Bot-Überbrückung, laufende Spiele
  überleben Server-Neustarts (Session-Snapshot), Heartbeat gegen
  Zombie-Verbindungen, gepanzerte Fehlerbehandlung auf Client und Server.
- **Drei Design-Themes** (Spieltisch/Nacht/Herzdame), Kartenfächer,
  synthetisierter Sound (offlinefähig, keine Audio-Dateien), Haptik.

## Schnellstart

### ☁️ Gehostet (Docker)

```sh
# Fertiges Image von GHCR (amd64 + arm64):
docker compose -f docker-compose.ghcr.yml up -d
# → http://<host>:8080
```

Oder auf Kubernetes per Helm (Chart wird bei jedem Release als OCI-Artefakt
publiziert):

```sh
helm install pikdame oci://ghcr.io/floriandeutsch89/charts/pikdame \
  --version <X.Y.Z> --set ingress.host=spiel.example.org --set image.tag=v<X.Y.Z>
```

Alles Weitere — Update, Rollback, Backup, Secrets, TLS —
steht im **[Betriebshandbuch](docs/OPERATIONS.md)**; Sicherheit (OWASP-Härtung,
CI-Scans) in **[SECURITY.md](SECURITY.md)**; Kubernetes-Details in
**[k8s/README.md](k8s/README.md)**. Die Auswahlseite für eine Domain mit
mehreren Apps liegt unter **[landing/](landing/README.md)**.

### 💻 Lokal

```sh
npm install && npm start
# → http://localhost:8080
```

### 🏕️ iPhone-Hotspot (CodeApp)

1. Projekt in die CodeApp laden (Git-Klon im integrierten Terminal oder
   Dateien-Import), dann: `npm install && node server.js`.
   Der Server listet beim Start alle erreichbaren Netzwerk-IPs auf und
   markiert Apples Hotspot-Bereich (`172.20.10.x`).
2. Persönlichen Hotspot aktivieren. **Hinweis:** iOS setzt dafür eine aktive
   Mobilfunk-/SIM-Verbindung voraus — ohne Empfang (Flugzeug, Ausland ohne
   Datentarif) startet der Hotspot oft gar nicht. Alternativen: Android-Hotspot
   eines Mitspielers, Reise-Router oder ein gemeinsames WLAN.
3. Mitspieler verbinden sich mit dem Hotspot und öffnen die angezeigte IP im
   Browser (z. B. `http://172.20.10.1:8080`) — der Client findet den Host
   automatisch, keine Code-Änderung nötig.

**⚠️ CodeApp muss im Vordergrund bleiben.** iOS pausiert den Node-Prozess,
sobald die App in den Hintergrund geht oder das Display sperrt (grundsätzliche
iOS-Einschränkung). Deshalb: Automatische Sperre auf „Nie" (Einstellungen →
Anzeige & Helligkeit) oder **Geführter Zugriff** (Bedienungshilfen) — der pinnt
den Bildschirm fest auf die CodeApp. Sollte doch etwas Unerwartetes passieren,
landet es in `data/crash.log`.

## Spiel-Sessions

Jedes Spiel bekommt einen **kryptographisch zufälligen 6-stelligen Code**
(ohne verwechselbare Zeichen) — nur wer ihn kennt, kann beitreten; eine
Spiel-Liste gibt es bewusst nicht. Der Code lässt sich per iOS-Share-Sheet
oder Link (`?session=CODE`) teilen. Beliebig viele Spiele laufen parallel und
vollständig isoliert; Reconnects finden über die gespeicherte Spieler-ID
automatisch an den richtigen Tisch zurück.

## Spielregeln

Die vollständigen Regeln stehen **in der App** (📖-Button, DE/EN). Kernpunkte
und ihre Umsetzung:

| Regel | Datei |
|---|---|
| 110 Karten (2×52 + 6 Joker), 15 Handkarten | `Deck.js` |
| Ziehen: Stapel ODER Ablagestapel in zwei Phasen (oberste Karte sofort legen, dann Rest) | `GameManager.js` |
| Sätze (gleicher Wert, Farbe max. 2×) und Folgen im Werte-Ring (K-A-2 gültig, max. 13) | `Rules.js` |
| Pro Spieler nur EIN Satz je Kartenwert; Anlegen & Joker-Tausch nur an EIGENEN Auslagen | `GameManager.js` |
| Glücksgriff beim Abheben (Pik Dame/Joker an der Abhebestelle) | `Deck.js` |
| Getauschte Joker bleiben sichtbar liegen, aus dem Spiel | `GameManager.js` |
| **Ausmachen nur per Abwurf der letzten Karte** | `GameManager.js` |
| Punkte: 2–9 = 5 · 10/B/D/K = 10 · Ass/Joker = 20 · ♠Dame = 100; Spielende ab 1000 | `Card.js`, `ScoreBoard.js` |

**Hausregeln** (beim Start wählbar): „Hand aus zählt doppelt", „über 1000 zum
Gewinnen", Bot-Schwierigkeit (easy / medium / hard / zen).

<details>
<summary><b>Bewusste Regel-Interpretationen</b></summary>

1. **Folgen sind zirkulär**: Werte bilden einen Ring (…Q-K-A-2-3…), max. 13
   Karten pro Folge (`Rules.js`, `RANK_ORDER`).
2. **Joker-Tausch-Timing**: nur in der eigenen Auslege-Phase; der freie Joker
   scheidet für den Rest der Runde aus.
3. **Bots sind Heuristiken**, kein Solver — regelkonform, tischbewusst, werfen
   nie freiwillig Joker ab (außer als Sieges-Abwurf der letzten Karte).
4. **„Hand aus"** = Runde endet im allerersten Zug, egal wer beginnt.
5. Bei **mehrdeutigen Joker-Kombinationen** fragt das Spiel per Overlay nach,
   statt zu raten (`enumerateMeldOptions` in `Rules.js`).
</details>

## Features im Detail

- **Lobby**: Spieleranzahl 2–4, Sitzordnung per ▲▼, Geber per ⭐ wählbar,
  gespeicherte Teams, Runden-Aufgeben per 🏳️ (ohne Gewinner-Bonus).
- **Rundenende**: Ergebnis-Overlay mit Statistik-Tabelle (ausgelegte Karten,
  ♠Q und 🃏 pro Spieler), Punkteverlauf-Chart, Badge-Feier; Rematch behält
  Sitzordnung und Namen.
- **Design**: Drei Themes, Glas-Panels, Kartenfächer mit hervorgehobener
  Pik Dame, grüner Rand an selbst gelegten Karten (pro Kartenslot getrackt).
  System-Font-Stack und Web-Audio-Synthese halten alles offlinefähig.
- **Zweisprachig**: Deutsch ist Quellsprache; Englisch wird client-seitig
  über `public/i18n.js` übersetzt (statische Texte, dynamische `L(de, en)`
  und Regex-Muster für Server-Meldungen — vertragsgetestet).

## Betrieb

Der Server spricht bewusst nur HTTP — öffentlich gehört ein Reverse-Proxy mit
TLS davor (Caddy-/nginx-Beispiele in [landing/README.md](landing/README.md));
der Client wechselt automatisch auf `wss:`. Wichtige Umgebungsvariablen
(alle opt-in, ohne sie läuft der Server exakt wie im Hotspot-Modus):

| Variable | Zweck |
|---|---|
| `PIKDAME_MAX_SESSIONS` | Obergrenze paralleler Spiele (Standard 200) |
| `PIKDAME_PUBLIC_MODE=1` | Profile/Teams/Statistik aus — für Server mit Fremden |
| `PIKDAME_TRUST_PROXY=1` | Client-IP aus `X-Forwarded-For` (hinter Reverse-Proxy) |
| `PIKDAME_ALLOWED_ORIGIN` | WebSocket nur von der eigenen Domain |
| `PIKDAME_ACCOUNTS=0` | Benutzerkonten abschalten |
| `PIKDAME_BASE_URL`, `PIKDAME_SMTP_*` | Bestätigungs-Mails (siehe `.env.example`) |

Eingebaute Härtung: Namens-Sanitizing + HTML-Escaping (doppelter XSS-Schutz),
IP-basierter Brute-Force-Schutz auf Codes und Konto-API, Rate-Limits,
16-KB-Nachrichtenlimit, Session-Cleanup, Heartbeat, Graceful Shutdown mit
Session-Snapshot, atomare Persistenz, SQLite im WAL-Modus, scrypt-Passwörter.
Beobachtung über `GET /statusz` (Version, Sessions, Speicher — keine Namen)
und `GET /healthz`.

## Entwicklung

```
server.js          HTTP + WebSocket, Konto-API, Session-Registry
game/              Reine Spiellogik (Rules, GameManager, Bot, Stores, …)
public/            Vanilla-JS-Client, i18n, PWA
test/              node --test — 162 Tests inkl. Vertrags- und E2E-Bot-Tests
helm/ · k8s/       Kubernetes (Chart empfohlen, rohe Manifeste als Alternative)
docs/ · scripts/   Betriebshandbuch, Backup/Restore
```

- **Tests**: `npm test` (Nodes eingebauter Runner, keine Test-Dependencies).
  Die CI führt exakt dasselbe aus — plus Dependency-Audit, Dockerfile-Lint,
  Trivy-Scan, Helm-Validierung und einen Smoke-Test, der die voll gehärtete
  Compose-Konfiguration real hochfährt. Alles auf Node 24.
- **Releases sind automatisiert**: Version in `package.json` bumpen +
  CHANGELOG-Abschnitt schreiben → beim Push auf `main` erzeugt der Workflow
  Git-Tag, GitHub-Release (Notes aus dem CHANGELOG), Multi-Arch-Image und
  Helm-Chart auf GHCR.
- **Konventionen** (Sprache, Constraints, Workflow): [CLAUDE.md](CLAUDE.md).
  Wichtigste Regel: keine neuen npm-Dependencies — der Server muss in der
  iOS CodeApp lauffähig bleiben (aktuell einzige Dependency: `ws`).

## Bewusste Grenzen

- **Eine Server-Instanz by design**: Sessions leben im Prozess-Speicher, die
  Konten-DB ist lokales SQLite — horizontal skalieren würde Spieler auf
  Instanzen verteilen, die nichts voneinander wissen. Für den Zweck
  (Familien-/Freundesrunden, 200-Session-Limit) reicht eine Instanz locker;
  Updates überbrückt der Session-Snapshot.
- Ohne Konten werden Profile anhand des Namens abgeglichen (case-insensitive);
  mit aktivierten Konten sind verifizierte Namen login-geschützt.

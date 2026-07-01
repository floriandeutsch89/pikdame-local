# ♠ Pik Dame

Offline-Multiplayer-Kartenspiel (Rommé-Variante) für 4 Spieler, lauffähig über
einen lokalen Node.js-Server auf einem iPhone-Hotspot. Fehlende Mitspieler
werden automatisch durch Bots ersetzt.

## Projektstruktur

```
pik-dame/
├── server.js              # HTTP + WebSocket Server (nur http + ws)
├── package.json
├── game/
│   ├── Card.js             # Kartendefinition, Punktwerte
│   ├── Deck.js              # Deck-Erzeugung, Mischen, Austeilung
│   ├── Rules.js              # Satz-/Folgen-Validierung, Anlegen, Joker-Tausch
│   ├── ScoreBoard.js          # Rundenwertung & Spielende-Logik
│   ├── Bot.js                 # Bot-KI (Ziehen, Auslegen, Abwerfen)
│   └── GameManager.js          # Zentrale Zustandsmaschine des Spiels
└── public/
    ├── index.html
    ├── style.css
    └── client.js             # WebSocket-Client (Mobile-First, Touch)
```

## Start (lokal testen)

```bash
cd pik-dame
npm install
npm start
```

Browser öffnen: `http://localhost:8080`

## Tests

Unit-Tests (Deck/Austeilung, Satz-/Folgen-Regeln, Joker-Logik, Punkteberechnung)
laufen mit dem in Node.js eingebauten Testrunner – keine zusätzliche Abhängigkeit nötig:

```bash
npm test
```

Tests laufen außerdem automatisch via GitHub Actions bei jedem Push/Pull-Request
auf `main` (siehe `.github/workflows/ci.yml`), gegen Node 18/20/22.

## Hosting mit Docker (Alternative zum Hotspot-Setup)

Statt direkt mit Node.js zu starten, lässt sich der Server auch als Docker-
Container betreiben (z. B. auf einem Raspberry Pi, NAS oder Heim-Server statt
einem iPhone-Hotspot):

```bash
docker compose up --build -d
```

- Der Server ist danach unter `http://<host>:8080` erreichbar.
- Spielerprofile/Teams/Spielverlauf landen im benannten Volume `pikdame-data`
  (gemountet auf `/app/data` im Container) und überleben Container-Neustarts
  und -Updates.
- Healthcheck: `GET /healthz` (von Docker automatisch alle 30s geprüft).
- Port/Variable anpassen: `PORT` in `docker-compose.yml` setzen.

Ohne Compose, direkt mit `docker`:

```bash
docker build -t pikdame .
docker run -d -p 8080:8080 -v pikdame-data:/app/data --name pikdame pikdame
```

> Hinweis: Dieses Docker-Setup wurde nicht in einer echten Docker-Umgebung
> gebaut/getestet (im Entwicklungs-Sandbox war kein Docker verfügbar) -
> bitte einmal selbst mit `docker compose up --build` gegenprüfen, bevor es
> produktiv eingesetzt wird.

## Start auf dem iPhone (CodeApp + Hotspot)

1. Projektordner `pik-dame/` in die CodeApp laden (z.B. via Git-Klon im
   integrierten Terminal oder Dateien-Import).
2. Im CodeApp-Terminal:
   ```bash
   cd pik-dame
   npm install
   node server.js
   ```
3. iPhone-Persönlichen-Hotspot aktivieren.
4. Andere Geräte (Smartphones der Mitspieler) verbinden sich mit dem Hotspot.
5. Auf jedem Gerät im Browser die **Hotspot-IP des iPhones** öffnen, z.B.
   `http://172.20.10.1:8080` (IP unter iPhone-Einstellungen → Persönlicher
   Hotspot, oder via `ifconfig`/`ipconfig getifaddr en0` im CodeApp-Terminal
   ermitteln).
6. `client.js` ermittelt den Host automatisch über `window.location.hostname`
   — es ist **keine Code-Änderung** nötig, unabhängig von der tatsächlichen
   Hotspot-IP.

## Spielregeln – Umsetzung im Code

| Regel | Datei | Hinweis |
|---|---|---|
| 110 Karten (2×52 + 6 Joker) | `Deck.js` | `createDeck()` |
| 15 Handkarten, Rest = Nachziehstapel | `Deck.js` | `dealCards()` |
| Ziehen: Stapel ODER ganzer Ablagestapel (mit Sofort-Auslage-Pflicht) | `GameManager.js` | `drawFromPile`, `drawFromDiscard`, `mustLayOffCardId` |
| Ablagestapel nur aufnehmbar, wenn die oberste Karte wirklich nutzbar ist | `GameManager.js` | `canUseDiscardTop()` |
| Sätze (gleicher Wert, Farbe max. 2x wegen 2 Decks) | `Rules.js` | `validateSet` |
| Folgen (≥3 aufeinanderfolgend, gleiche Farbe) | `Rules.js` | `validateRun` |
| Joker ersetzen jede Karte, austauschbar | `Rules.js` | `tryJokerSwap` |
| Ausgetauschter Joker bleibt liegen (eigener Ablagebereich, nicht wieder aufnehmbar) | `GameManager.js` | `retiredJokers` |
| Anlegen an bestehende Auslagen | `Rules.js` | `tryLayOff` |
| Letzte Karte verdeckt ablegen, Rundenende | `GameManager.js` | `discard()` |
| Punkte-Tabelle (2-9=5, 10/J/Q/K=10, A/Joker=20, Pik-Dame=100) | `Card.js` | `cardValue()` |
| Gewinner-/Mitspieler-Abrechnung (Pik-Dame zählt einfach, keine Sonderstrafe) | `ScoreBoard.js` | `scoreRound()` |
| Spielende bei Erreichen/Überschreiten von 1000 Punkten | `ScoreBoard.js` | `checkGameOver()` |
| Geber rotiert pro Runde, dauerhaft sichtbar | `GameManager.js` | `dealerIndex` / `dealerId` im State |
| Bots: regelkonform, Kombis erkennen, Pik-Dame/Joker loswerden (Pik Dame erst ab kleiner Hand dringend) | `Bot.js` | `decideDraw`, `findHandMelds`, `chooseDiscard`, `URGENT_DISCARD_HAND_SIZE` |

### Optionale Hausregeln (bei Spielstart wählbar)

| Regel | Standard | Effekt |
|---|---|---|
| Hand aus zählt doppelt | aus | Geht ein Spieler im allerersten Zug der Runde komplett aus, wird die GESAMTE Rundenwertung aller Spieler (inkl. Minuspunkte) verdoppelt |
| Über 1000 Punkte zum Gewinnen | aus | Spielende erst bei MEHR als 1000 Punkten (genau 1000 reicht nicht) |

### Lobby-Features

- **Spieleranzahl**: Vor dem Beitreten/Start wählbar (2-4, Standard 4) - bestimmt, wie viele Bot-Plätze beim Start automatisch aufgefüllt werden. Kann nicht kleiner als die Anzahl bereits beigetretener Spieler gewählt werden. `setMaxSeats()`.
- **Sitzordnung & Geber**: Vor Rundenbeginn frei per ▲▼ umsortierbar, Geber der ersten Runde per ⭐ direkt wählbar (`reorderPlayers`, `setExplicitDealer`).
- **Teams**: Gespeicherte Gruppen von Spielernamen (`PlayerStore.js`, `data/players.json`) lassen sich erneut anwenden und benennen freie Bot-Plätze entsprechend um.
- **Reconnect-Robustheit**: Verliert ein Spieler die Verbindung (z. B. wackliger Hotspot), übernimmt automatisch die Bot-Logik für seine Züge, bis er zurück ist (`isBotControlled`).
- **Statistik-Persistenz**: Nach Spielende (nicht nur Rundenende) werden Partien/Siege/Punkte pro Spielername in `data/players.json` fortgeschrieben.

### Rematch, Rundenstatistiken & Spielverlauf-Export

- **Rematch**: Nach Spielende ("Neue Partie") werden Gesamtpunkte und Rundenzählung zurückgesetzt, Sitzordnung/Namen bleiben erhalten (`prepareRematch()`).
- **Rundenstatistiken**: Am Rundenende zeigt das Ergebnis-Overlay zusätzlich eine Tabelle mit ausgelegten/verbliebenen Karten, Pik-Damen und Jokern auf der Hand pro Spieler (`lastRoundStats`).
- **Spielverlauf-Export**: Nach Spielende lässt sich der komplette Runde-für-Runde-Verlauf der Partie als JSON-Datei herunterladen ("📤 Spielverlauf exportieren"). Alle abgeschlossenen Partien werden außerdem dauerhaft in `data/games.json` gespeichert (`GameHistoryStore.js`), um Statistiken über mehrere Partien hinweg auszuwerten.

### Design-System: drei Stimmungen, ein Tisch

Über den Theme-Switcher in der Lobby (🟢/🌙/💖) lässt sich zwischen drei
Erscheinungsbildern wechseln (Auswahl wird im Browser gespeichert):

- **Spieltisch** (Standard): tiefes Tannengrün + Messing-Gold, klassische Casino-Filz-Optik.
- **Nacht**: fast schwarzer Tisch, gedämpftes Gold, höherer Kontrast für dunkle Räume.
- **Herzdame**: weinrot/rosé, spielerisch-romantisch – die Pik Dame bekommt hier ihren ironischen Auftritt.

Karten selbst bleiben in allen drei Themes cremefarben (wie echtes Kartenpapier) –
nur die Tischatmosphäre wechselt. Schriften kommen bewusst aus dem
Betriebssystem-Stack (Georgia/Palatino für Überschriften, System-Sans für den
Rest), damit nichts aus dem Internet nachgeladen werden muss – der Server läuft
ja gerade offline über Hotspot ohne Internetzugang.

Die eigene Hand wird als echter Kartenfächer dargestellt (CSS-Rotation pro
Karte um die Fächermitte), die Pik Dame ist in der Hand zusätzlich farblich
hervorgehoben, und ausgetauschte Joker werden in einer eigenen Leiste über dem
Spielfeld sichtbar gemacht.

### Sound & Haptik

Alle Töne werden zur Laufzeit per Web Audio API synthetisiert (kurze Sinus-/
Dreieckstöne) – es gibt keine Audio-Dateien zum Herunterladen, das Spiel bleibt
also vollständig offline-fähig. Ergänzend wird, sofern vom Gerät unterstützt,
kurz vibriert (`navigator.vibrate`). Ein/Aus-Schalter: Checkbox in der Lobby
("Sound & Vibration") oder 🔊/🔇-Button am Spieltisch; die Einstellung wird im
Browser gespeichert.

### Runde aufgeben

Über den 🏳️-Button in der Aktionsleiste kann jeder Spieler die laufende Runde
JEDERZEIT beenden (unabhängig davon, wer gerade am Zug ist). Es gibt dabei
keinen Gewinner-Bonus für irgendwen: alle Spieler (inkl. des Aufgebenden)
werden wie ein normaler Mitspieler gewertet (Pluspunkte aus Ausgelegtem minus
Minuspunkte der Resthand). `forfeitRound()` in `GameManager.js`.

### Joker-Auswahl bei Mehrdeutigkeit

Manche Joker-Kombinationen lassen mehr als eine gültige Interpretation zu
(z. B. 1 Dame + 2 Joker: ein Satz aus 3 Damen ODER eine Folge an drei
verschiedenen möglichen Stellen). In diesen Fällen fragt das Spiel aktiv
nach, statt eine Variante zu erraten - ein Auswahl-Overlay zeigt alle
gültigen Optionen in Klartext an. `enumerateMeldOptions()` /
`enumerateLayOffOptions()` in `Rules.js` ermitteln dafür systematisch (nicht
per Brute-Force) alle gültigen Interpretationen: Sätze werden nur über
gleichrangige Karten gesucht, Folgen nur über gleichfarbige - das hält die
Suche auch bei großen Händen sehr günstig. Ist nur eine Interpretation
gültig, wird sie automatisch verwendet (keine unnötige Rückfrage). Bots
wählen bei Mehrdeutigkeit automatisch die erste (kanonische) Option.

## Bewusste Annahmen (in den Regeln nicht 100% spezifiziert)

Diese Punkte wurden sinnvoll interpretiert und lassen sich bei Bedarf leicht
anpassen (Code-Stellen sind kommentiert):

1. **Ass in Folgen zählt nur hoch** (...Q-K-A), NICHT zusätzlich als 1 vor
   der 2 ("Ass-2-3" ist also keine gültige Folge). Anpassbar in `Card.js`
   (`RANK_ORDER`).
2. **Joker-Tausch-Timing**: Ein Spieler kann während seiner eigenen
   Auslegen/Anlegen-Phase einen Tisch-Joker gegen die passende Handkarte
   tauschen (`swapJoker`). Der freigewordene Joker bleibt sichtbar liegen und
   scheidet für den Rest der Runde aus dem Spiel aus.
3. **Bot-Schwierigkeit**: Die Bot-KI ist heuristisch (greedy Mustererkennung
   für Sätze/Folgen), kein vollständiger Solver. Sie spielt regelkonform und
   verfolgt die vorgegebene Priorität (Pik-Dame/Joker nicht horten), trifft
   aber keine strategisch optimalen Entscheidungen in jeder Lage.
4. **"Hand aus"**: wird erkannt, wenn die Runde im allerersten Zug der Runde
   (vor jedem `advanceTurn`) komplett beendet wird - unabhängig davon, welcher
   Spieler beginnt.

## Bekannte Grenzen / mögliche Erweiterungen

- Aktuell ein Tisch pro Server-Prozess (kein Multi-Room-Lobby-System) – passend
  für den beschriebenen Hotspot-Use-Case mit max. 4 Spielern.
- Spielerprofile/Teams werden anhand des Namens (case-insensitive) abgeglichen,
  nicht über echte Accounts/Logins.

## Entwicklungs-Workflow

- `main` ist immer deploybar; CI (GitHub Actions) läuft automatisch bei jedem
  Push/Pull-Request gegen `main` (Tests auf Node 18/20/22).
- Neue Features/Fixes: Feature-Branch (`feature/...`, `fix/...`, `docs/...`)
  → Pull Request gegen `main` → CI grün → Merge. Für dieses Solo-Projekt
  werden PRs zur Nachvollziehbarkeit angelegt, aber direkt selbst gemerged.


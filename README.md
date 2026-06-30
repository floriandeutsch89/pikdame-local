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
│   ├── Deck.js              # Deck-Erzeugung, Mischen, "Glücksgriff"-Austeilung
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
| 15 Handkarten, Rest = Nachziehstapel | `Deck.js` | `dealWithGlucksgriff()` |
| Glücksgriff (Pik-Dame/Joker beim Abheben) | `Deck.js` | Simulierter Cut pro Spieler vor dem regulären Austeilen |
| Ziehen: Stapel ODER ganzer Ablagestapel (mit Sofort-Auslage-Pflicht) | `GameManager.js` | `drawFromPile`, `drawFromDiscard`, `mustLayOffCardId` |
| Sätze (gleicher Wert, versch. Farben) | `Rules.js` | `validateSet` |
| Folgen (≥3 aufeinanderfolgend, gleiche Farbe) | `Rules.js` | `validateRun` |
| Joker ersetzen jede Karte, austauschbar | `Rules.js` | `tryJokerSwap` |
| Anlegen an bestehende Auslagen | `Rules.js` | `tryLayOff` |
| Letzte Karte verdeckt ablegen, Rundenende | `GameManager.js` | `discard()` |
| Punkte-Tabelle (2-9=5, J/Q/K=10, A/Joker=20, Pik-Dame=100) | `Card.js` | `cardValue()` |
| Gewinner-/Mitspieler-Abrechnung + Pik-Dame-Strafe | `ScoreBoard.js` | `scoreRound()` |
| Spielende bei >1000 Punkten | `ScoreBoard.js` | `checkGameOver()` |
| Bots: regelkonform, Kombis erkennen, Pik-Dame/Joker priorisiert loswerden | `Bot.js` | `decideDraw`, `findHandMelds`, `chooseDiscard` |

## Bewusste Annahmen (in den Regeln nicht 100% spezifiziert)

Diese Punkte wurden sinnvoll interpretiert und lassen sich bei Bedarf leicht
anpassen (Code-Stellen sind kommentiert):

1. **Ass in Folgen**: zählt nur hoch (...Q-K-A), nicht zusätzlich als 1 vor
   der 2. Anpassbar in `Card.js` (`RANK_ORDER`).
2. **Punktwert der "10"**: wurde in der Tabelle nicht explizit erwähnt; wird
   wie 2-9 mit 5 Punkten gewertet (`Card.js`, `cardValue()`).
3. **Zwei Pik-Damen gleichzeitig auf der Hand**: Sonderstrafe wird pro Karte
   angewendet (also -200, falls beide Pik-Damen am Rundenende auf einer Hand
   liegen). Siehe `ScoreBoard.js`.
4. **Joker-Tausch-Timing**: Ein Spieler kann während seiner eigenen
   Auslegen/Anlegen-Phase einen Tisch-Joker gegen die passende Handkarte
   tauschen (`swapJoker`). Der gewonnene Joker landet auf der Hand und sollte
   vom Spieler/Bot idealerweise im selben Zug noch abgeworfen werden.
5. **Bot-Schwierigkeit**: Die Bot-KI ist heuristisch (greedy Mustererkennung
   für Sätze/Folgen), kein vollständiger Solver. Sie spielt regelkonform und
   verfolgt die vorgegebene Priorität (Pik-Dame/Joker nicht horten), trifft
   aber keine strategisch optimalen Entscheidungen in jeder Lage.

## Bekannte Grenzen / mögliche Erweiterungen

- Keine Persistenz: Server-Neustart = neue Partie (für Offline-Hotspot-Runden
  in der Regel kein Problem).
- Reconnect: Ein Spieler kann mit derselben `playerId` (im `localStorage` des
  Browsers gespeichert) wieder beitreten und behält seine Hand.
- Aktuell ein Tisch pro Server-Prozess (kein Multi-Room-Lobby-System) – passend
  für den beschriebenen Hotspot-Use-Case mit max. 4 Spielern.

## Auf GitHub pushen

Dieses Verzeichnis ist noch nicht mit einem Git-Repository verknüpft. Im
Projektordner:

```bash
git init
git add .
git commit -m "Pik Dame: initiales Projekt-Setup"
git branch -M main
git remote add origin <URL-DEINES-REPOS>
git push -u origin main
```

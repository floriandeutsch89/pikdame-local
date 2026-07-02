# Changelog

Alle nennenswerten Änderungen an Pik Dame werden hier dokumentiert.
Format nach [Keep a Changelog](https://keepachangelog.com/de/), Versionierung nach [SemVer](https://semver.org/lang/de/):
**MAJOR** bei Regel-/Bruch-Änderungen, **MINOR** bei neuen Features, **PATCH** bei Fehlerbehebungen.

## [1.0.0] - 2026-07-02

Erstes stabiles Release - das komplette Familien-Kartenspiel als Web-App.

### Spielregeln
- Vollständige Pik-Dame-Regeln: 110 Karten (2 Decks + 6 Joker), 15 Handkarten, 2-4 Spieler
- Eigene Stapel pro Spieler: Anlegen und Joker-Tausch nur an den eigenen Auslagen
- Zirkuläre Folgen (Ring): K-A-2 ist gültig, maximal 13 Karten
- Zwei-Phasen-Ablagestapel: erst die oberste Karte (muss sofort gelegt werden), dann der Rest
- Glücksgriff beim Abheben vor dem Verteilen (Pik Dame/Joker sofort auf die Hand)
- Joker-Tausch, Hand-aus-Verdopplung, Punkteschwelle, Patt-Regel, Runde aufgeben
- Joker an Sätzen ohne Farb-Rückfrage (kanonische Default-Farbe); bei Folgen bleibt die Wahl oben/unten

### Multiplayer & Bots
- Spiel-Sessions mit 6-stelligen Codes, Beitritt per Link oder QR-Code
- Bots füllen freie Plätze und übernehmen bei Verbindungsabbruch nahtlos
- Reconnect mit Code + gespeicherter Spieler-ID
- Emotes (inkl. Pik-Dame-Minikarte) mit Server-Whitelist und Rate-Limit

### Oberfläche
- Mobile-First mit Desktop-Support (Chrome/Edge/Firefox/Safari), Querformat-Grid-Layout
- PWA: Home-Bildschirm-App mit Icons, Wake Lock, Vollbild-Modus (wo unterstützt)
- Anzeigegröße umschaltbar (Normal/Groß/Sehr groß) - für alle Altersklassen
- Anlege-Hinweise: passende eigene Auslagen leuchten grün, wenn eine Karte gewählt ist
- Pik-Dame-Ankündigung im Raid-Warning-Stil, Konfetti bei eigenem Rundensieg
- Handkarten ein-/ausklappbar, Sortierung nach Farbe/Wert, Zieh-Highlight
- Ablagestapel-Vorschau, Punkteverlauf-Chart, Statistik-Seite, Aktions-Toasts
- Modernes Graphit-Teal-Design mit Themes (Studio/Nacht/Herz)

### Hosting & Betrieb
- Läuft dependency-arm (nur `ws`) - auch in iOS CodeApp auf dem iPhone-Hotspot
- Docker-Betrieb für bis zu 200 parallele Spiele: Heartbeat, deployment-feste
  Sessions (Snapshot/Restore), nicht-blockierende atomare Persistenz,
  IP-Brute-Force-Schutz, `/statusz`-Metriken, öffentlicher Modus ohne Profildaten
- Gemessen: ~117 KB Heap pro aktivem Spiel; Speicher wird beim Session-Ende sofort frei

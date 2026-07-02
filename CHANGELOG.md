# Changelog

Alle nennenswerten Änderungen an Pik Dame werden hier dokumentiert.
Format nach [Keep a Changelog](https://keepachangelog.com/de/), Versionierung nach [SemVer](https://semver.org/lang/de/):
**MAJOR** bei Regel-/Bruch-Änderungen, **MINOR** bei neuen Features, **PATCH** bei Fehlerbehebungen.

## [1.8.0] - 2026-07-02

### Neu
- Benutzerkonten (nur im Docker-Betrieb): Registrierung mit Benutzername/E-Mail/Passwort, Bestätigungs-Mail mit 48h-Link, Login mit 90-Tage-Sitzung. Der Spielername ist nach dem Login fest der Kontoname - Statistik, Erfolge und Siegesserien bleiben so dauerhaft erhalten, und registrierte Namen sind vor Fremdnutzung geschützt (Beitritt nur mit Login)
- Speicherung in SQLite über Nodes eingebautes node:sqlite (data/users.db im Docker-Volume, keine neue Abhängigkeit); Passwörter mit scrypt + Salt, zeitkonstante Vergleiche
- Mailversand ohne Abhängigkeiten: eigener SMTP-Client (STARTTLS/SSL, AUTH LOGIN) - Mailserver wird später per Umgebungsvariablen eingetragen (PIKDAME_SMTP_*), bis dahin landet der Bestätigungslink im Server-Log
- In der iOS CodeApp / im Hotspot-Betrieb (Node < 22 oder PIKDAME_ACCOUNTS=0) bleibt alles wie bisher: die Konto-Oberfläche wird komplett ausgeblendet

### Geändert
- Docker-Image auf Node 22 (für das eingebaute SQLite)

## [1.7.1] - 2026-07-02

### Geändert
- Landing-README: Caddy-Beispiel ergänzt (automatisches HTTPS + WebSocket-Upgrade ohne Zusatzkonfiguration)

## [1.7.0] - 2026-07-02

### Neu
- Landing Page für pikdame.online (`landing/index.html`): eigenständige statische Auswahlseite zwischen Kartenspiel und Schreibblock im Studio-Design, inkl. Hosting-Anleitung (`landing/README.md`, Subdomain-Empfehlung mit nginx-Beispiel)

## [1.6.1] - 2026-07-02

### Geändert
- Rundenstart-Sprüche stehen jetzt garantiert volle 5 Sekunden: prioritäre Toasts (Spruch, Endspurt-Warnung, Fehlermeldungen) werden nicht mehr von Aktions-Meldungen ("Bot zieht eine Karte") verdrängt
- Gegner-Chips in Zugrichtung sortiert: der Chip ganz links ist immer der Spieler, der direkt nach dir dran ist
- Geber per ⭐ direkt am Gegner-Chip markiert; die Topbar zeigt nur noch "R3" (bzw. "R3 · Du gibst ⭐") - dauerhaft mehr Platz
- Kartenanzahl und Punkte in den Chips fett hervorgehoben; Topbar-Icons rücken auf schmalen Displays enger zusammen (kein Umbruch)

## [1.6.0] - 2026-07-02

### Neu
- Bots reagieren mit Emotes aufs Spielgeschehen - zufällig und leicht zeitversetzt, nie vorhersehbar: Grummeln (😤), wenn jemand den Ablagestapel nimmt; gelegentlicher Pik-Dame-Bluff vor dem Ziehen; Schreck (😱) und Jubel (🎉), wenn eine Pik Dame ausgelegt wird; Reaktionen aufs Rundenende
- Zwei neue Rundenstart-Sprüche ("Der lange Aal schlackert im Nebel", "Per aspera ad astra")

### Geändert
- Regel-Fix: Ausmachen geht nur noch per Abwurf der letzten Karte. Auslegen/Anlegen, das die Hand komplett leeren würde, wird abgelehnt - mindestens eine Karte muss für den Abwurf übrig bleiben (die Pflichtkarte vom Ablagestapel führt nie in eine Sackgasse). Die Spielregeln in der App wurden entsprechend ergänzt (DE/EN)

## [1.5.0] - 2026-07-02

### Neu
- Kreativer Spruch zum Rundenbeginn (24 Stück, DE/EN): alle am Tisch sehen denselben - wichtige Meldungen wie Endspurt-Warnung oder Glücksgriff haben Vorfahrt

## [1.4.0] - 2026-07-02

### Neu
- Erfolgs-Badges: 8 Auszeichnungen (🏆 Erster Sieg, 🚀 Hand aus!, ♠ Damensammler, 👑 Dreifache Dame, 😱 Autsch!, 💯 Punktekönig, 🔥 Siegesserie, 🐢 Comeback) - frisch verdiente werden am Spielende im Ergebnis-Overlay gefeiert, die Sammlung erscheint in der Statistik-Tabelle
- "Letzte Runde?"-Ansage: Steht jemand bei 800+ Punkten, warnt zu Rundenbeginn eine deutliche Endspurt-Meldung (6 Sekunden, zweisprachig), dass die 1000er-Schwelle das Spiel beendet

## [1.3.0] - 2026-07-02

### Neu
- Bot-Schwierigkeit einstellbar (Hausregeln): Leicht, Mittel, Schwer, Zen-Meister. Leicht spielt wie ein Anfänger (übersieht Chancen, wirft zufällig ab), Schwer gibt die Pik Dame nie freiwillig her, der Zen-Meister zählt zusätzlich Karten (wirft "tote" Kombinationen ab, deren Partner nicht mehr im Umlauf sind) und schaltet im Endspiel auf Schadensbegrenzung um
- Globale Server-Statistik im Statistik-Overlay: Partien, Runden, ausgelegte und auf der Hand erwischte Pik Damen, "Hand aus"-Runden - anonym über alle Spiele aggregiert
- Neue Familienregel: Pro Spieler nur EIN Satz je Kartenwert - weitere Karten dieses Werts werden angelegt statt einen zweiten Stapel zu eröffnen (Folgen/Straßen sind weiterhin mehrfach erlaubt)

### Behoben
- Bots werfen nie mehr einen Joker ab: harte Garantie in der Abwurf-Logik, alle Notfall-Pfade bevorzugen Nicht-Joker, und bei einer Nur-Joker-Hand werden die Joker an eigene Auslagen angelegt statt verschenkt

### Geändert
- Benachrichtigungen (Toasts) erscheinen jetzt zentriert in der Bildmitte und bleiben länger stehen (4 statt 2,6 Sekunden)
- Fehlermeldungen des Servers (z.B. "Ablagestapel kann nicht aufgenommen werden") erscheinen zusätzlich als 5 Sekunden langer Toast in der Bildmitte

## [1.2.0] - 2026-07-02

### Neu
- Sprachumschalter Deutsch/Englisch (🌐-Button im Hauptmenü, Standard: Deutsch, pro Gerät gespeichert) - komplette Oberfläche, Spielregeln, Spiel-Log und Fehlermeldungen werden übersetzt; jeder Spieler am Tisch kann seine eigene Sprache nutzen

### Geändert
- Spielregeln-Button aus der Topbar entfernt (Regeln bleiben im Hauptmenü erreichbar)

## [1.1.0] - 2026-07-02

### Neu
- Spielregeln-Übersicht in der App: 📖-Button im Hauptmenü und ❓-Button in der Topbar öffnen die kompletten Regeln (Ziel, Glücksgriff, Zugablauf, Kombinationen mit Ring-Folgen, Joker, Punkte, Spielende)

## [1.0.2] - 2026-07-02

### Geändert
- Ingame-Version steht jetzt rechtsbündig auf der Zeile von "Du bist am Zug" (kostet keine eigene Zeile mehr, auch im Querformat sichtbar)

## [1.0.1] - 2026-07-02

### Geändert
- Die Bestätigung beim Umschalten der Anzeigegröße erscheint jetzt mittig im Bild
- Versionsnummer auch im Spiel sichtbar (rechts unter der Topbar) - Tap öffnet "Was ist neu?"

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

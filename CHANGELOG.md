# Changelog

Alle nennenswerten Änderungen an Pik Dame werden hier dokumentiert.
Format nach [Keep a Changelog](https://keepachangelog.com/de/), Versionierung nach [SemVer](https://semver.org/lang/de/):
**MAJOR** bei Regel-/Bruch-Änderungen, **MINOR** bei neuen Features, **PATCH** bei Fehlerbehebungen.

## [1.41.1] - 2026-07-05

### Fixed
- KRITISCH: v1.41.0 machte die App unbenutzbar - Browser und PWA blieben dauerhaft bei "Verbinde..." hängen. Ursache: Die neue Deal-Animation griff beim allerersten Initialisieren (noch vor dem ersten Server-Zustand) auf den Spielzustand zu und ließ das gesamte Client-Skript abstürzen. Behoben - und damit so etwas nie wieder passiert, startet ab jetzt bei jedem Testlauf der ECHTE Client in einer simulierten Browser-Umgebung (Lobby- und Spielzustand); jeder Fehler dieser Klasse lässt die CI sofort rot werden

## [1.41.0] - 2026-07-05

### Added
- Karten-Deal zum Rundenbeginn ist jetzt sichtbar: Die 15 Handkarten fliegen gestaffelt vom Nachziehstapel in den Fächer und landen exakt in ihrer Position - einmal pro Runde, unter einer Sekunde, aus bei "Bewegung reduzieren"
- Avatar-Chips: Jeder Spieler bekommt einen runden Avatar mit Initiale und einer stabilen, aus dem Namen berechneten Farbe (Bots zeigen 🤖) - gleiche Farbe auf jedem Gerät, in jeder Partie
- Neues Tischthema "Filz": klassisches Kartenspiel-Grün mit warmem Gold-Akzent, wählbar über die Erscheinungsbild-Umschalter (Zahnrad)
- Sieg-Konfetti regnet jetzt auch Kartensymbole: ♠ ♥ ♦ ♣ und die ♛ taumeln in den Deckfarben zwischen den bunten Schnipseln herab

### Changed
- Hinweis: Die Vibration bei "Du bist dran" gab es bereits (Teil des Zugsignals seit v1.28) - Wunsch Nr. 3 war also schon erfüllt

## [1.40.0] - 2026-07-05

### Added
- Spielregeln um einen Hausregeln-Abschnitt ergänzt (Bot-Schwierigkeit inkl. Einzelbot-Umstellung, ⏱ Zug-Timer, Hand-aus-Verdopplung, 1000 streng) - deutsch und englisch synchron
- Impressum & Datenschutzerklärung jetzt zusätzlich vollständig auf Englisch (Courtesy-Übersetzung unter dem deutschen Original; rechtlich maßgeblich bleibt die deutsche Fassung)
- Animierter Lobby-Auftritt: Das ♠-Emblem flippt mit dezentem Überschwung herein, der Titel steigt auf, ein einmaliger Glanz zieht durch - läuft genau einmal pro Laden, respektiert die Bewegungs-Reduzierung des Systems

### Fixed
- Regeltext ans tatsächliche Spiel angeglichen ("Offline-Kartenspiel-Prüfung"): Der letzte Abwurf beim Ausmachen liegt VERDECKT (stand nirgends), die Joker-Tausch-Ausnahme beim Ausmachen fehlte, "Hand aus" beschrieb noch die alte falsche Definition (allererster Zug der Runde statt "vorher nichts ausgelegt"), und das Nachmischen des Ablagestapels bei leerem Nachziehstapel war gar nicht erklärt - jetzt steht auch, dass die oberste Karte dabei liegen bleibt und wann eine Runde unentschieden endet

## [1.39.1] - 2026-07-05

### Added
- Startseite verlinkt das öffentliche GitHub-Repository im Fußbereich (mit GitHub-Symbol, öffnet in neuem Tab) - wie es sich für ein Open-Source-Projekt gehört

## [1.39.0] - 2026-07-05

### Added
- Bereitschafts-Check vor dem SPIELSTART (und vor jeder Revanche): Sitzen zwei oder mehr Menschen am Tisch, meldet sich jeder per 🖐️-Knopf bereit (Häkchen erscheint am Namen, Umentscheiden erlaubt) - der "Spiel starten"-Knopf zeigt "n/m bereit" und wird erst aktiv, wenn alle bestätigt haben; der Server erzwingt das zusätzlich. Solo gegen Bots startet wie gewohnt ohne Zeremonie. Nach einer Revanche melden sich alle frisch bereit

### Changed
- Auslagen liegen jetzt für alle identisch sortiert: Sätze nach Rang aufsteigend, Folgen nach ihrer Startkarte einsortiert (Joker zählen als das, was sie vertreten) - egal in welcher Reihenfolge ausgelegt wurde, und stabil ohne Springen bei jedem neuen Meld

## [1.38.0] - 2026-07-04

### Added
- Zen liest Verschmähtes mit: Zieht ein Spieler verdeckt, obwohl oben eine offene Karte lag, merkt sich der Zen diesen Rang - der Nachfolger konnte ihn (vermutlich) nicht gebrauchen. Solche Ränge gelten fürs Abwerfen gegen genau diesen Spieler als sicherer; bewusst nur ein schwaches Signal (Bluffs existieren), das die harte Evidenz aus Stapelaufnahmen nie übersteuert. Pro Runde frisch, letzte 8 Beobachtungen je Spieler

### Changed
- Hand-Sortier-Umschalter besser erkennbar: Der Knopf rechts über der Hand ("77 Wert" / "♠♥ Farbe") war schon immer ein Umschalter zwischen Wert- und Farbsortierung - jetzt trägt er ein ⇅-Symbol, damit man ihm das auch ansieht
- Hinweis zu zwei gewünschten Features, die bereits an Bord sind: Der Bereitschafts-Check vor der nächsten Runde existiert seit v1.20 (der "Nächste Runde"-Knopf wartet auf alle verbundenen Spieler und zeigt "n/m bereit" - solo gegen Bots startet es deshalb sofort), und das Abzeichen "Hand aus!" beschreibt seit v1.37.1 die korrekte Bedeutung (Text angepasst)

### Fixed
- Zen-Meister warf die Pik Dame im Endspiel auch mit vollen 15 Handkarten ab: Der "letzter Ausweg"-Abwurf (Gegner kurz vorm Ausmachen) prüft jetzt zusätzlich die EIGENE Handgröße - der 100-Punkte-Spar-Tausch lohnt nur bei maximal 6 Karten, mit großer Hand bleibt die Dame liegen
- Der bleibende Rand-Schimmer der frisch gezogenen Karte überlebte bis in die Züge der Gegner - er verschwindet jetzt mit dem Ende des eigenen Zugs

## [1.37.1] - 2026-07-04

### Fixed
- Bots legen Kombinationen aus einer Stapelaufnahme jetzt noch im SELBEN Zug: Der Rest des Ablagestapels landet regelbedingt erst nach dem Pflicht-Legen auf der Hand - die Meld-Planung lief aber nur einmal davor, sodass frisch aufgenommene Sätze (drei Asse!) bis zum nächsten eigenen Zug liegen blieben und bei Rundenende Minuspunkte kosteten. Die Planung läuft jetzt in Durchgängen, bis nichts Neues mehr passt (Regressionstest: die drei Asse aus dem Stapel liegen nach dem Zug auf dem Tisch)
- "Hand aus zählt doppelt" verdoppelt jetzt wirklich: Die Erkennung verlangte bisher ein Rundenende im allerersten Zug der GESAMTEN Runde - praktisch unmöglich, die Regel (und das Hand-aus-Abzeichen) griffen daher nie. Korrekte Definition: Der Gewinner hatte vor seinem letzten Zug noch nichts ausgelegt und legt alles in einem Rutsch - unabhängig davon, in welchem Zug der Runde das passiert

## [1.37.0] - 2026-07-04

### Changed
- Zen-Meister gewichtet Karten-Erschöpfung jetzt voll statt nur im Gleichstand: Er zählte schon immer alle offenen Karten aller Spieler (sämtliche Auslagen, Ablagestapel, beobachtete Stapelaufnahmen) - aber die Erkenntnis "vom 9er-Rang liegen 3 von 8 Kopien auf dem Tisch, die vierte Neun kann kaum noch jemand sofort verwerten" war nur ein Nachrang-Kriterium. Jetzt fließt sie als echtes Gewicht in jede Abwurfwahl ein (beobachtete Gegner-Handkarten zählen dreifach, Erschöpfung immer), auch im Endspiel-Abwurf bei Punktgleichheit. Per Test bewiesen: Liegt der 9er-Drilling aus, wirft Zen die vierte Neun statt des teureren Königs; ohne den Drilling weiter den König. Winrate gegen "Schwer" stabil bei 35 %. Hinweis: Gegen "Mittel" schrumpft der Abstand Richtung fair - erwartbar, denn Mittel ist seit v1.36.1 durch den eigenen Damen-Schutz messbar stärker geworden (♠Q-Abwürfe von ~0,5 auf ~0,02 pro Partie)

## [1.36.1] - 2026-07-04

### Changed
- Auch MITTEL-Bots verschenken die Pik Dame nicht mehr: Der alte "Notabwurf ab 8 Handkarten" ist gestrichen - ab Stufe Mittel bleibt die Dame auf der Hand, solange irgendetwas anderes abwerfbar ist. Nur LEICHT wirft sie weiterhin sorglos (Anfänger-freundlich)
- Hand-Leiste klebt jetzt garantiert am unteren Rand und ist noch einen Hauch flacher (Karten 62×90, engere Polster) - mehr Tisch, weniger Rahmen. Die Aa-Größenstufen bleiben unverändert

### Fixed
- Changelog-Anzeige: Ein alter 1.26.1-Eintrag klebte ganz oben in der Datei, alle neueren Versionen rutschten darunter - chronologisch einsortiert, und ein neuer Wächter-Test erzwingt ab jetzt strikt absteigende Versions-Reihenfolge

## [1.36.0] - 2026-07-04

### Changed
- Zen-Meister mit Damen-Disziplin: Der Endspiel-Modus warf ab "Gegner hat 4 Karten" stumpf die teuerste Karte ab - und mit 100 Punkten war das fast immer die Pik Dame, ein Geschenk an den Tisch. Jetzt gibt Zen sie nur noch als allerletzten Ausweg her (Gegner steht mit maximal 2 Karten vorm Ausmachen) UND nur, wenn kein Gegner sie per Regel-Simulation sofort an eine ausliegende Kombination anlegen könnte - reines Rechnen mit offenen Informationen. Gemessen über 330 Selbstspiele: ♠Q-Abwürfe pro Partie von medium-Niveau (~0,5) auf 0,21 gesenkt, Winrate gegen "Schwer" auf 35 % gestiegen (Bestwert, fair wären 25 %)
- Selbstspiel-Werkzeug zählt jetzt ♠Q-Abwürfe pro Schwierigkeitsstufe mit - Damen-Verhalten ist ab sofort messbar statt gefühlt

### Fixed
- Tages-Challenge war nicht wirklich deterministisch: Das Abheben (Lucky Cut) würfelte seinen Schnittpunkt ungeseedet und verwürfelte damit einen Teil des eigentlich identischen Decks - je nach Schnittlage bekamen Spieler leicht unterschiedliche Hände. Der Cut wird jetzt im Challenge-Modus aus dem Runden-Seed abgeleitet: gleiche Abhebe-Zeremonie, garantiert gleiche Karten für alle. Aufgedeckt durch einen "unerklärlich" flackernden Determinismus-Test - der CI-Flake der letzten Releases war in Wahrheit dieser Bug

## [1.35.3] - 2026-07-04

### Changed
- Stapel-Zone (Nachziehen/Ablage) wieder kompakt und ganz nach unten gerückt, direkt über die Hand - der gesamte Freiraum gehört jetzt den Auslagen darüber. Die schwebende Mittigkeit aus v1.35.1 hat sich in der Praxis als Platzfresser erwiesen: ausgelegte Karten sehen schlägt schwebende Stapel

## [1.35.2] - 2026-07-04

### Fixed
- Repo-Hygiene: SQLite-Nebendateien (users.db-shm/-wal des lokalen Konten-Stores) waren versehentlich eingecheckt - aus dem Repo entfernt und samt der Datenbank selbst dauerhaft in die .gitignore aufgenommen. Es handelte sich ausschließlich um lokale Test-Artefakte; die echte Konten-Datenbank liegt unberührt auf dem Server-Volume

## [1.35.1] - 2026-07-04

### Fixed
- Tote Zone in der Tischmitte (Hochformat): Die Stapel (Nachziehen/Ablage) klebten direkt über der Hand, während sich der Auslagen-Bereich den gesamten Freiraum nahm - jetzt teilen sich beide den Platz und die Stapel schweben vertikal mittig im freien Bereich; bei vollen Auslagen weichen sie sauber zurück
- Kartenfächer bei vollen Händen: Die Absenkung der Randkarten wuchs unbegrenzt mit der Handgröße (bei 15 Karten hing der äußerste Joker 14 Pixel versetzt unter der Reihe) - der Fächer-Bogen ist jetzt auf 6 Pixel gedeckelt, alle Karten bleiben in der Linie
- ♠Q-Wasserzeichen auf dunklen Themes (z. B. Herzdame) etwas kräftiger - es war praktisch unsichtbar

## [1.35.0] - 2026-07-04

### Added
- Challenge-Intro statt Kaltstart: Der 🗓️-Button öffnet jetzt zuerst eine Erklärung (gleiches Deck für alle, Bestenlisten-Regeln, 7-Tage-Sichtbarkeit) samt Live-Anzeige, wer heute führt - erst "Los geht's!" startet die Partie. Neuer Mini-Endpoint /challengeboardz liefert dafür die Tages-Top-5

### Changed
- Hauptmenü entrümpelt: Tutorial und Challenge stehen als halbbreite Chips nebeneinander, und die fünf Meta-Buttons (Statistik, Spielregeln, Konto, Sprache, Anzeigegröße) bilden eine kompakte 2-Spalten-Werkzeugzone statt eines Button-Turms - klare Hierarchie: großer Start-Button, Beitreten, leise Werkzeuge
- Zieh-Glow deutlich verlängert (4 statt 1,6 Sekunden) - die frisch gezogene Karte ist jetzt wirklich zu erkennen, bevor der Effekt in den dezenten Rand-Schimmer ausklingt

## [1.34.1] - 2026-07-04

### Changed
- Kompaktere Hand-Leiste im Hochformat: weniger Luft über dem Kartenfächer, unter der Punktezeile bleibt nur noch die Geräte-Schutzzone (Home-Balken), und die Karten sind moderat kleiner (66×95 statt 72×104) - zusammen rund 35 Pixel mehr Platz für den Spieltisch. Die Aa-Größenstufen "Groß" und "Sehr groß" behalten ihre eigenen, unveränderten Kartenmaße

## [1.34.0] - 2026-07-04

### Added
- PWA-Selbst-Aktualisierung: Der Server stempelt seine Version beim Ausliefern in den Client; erkennt eine laufende (PWA-)Instanz beim Start, dass der Server neuer ist als ihr eigener Stempel, lädt sie sich einmalig automatisch neu - mit Schleifenschutz (max. ein Versuch pro 5 Minuten; hilft auch das nicht, erscheint ein klarer Hinweis, die App einmal komplett zu schließen). Zusammen mit der no-cache-Auslieferung aus v1.33.2 bleiben installierte Apps damit dauerhaft ohne Zutun aktuell

## [1.33.2] - 2026-07-04

### Fixed
- "Karten gezogen, plötzlich war der Nächste dran": Zwei Zug-Timer-Lücken geschlossen - der Hausregel-Countdown wurde auch für kurz getrennte Spieler (WLAN-Aussetzer) armiert und konnte VOR der 75-Sekunden-Schonfrist feuern; und ein vor dem Verbindungsabriss gestarteter Timer beendete den Zug trotz laufender Schonfrist. Jetzt gilt: getrennte Plätze gehören ausschließlich der Schonfrist-Logik, und wer nach einem Aussetzer zurückkehrt, bekommt einen frischen vollen Countdown
- Veraltete Browser-Clients nach Server-Updates (Ursache der "internen Codes" bei den Erfolgen und unsichtbar feuernder neuer Features wie dem Zug-Timer): Der Server liefert alle Dateien jetzt mit Cache-Control: no-cache aus - Browser prüfen bei jedem Laden kurz nach (winziges 304 bei unverändert) und haben nach jedem nächtlichen Update sofort den passenden Client. Einmalig hilft Neuladen bzw. Cache leeren, danach nie wieder

## [1.33.1] - 2026-07-04

### Changed
- Runden-/Geber-Anzeige ("R1 · du gibst") sitzt jetzt oben links als zweite Kopfzeile direkt unter dem Home-Button; der Zug-Status ("Du bist am Zug") ist linksbündig statt zentriert - beide teilen sich dieselbe linke Flucht. Unten links bei der Hand bleiben Fortschrittsbalken und Punktestand

## [1.33.0] - 2026-07-04

### Added
- 🗓️ Tages-Challenge: Ein Tipp auf dem Startbildschirm, und du sitzt sofort am Tisch - gegen drei mittlere Bots, mit einem Deck, das per UTC-Datums-Seed für ALLE Spieler weltweit identisch gemischt ist (jede Runde deterministisch, aber verschieden). Am Partieende landet dein bestes Tagesergebnis in der Tages-Bestenliste (Top 10 direkt im Ergebnis-Overlay, eigener Platz hervorgehoben); mehrere Versuche erlaubt, nur der beste zählt. Einträge verfallen automatisch nach 7 Tagen - Datenschutzerklärung entsprechend ergänzt (Spitzname empfohlen)

## [1.32.0] - 2026-07-04

### Added
- Persönliche Rekorde im Profil: Ein Tipp auf die eigene Zeile in der Hauptmenü-Statistik klappt die Details auf - beste Einzelrunde, ♠Q-Bilanz (ausgelegt/erwischt), ausgelegte Joker und "Hand aus"-Siege. Die beste Partie steht als eigene Spalte in der Tabelle. Alle Werte werden ab jetzt bei jedem Spielende automatisch fortgeschrieben
- Fünf neue Abzeichen: 👯 Doppeldame (beide ♠Q in EINER Runde), 💥 Monsterrunde (300+ Punkte in einer Runde), ⚔️ Zen-Bezwinger (Partie mit einem Zen-Meister am Tisch gewonnen), 🏃 Marathon (10 Partien), 🎯 Damenjägerin (10 ♠Q insgesamt ausgelegt) - insgesamt jetzt 13 sammelbare Erfolge

## [1.31.0] - 2026-07-04

### Added
- ⏱ Zug-Timer als Hausregel (Aus / 30 / 60 / 90 Sekunden): Läuft die Zeit eines menschlichen Spielers ab, spielt die Bot-Logik genau diesen einen Zug transparent zu Ende ("⏰ Zeit abgelaufen - der Zug von Anna wird automatisch zu Ende gespielt.") - der Tisch wartet nie wieder auf Tagträumer. Der Countdown tickt rein clientseitig gegen die Server-Deadline (null zusätzlicher Server-Verkehr), färbt sich ab 10 Sekunden rot, überlebt Server-Neustarts und lässt Bots unberührt

## [1.30.0] - 2026-07-04

### Changed
- Pik Dame ohne Dauer-Leuchten: Der permanente Ring auf der ♠Q in der Hand ist entfernt - Glow gibt es nur noch kurz beim Ziehen/Aufnehmen einer Karte
- Header aufgeräumt (UI/UX-Überarbeitung): 🏠 ganz links (Navigation), Zug-Status mittig, 😀 und ⚙️ rechts (Aktionen); die Zahnrad-Gruppe klappt nach links aus und enthält jetzt auch die Versionsanzeige. Runde und eigene Punkte wohnen unten links bei der Hand - direkt unter dem Fortschrittsbalken, wo der Blick ohnehin ist

### Fixed
- Datenschutzerklärung zur IP-Adresse entsprach nicht der Realität: Der Reverse-Proxy führt für die Angriffsabwehr (CrowdSec) sehr wohl Zugriffs-Protokolle. Der Text beschreibt das jetzt ehrlich (Art. 6 Abs. 1 lit. f, lokal, keine Weitergabe) - und die Technik wurde dem Versprechen angepasst: Log-Aufbewahrung hart auf 48 Stunden begrenzt (danach automatisch überschrieben); fürs Debugging temporär erhöhbar, dokumentiert in OPERATIONS.md. Der App-Server selbst protokolliert keine IP-Adressen

### Security
- Impressum mit echten Anbieterdaten - und Harvester-Schutz: Kontaktblock wird clientseitig zusammengesetzt (für Menschen sofort lesbar, im Quelltext steht die E-Mail-Adresse nirgends im Klartext; noscript-Fallback mit Entities), die Seite trägt noindex/nofollow und steht in der robots.txt - erreichbar bleibt sie selbstverständlich mit einem Tipp

## [1.29.0] - 2026-07-04

### Changed
- Bot-Stapelaufnahme denkt jetzt in Nutzen statt in Kartenzahl: Der pauschale "nie über ~20 Handkarten"-Deckel ist ersetzt durch eine Verwertbarkeits-Prüfung - vor einer großen Aufnahme (Stapel > 4) plant der Bot einmal voraus, wie viele der Karten er sofort auslegen/anlegen könnte. Ist der Stapel überwiegend totes Gewicht, lässt er ihn liegen; kann er ihn nutzen, greift er zu - 10 Handkarten plus 10 verwertbare Stapelkarten sind ein Power-Move, kein Problem. Kosten: ein seltener Planungs-Durchlauf, keine spürbare Last

### Fixed
- Bot-Schwierigkeits-Badge bei 3 Bots im Hochformat wieder sichtbar und antippbar: Es steckte im Namens-Element und wurde beim Kürzen langer Namen auf schmalen Chips einfach mit abgeschnitten - jetzt sitzt es als eigenes Element fest in der Chip-Ecke, unabhängig von Namenslänge und Chip-Breite

## [1.28.0] - 2026-07-04

### Changed
- Zen-Meister bekommt ein faires Gedächtnis: Er merkt sich jetzt genau die Karten, die der GANZE Tisch gesehen hat - wer den Ablagestapel aufnimmt, dessen aufgenommene Karten bleiben "im Hinterkopf", bis sie sichtbar wieder aus der Hand verschwinden (Abwurf, Auslage, Anlage, Joker-Tausch). Verdeckt gezogene Karten werden konstruktionsbedingt NIE erfasst - das Gedächtnis wird ausschließlich aus öffentlich beobachtbaren Ereignissen gebaut, nicht aus den echten Händen (per Fairness-Test abgesichert). Der Zen nutzt es doppelt: präzisere Kartenzählung (aufgenommene Karten sind für ihn nicht mehr ziehbar) und sichereres Abwerfen (wer sichtbar zwei Zehnen geschluckt hat, bekommt keine dritte serviert). In Bot-Selbstspielen kaum messbar - Bots horten dank Hand-Deckel selten Stapel; der Vorteil zielt auf menschliche Vielnehmer

## [1.27.0] - 2026-07-04

### Added
- Mehrfach-Anlegen: Mehrere passende Handkarten (z. B. zwei Zehnen an den Zehner-Drilling) lassen sich gemeinsam auswählen und mit EINEM Tipp an die eigene Auslage anlegen. Der Server prüft alles-oder-nichts und findet die richtige Reihenfolge selbst (Bube vor Dame an 8-9-10); die grüne Zielmarkierung erscheint nur, wenn wirklich alle gewählten Karten gemeinsam passen. Joker weiterhin einzeln (ihr Platz will gewählt sein)
- ♠Q-Wasserzeichen dezent im Spieltisch-Hintergrund - man erkennt sofort, dass man am Tisch sitzt
- 12 neue Rundenstart-Sprüche (DE+EN)
- Bot-Selbstspiel-Messwerkzeug `scripts/sim-bots.js`: Winraten pro Schwierigkeitsstufe, damit Bot-Tuning datengetrieben bleibt

### Changed
- Eigener Fortschrittsbalken sitzt jetzt direkt unter der Hand (breiter und besser sichtbar) statt im Kopfmenü
- Zen-Meister nachgeschärft und erstmals VERMESSEN: Endspiel-Modus greift einen Zug früher, wirft dabei aber keine Karten mehr aus fast fertigen Kombinationen (das tat er vorher!), und unter gleichwertigen Abwurf-Kandidaten wählt die Kartenzählung die nachweislich "toteste" Karte. Selbstspiel über hunderte Partien: Zen gewinnt ~30-33 % der 4er-Runden (fair wären 25 %) und ist damit messbar der stärkste Bot; mehr Dominanz begrenzt der Glücksanteil des Kartenspiels

### Security
- Sitzplatz-Schutz: Die (notwendigerweise öffentliche) Spieler-ID reicht nicht mehr, um einen Platz zu übernehmen - der Reconnect verlangt ein geheimes, kryptographisch zufälliges Platz-Token, das nur der eigene Browser kennt und das Server-Neustarts übersteht. Vorher konnte jeder Mitspieler mit einer abgelesenen ID in einem zweiten Tab fremde Handkarten einsehen
- Nachrichten-Drossel pro Verbindung (~25/s, harte Trennung bei Flut) ergänzt die bestehenden Schutzmaßnahmen (Join-Bruteforce-Sperre pro IP, 16-KB-Nachrichtenlimit, Namens-Bereinigung, Emote-Whitelist)
- Neues Kapitel "Security model" in docs/OPERATIONS.md dokumentiert das Bedrohungsmodell: Server ist autoritativ, fremde Hände/Nachziehstapel werden nie übertragen, alle Prüfungen sind O(1) und kosten keine spürbare Performance

## [1.26.1] - 2026-07-03

### Changed
- Zieh-Markierung final vereinfacht: Punkt/Balken komplett entfernt - der Glow-Effekt allein markiert die frisch gezogene Karte (heller Aufleucht-Moment, der in einen dezenten Rand-Schimmer ausklingt, bis die Karte gespielt wird)

## [1.26.0] - 2026-07-03

### Added
- 💡 Spiel-Tipps abschaltbar: Der wiederkehrende Bedien-Tipp ("Tipp: 3+ Karten auswählen...") lässt sich hinterm Zahnrad dauerhaft ausblenden (💡 → 💤) - die Einstellung wird auf dem Gerät gespeichert und gilt über Sitzungen hinweg. Pflicht-Hinweise (z. B. der Anlege-Zwang nach einer Stapelaufnahme) bleiben bewusst immer sichtbar; die Datenschutzerklärung nennt die Hinweis-Einstellung jetzt mit

## [1.25.0] - 2026-07-03

### Added
- Fortschrittsbalken zum 1000-Punkte-Ziel: jeder Gegner-Chip und die eigene Punkteanzeige tragen einen kleinen Farbverlaufs-Balken (grün → gelb → orange) - der Spielstand ist auf einen Blick erfassbar
- Delta-Spalte in der Rundenende-Tabelle: die Punkte der Runde erscheinen pro Spieler als "+85 ▲" (grün) bzw. "-40 ▼" (rot)

### Fixed
- Klick auf die Version zeigt jetzt auch im Online-Betrieb den Changelog: Die CHANGELOG.md fehlte im Docker-Image (.dockerignore blockte *.md, der Server fiel still auf einen Einzeiler zurück) - sie wird nun explizit mitgeliefert
- Lesbarkeit aller Overlays generell repariert: Die gedämpfte Textfarbe ist für den dunklen Spieltisch abgestimmt und war auf den hellen Overlay-Karten kaum lesbar (Spielregeln "Ziel & Karten", Hauptmenü-Statistik u. a.) - sie wird jetzt zentral pro Overlay-Karte dunkel überschrieben, ein Fix für alle Stellen

## [1.24.0] - 2026-07-03

### Added
- ↩️ Weiterspielen-Button auf dem Startbildschirm: Der zuletzt besuchte Tisch wird gemerkt und ist mit einem Tipp wieder betretbar (perfektes Gegenstück zum Home-Button); existiert der Tisch nicht mehr, verschwindet das Angebot automatisch

### Changed
- Hauptmenü-Untertitel erneuert: "Das Familien-Rommé - online mit Freunden & Bots" statt des veralteten Hotspot-Slogans
- Datenschutzerklärung an die Benutzerkonten angepasst: neuer Abschnitt zu optionalen Konten (E-Mail nur zur Bestätigung, Passwörter ausschließlich als scrypt-Hash, 90-Tage-Sitzungs-Token, Serverstandort), Mailgun EU als Auftragsverarbeiter für Bestätigungs-Mails benannt, Speicherdauer inkl. 48h-Verfall unbestätigter Registrierungen ergänzt; der Grundsatz-Abschnitt behauptet nicht länger "keine Konten, keine E-Mail-Adressen"

### Fixed
- Die grüne Markierung am Rundenende zeigt jetzt den Spieler, der ausgemacht hat: Der Gewinner trägt den grünen Ring am Chip und ist in der Ergebnis-Tabelle grün hinterlegt (mit 🏆); der Zug-Ring erlischt mit Rundenende, statt verwirrend stehenzubleiben

## [1.23.0] - 2026-07-03

### Added
- 🏠 Home-Button im Spiel: führt (mit Bestätigung) zurück zum Startbildschirm; der Platz bleibt reserviert und ist mit dem Spiel-Code jederzeit wieder einnehmbar
- ⚙️ Aufgeräumter Header: Textgröße, Sound, Vollbild und Historie sind standardmäßig hinter einem Zahnrad verstaut - ein Tipp klappt sie aus (Fishdom-Stil); Emote-Button bleibt direkt erreichbar

### Fixed
- Kurzes Minimieren der App beendet nicht mehr die eigene Runde: Beim Verbindungsverlust übernimmt der Bot erst nach einer Schonfrist von 75 Sekunden (vorher sofort - ein Relikt aus dem Hotspot-Modus). Rückkehr in der Frist bricht die Übernahme ab, der Tisch sieht eine transparente Log-Meldung, und nach einem Server-Neustart werden laufende Fristen neu aufgezogen

### Changed
- Bots (ab Mittel) füttern die Damen-Jäger nicht mehr: Solange noch eine Pik Dame auftauchen kann, werfen sie weder Damen (beliebiger Farbe - sie könnten einem Gegner den Satz für die +100-Auslage vervollständigen) noch Pik König/Bube (die Folgen-Nachbarn der Pik Dame) ab, sofern Alternativen existieren
- Primärer Betriebsmodus ist ab jetzt der gehostete Docker-Stack; der Hotspot-Modus bleibt funktionsfähig, wird aber nicht mehr aktiv optimiert (in CLAUDE.md verankert)

## [1.22.0] - 2026-07-03

### Added
- Bot-Schwierigkeit pro Bot einstellbar: Jeder Bot trägt sein Stufen-Badge sichtbar am Gegner-Chip (🌱 Leicht, 🙂 Mittel, 🔥 Schwer, 🧘 Zen-Meister). Ein Tipp aufs Badge öffnet die Auswahl - mitten im Spiel änderbar, mit transparenter Log-Meldung ("Anna stellt Uwe auf Schwer."). Die Lobby-Einstellung bleibt als Standard für neu erzeugte Bots; der Chip-Tipp selbst behält seine Auslagen-Filter-Funktion

## [1.21.0] - 2026-07-03

### Added
- 🎓 Tutorial-Modus für neue Spieler: Der Button auf dem Startbildschirm startet ein normales Spiel gegen leichte Bots, in dem kontextuelle Hinweise jede Regel genau dann erklären, wenn sie zum ersten Mal relevant wird - Ziehen (inkl. der Zwei-Phasen-Ablagestapel-Regel), Auslegen und Anlegen, Pik Dame, Joker, die Nur-per-Abwurf-Ausmachen-Regel, Rundenwertung. Jeder Hinweis erscheint einmal ("Verstanden ✓"), ist jederzeit abschaltbar, und nach dem letzten Hinweis verabschiedet sich das Tutorial von selbst. Läuft komplett clientseitig und damit auch offline in der CodeApp

## [1.20.0] - 2026-07-03

### Added
- Rundenende-Bereitschafts-Check: Die nächste Runde startet erst, wenn JEDER verbundene menschliche Spieler auf "Weiter" getippt hat - niemand wird mehr an der Rundenstatistik vorbeigehetzt. Der Button zeigt den Stand ("Nächste Runde (1/3 bereit)" bzw. "Warte auf Anna, Ben..."); Bots und getrennte Spieler blockieren nie, ein Verbindungsabbruch während des Wartens gibt den Tisch sofort frei
- Emotes am Rundenende: Reaktions-Buttons direkt im Ergebnis-Overlay, eingehende Emotes erscheinen dort als Namens-Chips (die Bot-Jubel- und Frust-Emotes waren bisher unsichtbar hinter dem Overlay)
- Neues ⏳-Emote ("Tick tack...") für die sanfte Erinnerung an Grübler
- 14 neue Rundenstart-Sprüche (DE+EN)
- Spielende: Umschaltbare Gesamtübersicht, wie viele Pik Damen und Joker jeder über die ganze Partie ausgelegt hat

### Fixed
- Partie-Rückblick funktioniert jetzt: Er öffnete sich unsichtbar HINTER dem Ergebnis-Overlay (Overlays stapeln in DOM-Reihenfolge). Beim Öffnen weicht das Ergebnis-Overlay, beim Schließen kommt es zurück
- Statistik-Texte im Ergebnis-Overlay sind wieder lesbar: Chart-Beschriftungen und Legende nutzten die hellen Spieltisch-Farben auf der weißen Overlay-Karte
- Markierung der frisch gezogenen/aufgenommenen Karte sitzt jetzt oben LINKS und ist größer - rechts wurde der Punkt im Kartenfächer von der Nachbarkarte verdeckt

### Changed
- Bots blähen ihre Hand nicht mehr auf: Aufnahmen, die zu 20+ Handkarten führen würden, werden übersprungen (beobachtet: ein 23-Karten-Bot, der nichts mehr loswurde)
- Bots wünschen sich keine Pik Dame mehr (Bluff-Emote), wenn bereits beide auf dem Tisch ausgelegt sind

## [1.19.4] - 2026-07-03

### Added
- Update-Skript scripts/server-update.sh als Gegenstück zum Bootstrap: Ein Befehl holt die aktuellen Stack-Dateien von main (compose, Caddyfile, Skripte - .env und secrets/ bleiben unangetastet), korrigiert die Secret-Dateirechte, pullt Images, baut den Custom-Caddy neu und rollt aus; im Betriebshandbuch als Standard-Update-Weg dokumentiert

### Fixed
- Falscher Volume-chown-Befehl im Troubleshooting korrigiert: Wegen cap_drop ALL fehlt selbst root im Container CAP_CHOWN - der einmalige Daten-Volume-chown beim UID-Upgrade braucht exec --privileged

## [1.19.3] - 2026-07-03

### Fixed
- EACCES beim Lesen der Secret-Dateien behoben: Compose-File-Secrets sind Bind-Mounts und behalten die Host-Dateirechte - die als root/600 angelegten Dateien waren für den Non-Root-App-User unlesbar. Der App-User hat jetzt eine feste UID (10001), das Bootstrap-Skript setzt chown 10001 + chmod 400, und das Betriebshandbuch enthält den Troubleshooting-Eintrag inklusive einmaligem Daten-Volume-chown beim Upgrade von älteren Images (App-UID war dort 100)

## [1.19.2] - 2026-07-03

### Fixed
- Watchtower auf den gepflegten Fork nickfedor/watchtower umgestellt: Das originale containrrr-Image ist seit über zwei Jahren unmaintained und crasht auf Docker Engine 29+ in einer Restart-Schleife ("client version 1.25 is too old, minimum supported API version is 1.44"); der Fork ist ein Drop-in-Replacement ohne Konfig-Änderungen

## [1.19.1] - 2026-07-03

### Added
- Troubleshooting-Abschnitt im Betriebshandbuch für den klassischen CrowdSec-Stolperstein: Bouncer erhält 403 an /v1/decisions/stream (Key fehlt/passt nicht; Caddy muss nach .env-Änderung per up -d --force-recreate neu erstellt werden - restart liest die .env nicht neu)

## [1.19.0] - 2026-07-03

### Added
- Server-Bootstrap-Skript (scripts/server-bootstrap.sh): ein Befehl richtet einen frischen Ubuntu/Debian-Host ein - Systemupdates, unattended-upgrades mit nächtlichem Auto-Reboot (04:30), fail2ban für SSH, UFW (22/80/443), Docker aus dem offiziellen Repo und die Prod-Stack-Dateien unter /opt/pikdame
- Caddy als Custom-Build mit einkompiliertem CrowdSec-Bouncer (docker/caddy/Dockerfile via xcaddy) plus crowdsec-Dienst, der Caddys JSON-Access-Log auswertet und Angreifer-IPs bannt; Bootstrap per cscli bouncers add dokumentiert
- SMTP-Ausgang trotz internetlosem App-Netz: dedizierter smtp-egress-Proxy (socat), der ausschließlich smtp.eu.mailgun.org:587 erreicht; die App spricht ihn über das interne pikdame_smtp-Netz an, TLS wird gegen den echten Mailgun-Hostnamen geprüft (neu: PIKDAME_SMTP_TLS_SERVERNAME)
- Auto-Updates des Stacks per Watchtower (täglich 04:00, label-basiert nur App-Image und Postgres-Minor-Updates; Alternativen wie Portainer in docs/OPERATIONS.md eingeordnet)
- Betriebshandbuch erweitert: Server-Bootstrap, DNS-Anleitung (A-Record auf die Server-IP), CrowdSec, SMTP-Egress, Auto-Updates und eine Best-Practice-Checkliste (Offsite-Backups per Cron, Uptime-Monitoring, SSH-Keys, SPF/DKIM, Image-Pinning)

### Changed
- PostgreSQL 18 in allen Compose-Dateien und der CI; Volume-Mountpoint gemäß neuem 18er-Image auf /var/lib/postgresql umgestellt (PGDATA liegt dort versioniert - erleichtert künftige pg_upgrade)
- Landing-Page verlinkt die echte Spiel-Domain play.pikdame.online

## [1.18.0] - 2026-07-03

### Added
- Produktions-Stack docker/docker-compose.prod.yml: Caddy als Reverse-Proxy mit automatischem TLS/ACME (Domain und ACME-E-Mail per Variable), gehärtetes Caddyfile (admin off, HSTS, nosniff, X-Frame-Options DENY, Referrer-/Permissions-Policy, Server-Header entfernt, JSON-Access-Logs, X-Forwarded-For für die IP-Rate-Limits der App)
- Least-Privilege-Netze: caddy_egress (Internet: ACME, später CrowdSec), caddy_pikdame (internal, nur Proxy-Pfad), pikdame (internal, nur App↔Postgres) - App und Datenbank haben keinerlei Internet-Route (dokumentierter Hinweis: das blockiert auch ausgehendes SMTP)
- Compose-File-Secrets für echte Geheimnisse: DB- und SMTP-Passwort liegen als Dateien unter docker/secrets/ und erscheinen nie in Environment oder docker inspect; die App unterstützt dafür generisch *_FILE-Varianten (PIKDAME_DATABASE_PASSWORD_FILE, PIKDAME_SMTP_PASS_FILE), das Passwort wird in die ansonsten geheimnislose Datenbank-URL injiziert
- CI validiert zusätzlich die Prod-Compose (Caddy + Secrets + Netze) bei jedem PR

### Changed
- Alles Docker-Spezifische in den Unterordner docker/ verschoben (Dockerfile, alle drei Compose-Dateien, Caddyfile, .env.example, secrets/); CI, Release-Workflow, Backup-/Restore-Skripte und Doku auf die neuen Pfade umgestellt
- Secrets-Leitlinie in docs/OPERATIONS.md: File-Secrets für Geheimnisse, .env nur für unkritische Konfiguration, Swarm-Secrets erst mit Swarm relevant

## [1.17.0] - 2026-07-03

### Added
- Konten-Datenbank auf PostgreSQL umgestellt (Docker/K8s-Stack): Beide Compose-Dateien bringen einen gehärteten postgres:16-alpine-Service mit (Healthcheck, eigenes Volume, nicht am Host exponiert), die App wartet per depends_on auf die gesunde Datenbank. Design-Begründung: Eine geteilte, netzwerkfähige DB ist die Voraussetzung, um jemals mehr als eine Instanz zu fahren - lokales SQLite auf einem Volume schließt das strukturell aus. Redis wäre als Account-Speicher die falsche Kategorie (Cache, kein System of Record), MariaDB gleichwertig - Postgres ist der robustere Standard
- Neues Backend game/PgAccountStore.js mit identischer API (parametrisierte Queries, case-insensitive Unique-Indizes, scrypt wie bisher); Auto-Auswahl über PIKDAME_DATABASE_URL, ohne die URL bleibt SQLite der Zero-Config-Fallback - die iOS CodeApp ist unberührt (pg ist pure JS und wird lazy geladen)
- Ausfall-Resilienz: Ist Postgres vorübergehend weg, antwortet die Konto-API mit klarer Meldung und erholt sich automatisch; der Namensschutz fällt dabei sicher zu (fail closed)
- CI testet den Postgres-Store gegen einen echten Service-Container; Helm-Chart mit database.url bzw. database.existingSecret; Backup-Skript zieht zusätzlich einen pg_dump

## [1.16.1] - 2026-07-03

### Changed
- SECURITY.md vollständig auf Englisch übersetzt; dabei aktualisiert: Kubernetes-Manifeste und Helm-Chart-Defaults spiegeln die Härtung, npm-Entfernung und OCI-Labels ergänzt

## [1.16.0] - 2026-07-03

### Added
- 🎬 Partie-Rückblick: Nach Spielende lässt sich die Partie Runde für Runde durchblättern - pro Runde Geber, Sieger (oder Unentschieden), Hand-aus-Markierung und eine Tabelle mit Rundenpunkten, Ausgelegt/Hand-Aufschlüsselung, ausgelegten Pik Damen und laufendem Gesamtstand
- 🔔 "Du bist dran"-Hinweis bei Hintergrund-Tab: Der Browser-Titel zeigt es an, und beim Zurückkehren gibt es einen kurzen Toast samt Vibration, falls man (noch) am Zug ist

### Changed
- Bot-Endspiel-Schutz erweitert: Bots meiden den Ablagestapel mit versteckter Pik Dame jetzt auch dann, wenn ein GEGNER nur noch 3 oder weniger Karten hat - die Runde endet dann meist, bevor man die Pik Dame wieder loswird

## [1.15.0] - 2026-07-03

### Changed
- Bots (ab medium) schlucken im Endspiel nicht mehr den Ablagestapel, wenn weiter hinten eine Pik Dame lauert: Mit 4 oder weniger Handkarten ziehen sie stattdessen verdeckt - eine fast gewonnene Runde wird nicht gegen ein 100-Minuspunkte-Risiko getauscht. Liegt die Pik Dame OBEN (sofort auslegbar, +100), bleibt die Aufnahme attraktiv
- Ausgeschiedene Joker werden nicht mehr als eigene Leiste über dem Spielfeld angezeigt (kein Mehrwert - der Tausch steht im Log, die Regel bleibt unverändert: getauschte Joker sind dauerhaft aus dem Spiel)

### Fixed
- Patt-Wächter gegen extrem seltene Endlos-Runden: Kreisen die Karten per Nachmischen ewig, weil niemand mehr auslegen kann, endet die Runde nach 160 auslage-losen Zügen unentschieden (gewertet wie das bestehende Leerstapel-Patt). Im 60-Spiele-Stresstest griff er genau einmal - vorher lief diese Runde endlos

## [1.14.2] - 2026-07-03

### Changed
- README.md und docs/OPERATIONS.md vollständig auf Englisch übersetzt (Struktur und Inhalt von 1.14.1 unverändert); Sprachregel in CLAUDE.md erweitert - übrige Doku-Dateien folgen bei der nächsten Berührung

## [1.14.1] - 2026-07-03

### Changed
- README komplett neu strukturiert: die zwei Betriebsarten (offline per iPhone-Hotspot, gehostet per Docker/Kubernetes) als Leitstruktur mit Vergleichstabelle, Schnellstart je Betriebsart, kompakte Regel- und Feature-Abschnitte, Verweis-Hub auf Betriebshandbuch/SECURITY/k8s/Helm statt Duplikation

### Fixed
- Veraltete README-Aussagen korrigiert: "ein Tisch pro Server" (Multi-Session existiert längst), "keine echten Accounts" (Benutzerkonten seit 1.8.0), "Docker ungetestet" (CI baut, scannt und startet das Image bei jedem PR), CI-Node-Versionen (24 statt 18/20/22), Rundenstatistik zählt AUSGELEGTE ♠Q/🃏

## [1.14.0] - 2026-07-03

### Added
- Helm Chart (helm/pikdame) als empfohlener Kubernetes-Weg: parametrisiert über values.yaml (Host, TLS, Image-Tag, Storage, Secret-Name, Limits), gehärtete Security-Defaults, Recreate-Strategie und Einzel-Replika fest verdrahtet in der Dokumentation
- Chart wird bei jedem Release automatisch als OCI-Artefakt auf GHCR veröffentlicht (oci://ghcr.io/floriandeutsch89/charts/pikdame, Chart-Version = App-Version) - Installation, Upgrade und Rollback als Helm-Einzeiler ohne Repo-Checkout
- CI-Job helm-validate: helm lint plus Template-Rendering in drei Varianten (Defaults, TLS, existingClaim/Secret) bei jedem PR

## [1.13.0] - 2026-07-03

### Added
- Betriebshandbuch docs/OPERATIONS.md: Start, Update, Rollback (versionierte GHCR-Tags), Backup/Restore, Monitoring-Endpunkte
- Backup-/Restore-Skripte (scripts/): konsistente Volume-Sicherung mit kurzem Container-Stopp (SQLite-WAL-Checkpoint + Store-Flush garantiert)
- Kubernetes-Manifeste (k8s/): Deployment (bewusst eine Replika mit Recreate-Strategie - Sessions leben im RAM, SQLite auf dem PVC), Service, Ingress mit WebSocket-Timeouts, PVC; Pod spiegelt die komplette OWASP-Härtung (non-root, readOnlyRootFilesystem, drop ALL, Seccomp); Anleitung inkl. Secrets und Backup in k8s/README.md
- .env.example als Vorlage für Produktions-Secrets (SMTP, Basis-URL); .env ist git-ignoriert, Compose-Dateien verweisen per env_file-Block darauf

### Changed
- Dockerfile auf Multi-Stage umgestellt (deps-Stage, minimales Laufzeit-Image) mit OCI-Labels; der Release-Workflow ergänzt Version und Commit als Labels am GHCR-Image
- stop_grace_period 30s in beiden Compose-Dateien - der Graceful Shutdown (Session-Snapshot + Store-Flush) bekommt garantiert genug Zeit
- .dockerignore auf den minimalen Build-Kontext reduziert (nur server.js, game/, public/, Manifeste)

## [1.12.0] - 2026-07-03

### Changed
- Node 24 statt 22: Docker-Image (node:24-alpine), CI und Konsistenz-Prüfung laufen auf der aktuellen LTS-Linie
- Englisch als verbindliche Code-Sprache: beide GitHub-Workflows, Dockerfile und beide Compose-Dateien vollständig auf englische Kommentare und Step-Namen umgestellt; Sprachregel in CLAUDE.md verankert (Code/Workflows/Infra englisch, nutzersichtbare Texte bleiben deutsch über das i18n-System, Bestandskommentare wandern per Boy-Scout-Regel bei jeder Berührung)

## [1.11.0] - 2026-07-03

### Added
- OWASP-Docker-Härtung in beiden Compose-Dateien: alle Capabilities entzogen (cap_drop ALL), Read-only-Dateisystem (beschreibbar nur data/-Volume und ein noexec-tmpfs für /tmp), explizites AppArmor-Standardprofil, Prozess-Obergrenze gegen Fork-Bomben (pids_limit 256), Datei-Deskriptor-Limits
- CI-Job docker-security: Dockerfile-Lint (hadolint) und Trivy-Schwachstellenscan des Images (Fehler ab HIGH bei fixbaren CVEs)
- CI-Job docker-smoke: fährt die voll gehärtete Compose-Konfiguration real hoch (Ubuntu-Runner mit aktivem AppArmor), wartet auf healthy, prüft /healthz und /statusz und verifiziert die effektive Härtung per docker inspect
- SECURITY.md: Abbildung aller OWASP-Regeln auf ihre Umsetzung, Host-Pflichten (Rootless Mode, Docker-Updates, Daemon-Socket) und Hinweis für SELinux-Hosts

## [1.10.0] - 2026-07-03

### Added
- Automatische Releases: Bei jedem Push auf main erzeugt ein Workflow Git-Tag und GitHub-Release, sobald die Version in package.json neu ist - die Release-Notes werden aus dem passenden CHANGELOG-Abschnitt ausgelesen
- Docker-Image auf GHCR: ghcr.io/floriandeutsch89/pikdame-local (latest + vX.Y.Z, amd64 und arm64 - läuft damit auch auf Raspberry Pi und Apple Silicon)
- docker-compose.ghcr.yml: Beispiel-Compose mit dem fertigen GHCR-Image (kein lokaler Build nötig), inkl. aller Best-Practice-Blöcke

## [1.9.0] - 2026-07-02

### Fixed
- Rundenstatistik zeigte für Pik Dame (♠Q) und Joker (🃏) immer 0: Die Spalten zählten die Karten AUF DER HAND (am Rundenende fast immer leer) statt der AUSGELEGTEN - jetzt zählen sie, wer wie viele Pik Damen und Joker ausgelegt hat

### Added
- Bots heißen jetzt Uwe, Inge, Maria, Heinz & Co. (16 Namen, zufällig ohne Duplikate) statt "Bot 1/2/3" - das 🤖-Symbol kennzeichnet sie weiterhin
- CLAUDE.md: Projekt-Kontext (Constraints, Architektur, Workflow) für KI-gestützte Weiterentwicklung
- CI: eigener dependency-check-Job (npm outdated + npm audit) und Konsistenz-Prüfung Dockerfile-Node == CI-Node

### Changed
- Gegner-Chips bleiben im Hochformat auch bei 3 Bots auf EINER Zeile (Chips teilen sich die Breite, kompakte Einheiten "Kt/Pkt", Volltext im Tooltip)
- docker-compose nach Best Practices: Ressourcen-Limits (1 CPU / 512M - trägt die 200-Session-Obergrenze mit Reserve), Log-Rotation (10m×3), no-new-privileges, deprecated version-Key entfernt
- SQLite im WAL-Modus mit busy_timeout (empfohlene Server-Betriebsart)
- CI testet nur noch auf Node 22 (identisch mit dem Docker-Image; Konto-Tests laufen damit immer echt)
- Dockerfile-Kommentare auf Englisch
- CHANGELOG nutzt die klassischen Keep-a-Changelog-Kategorien Added/Changed/Fixed (rückwirkend umgestellt)

## [1.8.2] - 2026-07-02

### Fixed
- Client: Eine kaputte/unerwartete Server-Nachricht (oder ein Render-Fehler) konnte den Verarbeitungsdurchlauf ungefangen abbrechen - jetzt wird geloggt und der nächste Spielzustand heilt die Anzeige
- Client: Alle 23 localStorage-Zugriffe abgesichert - im Safari-Privatmodus oder bei vollem Speicher läuft die App ohne Persistenz weiter, statt beim Start zu sterben
- Server: Unerwartete Fehler in der Konto-API antworten jetzt sauber mit 500, statt die HTTP-Antwort offen hängen zu lassen
- Server: Die Zähler-Tabelle des Konto-API-Rate-Limits wird periodisch geleert (wuchs sonst im Dauerbetrieb mit jeder IP unbegrenzt)
- Server: SQLite-Datenbank wird beim Herunterfahren sauber geschlossen

### Added
- 4 dauerhafte Vertrags-Tests: jede el()-ID existiert im HTML, keine ungeschützten localStorage-Zugriffe, alle Übersetzungs-Einträge haben ein HTML-Gegenstück, alle Server-Muster sind gültige Regexe - fängt ganze Fehlerklassen künftig in der CI

## [1.8.1] - 2026-07-02

### Fixed
- Absturz "_emoteTimers.add is not a function" nach einem Server-Neustart (z.B. im Hotspot-Betrieb): Die Bot-Emote-Timer landeten im Session-Snapshot und wurden beim Wiederherstellen zu einem kaputten Objekt. Transiente Felder werden jetzt vom Snapshot ausgeschlossen und beim Restore frisch initialisiert - auch bereits gespeicherte alte Snapshots werden repariert

## [1.8.0] - 2026-07-02

### Added
- Benutzerkonten (nur im Docker-Betrieb): Registrierung mit Benutzername/E-Mail/Passwort, Bestätigungs-Mail mit 48h-Link, Login mit 90-Tage-Sitzung. Der Spielername ist nach dem Login fest der Kontoname - Statistik, Erfolge und Siegesserien bleiben so dauerhaft erhalten, und registrierte Namen sind vor Fremdnutzung geschützt (Beitritt nur mit Login)
- Speicherung in SQLite über Nodes eingebautes node:sqlite (data/users.db im Docker-Volume, keine neue Abhängigkeit); Passwörter mit scrypt + Salt, zeitkonstante Vergleiche
- Mailversand ohne Abhängigkeiten: eigener SMTP-Client (STARTTLS/SSL, AUTH LOGIN) - Mailserver wird später per Umgebungsvariablen eingetragen (PIKDAME_SMTP_*), bis dahin landet der Bestätigungslink im Server-Log
- In der iOS CodeApp / im Hotspot-Betrieb (Node < 22 oder PIKDAME_ACCOUNTS=0) bleibt alles wie bisher: die Konto-Oberfläche wird komplett ausgeblendet

### Changed
- Docker-Image auf Node 22 (für das eingebaute SQLite)

## [1.7.1] - 2026-07-02

### Changed
- Landing-README: Caddy-Beispiel ergänzt (automatisches HTTPS + WebSocket-Upgrade ohne Zusatzkonfiguration)

## [1.7.0] - 2026-07-02

### Added
- Landing Page für pikdame.online (`landing/index.html`): eigenständige statische Auswahlseite zwischen Kartenspiel und Schreibblock im Studio-Design, inkl. Hosting-Anleitung (`landing/README.md`, Subdomain-Empfehlung mit nginx-Beispiel)

## [1.6.1] - 2026-07-02

### Changed
- Rundenstart-Sprüche stehen jetzt garantiert volle 5 Sekunden: prioritäre Toasts (Spruch, Endspurt-Warnung, Fehlermeldungen) werden nicht mehr von Aktions-Meldungen ("Bot zieht eine Karte") verdrängt
- Gegner-Chips in Zugrichtung sortiert: der Chip ganz links ist immer der Spieler, der direkt nach dir dran ist
- Geber per ⭐ direkt am Gegner-Chip markiert; die Topbar zeigt nur noch "R3" (bzw. "R3 · Du gibst ⭐") - dauerhaft mehr Platz
- Kartenanzahl und Punkte in den Chips fett hervorgehoben; Topbar-Icons rücken auf schmalen Displays enger zusammen (kein Umbruch)

## [1.6.0] - 2026-07-02

### Added
- Bots reagieren mit Emotes aufs Spielgeschehen - zufällig und leicht zeitversetzt, nie vorhersehbar: Grummeln (😤), wenn jemand den Ablagestapel nimmt; gelegentlicher Pik-Dame-Bluff vor dem Ziehen; Schreck (😱) und Jubel (🎉), wenn eine Pik Dame ausgelegt wird; Reaktionen aufs Rundenende
- Zwei neue Rundenstart-Sprüche ("Der lange Aal schlackert im Nebel", "Per aspera ad astra")

### Changed
- Regel-Fix: Ausmachen geht nur noch per Abwurf der letzten Karte. Auslegen/Anlegen, das die Hand komplett leeren würde, wird abgelehnt - mindestens eine Karte muss für den Abwurf übrig bleiben (die Pflichtkarte vom Ablagestapel führt nie in eine Sackgasse). Die Spielregeln in der App wurden entsprechend ergänzt (DE/EN)

## [1.5.0] - 2026-07-02

### Added
- Kreativer Spruch zum Rundenbeginn (24 Stück, DE/EN): alle am Tisch sehen denselben - wichtige Meldungen wie Endspurt-Warnung oder Glücksgriff haben Vorfahrt

## [1.4.0] - 2026-07-02

### Added
- Erfolgs-Badges: 8 Auszeichnungen (🏆 Erster Sieg, 🚀 Hand aus!, ♠ Damensammler, 👑 Dreifache Dame, 😱 Autsch!, 💯 Punktekönig, 🔥 Siegesserie, 🐢 Comeback) - frisch verdiente werden am Spielende im Ergebnis-Overlay gefeiert, die Sammlung erscheint in der Statistik-Tabelle
- "Letzte Runde?"-Ansage: Steht jemand bei 800+ Punkten, warnt zu Rundenbeginn eine deutliche Endspurt-Meldung (6 Sekunden, zweisprachig), dass die 1000er-Schwelle das Spiel beendet

## [1.3.0] - 2026-07-02

### Added
- Bot-Schwierigkeit einstellbar (Hausregeln): Leicht, Mittel, Schwer, Zen-Meister. Leicht spielt wie ein Anfänger (übersieht Chancen, wirft zufällig ab), Schwer gibt die Pik Dame nie freiwillig her, der Zen-Meister zählt zusätzlich Karten (wirft "tote" Kombinationen ab, deren Partner nicht mehr im Umlauf sind) und schaltet im Endspiel auf Schadensbegrenzung um
- Globale Server-Statistik im Statistik-Overlay: Partien, Runden, ausgelegte und auf der Hand erwischte Pik Damen, "Hand aus"-Runden - anonym über alle Spiele aggregiert
- Neue Familienregel: Pro Spieler nur EIN Satz je Kartenwert - weitere Karten dieses Werts werden angelegt statt einen zweiten Stapel zu eröffnen (Folgen/Straßen sind weiterhin mehrfach erlaubt)

### Fixed
- Bots werfen nie mehr einen Joker ab: harte Garantie in der Abwurf-Logik, alle Notfall-Pfade bevorzugen Nicht-Joker, und bei einer Nur-Joker-Hand werden die Joker an eigene Auslagen angelegt statt verschenkt

### Changed
- Benachrichtigungen (Toasts) erscheinen jetzt zentriert in der Bildmitte und bleiben länger stehen (4 statt 2,6 Sekunden)
- Fehlermeldungen des Servers (z.B. "Ablagestapel kann nicht aufgenommen werden") erscheinen zusätzlich als 5 Sekunden langer Toast in der Bildmitte

## [1.2.0] - 2026-07-02

### Added
- Sprachumschalter Deutsch/Englisch (🌐-Button im Hauptmenü, Standard: Deutsch, pro Gerät gespeichert) - komplette Oberfläche, Spielregeln, Spiel-Log und Fehlermeldungen werden übersetzt; jeder Spieler am Tisch kann seine eigene Sprache nutzen

### Changed
- Spielregeln-Button aus der Topbar entfernt (Regeln bleiben im Hauptmenü erreichbar)

## [1.1.0] - 2026-07-02

### Added
- Spielregeln-Übersicht in der App: 📖-Button im Hauptmenü und ❓-Button in der Topbar öffnen die kompletten Regeln (Ziel, Glücksgriff, Zugablauf, Kombinationen mit Ring-Folgen, Joker, Punkte, Spielende)

## [1.0.2] - 2026-07-02

### Changed
- Ingame-Version steht jetzt rechtsbündig auf der Zeile von "Du bist am Zug" (kostet keine eigene Zeile mehr, auch im Querformat sichtbar)

## [1.0.1] - 2026-07-02

### Changed
- Die Bestätigung beim Umschalten der Anzeigegröße erscheint jetzt mittig im Bild
- Versionsnummer auch im Spiel sichtbar (rechts unter der Topbar) - Tap öffnet "Was ist neu?"

## [1.0.0] - 2026-07-02

Erstes stabiles Release - das komplette Familien-Kartenspiel als Web-App.

### Added
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

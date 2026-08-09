# Changelog

Alle nennenswerten Änderungen an Pik Dame werden hier dokumentiert.
Format nach [Keep a Changelog](https://keepachangelog.com/de/), Versionierung nach [SemVer](https://semver.org/lang/de/)

## [2.5.0] - 2026-08-09

Auswertung eines PageSpeed-Insights-Berichts plus der Meldung, dass die Google
Search Console beim Live-Test nur den Studio-Vorspann zu sehen bekam.

### Fixed
- **Suchmaschinen sahen nur das Studio-Logo**: Der Vorspann liegt ab dem ersten Bild per CSS über der Lobby - der Live-Test der Search Console rendert genau dieses Bild, Startbildschirm und SEO-Text lagen darunter. Crawler (Googlebot, Bingbot, Lighthouse und weitere) überspringen den Vorspann jetzt vollständig und finden Lobby, Knöpfe und `seoIntro`-Text sofort im gerenderten DOM. Nachgewiesen mit echtem Chrome hinter der echten Caddy-Konfiguration
- **Jeder Seitenaufruf lud alles neu**: Die Dateien wurden mit `no-cache` ausgeliefert, aber ohne Kennzeichnung - „bitte nachfragen" ohne etwas zum Nachfragen. Der Browser holte `client.js` (~220 kB) bei JEDEM Aufruf komplett. Mit `ETag` antwortet der Server bei unverändertem Stand mit 304 und 0 Byte Inhalt; die Selbstaktualisierung nach einem Release bleibt unberührt, weil die Version in der Kennzeichnung steckt
- **Zwei Dateien blockierten die Anzeige unnötig**: `vendor-qrcode.js` (~55 kB) stand im Kopf, obwohl es nur beim Öffnen des QR-Fensters gebraucht wird - es wird jetzt erst beim Klick geladen. `i18n.js` und `client.js` laufen per `defer` nach dem Aufbau der Seite
- **Überschriften sprangen von h1 auf h3**: Die vier Abschnitte des Startbildschirms (Tagesaufgaben, Spieleranzahl, Sitzordnung, Hausregeln) sind jetzt h2 - eine übersprungene Ebene ist für Screenreader ein echtes Hindernis
- **Zoom war gesperrt**: `user-scalable=no, maximum-scale=1.0` verhinderte das Vergrößern. iOS-Safari ignoriert das seit Jahren ohnehin, für alle anderen war es eine Barriere

### Added
- **Reduzierte Bewegung überspringt den Vorspann** ganz (vorher lief eine ruhigere Fassung). Wer ihn in den Einstellungen ausdrücklich auf „voll" gestellt hat, bekommt ihn weiterhin
- **Content-Security-Policy** im erzwungenen Modus, dazu `Cross-Origin-Opener-Policy`. Alles wird von der eigenen Herkunft geladen; das einzige eingebettete Skript ist über seinen sha256-Wert erlaubt. Der WebSocket steht ausdrücklich in `connect-src`, weil Safari `wss://` nicht immer als eigene Herkunft anerkennt
- `test/csp-contract.test.js`: rechnet den sha256-Wert aus `index.html` neu aus und lässt den Bau scheitern, wenn er nicht mehr zur Caddy-Konfiguration passt - sonst würde die Sperre still zuschlagen und der Startbildschirm bei jedem Aufruf kurz aufblitzen. Prüft zusätzlich, dass keine fremde Herkunft eingebunden wird
- `test/splash-crawler.test.js`: startet den echten Client und hält beide Seiten fest - Crawler bekommen kein Vorspann-Element und hinterlassen NICHTS im Sitzungsspeicher, ein normaler erster Besuch bekommt den Vorspann wie gewohnt
- **Verkleinerte Auslieferung im Docker-Bild**: Ein eigener Bau-Abschnitt (`scripts/minify-assets.js`, esbuild) verkleinert JS und CSS - 437 kB werden zu 234 kB, über die Leitung fällt `client.js` von 74 auf 43 kB und `style.css` von 36 auf 19 kB. **Das Verzeichnis im Projekt bleibt unverändert lesbar**: Der Hotspot-/CodeApp-Betrieb liefert `public/` direkt aus dem Checkout aus und bleibt bau-frei. `index.html` wird bewusst NICHT angefasst, sonst passte der sha256-Wert der Sicherheitsregel nicht mehr
- `.gitattributes`: LF in jeder Arbeitskopie. Der sha256-Wert der Sicherheitsregel wird über die tatsächlich ausgelieferten Bytes gebildet - eine Windows-Arbeitskopie mit CRLF ergäbe einen anderen Wert und ein gesperrtes Skript

### Changed
- Symbole werden einen Tag lang zwischengespeichert (sie ändern sich zwischen Veröffentlichungen nicht); alles andere fragt weiterhin bei jedem Aufruf nach

## [2.4.0] - 2026-08-09

Durchspielen des Tutorials im Browser (Telefon- und Desktop-Layout) - der Modus
lief, aber mehrere Lektionen erreichten den Lernenden nie.

### Fixed
- **Der Hinweis-Balken verdeckte die Kopfzeile** - in BEIDEN Layouts lagen `Du bist am Zug` und die Rundenzeile darunter. Ausgerechnet die Zeile, auf die das Tutorial selbst verweist („oben steht immer, wer gerade dran ist"). Der Balken hing an einem geratenen `top: 52px`; jetzt sitzt er an der Oberkante und das Layout hält per gemessener Höhe genau so viel Platz frei
- **Die Wertungs-Lektion war nie lesbar**: Am Rundenende lag der Balken *hinter* dem Ergebnis-Fenster. Beim Tippen auf „Nächste Runde" galt der Schritt trotzdem als gesehen - „Wertung verstehen" war abgehakt, ohne je auf dem Bildschirm gestanden zu haben. Der Balken liegt jetzt über den Fenstern, deren Karte rückt entsprechend nach unten
- **„Spiel starten" war unerreichbar**: Der Schritt wartete auf die Lobby, das Tutorial startet seine Runde aber sofort - der Willkommens-Text war toter Code. Damit wurde die Liste nie vollständig, das Tutorial **schaltete sich nie ab** und trug seine Hinweise in jedes spätere normale Spiel. Der Willkommens-Schritt deckt jetzt beide Einstiege ab
- **Die Regel-Erklärung nach einer Ablehnung erschien grundsätzlich nicht**: Die Fehlermeldung belegt den Meldungs-Platz 5 Sekunden lang mit Vorrang, die Erklärung kam nach 0,9 Sekunden ohne Vorrang und wurde jedes Mal verworfen. Sie erscheint jetzt nach der Fehlermeldung - und deckt zusätzlich den häufigsten Anfängerfehler ab (Farben in einer Folge gemischt) sowie „nur ein Satz je Wert"
- **Ein einzeln gewählter Joker bekam keinen grünen Rahmen**, obwohl der Zug erlaubt ist: Die Prüfung wies Joker sofort ab. Sie nutzt jetzt dieselbe Eindeutigkeits-Suche wie das Anlegen mehrerer Karten - mehrdeutige Fälle (beide Enden einer Folge) bleiben weiter unmarkiert
- **„1 Karten"** im Kartenzähler - jetzt „1 Karte"
- **Pik-Dame-Jubel und Protokoll-Meldung überdruckten sich** (beide in der Bildmitte): „Du sicherst dir 100 Punkte" war unlesbar. Die Meldung rückt jetzt unter das Jubel-Feld
- Der Rundenende-Hinweis nannte einen Knopf „Weiter", der „Nächste Runde" heißt
- Der Hinweis unter der Fortschrittsliste behauptete, abgehakt werde nur per „Verstanden" - tatsächlich zählt seit v1.71 auch eine vorübergegangene Situation

### Added
- **Zwei neue Lektionen**: „An eigene Auslage anlegen" (im Text erwähnt, aber nie gezeigt - kein Schritt hatte je ein Anlege-Ziel markiert) und „Joker zurücktauschen" (der Joker-Schritt sprach von „getauschten Jokern", ohne den Tausch je zu erklären)
- Der Schritt „Auslegen" markiert jetzt auch den **Auslegen-Knopf**, der Abwerf-Schritt zusätzlich den **Fächer** - er zeigte vorher nur auf einen Knopf, den es ohne gewählte Karte noch gar nicht gibt
- Die Fortschrittsliste kennt **Bonus-Punkte** für Lektionen, die an einer seltenen Spielsituation hängen (Ablagestapel aufnehmen, Joker-Tausch). Sie zählen nicht mit, sonst wäre 100 % nicht erreichbar
- Rauchtest prüft Willkommens-Schritt und Singular/Plural des Kartenzählers

### Changed
- **„Pik Dame: +100 oder -100" kommt jetzt VOR „Pik Dame auslegen"**: Erst folgte man dem Rat und legte die Dame aus, danach konnte der erklärende Schritt nie mehr auslösen - er setzt sie auf der Hand voraus
- Wer ohne Namen ins Tutorial startet, heißt „Neuling" statt „Spieler417"

## [2.3.2] - 2026-08-09

### Changed
- **Tages-Challenge wieder gegen Zen-Meister** (Tischentscheidung): Die tägliche Herausforderung soll fordernd sein - gleiche Karten für alle, und die stärksten Gegner. Das **Tutorial bleibt bei „mittel"**: Zen-Meister wären als erste Gegner für Anfänger zu hart, und dort ist die Stufe ohnehin bewusst gewählt (die Anfänger-Stufe würfelt beim Abwurf und wäre nicht reproduzierbar)
- Das Erklär-Fenster nennt jetzt „drei Zen-Meister, die stärksten Bots" (deutsch und englisch) - der Text darf nicht wieder etwas anderes versprechen als der Server einstellt
- Ein Test hält beide Stufen getrennt fest: Challenge = Zen, Tutorial = mittel. Beide Modi teilen sich denselben Setup-Weg, damit fällt eine versehentliche Angleichung sofort auf

## [2.3.1] - 2026-08-09

### Fixed
- **Tages-Challenge und Tutorial spielten weiter gegen Zen-Bots**, obwohl Erklär-Fenster und Changelog „drei mittlere Bots" versprachen (Spieler-Report): Der Server setzte die Stufe über `setHouseRules(...)` - die **Bot-Stärke ist aber keine Hausregel**. `setHouseRules` übernimmt nur bekannte Schlüssel und verwarf `botDifficulty` **stillschweigend**, sodass alle Bots auf dem Standard Zen blieben. Es gab keine Fehlermeldung, der Aufruf lief einfach ins Leere
- Beide Solo-Modi nutzen jetzt die neue Methode `setAllBotsDifficulty()`, die ausdrücklich für das serverseitige Setup gedacht ist (ohne die Lobby-Sperre, die in der Challenge sonst jede Änderung verweigert). Sie merkt sich die Stufe außerdem für **später aufgefüllte** Bots - der Server füllt den Tisch erst nach dem Setzen
- Veraltete Fehlermeldung berichtigt: Sie nannte beim Änderungsversuch in der Challenge noch „Zen-Meister für alle"

### Added
- Zwei Tests: Nach dem Setup spielen in Challenge **und** Tutorial alle Bots nachweislich auf „mittel" - auch in der Ansicht, die der Client bekommt. Ein zweiter Test hält die Ursache fest, dass der alte Hausregel-Weg die Stufe **nicht** ändert

## [2.3.0] - 2026-08-08

### Geändert
- Abhängigkeiten aktualisiert (wöchentlicher automatischer Check): pg 8.22.0→8.23.0

## [2.2.0] - 2026-08-08

### Added
- **Fortschritt über Partien hinweg** - drei Ebenen, alle optional:
  - **Tagesaufgaben:** drei aus dem UTC-Datum geseedete Aufgaben, weltweit für
    alle gleich (wie das Challenge-Deck). Stehen auf dem Startbildschirm mit
    Fortschrittsbalken, werden nach jeder beendeten Partie ausgewertet und
    melden sich bei Erfüllung. Zehn Aufgabentypen im Pool
  - **Erfolge-Galerie:** Die 13 Abzeichen blitzten bisher einmal am Partieende
    auf und waren danach unsichtbar. In der Statistik gibt es jetzt eine
    Vitrine mit ALLEN Abzeichen - verdiente mit Datum, gesperrte mit
    Fortschritt („Damenjägerin 4/10")
  - **Stufe & Saison-Rangliste:** Erfahrung pro beendeter Partie, eine Stufe
    und eine Monats-Rangliste. Hängt am KONTO (nicht am Gerät) und steht im
    Konto-Fenster. Erfahrung gibt es fürs **Beenden**, nicht nur fürs Gewinnen;
    ein negativer Endstand kostet nie Erfahrung
  Die Auswertung ist eine reine Funktion über den fertigen Partie-Datensatz
  (`game/Progression.js`) - die Engine bekommt keine Fortschritts-Haken in den
  Spielablauf. Ohne Konto laufen Aufgaben und Vitrine trotzdem (namensbasiert
  wie die übrige Statistik); im öffentlichen Modus bleibt beides aus
- **Favicon.** Jeder Seitenaufruf endete mit einem 404 auf `/favicon.ico`, weil
  kein Icon deklariert war. Jetzt ein lokales SVG (plus PNG-Rückfall) - kein
  Download, Hotspot-Betrieb unberührt
- **Warnung bei halber SMTP-Konfiguration.** Fehlt `PIKDAME_SMTP_USER`/`PASS`
  oder `PIKDAME_MAIL_FROM`, wird ohne AUTH bzw. als `noreply@localhost`
  gesendet - beides lehnen praktisch alle Anbieter ab. Der Server sagt das
  jetzt beim Start (`[mail] WARNUNG: …`) statt Stunden später über eine
  Provider-Fehlermeldung

### Changed
- **Tages-Challenge läuft gegen MITTLERE Bots statt gegen Zen.** Das
  Erklär-Fenster versprach seit jeher „drei mittlere Bots", der Server setzte
  aber `zen` - mit den trainierten ONNX-Modellen ist mittel als Tagesaufgabe
  fordernd genug
- **Produktions-Stack: der Mailserver steht nur noch an EINER Stelle.**
  `PIKDAME_SMTP_RELAY_HOST` speist jetzt sowohl das socat-Ziel des
  Egress-Proxys als auch den Zertifikatsnamen, gegen den der App-Container
  prüft. Vorher waren das zwei fest verdrahtete Kopien derselben Tatsache:
  Anbieter wechseln und die TLS-Prüfung lief still gegen den alten Namen.
  Alle SMTP-Werte sind zusätzlich aus der `.env` überschreibbar, und der
  direkte Weg ohne Proxy ist dokumentiert (eine Zeile `.env` + eine Zeile
  `networks:`)

### Fixed
- **„Weiter" / „Neue Partie" steht wieder im Bild.** Seit der Zeitleiste mit
  den Schlüsselmomenten war die Ergebniskarte höher als der Bildschirm - der
  eine Knopf, den jeder Spieler braucht, war der einzige, für den man scrollen
  musste (auf dem iPhone UND auf 1440×900). Die Karte scrollt jetzt nur noch
  im Inhaltsbereich, die Aktionsleiste ist fest angeheftet; eine Verlaufskante
  zeigt an, dass oben noch mehr steht
- **„Spiel starten" ist in der Lobby ohne Scrollen erreichbar.** Auf dem
  Telefon lag die Hauptaktion unter Code-Banner, Spieleranzahl, Sitzordnung
  und Hausregeln - vier Abschnitte zwischen Ankommen und Starten. Die
  Hauptaktionen sitzen jetzt in einer angehefteten Leiste am unteren Rand,
  die Abschnitte behalten ihre Lesereihenfolge

## [2.1.0] - 2026-08-08

### Added
- **35 neue Sprüche zum Rundenstart** (jetzt 87 statt 52) - weiterhin aus Geber
  und Rundennummer geseedet, damit alle am Tisch denselben Spruch lesen. Ein
  Vertragstest prüft ab sofort, dass jeder Eintrag ein sauberes Deutsch/Englisch-
  Paar ist und kein Spruch doppelt vorkommt
- **`/statusz` nennt den Mail-Treiber** (`"mailDriver": "smtp"` oder `"log"`).
  Damit lässt sich ohne Shell auf dem Server beantworten, ob der Container die
  `PIKDAME_SMTP_*`-Variablen überhaupt gesehen hat
- Neue Tests: Fehlversand-Fallback des Mailers, Durchreichung der Mail-
  Konfiguration in den Compose-Dateien und ein Browser-naher Test (jsdom) für
  das Scroll-Verhalten des Kartenfächers
- **Mail-Doku berichtigt** (`docs/admin/mail.md`): Die dort abgedruckten
  Log-Zeilen gab es so nie im Code - beim Suchen nach `--- MAIL (Log-Fallback`
  oder `Mail verschickt an …` findet man nichts. Jetzt stehen die echten
  `[mail]`-Zeilen drin, dazu ein Abschnitt über das Durchreichen der Variablen
  in den Container und die `mailDriver`-Abfrage über `/statusz`

### Changed
- **Die einfachen Compose-Stacks reichen die Mail-Konfiguration aus der `.env`
  durch** (`PIKDAME_BASE_URL`, `PIKDAME_SMTP_*`, `PIKDAME_MAIL_FROM`). Bisher
  standen diese Zeilen nur als Kommentar in `docker-compose.yml` und
  `docker-compose.ghcr.yml` - wer sie in die `.env` schrieb, bekam sie nie in
  den Container, und die Registrierung meldete weiter „kein Mailserver".
  Nicht gesetzte Variablen bleiben leer, der Log-Fallback ändert sich nicht.
  Der Produktions-Stack bleibt unverändert am Egress-Proxy

### Fixed
- **Registrierung meldet nicht mehr „noch kein Mailserver eingetragen", wenn
  einer eingetragen ist.** Jede nicht zugestellte Mail wurde als „nicht
  konfiguriert" gemeldet - auch die, bei der der SMTP-Server erreichbar war und
  den Versand abgelehnt hat. Es gibt jetzt drei Meldungen: zugestellt, Versand
  fehlgeschlagen (mit Hinweis auf das Server-Log) und kein Mailserver
- **Ein fehlgeschlagener Versand verschluckt den Bestätigungslink nicht mehr.**
  Bei konfiguriertem, aber fehlerhaftem Mailserver stand nur die Fehlermeldung
  im Log - das Konto existierte und konnte nie bestätigt werden. Der Mailtext
  landet jetzt wie im Log-Fallback im Server-Log
- **Der Kartenfächer springt nicht mehr zur frisch gezogenen Karte zurück.**
  Bei einer scrollbaren Hand (ab 16 Karten) zog jeder Neuaufbau der Anzeige die
  gezogene Karte wieder in die Mitte - Scrollen nach links oder rechts war
  praktisch unmöglich. Der Sprung passiert jetzt nur noch nach dem **Aufnehmen
  des Ablagestapels** (wo viele Karten auf einmal dazukommen) und dort genau
  einmal. Der Glow der gezogenen Karte bleibt unverändert

## [2.0.0] - 2026-08-08

Oberflächen-Überarbeitung. Die Spielregeln, das Protokoll und die Sitzungs-
Snapshots sind unverändert - laufende Partien überleben das Update.

### Added
- **Echtes Icon-Set statt Emoji.** Die gesamte Bedienoberfläche (Kopfzeile, Lobby-Knöpfe, Einstellungen, Ergebnis-Fenster) nutzt jetzt Strich-Icons, die inline im HTML liegen: Sie nehmen die Theme-Farbe an, sitzen auf der Schriftlinie und sehen auf jedem iOS-Stand gleich aus. Emoji bleiben dort, wo sie **Inhalt** sind - Bot-Gesichter, Reaktionen, Abzeichen. Kein Download, der Hotspot-Betrieb bleibt unberührt
- **Einstellungen im Spiel als eigenes Fenster** mit beschrifteten Zeilen statt acht 36-px-Symbolen in der Kopfzeile. Jede Zeile nennt ihren Zustand („Sound & Vibration – An"), jede ist 44 px hoch
- **Erscheinungsbild im Spiel umschaltbar:** Die Themen-Auswahl gibt es jetzt auch in den Spiel-Einstellungen, nicht mehr nur in der Lobby. Beide Reihen bleiben synchron
- **Kartenanzahl über der eigenen Hand**, mittig zwischen Einklapp-Pfeil und Sortierung - bei 15 überlappenden Karten ist sie nicht abzählbar, entscheidet aber, ob man noch rauskommt
- **Schrift- und Bedienelement-Skala** als CSS-Variablen (`--fs-*`, `--tap-min`, `--ctl-h`). Vorher standen in derselben Knopfreihe 17 px, 15,3 px, 13,6 px und 12,24 px nebeneinander
- **Startbildschirm mit Karten-Motiv:** drei aufgefächerte Karten mit der ♠Q statt nur des Schriftzugs - der erste Blick sagt jetzt „Kartenspiel" statt „Formular"
- **Rundenende nennt den Sieger im Klartext** („Erika gewinnt die Runde") mit der Rundenpunktzahl groß darunter. Vorher war der Sieger nur eine grüne Tabellenzeile - und weil gewinnt, wer **rausgeht**, stand die höchste Zahl oft bei jemand anderem, was wie ein Anzeigefehler aussah
- **Fortschrittsbalken bis 1000 pro Spieler** im Rundenergebnis: Wie eng die Partie steht, war aus der Punktetabelle allein nie ablesbar
- **Spielende stellt den Sieger nach oben.** „Maria gewinnt das Spiel!" stand als normale Textzeile UNTER den vier Punktezeilen - der wichtigste Satz des Bildschirms, und man musste erst an allem anderen vorbeilesen. Jetzt Kopfzeile mit Krone und Endpunktzahl
- **ONNX-Bots ohne Umgebungsvariable:** `PIKDAME_ONNX` ist jetzt dreiwertig - **nicht gesetzt = automatisch** (die gelernten Bots werden benutzt, sobald Laufzeit UND Modelle vorhanden sind), `1` erzwingt sie (mit lauter Meldung, falls das nicht geht), `0` erzwingt die Heuristik. Wo die Laufzeit fehlt - Standard-Image, Hotspot-/CodeApp-Betrieb - bleibt es still bei der Heuristik, dieser Pfad ändert sich nicht
- **Mail-Einrichtung dokumentiert** (`docs/admin/mail.md`): alle `PIKDAME_SMTP_*`-Variablen, Beispiele für STARTTLS/SSL/offenes Relay, der Log-Fallback ohne Mailserver und eine Fehlertabelle
- Neue Vertragstests: jedes Icon muss ein passendes `<symbol>` haben, reine Icon-Knöpfe brauchen einen zugänglichen Namen, Beschriftungen neben einem Icon müssen im eigenen `<span>` stehen, und jede Scroll-Kante muss sowohl gestaltet als auch tatsächlich gesetzt werden

### Changed
- **Joker tragen eine Krone** statt des 🃏-Emojis - in Handkarten, Auslagen und auf dem Ablagestapel, in der Joker-Farbe des jeweiligen Themes
- **Geister-Beschriftung am Joker zeigt in Sätzen nur noch den Wert.** Mit Farbsymbol sah der Joker im Satz aus wie eine echte ♥/♠-Karte; in **Folgen** bleibt das Symbol, weil man die Folge daran liest
- **Spielverlauf ist ein richtiges Fenster** (unten eingeblendet am Telefon, Seitenspalte am großen Bildschirm) mit Titelzeile und Schließen-Knopf, statt eines 240-px-Kastens ohne Überschrift, der hinter den Einstellungen verschwand
- **Einklapp-Knopf der Hand** ist ein Pfeil, der sich dreht - vorher wechselte er zwischen „⌄" und „⌃ 15 Karten" und veränderte dabei Breite und Schriftgröße
- **Punkte-Anzeige färbt sich nach Bedeutung:** Akzentfarbe nur, solange man wirklich vorn liegt, Rot bei negativem Stand, sonst neutral. Vorher stand -245 im selben Grün wie ein Sieg
- **Leerer Bereich zwischen Auslagen und Stapeln** liegt jetzt in einem weichen Lichtkegel - der Platz gehört bewusst den Auslagen, sah aber wie ein Layout-Fehler aus
- Die Reaktions-Leiste schließt sich beim Tippen irgendwo anders
- **Startbildschirm aufgeräumt:** Statistik, Regeln, Konto, Sprache und Einstellungen liegen in EINER Symbolreihe statt in fünf vollbreiten Knöpfen, die genauso schwer wogen wie „Neues Spiel erstellen". Die Themen-Auswahl ist in die Einstellungen umgezogen (Aussehen wählen, bevor man den Namen getippt hat, ist nicht die erste Entscheidung), und „Spiel starten" erscheint erst, wenn es etwas zu starten gibt - vorher stand dort ein ausgegrauter Knopf ohne Funktion
- **Reaktionen am Rundenende schieben nichts mehr herum.** Die Namens-Chips lagen im Textfluss zwischen Überschrift und Reitern - jeder ankommende und wieder verschwindende Chip verschob die Reiterleiste und landete auf ihr. Sie schweben jetzt in der oberen rechten Ecke der Karte
- **Reaktions-Auswahl ist eine Reihe gleich großer runder Ziele** statt sieben grauer Kästchen unterschiedlicher Breite, in der die ♠Q-Reaktion als kleine Spielkarte aus der Reihe fiel
- **Die Sieger-Karte fährt auf und zählt die Punkte hoch** (Krone landet einen Wimpernschlag später). Der Höhepunkt einer Runde bzw. Partie war bisher einfach da. Bei „Bewegung reduzieren" steht die Zahl sofort
- **„Schlüsselmomente" ist eine Zeitleiste** statt Emoji-Sätzen: Rundenchip an der Schiene, Überschrift, Detailzeile und die Punktverschiebung rechts - grün oder rot, je nachdem, ob der Moment geholfen oder wehgetan hat
- **Rundenende: Nebenaktionen liegen unter „Mehr".** Rückblick, Export, Aufgeben und Hauptmenü standen als vier gleichwertige Knöpfe unter „Weiter" - die Hauptaktion musste man suchen
- **Reiter „Ergebnis/Statistik" sind wieder lesbar:** Sie malten mit den Farben des DUNKLEN Tisches auf die helle Ergebniskarte - der inaktive Reiter war praktisch weiß auf weiß. Jetzt ein Segment-Umschalter in Kartenfarben

### Fixed
- **Zeigen auf eine Handkarte verdeckte am PC alle rechten Nachbarn.** Die Karte unter dem Zeiger wurde per `z-index` nach vorn geholt und lag damit genau über deren schmalen Klickstreifen - man musste erst wieder herausfahren, um die nächste Karte zu treffen. Rückmeldung kommt jetzt wie bei der Auswahl über einen kleinen Versatz nach oben; die Stapelreihenfolge bleibt unangetastet (derselbe Fehler war für `.selected` und `.just-drawn` längst behoben, nur `:hover` fehlte). Ein Vertragstest hält das jetzt fest
- **Das Rundenergebnis zeigte bei vier Spielern nur drei Zeilen** - der Sieger wanderte in die Kopfzeile und fiel aus der Liste. Jetzt stehen wieder alle in der Liste, die Fortschrittsbalken sind damit auch vergleichbar
- **Kartenrücken aus den Einstellungen wurde nicht übernommen.** Die Freischalt-Prüfung liest das Spielerprofil, beim Start ist das aber noch nicht geladen - ein freigeschalteter Rücken (Gold, Nachtblau, Joker) galt dadurch bei jedem Laden als gesperrt und fiel still auf „Klassisch" zurück. Die Auswahl selbst war nie weg, nur der Nachziehstapel zeigte sie nicht
- **Hinweis auf eine neue Version ist jetzt ein Banner statt eines 4-Sekunden-Hinweises.** Auf dem iPhone-Startbildschirm liefert ein Neuladen oft wieder dieselbe zwischengespeicherte Fassung - dort steht jetzt sofort das Banner mit dem einzigen wirksamen Weg (App im Umschalter wirklich schließen und neu öffnen), ohne einen Knopf anzubieten, der dort nichts bewirkt
- **Der Bedien-Tipp kam immer wieder.** Er erschien einmal pro eigenem Zug - also 10-15 Mal pro Runde, denselben Satz. Jetzt erscheint er drei Mal und bleibt dann weg; wer ihn erneut sehen will, schaltet die Tipps in den Einstellungen aus und wieder ein
- **Negative Rundenpunkte standen in Grün.** Die Farbe markierte „das bin ich" bzw. den Rundensieger - bei -170 las sich das wie ein Erfolg. Farbe zeigt jetzt ausschließlich das **Vorzeichen** (grün/rot); der eigene Eintrag wird durch eine Akzentlinie am Rand markiert, nicht durch Farbe
- **„Tutorial" war 8 px niedriger als „Challenge".** `#tutorialBtn` trug noch ein `margin-top` aus der Zeit, als die beiden untereinander standen - in der Flex-Reihe fraß das genau diese 8 px. Ein Vertragstest verbietet jetzt ID-Regeln mit Rand/Größe/Farbe für Knöpfe in einer Flex-Reihe (denselben Fehlertyp hatte zuvor `#forfeitBtn`)
- **Kein Weg ins Hauptmenü am Rundenende.** „Hauptmenü" gab es nur nach der ganzen Partie - am Rundenende verdeckt das Ergebnisfenster den Tisch, der Haus-Knopf der Kopfzeile ist also unerreichbar, und es blieb nur „Nächste Runde" oder die ganze Partie aufgeben. Der Tisch läuft weiter und der Spiel-Code holt einen zurück, das Verlassen ist hier also gefahrlos. Am **Spielende** klappt der „Mehr"-Bereich zudem von selbst auf, weil „Weiter" dort nicht mehr der naheliegende Schritt ist
- **„Spiel aufgeben" im Ergebnisfenster verlor sein Icon**, sobald eine Abstimmung lief: Die Beschriftung wurde als Ganzes überschrieben. Der Vertragstest dagegen erkennt diesen Fall jetzt auch, wenn das Element vorher in einer Variablen zwischengelagert wurde
- **Kleine Bedienelemente haben ein 44-px-Tastfeld** (Ablage-Lupe, Hand-Werkzeugleiste), ohne dass sich ihre gezeichnete Größe ändert
- **Kopfzeile lief am iPhone über:** Das Zahnrad klappte acht Symbole in die Kopfzeile - Einstellungs- und Pause-Knopf wurden aus dem Bild geschoben und der Tisch wurde scrollbar. Die Kopfzeile trägt jetzt drei Knöpfe, alle 44 px (Apple-Mindestmaß)
- **Auslagen bekommen Verlaufskanten nach oben und unten** - bisher nur nach unten; eine oben abgeschnittene Reihe sah wie ein Zeichenfehler aus
- **Karten der eigenen Hand kamen dem Fortschrittsbalken bis auf 3 px nahe** und wirkten, als lägen sie darauf. Der Fächer-Überhang steckt jetzt im Kasten
- „Spiel aufgeben" war in den Einstellungen grau statt rot: eine ID-Regel aus der alten Kopfzeile stach die neue Klasse aus

## [1.93.1] - 2026-08-08

### Fixed
- **Große Hand am iPhone: die Verlaufskanten fehlten seit v1.70.0.** Ab 16 Karten (nach einer Stapelaufnahme) scrollt die Hand seitlich - die dezenten Kanten, die zeigen, auf welcher Seite noch Karten liegen, blieben aber aus. Die Funktion dahinter war in v1.70.0 versehentlich mitgelöscht worden, die Aufrufstelle blieb stehen; bei jedem Neuaufbau der Hand flog dadurch ein Fehler, der den Rest der Layout-Routine abbrach - deshalb wurde auch die **frisch gezogene Karte nicht mehr ins Bild geholt**. Am iPhone besonders ärgerlich, weil Safari die Scrollleiste im Ruhezustand ausblendet und die Kanten damit der einzige Hinweis aufs seitliche Scrollen sind
- **Eine Einblendung konnte das Rundenergebnis verdecken:** Hinweise liegen mittig und über allen Fenstern. Stand noch ein Tipp auf dem Schirm, wenn das Rundenende aufging, lag er quer über den Punktezeilen. Eine offene Einblendung verschwindet jetzt, sobald sich ein Fenster öffnet; danach ausgelöste Hinweise (Server-Fehler, Warnungen) erscheinen weiterhin darüber
- **„Pik Dame abwerfen?": die beiden Knöpfe waren verschieden groß und gegeneinander versetzt.** Der Dialog benutzte die Knopfreihe aus der Lobby, deren Regeln nur den Abbrechen-Knopf treffen - „Ja, abwerfen" blieb dadurch schmaler und höher und saß 8px über „Abbrechen". Die Reihe hat jetzt eine eigene Klasse, die alle Knöpfe gleich bemaßt

## [1.93.0] - 2026-08-08

### Added
- **Wochenwertung im Challenge-Fenster:** Neben „Heute führt" stehen jetzt die drei Besten der laufenden Woche. Die Wertung selbst gab es längst (beste **fünf von sieben** Tagen, damit ein verpasster Tag die Woche nicht ruiniert und Regelmäßigkeit mehr zählt als ein einzelner Glückstreffer) - sie war bisher nur nach einer beendeten Partie zu sehen, nicht vor dem Start

### Fixed
- **Zwei Pik Damen in einem Zug: Meldung sagte 100 statt 200 Punkte** (Spieler-Report): Die Ankündigung brach nach der ersten gefundenen Dame ab. Die **Wertung war immer korrekt** - nur die Einblendung zählte nicht weiter. Jetzt werden alle im selben Zug ausgelegten Pik Damen zusammengezählt („♠♠ BEIDE PIK DAMEN! ♠♠ - Du sicherst dir 200 Punkte!"); der seltene Fall, dass zwei verschiedene Spieler gleichzeitig eine legen, wird ebenfalls sauber benannt
- Der Rauchtest prüft die 200er-Meldung; gegengeprüft mit dem alten Verhalten, das dabei wortwörtlich das gemeldete Fehlerbild erzeugt

## [1.92.0] - 2026-08-08

### Geändert
- Abhängigkeiten aktualisiert (wöchentlicher automatischer Check): ws 8.21.1→8.21.3

## [1.91.0] - 2026-07-31

### Changed
- **In Tages-Challenge und Tutorial übernimmt nie ein Bot deinen Platz.** Bisher galt auch dort die normale Regel: Wer sich trennt (App minimiert, Anruf, Bildschirmsperre), dessen Platz übernahm nach 75 Sekunden ein Bot. Für eine Bestenliste ist das wertlos - und im Tutorial hätte der Lernende beim Zurückkommen ein fremdes Spiel vorgefunden
- **Stattdessen: 90 Sekunden Pause.** Trennt sich der Mensch in einem dieser Modi, pausiert das Spiel und wartet. Wer rechtzeitig zurückkommt, spielt einfach weiter
- **Danach: Abbruch ohne Wertung.** Bleibt die Rückkehr aus, wird das Spiel abgebrochen - **keine Punkte, keine Statistik, kein Eintrag in der Bestenliste**, und die Sitzung wird serverseitig entfernt, ist also auch über den Code nicht wiederaufnehmbar. Technisch bewusst über einen eigenen Weg statt über das reguläre Rundenende: Wertung und Speicherung hängen genau daran und werden so gar nicht erst ausgelöst
- Wer nach dem Abbruch zurückkehrt, bekommt eine klare Ansage statt einer stummen Fehlermeldung, und der „Weiterspielen"-Knopf verschwindet

### Added
- Drei Tests: Solo-Modi geben den Platz **auch weit nach** der normalen Übernahmefrist nicht an einen Bot; die Pause meldet eine Frist von ~90 Sekunden und der Abbruch beendet **keine** Runde (damit keine Wertung); ein normales Mehrspieler-Spiel übergibt weiterhin an einen Bot, damit der Tisch nicht stehenbleibt

## [1.90.0] - 2026-07-31

### Added
- **Tutorial spielt jetzt auf einem festen Lehr-Deck:** Bisher lief es auf einem zufälligen Spiel - ob überhaupt ein Satz, ein Joker oder die Pik Dame auftauchte, entschied das Mischglück. Der Seed ist jetzt fest und wurde per Suchskript so ausgewählt, dass die Starthand alles Wichtige zeigt: **vier Dreien** (sofortiger erster Satz), **drei Damen inklusive der Pik Dame** (auslegen bringt +100 statt −100) und **genau einen Joker**. Der Lernende **beginnt** außerdem die Runde, und es gibt keinen Zugtimer
- **Ziel-Markierungen (nur im Tutorial):** Der Hinweis markiert jetzt nicht nur die Karten, sondern auch das **Ziel** der Aktion - den Nachziehstapel beim Ziehen, den Abwerfen-Knopf am Zugende. Karte plus Ziel erzählt den ganzen Zug statt nur die halbe Aktion
- **Zwei neue geführte Schritte:** „Lege die drei Damen aus" (der beste Moment, den Unterschied zwischen +100 und −100 zu zeigen) und „Beende den Zug mit Abwerfen", sobald keine Kombination mehr in der Hand steckt
- **Fehler als Lehrmomente:** Lehnt der Server im Tutorial einen Zug ab, folgt kurz darauf die **Regel dahinter** in einfachen Worten - etwa warum die Ablagekarte nicht genommen werden darf, wenn danach nichts zum Abwerfen übrig bliebe
- **Fortschritts-Checkliste:** Neuer Knopf „Fortschritt" im Hinweis-Banner zeigt alle Lernschritte mit ✅/⬜ und einem Zähler

### Technisch
- Die Bots spielen im Tutorial auf **mittlerer** Stufe: Die Anfänger-Stufe würfelt beim Abwurf, damit wäre der Ablauf nicht reproduzierbar
- Ein Test nagelt die Lehrhand fest (Satz, drei Damen mit Pik Dame, genau ein Joker, Lernender beginnt) - ändert jemand den Seed, schlägt er an, weil die Tutorial-Texte konkrete Karten nennen
- Rauchtest prüft die Ziel-Markierung am Ziehstapel; ein Vertragstest hält fest, dass sie **ausschließlich** bei aktivem Tutorial gesetzt wird und es genau eine Stelle im Code gibt, die sie setzt

## [1.89.0] - 2026-07-31

### Changed
- **„Spiel aufgeben" ist umgezogen** (Nutzer-Report: lag direkt unter „Abwerfen"): Eine endgültige Aktion gehört nicht neben einen Knopf, der in jedem Zug gedrückt wird. Der Aufgeben-Knopf sitzt jetzt in der Kopfleiste hinter dem ⚙️-Zahnrad, bei den übrigen seltenen Aktionen - ein bewusster Tipp entfernt und am anderen Ende des Bildschirms. Läuft eine Abstimmung, zeigt er weiterhin den Stand („🏳️ 1/2"), und der Hinweis-Toast beim Vorschlag bleibt unverändert
- Der Rauchtest stellt sicher, dass der Knopf **nicht** in der Handleiste liegt - gegengeprüft, indem er testweise zurückgeschoben wurde

### Documentation
- Kommentar im Server berichtigt: Die Tages-Challenge spielt gegen **drei Zen-Bots** (fest eingestellt), nicht gegen „medium"

### Added
- **Determinismus-Test für die Tages-Challenge:** Gleiches Datum ⇒ identische Hand, identische Ablagekarte, identische Stapelgrößen; anderer Tag ⇒ andere Hand. Hält ausdrücklich fest, dass die Challenge nie für einen manuellen Schnitt anhält

## [1.88.3] - 2026-07-31

### Fixed
- **Einstellungs-Menü war trotz Korrektur weiter unlesbar** - mein Fehler beim letzten Release: Der alte Stil-Block blieb **zusätzlich** in der Datei stehen, und zwar *hinter* dem neuen. Bei gleicher Spezifität gewinnt die spätere Regel, also galt weiterhin weiße Schrift auf weißer Karte. Das Duplikat ist entfernt; die korrigierten Farben greifen jetzt wirklich
- Der CSS-Vertragstest hat das nicht bemerkt, weil er nur das **erste** Vorkommen prüfte - genau das falsche. Er stellt jetzt sicher, dass der Abschnitt **genau einmal** existiert, und prüft alle Vorkommen; gegengeprüft mit einem künstlich eingefügten Duplikat

### Added
- **Marken-Ausnahme zur Lizenz** (`BRAND.md`, Verweis in `LICENSE` und `README`): Der Quellcode bleibt MIT-lizenziert, aber **Name, Studio-Zeichen und Vorspann-Animation sind ausdrücklich ausgenommen** - nötig, weil das Zeichen von Code gezeichnet wird, der in den MIT-Dateien mitgeliefert wird. Ausdrücklich weiterhin erlaubt: forken, ändern, betreiben, die Herkunft nennen („ein Fork von Pik Dame") und unveränderte Bildschirmfotos. Nicht erlaubt ohne Erlaubnis: das Zeichen oder den Namen als eigene Produkt-Identität führen oder eine geänderte Fassung damit veröffentlichen. An den Stellen im Quelltext, wo die Marke steckt, steht jetzt ein Hinweis

## [1.88.2] - 2026-07-31

### Fixed
- **Einstellungs-Menü war unlesbar und schlecht gesetzt** (Foto-Report): Die Auswahlfelder zeigten weiße Schrift auf weißer Fläche. Grund: Overlay-Karten sind in **jedem** Theme hell, ich hatte für die Bedienelemente aber die Farben des dunklen Tisches genommen. Jetzt durchgehend Karten-Farben - dunkler Text, dezent getönte Flächen, der Schalter mit weißem Knopf und Akzentfarbe im eingeschalteten Zustand
- **Layout aufgeräumt:** Bedienelemente behalten ihre Breite, dadurch bricht die Beschriftung nicht mehr neben ihr Symbol um („🎴" stand über „Kartenrücken"); der Kartenrücken-Knopf ist kompakt statt bildschirmbreit; „Studio-Logo beim Start" heißt jetzt schlicht „Studio-Logo", der Zusatz steht in der Erklärzeile
- **Erklärzeilen gehören sichtbar zu ihrer Zeile:** Sie standen bisher unter der Trennlinie und wirkten wie eine Einleitung zum nächsten Punkt - jetzt sitzen Zeile und Erklärung im selben Block, die Trennlinie kommt danach

### Added
- **CSS-Vertragstest für Overlay-Karten:** Bedienelemente in Overlays dürfen nicht mit den Farben des dunklen Tisches (`--text`, `--glass-strong`) gemalt werden - genau dieser Griff hatte die weiße Schrift auf weißem Grund erzeugt. Gegengeprüft: Mit den alten Farben schlägt der Test an

## [1.88.1] - 2026-07-31

### Fixed
- **Sprachwechsel ließ den „Weiterspielen"-Knopf in der alten Sprache stehen** (Nutzer-Report): Seine Beschriftung enthält den Spiel-Code und wird deshalb im Code erzeugt statt aus der Übersetzungstabelle geholt - gesetzt wurde sie aber nur einmal, beim Eintreffen der Sitzungsmeldung. Ein späterer Sprachwechsel fasste sie nicht mehr an. Jetzt wird sie beim Umschalten neu erzeugt; dasselbe gilt für die Auswahlfelder im Einstellungs-Menü und den Kartenrücken-Knopf, die aus demselben Grund hätten hängenbleiben können
- Der Rauchtest schaltet jetzt wirklich zwischen Deutsch und Englisch um und prüft, dass der Knopf folgt **und** den Spiel-Code behält - gegengeprüft: ohne die Auffrischung bleibt „↩️ Weiterspielen (AQM93Q)" im englischen Modus stehen

### Changed
- **Handbuch-Menü (readthedocs) eindeutig gemacht:** Jede Rubrik hieß bisher genauso wie ihr erster Eintrag („ADMIN MANUAL" → „Admin manual"), was wie eine Dopplung aussah. Die Rubrik benennt jetzt den Bereich, der Eintrag die Seite („Admin manual" → „Overview"); die Einstiegsrubrik heißt „Start here" statt wie ihre eigene Seite

## [1.88.0] - 2026-07-31

### Changed
- **Eigenes Einstellungs-Menü:** Anzeigegröße, Studio-Logo, Kartenrücken und Debug-Ansicht sind aus der Lobby-Werkzeugleiste in ein Menü hinter **⚙️ Einstellungen** umgezogen - untereinander, mit **Auswahlfeldern** und einem **Schalter** statt durchklickbarer Knöpfe. Der aktuelle Wert ist damit sofort ablesbar, statt sich erst beim Durchtippen zu zeigen; alle Bedienelemente sind mindestens 44 px hoch
- Kurze Erklärzeilen im Menü: „Automatisch" beim Studio-Logo folgt der Systemeinstellung „Bewegung reduzieren", die Debug-Ansicht ist als Werkzeug für die Fehlersuche gekennzeichnet

### Documentation
- **README:** Abzeichen-Zahl von 8 auf **13** berichtigt, „drei Themes" auf **fünf** (inklusive hellem Küchentisch), Tages-Challenge samt Wochenwertung, freischaltbare Kartenrücken und Studio-Vorspann ergänzt; Regeltabelle um die Aufnahme-Beschränkung und die Joker-Beschriftung erweitert
- **CLAUDE.md:** **Sachfehler behoben** - dort stand, bei leerem Ziehstapel werde die Ablage neu gemischt. Das Gegenteil ist der Fall (es wird nie neu gemischt; wer die oberste Ablagekarte nicht nehmen kann, beendet die Runde). Ergänzt: die Aufnahme-Beschränkung aus 1.85.2, die Hausregel-Bindung der „Hand aus"-Verdopplung, der Studio-Vorspann samt seiner Startreihenfolge, der Terraform-Ordner, der wöchentliche Abhängigkeits-Workflow und die Kartenerhaltungs-Garantie als Testdisziplin
- **SECURITY.md:** Härtung des bereitgestellten Servers ergänzt (Cloud-Firewall vor dem Host, Schlüssel-only-SSH, fail2ban über das systemd-Journal, automatische Sicherheits-Updates, Dockge nur per SSH-Tunnel), dazu der wöchentliche Abhängigkeits-Workflow und das Double-Opt-in der Konten
- **Handbuch (readthedocs):** Zug-Beschreibung um die Aufnahme-Beschränkung ergänzt, Bot-Stufen präzisiert

## [1.87.2] - 2026-07-31

### Fixed
- **Beim Start blitzte kurz die Lobby auf, bevor der Vorspann kam:** `client.js` wird am Ende der Seite geladen - die Lobby war also längst gezeichnet, als das Skript den Vorspann einblendete. Der Vorspann liegt jetzt **von der ersten Bildschirmausgabe an** über allem (per CSS statt per Skript). Ein winziges Skript im Seitenkopf entscheidet noch vor dem ersten Bild, ob er überhaupt gezeigt wird - sonst hätte umgekehrt bei jedem weiteren Laden derselben Sitzung kurz das Logo aufgeblitzt. Zusätzlich eine Notbremse in CSS: Sollte das Skript ausfallen, verschwindet der Vorspann trotzdem nach 9 Sekunden

### Changed
- **Grüner Rahmen jetzt auch bei Joker-Auswahlen:** Die Vorschau markierte Auslagen nur, wenn kein Joker ausgewählt war - der seit 1.87.1 gültige Zug (Joker + Bube♦ an 7♦-8♦-9♦) sah dadurch unmöglich aus, obwohl er funktionierte. Die Vorschau spiegelt jetzt dieselbe Suche wie der Server: alle Reihenfolgen, alle Joker-Plätze, Ergebnisse reihenfolgeunabhängig verglichen. Markiert wird **nur bei genau einem** möglichen Ergebnis - bei echter Mehrdeutigkeit bleibt der Rahmen aus, weil der Server dann ohnehin nachfragt
- Der Rauchtest wählt die beiden Karten im DOM wirklich aus und prüft die Markierung; gegengeprüft mit der alten Regel, die dabei korrekt durchfällt

## [1.87.1] - 2026-07-30

### Changed
- **Joker beim Mehrfach-Anlegen: eindeutige Fälle werden jetzt selbst erkannt** (Spieler-Report): Wer an eine Folge 7♦-8♦-9♦ gleichzeitig einen **Joker und den Buben♦** anlegt, meint zwangsläufig Joker = 10♦ - trotzdem kam bisher die Rückfrage „Joker bitte einzeln anlegen". Der Grund: Der Joker allein wäre mehrdeutig (6♦ unten oder 10♦ oben), und geprüft wurde nur die einzelne Karte. Jetzt durchsucht das Spiel **alle Reihenfolgen und alle Joker-Plätze** der gesamten Auswahl; bleibt genau ein Ergebnis übrig, wird es ohne Nachfrage gelegt
- Gefragt wird nur noch bei **echter** Mehrdeutigkeit - etwa Joker + 6♦ an 7♦-8♦-9♦, wo sowohl 5♦-6♦-7-8-9 als auch 6♦-7-8-9-10♦ herauskommen kann. Die Meldung nennt jetzt auch den Grund
- Verschiedene Reihenfolgen mit **demselben** Ergebnis gelten ausdrücklich nicht als mehrdeutig (zwei Zehnen an einen Satz sind egal in welcher Folge dasselbe) - das hätte sonst funktionierende Züge blockiert, was ein Bestandstest sofort aufgedeckt hat

## [1.87.0] - 2026-07-30

### Added
- **Studio-Vorspann „Flodex Interactive":** Beim Öffnen der App wirbeln fünf Klingen herein und rasten zum Ring zusammen; danach steigt der Schriftzug langsam auf. Der Vorspann läuft **einmal pro Sitzung**, Antippen überspringt ihn sofort
- **Einstellung „🌀 Studio-Logo"** in den Lobby-Werkzeugen mit drei Stufen: **Automatisch** (folgt der Systemeinstellung „Bewegung reduzieren"), **Voll** (immer der volle Wirbel) und **Aus** (kein Vorspann). Wer die Bedienungshilfe aktiviert hat, bekommt standardmäßig eine ruhige Fassung, in der die Klingen nur nacheinander aufblenden - kann aber bewusst auf „Voll" stellen

### Technisch
- Der zweite Teil des Vorspanns (Einrasten, Schriftzug) hängt am **tatsächlichen Ende** der Klingen-Animation statt an ausgerechneten Zeitpunkten - feste Verzögerungen und laufende Animationen sind zwei getrennte Uhren und driften auf langsamen Geräten auseinander
- Zwei Sicherheitsnetze: Bleibt das Fertig-Signal aus, startet der zweite Teil per Zeitschaltung; und der Vorspann verschwindet in **jedem** Fall nach spätestens 8 Sekunden. Er kann das Spiel also nie blockieren, auch nicht bei abgeschalteten Animationen
- Der Rauchtest prüft, dass der Vorspann startet **und** sich durch Antippen beenden lässt; gegengeprüft, indem der Start testweise lahmgelegt wurde - der Test schlägt dann korrekt an

## [1.86.1] - 2026-07-29

### Fixed
- **„Hand aus" versprach eine Verdopplung, die nicht stattfand** (Spieler-Report, betraf Tages-Challenge und normales Spiel gleichermaßen): Die Doppelwertung ist eine **optionale Hausregel** („Hand aus zählt doppelt", standardmäßig aus) - Ergebnis-Notiz **und** Spielprotokoll behaupteten sie aber unabhängig davon. Die Wertung selbst war immer korrekt: Ohne aktive Regel wurde nie verdoppelt, die Anzeige log also schlicht. Jetzt erscheint die Notiz nur bei aktiver Regel, und das Protokoll meldet ohne Regel nur noch die Leistung selbst („Hand aus! X hat die komplette Hand in einem Zug ausgelegt.") - ohne Punktversprechen. Die Leistung bleibt in Rekorden, Abzeichen und Schlüsselmomenten weiterhin gewürdigt
- Abgesichert in beide Richtungen: ein Test beweist, dass das Protokoll die Verdopplung nur bei aktiver Regel erwähnt **und** die Rundenwertung dann tatsächlich genau doppelt so hoch ist; der Rauchtest prüft denselben Rundenzustand mit beiden Regelständen im DOM. Beide wurden gegen den fehlerhaften Stand gegengeprüft und lehnen ihn ab

## [1.86.0] - 2026-07-29

### Geändert
- Abhängigkeiten aktualisiert (wöchentlicher automatischer Check): jsdom 30.0.0→30.0.1

## [1.85.2] - 2026-07-28

### Changed
- **Die Abwurfpflicht gilt jetzt ausnahmslos** (Regelentscheidung vom Tisch): Die oberste Ablagekarte darf **nicht mehr aufgenommen werden, wenn das anschließende Pflicht-Legen die ganze Hand verbrauchen würde** - danach bliebe keine Karte zum Abwerfen übrig. Bisher ließ genau dieser Zwang eine Ausnahme zu, sodass man ohne Abwurf ausmachen konnte. Statt die Ausnahme beim Legen zu erlauben, wird nun die Aufnahme verboten: Die Sackgasse entsteht gar nicht erst. Erlaubt bleibt die Aufnahme, wenn noch ein Reststapel folgt (der kommt ohnehin auf die Hand), wenn die Karte an eine eigene Auslage passt (kostet keine Handkarte) oder wenn eine Kombination existiert, die mindestens eine Handkarte verschont
- Die Regel gilt einheitlich an allen drei Stellen, die über Aufnehmbarkeit entscheiden: bei der Aufnahme selbst, beim Hinweis „Nachziehstapel leer - du kannst aber aufnehmen" und bei der Patt-Erkennung. Ein Zug, den es nicht mehr gibt, zählt damit auch nicht mehr als verbleibende Möglichkeit
- Der Regeltext in der App (deutsch und englisch) benennt die Einschränkung ausdrücklich; die dort seit jeher stehende Zusage „mindestens eine Karte bleibt fürs Abwerfen" stimmt jetzt auch technisch
- **Gemessen** (150 Partien, 1022 Runden): Rundenenden ohne Abwurf **0,0 %** (vorher vereinzelt), Patt-Quote unverändert **4,0 %** (Referenzwert 4,3 %) - die Regel greift selten (2 abgelehnte Aufnahmen), ändert also den Spielfluss nicht spürbar. Bots fallen bei abgelehnter Aufnahme sauber auf den Nachziehstapel zurück

## [1.85.1] - 2026-07-28

### Fixed
- **Karten konnten sich verdoppeln - eine Pik Dame tauchte dreimal auf** (Spieler-Report aus der Tages-Challenge): Die Zug-Planung der Bots schrieb ihren Arbeitsstand in die übergebenen Auslagen zurück, um Folgekarten korrekt zu prüfen. Beim Abwägen „Ablagestapel aufnehmen oder nicht?" bekam sie jedoch die **echten** Tisch-Auslagen und rechnete gleichzeitig mit einer gedachten Hand, die den **kompletten Ablagestapel** enthielt. Dadurch landeten Karten in echten Auslagen, ohne die Hand oder die Ablage je zu verlassen - sie existierten doppelt. Die Planung arbeitet jetzt grundsätzlich auf Kopien (abgesichert an der Wurzel, also für alle heutigen und künftigen Aufrufer), und der betroffene Aufrufer übergibt zusätzlich selbst nur noch Kopien
- **Wichtig: Das betraf das reguläre Spiel genauso** - der Fehler war nicht challenge-spezifisch, die Challenge machte ihn nur reproduzierbar sichtbar

### Added
- **Kartenerhaltungs-Test als dauerhafte Garantie:** Zwei neue Tests spielen vollständige Partien durch - eine mit Challenge-Deck (geseedet), eine regulär - und prüfen **nach jedem Zug**, dass die Menge aller Karten im Spiel exakt dem 110-Karten-Deck entspricht; zusätzlich wird ausdrücklich zugesichert, dass nie mehr als zwei Pik Damen gleichzeitig existieren. Ein dritter Test hält die Fehlerursache fest: Die Bot-Planung darf die ihr übergebenen Auslagen nicht verändern. Alle drei wurden gegen den fehlerhaften Stand gegengeprüft und lehnen ihn ab

## [1.85.0] - 2026-07-28

### Geändert
- Abhängigkeiten aktualisiert (wöchentlicher automatischer Check): jsdom 29.1.1→30.0.0

## [1.84.4] - 2026-07-26

### Fixed
- **„Neu gezogen"-Markierung war praktisch unsichtbar** (Foto-Report, in jedem Farbmodell): Der Glow klang in `--accent-soft` aus - einer Farbe mit rund 28 % Deckkraft - und war nach dem kurzen Aufblitzen kaum noch zu erkennen. Die frisch gezogene Karte trägt jetzt dauerhaft denselben kräftigen Akzent-Ring wie eine ausgewählte Karte (nachweislich in allen Themes gut sichtbar), plus weichen Schein; das Aufblitzen ist kürzer, weil der bleibende Ring die eigentliche Markierung ist. Bewusst weiterhin **ohne** z-index - eine nach vorn geholte Karte verdeckte sonst den Klickstreifen der Nachbarkarte im Fächer
- **Glücksgriff- und Pik-Dame-Einblendung sah kaputt aus:** Das Overlay hatte weder Hintergrund noch Rahmenbreite, Innenabstand oder Maximalbreite - der Glanz-Schatten malte deshalb ein hartkantiges, milchiges Rechteck um den Text, aus dem die Überschrift seitlich herauslief. Es ist jetzt ein richtiges Panel (abgerundet, mit Unschärfe hinterlegt, umbrechender Text), und die Schriftfarben kommen aus der Theme-Palette statt aus fest verdrahtetem Weiß bzw. Hellgrün - beides war für dunkle Tische gedacht und auf dem hellen Küchentisch-Theme kaum lesbar
- Beide Fehlerbilder sind per CSS-Vertragstest festgenagelt (Ruhezustand nutzt die volle Akzentfarbe, kein z-index; Overlay definiert Hintergrund/Polster/Maximalbreite/Radius und bezieht seine Farben aus Theme-Variablen) - die Tests wurden gegen den alten Stand gegengeprüft und hätten ihn abgelehnt

## [1.84.3] - 2026-07-25

### Added
- **Terraform: fail2ban und SSH-Härtung** - der Server sperrt jetzt Adressen nach 5 Fehlversuchen für eine Stunde (fail2ban liest das systemd-Journal, weil das Ubuntu-Cloud-Image ohne rsyslog kommen kann und ein dateibasiertes Jail sonst still ins Leere liefe). Zusätzlich: Passwort- und Tastatur-Anmeldung abgeschaltet, root nur per Schlüssel, `MaxAuthTries 3`

### Changed
- **Terraform: Standard-Servertyp auf `cx23`** (aktuelle CX-Generation, 2 vCPU / 4 GB / 40 GB). Der bisherige Standard `cx22` läuft weiter, gehört aber zur Vorgänger-Generation; die Variablen-Beschreibung verweist jetzt auf `hcloud server-type list` zur Prüfung des aktuellen Angebots
- **Terraform-README auf Englisch** (Wunsch), inklusive neuem Abschnitt zur Sicherheitslage (Cloud-Firewall vor dem Host, Schlüssel-only-SSH, fail2ban, automatische Sicherheits-Updates)

## [1.84.2] - 2026-07-17

### Added
- **Terraform-Ordner für Hetzner Cloud** (`terraform/`): Ein `apply` erzeugt einen Ubuntu-24.04-LTS-Server mit Docker (offizielles Docker-Repo) und Dockge als Compose-Verwaltung, samt Cloud-Firewall (nur SSH/80/443 offen - die Dockge-UI ist bewusst nur per SSH-Tunnel erreichbar), automatischen Sicherheits-Updates und Lösch-Schutz für den Server. Standardwerte: x86-Maschine (die GHCR-Images sind amd64) in Falkenstein (Deutschland, passend zur Datenschutz-Angabe); alles per Variable änderbar. Anleitung inkl. Stack-Einspielen über Dockge im `terraform/README.md`

## [1.84.1] - 2026-07-17

### Fixed
- **Double-Opt-in: abgelaufene unbestätigte Konten geben Name und E-Mail wieder frei.** Die Registrierung mit Bestätigungs-Mail war bereits vollständig umgesetzt (Konto erst nach Klick auf den Mail-Link nutzbar, Login vorher gesperrt, Link 48 h gültig) - aber nie bestätigte Konten blieben für immer liegen und blockierten Benutzernamen und E-Mail-Adresse; der Hinweis „bitte neu registrieren" beim abgelaufenen Link lief damit ins Leere. Jetzt räumt jede Registrierung abgelaufene Unbestätigte auf (SQLite und Postgres); ein Rundlauf-Test sichert den kompletten Opt-in-Fluss ab

### Added
- **Wöchentlicher Dependency-Update-Workflow** (`deps-update.yml`): Prüft jeden Montag auf veraltete Pakete. Falls vorhanden: Update auf die neuesten Versionen, Minor-Versions-Bump samt Changelog-Zeile, Pull Request mit angefordertem Review - und **Auto-Merge, sobald alle Checks grün sind** (Chore-Updates brauchen keinen menschlichen Blick). Nur wenn die CI rot ist, bleibt der PR zur manuellen Prüfung offen

## [1.84.0] - 2026-07-17

### Added
- **Kartenrücken-Galerie:** Der 🎴-Chip öffnet jetzt eine Galerie mit allen Rücken als Vorschau-Kacheln - die aktive Wahl ist markiert, gesperrte Designs zeigen 🔒 samt Freischalt-Ziel („ab 10 Siegen"). „Was mir noch fehlt" ist damit sichtbar statt versteckt im Blindzyklus

### Changed
- **Getrennt-Status wohnt jetzt am Spieler-Chip:** Verliert jemand die Verbindung, wird sein Chip gedimmt und trägt ein pulsierendes „⏳ getrennt"-Badge, bis er zurück ist - der flüchtige Riesen-Toast mitten im Spielfeld entfällt dafür (im Protokoll steht die Meldung weiterhin)
- **Joker-Beschriftung, bestätigt für alle Ränge:** Die Geister-Beschriftung aus 1.83.0 liest die vertretene Karte generisch - jede Kombination von 2 bis Ass in allen Farben. Der Rauchtest beweist es jetzt ausdrücklich mit den Rändern des Spektrums (2, Bube, Ass)

## [1.83.1] - 2026-07-17

### Changed
- **Handkarten-Fächer beruhigt bei voller Hand** (Foto-Report, 15 Karten auf schmalem Gerät): Ab 12 Karten flacht der Fächer deutlich ab (Rotation ±4° statt ±10°, Hub 3 statt 6 px) - die Eck-Indizes werden ruhig lesbar, die Karten „tanzen" nicht mehr. Der Seitenrand-Abzug schrumpft mit (der flache Fächer hat kaum Rotations-Überhang), dadurch bekommt jede Karte einen breiteren sichtbaren Streifen und die erste Karte klebt nicht mehr angeschnitten am Rand; Mindeststreifen von 14 auf 16 px angehoben. Die Starthand bleibt bewusst ohne seitliches Scrollen
- **Hinweis-Blase kompakter:** Lange Meldungen (z. B. der Getrennt-Hinweis) bliesen den zentralen Pillen-Toast bildschirmfüllend auf - jetzt engere Breite, abgerundetes Rechteck und ruhiger Mehrzeilen-Umbruch

## [1.83.0] - 2026-07-17

### Added
- **Joker in Auslagen zeigen, welche Karte sie vertreten** (Spieler-Report: Bei „Joker, Bube, Joker" war nicht mehr erkennbar, ob das drei Buben sind oder eine 10-B-D-Folge): Auf jedem ausgelegten Joker steht jetzt klein, kursiv und gedämpft die vertretene Karte (z. B. „B♦") - sofort lesbar ohne Antippen, in der Farbsymbol-Farbe. Das hilft nebenbei beim Joker-Tausch, weil man auf einen Blick sieht, welche echte Karte gebraucht wird. Handkarten-Joker bleiben unbeschriftet (sie vertreten ja noch nichts); per DOM-Test zugesichert

## [1.82.2] - 2026-07-17

### Fixed
- **„Runde undefined" in den Schlüsselmomenten** (Foto-Report): Die Momente-Sammlung las das falsche Feld aus der Rundenhistorie (`round` statt `roundNumber`) - mein Test hatte die Struktur frei nachgebaut statt die echte zu verwenden und übersah es dadurch. Behoben; der Test nutzt jetzt die echte Struktur und sichert zusätzlich zu, dass jeder Moment eine echte Rundennummer trägt
- **Küchentisch-Theme: unlesbare helle Hinweistexte** (Untertitel, „Spiel-Code…", Abschnitts-Hinweise): Das neue Theme definierte 11 der 26 Theme-Variablen nicht (u. a. `--text-muted`, Kartenränder, Farbtöne) - die fehlenden erbten die **hellen** Werte der dunklen Themes: weiß auf hellem Holz. Der Variablensatz ist jetzt vollständig (warme, dunkle Töne), und ein neuer **Theme-Vertragstest** erzwingt maschinell, dass jedes Theme denselben Variablensatz definiert wie die Referenz - unvollständige Themes können nie wieder durchrutschen

## [1.82.1] - 2026-07-17

### Fixed
- **Punkte-Popup zeigte Auslagen mit Joker zu niedrig an** (Foto-Report: Q♦-Joker-A♦ als „+30"): Die Popup-Summe übersprang Joker-Plätze. Das Popup nutzt jetzt **exakt die Wertung der Rundenabrechnung** (Joker zählt 20, wie das Ass) - die korrekte Anzeige für dieses Beispiel ist **+50** (Q 10 + Joker 20 + A 20). Per Test festgeheftet: Popup-Wert == amtliche Rundenwertung

### Hinweis
- Falls eure Familienregel den Auslage-Joker als **vertretene Karte** wertet (im Beispiel als König = 10 → gesamt 40), wäre das eine echte Regeländerung an der Rundenwertung - bitte kurz bestätigen, dann setze ich sie sauber um (inkl. Regeltext, Messung und neuer Trainingsdaten-Version)

## [1.82.0] - 2026-07-16

### Added
- **Punkte-Popups (Brotato-Prinzip: Punkte fühlbar machen):** Beim Auslegen steigt der Wert der Auslage als „+50" auf, beim Anlegen der Kartenwert - und die gelegte Pik Dame bekommt ein großes goldenes „+100" mit Leuchten. Eigene Punkte erscheinen über der eigenen Auslagen-Zone, fremde am jeweiligen Spieler-Chip. Rein kosmetisch, respektiert reduzierte Bewegung
- **Runden-Stempel:** Jeder Rundenbeginn wird mit einem kurzen Vollbild-Stempel („RUNDE 3") gefeiert - nicht beim Neuladen oder Wiederverbinden
- **Bot-Gesichter:** Die Bots sind endlich unterscheidbar - deterministisch aus dem Namen bekommt jeder Bot ein festes Gesicht (👵 🧔 👩‍🦳 …) statt fünfmal 🤖, im Spieler-Chip wie in allen Listen. Erika sieht jetzt immer aus wie Erika
- **🎩 Spott-Titel:** Wer die Partie mit den meisten gefangenen Pik Damen beendet, wird im Ergebnis liebevoll ausgezeichnet („Damen-Magnet der Partie") - rein kosmetisch, natürlich

## [1.81.0] - 2026-07-16

### Added
- **Schlüsselmomente:** Das Partie-Ergebnis erzählt jetzt die bis zu drei dramatischsten Momente der Partie („♠ Runde 2: Flo wurde mit der Pik Dame auf der Hand erwischt - ein 100-Punkte-Schlag"). Rangfolge nach Dramatik: gefangene Dame > „Hand aus" > ausgelegte Dame > beste Einzelrunde
- **Wochenwertung der Tages-Challenge** (Mo-So): Es zählt die Summe deiner **besten 5 Tagesergebnisse** - ein, zwei verpasste Tage ruinieren die Woche nicht, und Stetigkeit schlägt den einen Glückstag. Top 5 + eigener Rang direkt im Challenge-Panel
- **Freischaltbare Kartenrücken** (kosmetisch, an Erfolge gekoppelt): Gold ab 10 Siegen, Nachtblau ab 25 Partien, Joker ab 3× „Hand aus". Auswahl über den neuen 🎴-Chip in den Lobby-Werkzeugen; gesperrte Designs verraten per Antippen ihr Ziel
- **Saisonale Akzente:** Im Dezember rieselt dezenter Schnee über den Tisch (respektiert reduzierte Bewegung), im Oktober gibt es ein 🎃-Emote, um Silvester ein 🎆 - die Bots antworten passend
- **Neues Theme „Omas Küchentisch":** helles, warmes Holz statt dunklem Filz - als fünfte Stimmung im bestehenden Theme-Wähler

## [1.80.1] - 2026-07-16

### Fixed
- **Statistik-Seite: Der Leerzustand erklärt jetzt das Zähl-Kriterium.** Untersuchung der Meldung „Statistik immer leer": Der Speicher-Pfad ist nachweislich intakt (End-to-End-Simulation: komplette Partie → Profil erscheint) - gezählt werden aber **nur regulär bis 1000 Punkte beendete Partien**; aufgegebene oder vorzeitig verlassene Spiele fließen bewusst nicht ein, einzelne Runden sind keine Partie. Der bisherige Hinweis („spielt erstmal eine Runde") war irreführend und behauptete das falsche Kriterium - jetzt steht dort präzise, was zählt und was nicht

### Changed
- **Impressum: E-Mail nur noch per Klick sichtbar** („E-Mail-Adresse anzeigen"). Die Adresse stand zwar nie im statischen HTML (JS-Zusammenbau), aber Headless-Scraper sehen das fertige DOM - jetzt entsteht sie erst nach einem Klick. Ein Klick ist für die Impressums-Erreichbarkeit zumutbar und gängige Praxis

## [1.80.0] - 2026-07-16

### Added
- **Soziale Bots:** Auf ein menschliches Emote antwortet jetzt gelegentlich **genau ein** Bot mit einem passenden Gegen-Emote (mit Varianz - auf 😤 gibt es auch mal Schadenfreude 😂, auf 😱 mal Mitgefühl, mal Gelächter). Bewusst sparsam gehalten: 45 % Chance, tischweiter 8-Sekunden-Cooldown, Antwort nach 0,7-2,2 s („gesehen, kurz überlegt"). Kontext-Reaktion nach Catan-Vorbild: Wer ⏳ schickt, während ein **Bot** am Zug ist, bekommt genau von diesem ein 😤/⏳ zurück. Bots antworten nie auf Bots (keine Kaskaden)
- **Glücksgriff-Reaktion:** Ergattert ein Mensch beim Abheben Pik Dame oder Joker, staunt der Tisch (😱) - Bots feiern ihre eigenen Griffe nicht

### Fixed
- **Pik-Dame-Reaktion kommt jetzt im Moment des Geschehens:** Highlight-Emotes (gelegte ♠Q, Glücksgriff) nutzen ein kurzes Reaktionsfenster (0,15-0,7 s) statt bis zu 1,8 s - vorher wirkte die Reaktion „wie nach dem Zug" (Spieler-Feedback)

## [1.79.2] - 2026-07-16

### Fixed
- **Auslagen-Liste: sichtbare Scroll-Kante.** Die letzte Auslagen-Reihe schnitt hart an der Unterkante ab und der Stapel-Glow strahlte darüber - das sah wie ein Überlappungs-Bug aus (per Debug-Overlay-Screenshot entdeckt), war aber ein Scrollbereich ohne jeden Hinweis. Jetzt: Luft unter der letzten Reihe und eine weiche Ausblend-Kante, solange unten weitere Auslagen liegen (dasselbe Muster wie die seitlichen Hand-Scrollkanten)

### Changed
- Debug-Panel per Antippen zwischen oben und unten umdockbar, damit es bei Diagnosen nicht den Kopfbereich verdeckt

## [1.79.1] - 2026-07-16

### Fixed
- **Hauptmenü tot („Neues Spiel", „Beitreten", „Tutorial" ohne Funktion) - kritischer Hotfix:** Beim PWA-Start kann iOS kurzzeitig altes, gecachtes HTML mit dem neuen Script kombinieren. Das frische Debug-Overlay (1.79.0) griff dann auf noch nicht vorhandene Elemente zu, der ungefangene Fehler brach den Start **vor** dem Verbindungsaufbau ab - und verhinderte ausgerechnet die eingebaute Selbstheilung (Versions-Stempel → automatischer Reload). Der Debug-Start ist jetzt vollständig abgesichert (ein optionales Feature darf den kritischen Startpfad nie brechen), und der Client-Rauchtest fährt zusätzlich einen „Cache-Versatz"-Lauf: neues Script auf altem Markup muss booten und die Verbindung erreichen - dieser Test schlägt mit dem 1.79.0-Stand exakt mit dem Live-Fehler fehl

## [1.79.0] - 2026-07-16

### Added
- **🐞 Debug-Overlay (optional, für Fehlersuche):** In den Lobby-Werkzeugen („🐞 Debug: Aus/An") und im Spiel-Zahnrad zuschaltbar. Zeigt ein 10/50-px-Messgitter, farbige Umrandungen der Schlüssel-Container (App = rot, Screen = orange, Handleiste = cyan, Hand = gelb) und ein Live-Metrik-Panel: alle Viewport-Höhenquellen (innerHeight, visualViewport, 100dvh, gemessene --appvh, tatsächliche App-Höhe **und deren Differenz** - das Lücken-Maß der letzten PWA-Bugs), Safe-Areas, Standalone-Status, Anzeigegröße und Version. Ein Screenshot mit aktivem Overlay macht Layout-Fehlerbilder aus der Ferne exakt vermessbar. Einstellung bleibt gespeichert

### Fixed
- **„Spiel starten" steht jetzt über dem Hauptmenü-Knopf** in der Spiel-Lobby - die Primäraktion zuerst, der Rückweg darunter. Die umgekehrte Reihenfolge (seit 1.77.1) war verwirrend; alle übrigen Menüs folgen bereits diesem Muster (geprüft: Rundenende, Challenge-Intro, Bestätigungsdialoge)

## [1.78.3] - 2026-07-16

### Fixed
- **PWA: Lücke unter der Handleiste bzw. (nach Doppeltipp) oben** - beides dieselbe Ursache: Beim PWA-Kaltstart lieferte die gemessene Fensterhöhe zeitweise einen zu kleinen Wert, der App-Container blieb kürzer als der Bildschirm und ließ sich im entstandenen Spielraum verschieben. Das ist der Spiegelfall des v1.72-Bugs (damals meldete `100dvh` zu wenig, die Messung rettete; jetzt umgekehrt). Die Container-Höhe nimmt jetzt per `max()` **die größere beider Quellen** - damit ist der Viewport in beiden Fehlerbildern gefüllt. Zusätzlich: Messung über `visualViewport` (im Standalone verlässlicher) mit Kaltstart-Nachmessung, und die Gesamtseite ist als nicht verschiebbar markiert (`overscroll-behavior: none`)

## [1.78.2] - 2026-07-16

### Fixed
- **PWA: Doppeltipp auf leere Flächen verschiebt das Bild nicht mehr** - iOS löste dort trotz deaktiviertem Zoom einen Smart-Zoom-Versatz aus. `touch-action: manipulation` unterbindet das (und entfernt nebenbei die 300-ms-Tipp-Verzögerung); Wischen und Scrollen bleiben unberührt
- **Ausgewählte Karten ragten auch bei normaler UI-Größe über die Werkzeugleiste:** Die Auswahl hob Karten doppelt an - einmal per CSS (−14 px, der dokumentierte Mechanismus) und zusätzlich per redundanter Transform-Zeile im Client (−18 px) = 32 px bei nur 6 px Reserve. Die Redundanz ist entfernt, die verbleibende Anhebung hat jetzt ein eigenes Platzbudget im Hand-Container (alle Größenstufen + Querformat angepasst), die Werkzeugleiste liegt zusätzlich immer über den Karten. Der CSS-Vertragstest aus 1.78.1 prüft nun Kartenhöhe **plus Anhebung** gegen jede Container-Höhe

### Added
- **Challenge: „7 Tage sichtbar" gilt jetzt wörtlich.** Die Daten waren nie weg (persistentes Volume, 7-Tage-Aufbewahrung funktionierte) - aber die Anzeige kannte nur den aktuellen Tag, gestern verschwand still aus dem Blick. Die Challenge-Auswertung zeigt jetzt aufklappbar die **vergangenen Tage**: Tagessieger, Teilnehmerzahl und dein eigenes Ergebnis samt Platz pro Tag (leere Vortage werden übersprungen). Kein Watchtower-Problem

## [1.78.1] - 2026-07-15

### Fixed
- **Handkarten sprengten bei UI-Größe „groß"/„sehr groß" den Rahmen** (Foto-Report, PWA und Browser): Die Größenstufen vergrößerten die Karten (bis 112 px), der Hand-Container behielt aber seine Basis-Höhe für 90-px-Karten - die Karten ragten über die Werkzeugleiste, mit ausgewählten Karten (+32 px Anhebung) besonders deutlich. Jede Stufe bringt jetzt die passende Container-Höhe mit (im knappen Querformat entsprechend zurückgenommen). Ein neuer CSS-Vertragstest erzwingt maschinell, dass **jede** Kartengröße in ihren Container passt - er war vor dem Fix rot

### Changed
- **Challenge: „Noch mal probieren":** Nach einer Tages-Challenge heißt der Knopf am Spielende nicht mehr „Neue Partie (Rematch)", sondern **„🔁 Noch mal probieren"** - und startet solo **direkt** dieselbe Challenge neu (gleiches Tages-Deck, deterministisch identische Runde 1, per Test zugesichert), ohne Umweg über die Lobby. Mit mehreren Menschen bleibt das Bereit-Gate erhalten

## [1.78.0] - 2026-07-15

### Changed
- **Abheberegel korrigiert (Missverständnis meinerseits ausgeräumt):** Der abgehobene Packen wird **nicht** für die Runde beiseitegelegt - er kommt nach dem Verteilen **zurück in den Nachziehstapel**. Abheben bestimmt nur, **wo** das Verteilen beginnt; keine Karte verlässt je das Spiel. Der Start-Nachziehstapel ist damit wieder **konstant** (bei 4 Spielern immer 49 Karten: 110 − 60 Handkarten − 1 Ablage) - die in v1.77.2 gemeldeten „schwankenden Stapel" waren die Folge meiner Fehlinterpretation aus v1.71, nicht der Familienregel. Glücksgriff unverändert; die Abhebekarte wird dem Abheber gezeigt und ist schlicht die erste verteilte Karte. Die „Beiseite"-Anzeige aus v1.77.2 ist wieder entfernt (es gibt nichts mehr anzuzeigen)
- **Messbare Folge** (200 Bot-Spiele, 0 Hänger): Die Patt-Quote fällt von ~57 % auf **~4 %** - Runden enden wieder fast immer durch Rausgehen (mittlere Länge 32 Züge). Die Rundenende-Regel selbst bleibt unverändert: Stapel leer + Ablagekarte nicht aufnehmbar → Runde endet, Ablage wird nie neu gemischt
- ⚠️ Durch die geänderte Schnitt-Logik ändern sich die **Tages-Challenge-Decks einmalig** mit diesem Update
- **Trainingsdaten:** Regelversion im Zug-Log auf 3 erhöht; der Trainings-Loader nutzt per Default nur noch rv-3-Daten (die rv-2-Züge entstammen den zwischenzeitlichen Beiseite-Regeln - ein anderes Spiel)

## [1.77.2] - 2026-07-15

### Fixed
- **Der beim Abheben beiseitegelegte Packen ist jetzt am Tisch sichtbar** (Spieler-Report: „In 2 Runden sind 20 Karten vom Ziehstapel weg?!"): Neben der Ablage zeigt ein passiver, gestrichelter Mini-Stapel „Beiseite" mit Anzahl, wie viele Karten der Abheber für diese Runde aus dem Spiel genommen hat. Die Bilanz stimmte immer (per 300-Runden-Simulation erneut verifiziert: Start-Nachziehstapel schwankt regelbedingt zwischen 9 und 38 Karten bei 4 Spielern, alle 110 Karten stets erfasst) - jetzt kann man sie auch **sehen**: Hände + Ablage + Nachziehen + Beiseite = 110
- Flackernden Zug-Timer-Test deterministisch gemacht (bei zufälligem Mensch-Abheber blieb die Testrunde in der Abhebephase hängen - seltener roter CI ohne Codefehler)

## [1.77.1] - 2026-07-14

### Fixed
- **Aus einer erstellten Lobby führt jetzt ein Weg zurück:** Neuer Knopf „🏠 Zurück zum Hauptmenü" in der Spiel-Lobby (vor Spielstart). Vorher saß man nach „Neues Spiel erstellen" fest - selbst ein Neuladen sprang per Auto-Fortsetzen sofort wieder in die Session. Der Server gibt den Sitz frei (Bereit-Status und Punkte werden bereinigt, Bots rücken nach, die Organisator-Rolle geht automatisch an den nächsten Menschen über), der Client vergisst die Zugangsdaten dieser Session und lädt das Hauptmenü. Im laufenden Spiel bleibt der Weg über 🏳️ Aufgeben; E2E-getestet über den echten Server (Beitreten → Verlassen → Sitz frei)

## [1.77.0] - 2026-07-14

### Changed
- **Rundenergebnis in zwei Reitern:** Reiter „Ergebnis" (standardmäßig aktiv) zeigt die tabellarischen Rundenwerte, Gewinner und neue Erfolge; Reiter „📈 Statistik" enthält die Detail-Tabelle, den Punkteverlauf-Graphen und (am Spielende) die Partie-Totals. Vorher stand alles untereinander - bei 4 Spielern rutschte der Weiter-Knopf unter den Falz und man musste scrollen, um die nächste Runde zu bestätigen. Der Statistik-Reiter erscheint nur, wenn er Inhalt hat
- Der Client-Rauchtest rendert das Ergebnis-Overlay jetzt mit einem echten 4-Spieler-Rundenende und prüft die Reiter-Mechanik (Standard-Reiter, Wechsel per Klick) im DOM; dabei wurde der WebAudio-Stub des Tests korrigiert (verkettbares `connect`), der das Overlay-Rendering im Test stillschweigend abbrach

## [1.76.1] - 2026-07-14

### Fixed
- **Pause-Knopf funktioniert wieder.** Der Server pausierte auf Knopfdruck sogar korrekt - aber `paused` und der Abstimmungsstand fehlten in der publicState-Positivliste. Der Client sah daher weder Overlay noch Knopf-Zustand, während alle Züge serverseitig mit „Das Spiel ist pausiert" abgelehnt wurden: Der Knopf wirkte komplett kaputt und das Spiel danach eingefroren. Jetzt sind Pause-Status und Stimmen (`1/2 dafür`) sichtbar, Overlay und Fortsetzen-Knopf greifen; abgesichert per Solo- und Zwei-Spieler-Regressionstest

## [1.76.0] - 2026-07-14

### Changed
  - **ONNX:** Modelle wurde erneut trainiert, um die aktuelle Regelversion zu berücksichtigen.
  - **Docs** ReadTheDocs-Dateien aktualisiert.
  - **CI/CD** Chore: Updated checkout to v5
  - **Docker** Updated compose files to use dockerproxy instead of directly exposing the socket.

## [1.75.0] - 2026-07-14

### Changed
- **Trainingsdaten-Qualität (menschliche Züge für die Bot-Ausbildung):**
  - **Abgebrochene Spiele zählen nicht mehr:** Jede Log-Zeile trägt jetzt ein `outcome` (`completed`/`forfeit`); aufgegebene Partien werden markiert und vom Trainings-Loader standardmäßig übersprungen - halbe Partien lehren halbe Strategien
  - **Regelversion im Log (`rv`):** Alle Daten von vor den Regeländerungen dieser Woche (Packen beiseite, kein Nachschub, Rundenende-Regel) stammen aus einem anderen Spiel - der Loader schließt sie standardmäßig aus (Zeilen ohne Feld gelten als Version 1). Für andere Analysen per Parameter wieder einbeziehbar
  - **Zurückgenommene Stapel-Aufnahmen (↩︎ Zurücklegen) werden nicht mehr geloggt** - ein sofort rückgängig gemachter Zug ist nie passiert und hätte dem Modell Aufnahmen ohne Folgeaktion beigebracht
  - Log-Format-Doku (rl-setup) entsprechend erweitert; Filter per synthetischem Datensatz verifiziert (4 Zeilen → exakt die 1 gültige bleibt)

## [1.74.1] - 2026-07-14

### Changed
- **Zwei Bot-Taktik-Hypothesen gemessen statt geraten** (je 5000 gepaarte Selbstspiele, 4× Zen, unter den neuen Regeln): (1) Kombinationen auf 3 Karten kürzen und den Rest fürs Anlegen behalten → **50,24 % Sieganteil, kein Effekt**. (2) Resthand auf „≡ 1 mod 3" steuern (eine Karte für den Pflicht-Abwurf, Rest in Dreiern - die präzisierte Fassung von „durch 3 teilbar") → **49,24 %, kein Effekt**. Erklärung: Eine zurückgehaltene Karte kann jederzeit an die eigene Auslage angelegt werden - der Bot legt sie meist im selben Zug wieder hin; „Flexibilität durch Zurückhalten" existiert im Regelwerk bereits gratis über das Anlegen. Beide Stellschrauben bleiben als dokumentierte, standardmäßig inaktive Mess-Knöpfe im Code (`capMeldSize`, `mod3Trim`); das Bot-Verhalten ist **unverändert**

## [1.74.0] - 2026-07-14

### Changed
- **Bei leerem Nachziehstapel wird jetzt GAR NICHTS nachgelegt** - auch nicht der beim Abheben beiseitegelegte Packen (v1.73 hatte ihn noch als Nachschub verwendet; das war meine Annahme, nicht die Familienregel). Es gilt schlicht: Kannst du die oberste Ablagekarte aufnehmen, ist das dein Zug - kannst du es nicht, **endet die Runde sofort** und wird gewertet (Auslagen plus, Handkarten minus, kein Gewinner-Bonus). Regeln DE/EN und Doku entsprechend geschärft
- ℹ️ **Messbare Folge** (200 Bot-Spiele simuliert, 0 Hänger): ~57 % der Runden enden jetzt über diese Regel statt durch Rausgehen, mittlere Rundenlänge 24 Züge - die arithmetische Konsequenz aus beiseitegelegtem Packen plus null Nachschub. Falls sich das live zu kurz anfühlt, ist die Stellschraube der erlaubte Abhebe-Bereich (kleinerer Packen = längere Runden)

### Fixed
- **Regel-Audit (angefordert):** Alle Aussagen des Regeltexts wurden systematisch gegen die Engine geprüft - Satz 3-8 Karten mit maximal doppelter Farbe, Folgen bis 13 ohne Wert-Dopplung und mit K-A-2-Ring, verdecktes Ausmachen (letzte Karte nicht aufnehmbar), Anlegen nur an eigene Auslagen, Joker-Tausch nur gegen die exakt repräsentierte Karte und der getauschte Joker dauerhaft aus dem Spiel, Punktwerte 5/10/20/100, Hand-aus-Verdopplung, Abheben/Glücksgriff/Beiseitelegen. **Einzige gefundene Abweichung war das Nachlegen** - mit diesem Release behoben; alles andere entspricht den Regeln

## [1.73.0] - 2026-07-14

### Fixed
- **Ein Spieler konnte unrettbar feststecken** (Spieler-Report mit Screenshot): Nachziehstapel leer, oberste Ablagekarte nicht regelkonform aufnehmbar - ziehen war clientseitig gesperrt, aufnehmen verboten, die Runde lief endlos weiter. Zwei Ursachen: Der Client deaktivierte den Zieh-Klick bei 0 Karten (der Server hätte reagiert, der Klick kam nie an), und die Rundenende-Prüfung wertete einen vollen Ablagestapel als „noch nachmischbar" - wodurch die seit jeher versprochene Ende-Regel praktisch nie zündete

### Changed
- **Familienregel-Rundenende (wie ursprünglich gefordert):** Der Ablagestapel wird **nicht mehr neu gemischt**. Ist der Nachziehstapel leer, wird zuerst der beim Abheben beiseitegelegte Packen nachgelegt; ist auch der aufgebraucht, gilt: Kann der Spieler am Zug die oberste Ablagekarte aufnehmen, ist das sein Zug - **kann er es nicht, endet die Runde sofort und wird ganz normal gewertet** (ausgelegte Karten plus, Handkarten minus, kein Gewinner-Bonus). Regeln DE/EN und Doku entsprechend aktualisiert
- Bots weichen im Endspiel automatisch auf die Ablage-Aufnahme aus, wenn Ziehen unmöglich ist (in der Simulation hingen sonst 2 von 150 Spielen genau dort). 200 Spiele Robustheits-Simulation: 0 Hänger, ~3 % der Runden enden über die neue Regel

## [1.72.1] - 2026-07-14

### Changed
- **Das Caddy-Image wird nur noch gebaut, wenn sich wirklich etwas geändert hat.** Der Build ist langsam (xcaddy kompiliert Go, arm64 unter Emulation), das Rezept ändert sich aber so gut wie nie. Vor jedem Build vergleicht der Job jetzt mit dem bereits veröffentlichten Image: Rezept-Hash (alle Dateien in `docker/caddy`) sowie die Digests **beider Caddy-Basis-Images**. Nur wenn sich davon etwas unterscheidet, wird neu gebaut - sonst wird das vorhandene Image für die neue Version **umgetaggt** (Sekunden statt Minuten), sodass `:vX.Y.Z` weiterhin für jedes Release existiert
- Wichtig dabei: Die Basis-Digests sind Teil der Prüfung. Ein reiner Datei-Vergleich hätte den Hauptnutzen zerstört - **Caddy-Sicherheitspatches** werden weiterhin automatisch mit dem nächsten Release eingesammelt. Sind die Upstream-Digests nicht lesbar, wird im Zweifel gebaut

## [1.72.0] - 2026-07-14

### Fixed
- **PWA: Der tote schwarze Streifen unter der Handleiste ist weg.** Per Screenshot diagnostiziert: Im iOS-Standalone-Modus weicht `100dvh` von der echten Fensterhöhe ab - der App-Container endete über der Unterkante, Hand und Punkte-Badge schwebten. Die App misst jetzt die echte Höhe (`innerHeight`) und nutzt sie **nur im installierten PWA** als Container-Höhe; Browser-Tabs bleiben unberührt. Zusammen mit dem 16-px-Polster-Fix aus 1.71.1 sitzt die Leiste jetzt an der Kante

### Added
- **Caddy-Image wird als Package veröffentlicht:** `ghcr.io/floriandeutsch89/pikdame-local-caddy` (`:latest` + `:vX`, amd64 + arm64) - der Reverse-Proxy mit einkompiliertem CrowdSec-Bouncer-Plugin (xcaddy). Jedes Release baut auf der aktuellen `caddy:2-alpine`-Basis neu - genau richtig für ein Binary am offenen Internet. Die Prod-Compose dokumentiert den Umstieg von Server-Build auf Pull (dann hält Watchtower auch den Proxy aktuell); CI lintet das Caddy-Dockerfile mit

## [1.71.1] - 2026-07-14

### Fixed
- **PWA (installierte App auf dem Homescreen): Hand, Fortschrittsbalken und Punkte-Badge sitzen jetzt tiefer.** Im Standalone-Modus reservierte die App die volle Home-Indicator-Zone plus Polster, wodurch die Handleiste sichtbar über der Unterkante schwebte. Ein Teil der Reserve wird zurückgegeben (~16 px); der Browser-Modus ist unberührt (`display-mode: standalone` greift nur in der installierten App)

## [1.71.0] - 2026-07-13

### Changed
- **Familienregel beim Abheben (in Regeln + Spiel verewigt):** Der abgehobene Packen wird jetzt **beiseitegelegt** - alle Karten vor der Abhebestelle plus die Abhebekarte selbst kommen für die Runde aus dem Spiel; verteilt und gezogen wird nur der Rest. Läuft der Nachziehstapel leer, wird **zuerst der beiseitegelegte Packen** gemischt nachgelegt (erst danach wie bisher die Ablage). Glücksgriffe bleiben wie gehabt: Pik Dame/Joker an der Abhebestelle wandern in die Hand des Abhebers; die nächste normale Karte gilt dann als Abhebekarte und geht mit dem Packen beiseite
- Der **Abhebebereich ist entsprechend begrenzt** (je nach Spielerzahl), damit nach dem Beiseitelegen immer für alle verteilt werden kann - der Slider deckt automatisch nur den erlaubten Bereich ab. ⚠️ Durch die neue Schnitt-Formel ändern sich die **Tages-Challenge-Decks einmalig** mit diesem Update (Bestenliste des laufenden Tages nicht direkt vergleichbar über den Deploy-Zeitpunkt hinweg)
- **RL/Bots:** Regeländerung betrifft alle gleichermaßen; Observation- und Action-Space sind unverändert, bestehende Modelle spielen weiter. Da die Runde jetzt mit weniger Nachziehkarten läuft, ist ein Neutraining mittelfristig sinnvoll

### Fixed
- **Tutorial: Hinweise wiederholen sich nicht mehr.** „Du bist dran! Ziehe eine Karte …" erschien jede Runde erneut, weil ein Hinweis nur beim aktiven Weiter-Klick als gesehen galt - verschwand er von selbst (weil man z. B. einfach zog), wurde er nie abgehakt. Jetzt gilt: einmal gezeigt = gesehen, egal wie er endet

### Added
- **Tutorial zeigt jetzt, WOMIT man es macht:** Die konkreten Karten glühen golden - die legbare Kombination beim Auslegen-Hinweis (Satz- und Folgen-Suche, bewusst konservativ ohne Joker/Ringfolgen), die Pflichtkarte nach einer Stapel-Aufnahme samt passender eigener Ziel-Auslage, die Pik Dame und Joker bei ihren Hinweisen. Respektiert „Bewegung reduzieren"

## [1.70.1] - 2026-07-13

### Fixed
- **Tages-Challenge ist jetzt wettbewerbs-fest.** Bisher war der Challenge-Spieler Host seiner eigenen Session und konnte sich mitten in der Partie **leichtere Bots einstellen** (Bot-Chip-Menü) oder **Hausregeln ändern** (Zug-Timer, Schwellen-Modus) - und so die Bestenliste verzerren. Jetzt sind in der Challenge Bot-Stärke (Zen-Meister für alle, weltweit) und Regeln **serverseitig eingefroren**; nur das interne Setup darf sie beim Erstellen setzen. Der Client bietet die Menüs in der Challenge gar nicht erst an. Normale Partien bleiben voll einstellbar (per Test abgesichert)

## [1.70.0] - 2026-07-13

### Added
- **Stapel-Aufnahme zurücknehmen (Vertipper-Ausweg):** Wer den Ablagestapel versehentlich antippt, kann die Aufnahme mit „↩︎ Zurücklegen" rückgängig machen - solange die aufgenommene oberste Karte noch nicht gelegt wurde (Phase 1 der Zwei-Phasen-Aufnahme). Das ist konstruktionsbedingt fair: Die Karte war ohnehin für alle sichtbar, es ist keine verdeckte Information geflossen, am Tisch hat sich nichts geändert. Die Karte wandert exakt zurück an die Stapelspitze (auch das Bot-Gedächtnis wird zurückgesetzt), danach zieht man ganz normal neu. Sobald die Pflichtkarte gelegt wurde, gibt es bewusst kein Zurück mehr

### Changed
- **Abhebe-Aufdeckung neu gestaltet** (privat vs. öffentlich, wie am echten Tisch):
  - **Glücksgriff (Pik Dame/Joker an der Abhebestelle):** Großes „🍀 GLÜCKSGRIFF!"-Popup mit Kleeblatt für den **ganzen Tisch** (grüne Variante der Pik-Dame-Ansage) plus die goldenen Karten - auch wenn ein **Bot** den Glückstreffer landet. Der Jackpot-Moment gehört allen
  - **Gewöhnliche Karte:** sieht **nur der Abheber** (kurzes, dezentes „Deine Abhebekarte - bleibt im Deck") - der Server schickt sie den anderen gar nicht erst. Genau wie beim physischen Abheben: Nur wer abhebt, sieht die Karte; für alle anderen bleibt sie verdeckt
  - Die Karte, die eine Glücks-Serie beendet, sieht ebenfalls nur der Abheber (gedimmt, „bleibt im Deck")
- **Zum gemeldeten „nur einmal abheben"-Eindruck:** Die Engine ist korrekt - das Abheben passiert **jede Runde**, der Abheber rotiert mit dem Geber (per Regressionstest über 6 Runden festgeschrieben). Bei 1 Mensch + 3 Bots bist du aber nur jede 4. Runde der Spieler rechts vom Geber; die Bot-Runden hoben bisher **unsichtbar** automatisch ab. Mit dem neuen Glücksgriff-Popup ist der Schritt jetzt immer dann sichtbar, wenn etwas passiert

## [1.69.0] - 2026-07-13

### Changed
- **Große Hände (ab 16 Karten, z. B. nach einer Stapelaufnahme) sind auf dem Handy jetzt seitlich scrollbar** statt immer enger gestaucht zu werden. Bisher blieben hochkant nur ~14 px sichtbarer Streifen pro Karte (Apple empfiehlt 44 px Touchziele) - bei 25+ Karten lief die Hand sogar über den Rand. Jetzt behält jede Karte einen komfortablen Streifen (26 px+), man wischt seitlich:
  - dezente Fade-Kanten zeigen nur dort, wo tatsächlich weitere Karten liegen
  - frisch aufgenommene Karten werden automatisch ins Bild gescrollt - so ist sofort klar, dass die Hand jetzt scrollt
  - die Scroll-Position übersteht Zwischen-Updates; kein versehentliches Seiten-Zurück beim Wischen (`overscroll-behavior`)
  - Normalfall (≤15 Karten), Querformat und Desktop sind unverändert - dort passt alles ohne Scrollen

## [1.68.0] - 2026-07-13

### Added
- **Die abgehobenen Karten werden jetzt kurz aufgedeckt** - mit einfliegender Animation für alle am Tisch: die beim Glücksgriff behaltenen Karten (golden leuchtend, auch mehrere in Serie, wenn Joker/Pik Dame aufeinander folgen) plus die gewöhnliche Karte, die die Serie beendet hat (leicht gedimmt - sie bleibt im Deck). Läuft auch beim automatischen Abheben (Bots, Challenge), damit der Schritt in jeder Runde sichtbar ist. Rein visuell: der StateEncoder liest das Feld nicht, Bots und RL-Training bleiben davon unberührt; respektiert „Bewegung reduzieren" und läuft nicht im Hintergrund

### Changed
- **Doku aufgeräumt:** Die Seiten „WebSocket protocol", „Game constants" und „Configuration" zeigten ihre Überschrift doppelt (die eingebundene generierte Datei brachte eine zweite H1 mit) - behoben. `docs/OPERATIONS.md` und `docs/RL_TRAINING.md` sind vollständig in die Read-the-Docs-Struktur migriert (`admin/operations` bzw. neue Seite `developer/rl-setup`) und als Einzeldateien entfernt; alle Verweise im Code, README, k8s- und Docker-Doku zeigen jetzt auf die gerenderten Seiten. Der Rundenstart (Abheben inkl. Glücksgriff-Serie) ist in der Overview dokumentiert

## [1.67.0] - 2026-07-13

### Added
- **Abheben ist jetzt ein echter, interaktiver Schritt zum Rundenstart** - wie in den Regeln beschrieben. Ist der Abheber (Spieler rechts vom Geber) ein verbundener Mensch, startet die Runde in der neuen Phase „Abheben": Er wählt auf einer Deck-Leiste selbst die Stelle (Touch, Maus oder Tastatur), alle anderen sehen „X hebt ab …". Liegen an der Stelle Pik Dame oder Joker, gehören sie wie bisher sofort ihm (Glücksgriff)
- **Der Tisch kann nie blockieren:** 45-Sekunden-Frist mit sichtbarem Countdown, danach wird automatisch abgehoben - ebenso sofort, wenn der Abheber die Verbindung verliert oder der Server mitten im Abheben neu startet
- **Bots heben weiterhin sofort automatisch ab.** Dadurch bleiben Selbstspiel-Simulationen, der Lasttest und das **RL-Training** (alle Sitze sind Bots) exakt so synchron wie bisher - Observation-Space, Action-Space und Reward sind unverändert. Das Abheben wird bewusst keine lernbare Aktion: Die Karten liegen verdeckt, die Schnittposition trägt null Information
- **Tages-Challenge bleibt automatisch und geseedet:** Ein frei gewählter Schnittpunkt würde die weltweit identischen Decks auseinanderlaufen lassen
- **Sicherheit:** Das gemischte Deck liegt während der Abhebe-Phase nur serverseitig; `publicState` ist eine Positivliste und gibt es nie heraus (per Test abgesichert). Regeln (DE+EN) und Protokoll-Doku aktualisiert; 10 neue Tests inkl. Ende-zu-Ende über den echten Server

## [1.66.0] - 2026-07-13

### Changed
- **Desktop-Darstellung: Das Spiel nutzt große Bildschirme jetzt wirklich.** Bisher bekam ein 24-Zoll-Monitor dieselben 62-px-Karten wie ein 6-Zoll-Handy, gedeckelt auf 880 px Breite - alles wirkte winzig. Neu: zwei Desktop-Stufen (ab 1100 px und ab 1500 px Fensterbreite), die Schriftgröße, Karten (Hand bis 86 px statt 62 px), Stapel, Auslagen und Spielfläche (bis 1200 px) gemeinsam hochskalieren. iPhone/Tablet bleiben unverändert
- Die manuelle **Anzeigegröße „Groß/Sehr groß"** (für ältere Mitspieler) hat eigene Desktop-Werte bekommen: Sie war für Handys abgestimmt und hätte auf einem Monitor die Karten sonst *kleiner* gemacht als der neue Desktop-Standard. Jetzt gilt auf jedem Gerät durchgängig: Normal < Groß < Sehr groß

## [1.65.1] - 2026-07-13

### Fixed
- **Lizenz ergänzt und Widerspruch behoben.** Das Repo hatte **keine `LICENSE`-Datei** - juristisch heißt das im Zweifel „alle Rechte vorbehalten", also **niemand** hätte den Code nutzen, forken oder betreiben dürfen. Gleichzeitig behauptete `package.json` bereits **MIT**, während die Docker-Images sich als `UNLICENSED` labelten. Jetzt einheitlich **MIT** (© 2026 Florian Deutsch):
  - `LICENSE` im Repo-Wurzelverzeichnis
  - Image-Label `org.opencontainers.image.licenses` in beiden Dockerfiles auf `MIT` korrigiert
  - `LICENSE` wird **in die Images kopiert** - MIT verlangt, dass Lizenz- und Copyright-Hinweis jede Kopie begleiten, und ein Container-Image ist eine Kopie
  - Lizenz-Abschnitt im README

## [1.65.0] - 2026-07-13

### Added
- **Helm: ONNX-Bots per Overrides statt eigenem Chart.** Bewusst **kein** zweiter Chart - der bestehende parametrisiert das Image bereits, ein zweiter würde nur Ingress/PVC/Service-Templates duplizieren. Stattdessen: `helm/pikdame/values-onnx.yaml` (setzt Image auf das ONNX-Package und `onnx.enabled=true` → `PIKDAME_ONNX=1`):
  ```
  helm install pikdame oci://ghcr.io/floriandeutsch89/charts/pikdame \
    --version <X.Y.Z> -f helm/pikdame/values-onnx.yaml
  ```
  Gleiche UID/GID (10001), ein vorhandenes PVC läuft weiter
- **Schutzplanke:** Der Chart **verweigert das Rendern**, wenn `onnx.enabled=true` mit dem Standard-Image (Alpine) kombiniert wird - genau diese Kombination würde still auf die heuristischen Bots zurückfallen, weil `onnxruntime-node` glibc braucht. Lieber beim Installieren scheitern als Wochen später rätseln. CI prüft, dass die Schutzplanke greift

### Changed
- **Datenschutzerklärung: Hosting-Abschnitt ergänzt** (DE + EN). Der Server wird bei der **IONOS SE** (Elgendorfer Str. 57, 56410 Montabaur) gehostet; IONOS wird als **Auftragsverarbeiter nach Art. 28 DSGVO** benannt, Rechtsgrundlage Art. 6 Abs. 1 lit. f DSGVO, Serverstandort Deutschland, keine Drittlandübermittlung, ausdrücklich **keine Web-Analyse** (weder IONOS WebAnalytics noch Google Analytics). Zudem wurde die bisher irreführende Formulierung „auf dem eigenen Server des Betreibers" korrigiert

## [1.64.0] - 2026-07-13

### Changed
- **ONNX Models** Neu trainierte Modelle (stärker)

## [1.63.0] - 2026-07-12

### Added
- **Zweites Container-Image mit fertigen ONNX-Bots.** Jeder Release veröffentlicht jetzt zusätzlich `ghcr.io/floriandeutsch89/pikdame-local-onnx` (`:latest` und `:vX.Y.Z`, amd64 + arm64) - Laufzeit und trainierte Modelle sind bereits enthalten, `PIKDAME_ONNX=1` ist gesetzt. Kein Selbstbau mehr nötig:
  ```
  docker run -d -p 8080:8080 -v pikdame-data:/app/data \
    ghcr.io/floriandeutsch89/pikdame-local-onnx:latest
  ```
  Das Standard-Image bleibt unverändert schlank (Alpine, heuristische Bots). Beide nutzen dieselbe UID/GID (10001) und damit dasselbe Daten-Volume. Der ONNX-Build läuft als **eigener Job**, damit ein Fehler dort das Haupt-Image nie blockiert

### Changed
- **Reward-Funktion des RL-Trainings vergleicht jetzt gegen den DURCHSCHNITT der Gegner statt gegen den Besten.** Der bisherige Vergleich mit dem stärksten von drei Gegnern machte die Belohnung von fremdem Losglück abhängig - also von Rauschen, das der Agent nicht beeinflussen kann. Rauschen im Ziel ist genau das, was den Critic am Lernen hindert (sichtbar an schlechter `explained_variance`). Gemessen über je 400 Spiele:

  | Formel | Runden-Reward eines Durchschnittsspielers | Streuung (SD) |
  | --- | --- | --- |
  | alt (Maximum) | **−5,17** | 3,69 |
  | **neu (Durchschnitt)** | **−0,07** | **2,96** |

  Das Signal ist jetzt **um null zentriert** (ein positiver Runden-Reward heißt tatsächlich „besser als der Tisch") und rund **20 % rauschärmer**. Die neue Baseline des heuristischen Bots liegt bei **−0,62** (medium) bzw. **−0,59** (zen) - das ist die Zahl, die ein Modell schlagen muss
  - **Achtung:** Werte von vor v1.63.0 sind **nicht vergleichbar**, und die bisher trainierten Modelle haben ein anderes Ziel optimiert - sie sollten neu trainiert werden. Die alte Formel lässt sich mit `PIKDAME_RL_REWARD=max` reproduzieren
- `eval_onnx.py` und die Trainings-Doku nennen die neuen Baselines

## [1.62.0] - 2026-07-12

### Added
- **ONNX-Modelle lassen sich jetzt tatsächlich ausliefern** - über ein neues, separates Image `docker/Dockerfile.onnx`. Bisher fehlte sowohl das Kopieren des `models/`-Ordners als auch die Laufzeit `onnxruntime-node`, `PIKDAME_ONNX=1` fiel also **still** auf die Heuristik zurück.
  - **Wichtig:** Das Standard-Image ist **Alpine (musl)** - dort kann ONNX **prinzipiell nicht** laufen. `onnxruntime-node` liefert vorgebaute Binaries, die gegen **glibc** gelinkt sind (`libstdc++.so.6`, `GLIBC_2.x`); auf musl installieren sie sich scheinbar erfolgreich und scheitern dann beim Laden. Das ONNX-Image nutzt deshalb eine **Debian-Basis**: `docker build -f docker/Dockerfile.onnx -t pikdame-onnx .`
  - Gleiche UID/GID (10001) wie das Standard-Image - ein vorhandenes Daten-Volume funktioniert beim Wechsel weiter
  - Neue Variable **`PIKDAME_MODELS_DIR`**: Modelle können auf ein Volume gelegt und **ohne Image-Neubau** ausgetauscht werden
  - Das Standard-Image bleibt unverändert schlank (kein ONNX, keine Modelle)
- **Laute Diagnose statt stillem Fallback**: Ist `PIKDAME_ONNX=1` gesetzt, aber die Laufzeit oder eine Modelldatei fehlt, sagt der Server das jetzt unübersehbar im Log (und spielt sicher mit der Heuristik weiter). Bei Erfolg wird das geladene Modell protokolliert
- **Dokumentation des Trainings-Outputs** (`docs/developer/rl-training.md`): Was `approx_kl`, `value_loss`, `policy_gradient_loss`, `entropy_loss`, `explained_variance`, `clip_fraction` & Co. bedeuten, welche Werte gesund sind und was sie im Fehlerfall verraten - plus ein Diagnose-Leitfaden

### Fixed
- **Die Bewertung eines trainierten Modells war irreführend.** `eval_onnx.py` gab nur den mittleren Episoden-Reward aus. Dieser ist aber **relativ** (eigene Punkte minus die des **besten** von drei Gegnern, plus ±1 am Spielende) und damit gegen gleich starke Gegner **strukturell negativ** - ein Wert nahe null ist gar nicht erreichbar. Zum Vergleich gemessen: Der **heuristische Bot selbst** erreicht in genau diesem Schema **−5,37** (medium) bzw. **−5,17** (zen). Ein Modell bei −2,3 ist also **deutlich besser** als der Bot, gegen den es spielt. `eval_onnx.py` gibt jetzt zusätzlich die **Siegquote** (25 % = gleichauf) samt Standardfehler aus und erklärt die Einordnung direkt in der Ausgabe

## [1.61.0] - 2026-07-12

### Added
- **Vollständige Dokumentation** (Sphinx + Markdown/MyST, gebaut auf Read the Docs) im Unterordner `docs/` - bewusst im selben Repo, damit Doku und Code nie auseinanderlaufen. Struktur: Overview, Getting started (Docker, Compose-Stack mit automatischem TLS/ACME, Kubernetes, lokal), Admin-Handbuch (Konfiguration, **Backup & Restore inkl. erprobter Wiederherstellungs-Übung**, ONNX-Bots, Ops-Runbook), Developer Guide (Architektur, WebSocket-Protokoll, Bots, Contributing), FAQ, Roadmap und Releases
- **Automatisch aus dem Code generierte Doku-Teile** (`npm run docs:gen`): die Tabelle aller Umgebungsvariablen, das WebSocket-Protokoll und sämtliche Spielkonstanten (Kartenzahl, Punktwerte, Kombinations-Grenzen, Punkteschwelle) werden direkt aus dem Quelltext extrahiert - sie können also nicht veralten. **CI prüft das** (`npm run docs:check`): Wer eine Konstante, eine Variable oder eine Protokoll-Nachricht ändert, ohne die Doku neu zu generieren, bekommt einen roten Build
- Bestehende Anleitungen (`OPERATIONS.md`, `RL_TRAINING.md`) werden eingebunden statt dupliziert

## [1.60.0] - 2026-07-12

### Changed
- ONNX-Training: Korrektur fehlender Dependencies
- ONNX-Training: Resume-Modus hinzugefügt. Die SB3-Checkpoints werden nun immer genutzt, wenn sie im models-Ordner liegen.

## [1.59.0] - 2026-07-12

### Performance
- **Akkuschonung auf dem Handy** (vier echte Stromfresser abgestellt):
  - **Display bleibt nur noch wach, wenn DU am Zug bist.** Bisher wurde die Bildschirmsperre während der gesamten Partie verhindert - das Display leuchtete also auch dann mit voller Helligkeit, wenn man minutenlang auf Mitspieler oder Bots wartete. Das war mit Abstand der größte Verbraucher. Jetzt darf das Handy beim Warten wie gewohnt dimmen und einschlafen; bist du dran, bleibt der Bildschirm zuverlässig an (und du bekommst ohnehin eine Benachrichtigung)
  - **Sekundentakt-Timer läuft nur noch, wenn wirklich ein Countdown aktiv ist.** Vorher weckte die App die CPU *jede Sekunde* - dauerhaft, auch in der Lobby, am Rundenende, bei ausgeschaltetem Zug-Timer und im Hintergrund. Jetzt startet und stoppt er sich selbst
  - **Audio-Hardware wird schlafen gelegt.** Der Audio-Kontext blieb nach dem ersten Ton dauerhaft aktiv (und hielt damit die Audio-Einheit in Betrieb). Jetzt wird er nach kurzer Stille - und sofort beim Wechsel in den Hintergrund - suspendiert und beim nächsten Ton automatisch wieder aufgeweckt
  - **Endlos-Animationen stoppen im Hintergrund** (pulsierender Nachziehstapel, Anlege-Ziel, aktiver Gegner): Sie laufen nicht mehr weiter, wenn niemand hinsieht. Zusätzlich wird die Systemeinstellung „Bewegung reduzieren" respektiert

## [1.58.0] - 2026-07-12

### Changed
- **Session-Limit von 200 auf 500 angehoben.** Das alte Limit lag exakt auf dem Zielwert - die 201. Partie wurde bereits mit „Server ist voll" abgewiesen. Messungen (neuer `scripts/load-test.js`) zeigen, dass selbst 500 parallele Partien sauber laufen. Weiterhin über `PIKDAME_MAX_SESSIONS` einstellbar

### Performance
- **Zustands-Broadcasts werden jetzt gebündelt** (Coalescing): Ein einzelner Bot-Zug löste bisher bis zu 4 komplette Zustands-Sendungen pro Mitspieler aus (Ziehen, Auslegen, Anlegen, Abwerfen) - obwohl niemand die Zwischenzustände sieht, weil sie im selben Verarbeitungsschritt entstehen. Jetzt wird pro Schritt nur noch der finale Zustand gesendet: **75 % weniger Nachrichten und 63 % weniger übertragene Daten** pro Bot-Zug, bei identischer Sichtbarkeit für die Spieler. Die kanonische Sortierung der Auslagen bleibt bewusst synchron (sie ist Spielzustand, kein Netzwerkdetail)
- Gemessen bei **200 parallelen Partien** (je 1 Mensch + 3 Bots): Event-Loop-Latenz im **Median 0 ms**, p95 1 ms, p99 1 ms; ~88 MB Arbeitsspeicher (~68 KB pro Partie). Die Reaktionszeit für Spieler bleibt damit auch unter Volllast unbeeinträchtigt

### Internal
- Neues Lasttest-Werkzeug `scripts/load-test.js` (misst Event-Loop-Latenz, Broadcast-Volumen und Speicher bei N parallelen Partien)

## [1.57.1] - 2026-07-12

### Added
- Bestätigungs-Meta-Tag für die Bing Webmaster Tools eingebunden (`msvalidate.01`) - damit lässt sich der Seitenbesitz bei Bing verifizieren, Sitemap einreichen und die Indexierung anstoßen (deckt auch DuckDuckGo ab)

## [1.57.0] - 2026-07-12

### Added
- **Suchmaschinen-Optimierung (SEO)**, damit das Spiel über Begriffe wie „Pik Dame spielen", „Kartenspiel Rommé" oder „Rommé" gefunden wird:
  - Aussagekräftiger Seitentitel und Meta-Description (statt nur „Pik Dame")
  - Open-Graph- und Twitter-Card-Vorschau (schöne Vorschaukarte beim Teilen in WhatsApp, Signal & Co.)
  - Strukturierte Daten (JSON-LD): `VideoGame` (Genre, Spielerzahl, kostenlos) und eine `FAQPage` mit den häufigsten Fragen - Google kann daraus direkt Antworten anzeigen
  - Canonical-URL und Robots-Meta
  - Sichtbarer, aufklappbarer Einsteiger-/Suchtext in der Lobby („Pik Dame spielen - das Rommé-Kartenspiel kostenlos online") mit Erklärung, Punktetabelle und Hinweisen zum Spielen mit Freunden. Ohne echten Text sieht Google nur eine leere App-Hülle
  - `sitemap.xml` und erweiterte `robots.txt` (mit Sitemap-Verweis)

### Fixed
- Zeitbomben-Test entschärft: Der Test der Tages-Challenge nutzte feste Datumsangaben und schlug fehl, sobald diese aus dem 7-Tage-Fenster fielen. Er rechnet jetzt relativ zum heutigen Datum

## [1.56.1] - 2026-07-09

### Added
- „Spiel aufgeben" wird jetzt auch am **Rundenende in der Punkteübersicht** angeboten - man muss also nicht extra ins laufende Spiel zurück, um die Partie zu beenden. Gleiche Abstimmung wie sonst (alle aktiven Spieler müssen zustimmen)

### Docs
- **Kartenverteilung/Fairness dokumentiert** (README-Abschnitt, ausführlicher Code-Kommentar an `shuffle`, kurze Zeile in den Spielregeln DE+EN): Vor jeder Runde wird ein komplett neues 110-Karten-Deck **fair und unverzerrt per Fisher-Yates** gemischt (Standard-Zufallsmischen) und reihum ausgeteilt. Es gibt **bewusst kein Ausbalancieren** der Hände - das wäre in Wahrheit unfair. Die Fairness liegt in der Gleichverteilung: Jeder hat in jeder Runde exakt die gleiche Chance auf die guten Karten; einzelne Runden entscheidet Glück, über viele gleicht es sich aus. Die Tages-Challenge nutzt einen deterministischen Seed, damit alle weltweit dasselbe Deck erhalten

## [1.56.0] - 2026-07-09

### Changed
- „Aufgeben" beendet jetzt das **ganze Spiel** statt nur die laufende Runde - und heißt entsprechend überall **„Spiel aufgeben"**. Stimmen alle aktiven Spieler zu (Abstimmung wie zuvor), wird die Partie **sofort abgebrochen**: Endbildschirm mit dem aktuellen Punktestand, **kein Sieger**, und das Spiel wird **nicht** als abgeschlossene Partie gewertet (keine Statistik/Erfolge). Von dort geht es per 🏠 zurück ins Hauptmenü oder per Rematch in eine neue Partie. Regeltext, Button, Bestätigung und Hinweise entsprechend angepasst

## [1.55.0] - 2026-07-09

### Changed
- Aufgeben ist jetzt eine **Abstimmung** statt eines Alleingangs: Tippt jemand auf 🏳️, wird das als Votum fürs Aufgeben gewertet, und **alle aktiven Spieler werden gefragt** (sichtbarer Hinweis-Toast „Aufgeben vorgeschlagen – tippe 🏳️ zum Zustimmen"). Die Runde endet erst, wenn **alle verbundenen Mitspieler** zustimmen (analog zur Pause). Der Aufgeben-Button zeigt den Stimmenstand (z. B. „🏳️ Aufgeben (1/2)"); ein Votum lässt sich auch wieder zurückziehen. Ist man der einzige verbundene Mensch (Rest Bots), gibt der eine Tipp wie bisher sofort auf. Trennt sich ein Mitspieler, während ein Votum läuft, wird neu ausgewertet. Wertung unverändert: alle wie normale Mitspieler, kein Gewinner-Bonus

## [1.54.5] - 2026-07-09

### Fixed
- Anlegen an den falschen Stapel: Wählte man eine Handkarte aus und tippte auf eine unpassende Auslage, kam korrekt „passt nicht" - die Karte wurde aber trotzdem sofort abgewählt, sodass man sie neu selektieren musste, um sie einem anderen Stapel zuzuweisen. Die Auswahl wird jetzt **nicht mehr voreilig beim Tippen** geleert, sondern erst, wenn die Karte die Hand tatsächlich verlässt (erfolgreiches Anlegen/Auslegen/Abwerfen). Ein abgelehnter Versuch lässt die Karte ausgewählt - sie kann direkt auf einen anderen Stapel gelegt werden, ohne neu zu selektieren. Gilt genauso für „Auslegen" und Mehrfach-Anlegen

## [1.54.4] - 2026-07-09

### Fixed
- Diagnose für verlorene Statistiken: Beim Start prüft der Server jetzt, ob das (gemountete) Datenverzeichnis wirklich **beschreibbar** ist, und schreibt das Ergebnis deutlich ins Log. Häufigste Ursache für „Statistiken nach Neustart weg" ist ein Volume, das **root** gehört, während die App als non-root-User (UID 10001) läuft - Schreibvorgänge scheitern dann still. Ist das Verzeichnis nicht beschreibbar, erscheint jetzt eine unübersehbare Warnung samt Behebung (`docker run --rm -v <projekt>_pikdame-data:/d alpine chown -R 10001:10001 /d`)
- Robustheit: `flushSync` beim Graceful Shutdown schreibt jetzt auch dann, wenn gerade ein asynchroner Write „in der Luft" ist - schließt eine seltene Race Condition, bei der die allerletzte Änderung vor dem Beenden verloren gehen konnte

## [1.54.3] - 2026-07-09

### Internal
- Gameplay-Theorie gemessen (kein Verhalten geändert): „Wenn ich die Ablage nehmen könnte, aber schon einen Drilling habe, lieber vom Nachziehstapel ziehen (um andere Kombinationen zu vervollständigen), sofern der Stapel klein ist." Als abschaltbaren Seam eingebaut und per Selbstspiel-A/B getestet (5000 Partien, 4× Zen): Win-Share 46,1 % (z=−5,56), Score-Δ **−32,9** – **deutlich schlechter**. Wiederkehrende Erkenntnis: Eine garantierte Ablage-Kombination auszuschlagen, um auf einen Zug zu spekulieren, kostet ~30 Punkte (auch bei einem „redundanten" Drilling ist das Auslegen echter Fortschritt Richtung Ausmachen). Standardverhalten bleibt unverändert

## [1.54.2] - 2026-07-09

### Fixed
- Statistiken (Spielerprofile, Erfolge, Server-Statistik) konnten nach einem Server-Neustart verloren gehen: Der Server nutzt für sein Datenverzeichnis die Variable `PIKDAME_DATA_DIR`, die Stores (players.json, stats.json, challenges.json, games.json sowie der SQLite-Konten-Fallback) haben diese aber ignoriert und fest `…/data` verwendet. Lief das in der Produktion auseinander, schrieben die Stores in ein nicht dauerhaftes Verzeichnis. Jetzt respektieren **alle** Stores dasselbe `PIKDAME_DATA_DIR` wie der Server - Server und Statistik-Dateien liegen garantiert im selben (persistenten) Verzeichnis. Persistenz Ende-zu-Ende verifiziert (Aufzeichnen → Flush → Neustart → Laden)
- Zusätzliche Absicherung: Bei einem unerwarteten Fehler (uncaughtException/unhandledRejection) werden gepufferte Schreibvorgänge jetzt sofort auf die Platte geschrieben, damit auch bei einem Absturz kurz vor dem Beenden nichts verloren geht (der reguläre Graceful-Shutdown-Flush bei SIGTERM war bereits vorhanden)

## [1.54.1] - 2026-07-09

### Internal
- Gameplay-Theorie gemessen (kein Verhalten geändert): „Wenn ein Gegner bereits einen Joker ausgelegt hat, kann man ♠Bube/♠König eher abwerfen." Als abschaltbare Stellschraube eingebaut und per Selbstspiel-A/B getestet (5000 Partien, 4× Zen): Win-Share 50,3 % (z=0,48), Score-Δ +2,7 – **kein signifikanter Effekt**. Die Idee ist plausibel und lehnt sich minimal ins Positive, ist aber statistisch Rauschen; das Standardverhalten bleibt unverändert (die Vorsicht bei Damen jeder Farbe bleibt ohnehin bestehen)

## [1.54.0] - 2026-07-09

### Added
- Nach Spielende gibt es neben „Neue Partie (Rematch)" jetzt auch einen Button **🏠 Hauptmenü**, der zurück zum Startbildschirm führt

### Changed
- Wird die App über einen geteilten Link mit Spiel-Code (`?session=…`) geöffnet, wird „Neues Spiel erstellen" ausgeblendet und der Code vorausgefüllt - man will dann ja beitreten, nicht ein neues Spiel starten
- Lobby: Der Start-Button heißt jetzt schlicht „Spiel starten" (der Zusatz „(fehlende Plätze = Bots)" ist entfallen)
- Lobby-Statistik neu gestaltet: Statt einer auf dem iPhone stark gequetschten 6-Spalten-Tabelle gibt es jetzt pro Spieler eine übersichtliche Karte; die Erfolge werden als gut lesbare Chips (Emoji + Name) angezeigt statt in einer winzigen Spalte

## [1.53.3] - 2026-07-09

### Internal
- Datengetriebene Tuning-Werkzeuge ergänzt (kein Spielverhalten geändert): neuer A/B-Selbstspiel-Harness `scripts/sim-ab.js` (Varianten- gegen Baseline-Sitze in denselben Partien) plus zwei abschaltbare, sanitisierte Bot-Stellschrauben (`queenDumpMaxHand`, `earlyDrawBiasTurns`), beide standardmäßig aus. Zwei Messungen (je 5000 Partien, 4× Zen): Pik-Dame-Notabwurf ab Handgröße 5 statt 6 → kein messbarer Effekt (z=0,34); die ersten Züge den Nachziehstapel bevorzugen → deutlich schlechter (−30 Punkte, z=−7,71). Daher keine Änderung der Defaults
- Totes Konstrukt `URGENT_DISCARD_HAND_SIZE` (=8) entfernt: Es war seit Längerem nicht mehr in der Abwurf-Logik verwendet (die Pik Dame wird ohnehin gehalten, solange es Alternativen gibt), stiftete aber Verwirrung über die tatsächliche Schwelle. Tests entsprechend angepasst

## [1.53.2] - 2026-07-09

### Fixed
- Bots mit weniger als 3 Karten auf der Hand nutzen den Pik-Dame-Emote (🎉/😱) nicht mehr – ein kurz vorm Ausmachen stehender Bot jubelt bzw. erschrickt jetzt nicht mehr. Andere Emotes bleiben unverändert

## [1.53.1] - 2026-07-09

### Changed
- Die (bisher unsichtbare) „Doppel-Satz-Regel" wurde vollständig entfernt: Man darf jetzt jederzeit einen **zweiten Satz gleichen Werts** eröffnen, statt an den bestehenden anlegen zu müssen. Diese Familienregel war seit v1.3.0 im Code, stand aber nicht in den sichtbaren Spielregeln – und war die eigentliche Ursache des Aufnahme-Regelbruchs aus v1.53.0. Wichtig bleibt nur: Mit einer aus der Ablage aufgenommenen Karte muss sofort eine neue Kombination (Drilling **oder** Folge) gelegt werden. Bots erzeugen bei Bedarf jetzt ebenfalls zweite Sätze; die Aufnahme-Absicherung greift weiterhin (Regressionstest: 0 ungelegte Aufnahmen)

## [1.53.0] - 2026-07-09

### Fixed
- Regelbruch behoben: Ein Bot nahm gelegentlich eine Karte aus dem Ablagestapel (z. B. Kreuz-Ass), legte sie aber nicht sofort aus, sondern warf eine andere Karte ab. Ursache war ein Widerspruch zweier Regeln: „Aufnehmen erlaubt, wenn die Karte eine neue Kombination bilden kann" gegen die Doppel-Satz-Regel („du hast schon einen Satz dieses Werts – lege dort an"), wobei das Anlegen scheiterte, weil die Farbe im Satz schon zweimal (Zwei-Deck-Maximum) vorhanden war. Jetzt darf die **Pflicht-Aufnahmekarte** ausnahmsweise einen zweiten Satz gleichen Werts eröffnen, wenn der bestehende Satz sie nicht aufnehmen kann – und der Bot legt die aufgenommene Karte garantiert sofort aus (mehrfach abgesichert). Betrifft auch Menschen, die in dieser Konstellation sonst festsaßen

## [1.52.3] - 2026-07-07

### Fixed
- „Weiterspielen"-Button wird nur noch angezeigt, wenn das Spiel mit dem gemerkten Code wirklich noch existiert. Der Code wird lokal gespeichert, die Sitzungen liegen aber im Arbeitsspeicher des Servers und verschwinden bei Neustart/Ablauf – dadurch bot der Button oft ein totes Spiel an und man bekam beim Klick „Kein Spiel mit diesem Code gefunden". Jetzt fragt der Client beim Start kurz beim Server nach (neue checkSession-Prüfung, mit derselben Missbrauchs-Drosselung wie beim Beitreten) und blendet den Button nur bei einer noch laufenden Partie ein; ein veralteter Code wird verworfen

## [1.52.2] - 2026-07-07

### Fixed
- Regeltext korrigiert (DE + EN): (1) Die unsinnige Passage „Einzige Ausnahme: Tauschst du mit deiner letzten Handkarte einen Joker aus deiner Auslage, endet die Runde sofort." entfernt – ein Joker-Tausch beendet die Runde nicht (ausgemacht wird nur durch verdecktes Abwerfen der letzten Karte). (2) Die Punkte-Übersicht ist jetzt sauber als Liste formatiert (je ein Punkt pro Zeile) statt als eine überladene Zeile. (3) Die Leerstapel-Regel klargestellt: Der Ablagestapel wird nur nachgemischt, solange dafür noch Karten da sind – kannst du weder nachziehen noch die oberste Ablagekarte aufnehmen, endet die Runde und wird gewertet

## [1.52.1] - 2026-07-07

### Fixed
- Bot-Schwierigkeit wird jetzt auch Nicht-Organisatoren angezeigt – schreibgeschützt, aber klar sichtbar – **sowohl in der Lobby als auch im Spiel**. Vorher war der Schwierigkeits-Badge im Spiel nur für den Organisator sichtbar. Für Nicht-Hosts ist der Badge nicht antippbar (voller Kontrast statt blasser „deaktiviert"-Optik), und ein Tooltip zeigt die Stufe im Klartext (z. B. „Schwierigkeit: Zen-Meister")

## [1.52.0] - 2026-07-07

### Changed
- Bot-Schwierigkeit ist jetzt **pro Bot** in der Lobby einstellbar (Tipp auf den Schwierigkeits-Badge in der Sitzordnung) und wird pro Bot im geteilten Zustand angezeigt. Die globale Einstellung wurde entfernt. Jeder Bot startet standardmäßig auf **Zen-Meister** und kann einzeln auf Anfänger/Fortgeschritten/Zen gestellt werden

### Internal
- Aufräumen (keine Verhaltensänderung): inline-`require`s für StateEncoder/MoveLogger in GameManager nach oben gezogen (kein zirkulärer Import), der `botDifficulty || 'zen'`-Fallback in einen Helfer `botDifficultyOf()` ausgelagert, der doppelte Pik-Dame-Reaktionsblock zu `_celebratePikDame()` zusammengefasst und das mehrfach genutzte „verbundene Menschen"-Filter in `_connectedHumans()` gebündelt (Host-/Pause-/Bereit-Gate)

## [1.51.0] - 2026-07-07

### Added
- Pause-Modus im laufenden Spiel: Jeder Mitspieler kann über den ⏸️-Button eine Pause vorschlagen. Sobald **alle** verbundenen Menschen zustimmen, friert das Spiel ein (Bots ziehen nicht, der Zug-Timer stoppt, Aktionen sind gesperrt) und ein Pause-Overlay erscheint. Fortsetzen funktioniert genauso – erst wenn alle „Fortsetzen" drücken, geht es weiter. Trennt sich jemand, blockiert er die Abstimmung nicht

### Fixed
- Lobby: Nicht-Hosts sahen die vom Organisator gewählten Einstellungen nicht – die Regel-Bedienelemente wurden nie aus dem Server-Zustand befüllt. Hausregeln (Schwierigkeit, Hand-aus, 1000-streng, Zug-Timer) werden jetzt für alle live aus dem geteilten Zustand angezeigt und vom Host live synchronisiert
- Lobby: Die gewählte Bot-Schwierigkeit (z. B. Zen-Meister) wurde nicht auf die Bots übertragen – sie hatten „Fortgeschritten". Ursache: Die in der Lobby vorbefüllten Bots wurden mit dem alten Standard erstellt, und die Auswahl aktualisierte sie nie. `setHouseRules` setzt die Schwierigkeit jetzt auf **alle** vorhandenen Bots, und der Standard wurde auf „Zen-Meister" angeglichen (passend zur Auswahl-Vorgabe)

## [1.50.0] - 2026-07-07

### Changed
- Menschen-Zug-Logging (human-moves.jsonl) auf ein best-practice, selbstbeschreibendes Format umgestellt. Jede Zeile enthält jetzt drei Sichten derselben Entscheidung plus das Ergebnis: (1) `state` – der **rohe, menschenlesbare Spielzustand aus Spielersicht** (die echten Handkarten, Ablage-Top, Auslagen mit Karten, Gegner-Kartenzahlen und öffentlich bekannte Karten, Stapelgrößen); (2) `move` – die **deserialisierte Aktion** (z. B. `{type:"discard", card:"QS"}` statt nur eines Enum-Index); (3) `obs`/`action`/`mask` – der kodierte Netz-Input fürs direkte Training. So sind die Logs lesbar, überprüfbar UND encoder-unabhängig (ein verbesserter StateEncoder kann alte Aufzeichnungen neu kodieren, weil der Rohzustand erhalten ist). Karten werden als Kürzel `Rang+Farbe` gespeichert (`QS`, `10H`, Joker `JK`). Datenschutzerklärung (DE+EN) entsprechend präzisiert (anonyme Spielverlaufsdaten inkl. Karten, weiterhin ohne Name/Konto/Gerät/IP). Schema vollständig in docs/RL_TRAINING.md dokumentiert. **Hinweis:** Bereits gesammelte Logs im alten Format werden dadurch obsolet (bewusst in Kauf genommen)

## [1.49.1] - 2026-07-07

### Fixed
- Runde endet jetzt automatisch, wenn niemand mehr etwas tun kann: Ist der Nachziehstapel leer und nicht nachmischbar (Ablage ≤ 1 Karte) und der Spieler kann die oberste Ablagekarte nicht nehmen, wird die Runde sofort zu Zugbeginn beendet und normal gewertet. Vorher wurde das nur beim aktiven Ziehen erkannt - einem Menschen, dem die (unmögliche) Zieh-Aktion gar nicht angeboten wird, hing der Tisch endlos
- Lobby-Start nur mit aktiver Bereitschaft: Die Start-Prüfung zählt jetzt alle am Tisch sitzenden Menschen, nicht nur die verbundenen. Wer die App minimiert (und damit die Verbindung verliert), verliert seine Bereitschaft und muss nach der Rückkehr erneut „bereit" drücken - das Spiel startet nicht mehr hinter dem Rücken eines minimierten Spielers. Kehrt ein getrennter Lobby-Spieler bis zum Ablauf der Übernahmefrist nicht zurück, wird sein Platz frei (Bot rückt nach), damit die Lobby nicht ewig blockiert

### Docs
- docs/RL_TRAINING.md: Struktur der human-moves.jsonl vollständig dokumentiert (Feld-Tabelle mit Bedeutung; Encoding via StateEncoder). Der Melding-/Anlege-Punkt ist jetzt ehrlich eingeordnet: bewusst heuristisch, kein Flaschenhals (greedy-Auslegen ist nahezu optimal, eine ausgefeilte Variante war messbar schlechter); die strategische Tiefe steckt im trainierten Ziehen/Abwerfen

## [1.49.0] - 2026-07-07

### Added
- Organisator-Rolle in der Lobby: Der erste beigetretene Mensch ist der Organisator. Nur er kann die Einstellungen ändern - Spieleranzahl, Sitzordnung/Geber, Bot-Schwierigkeit, Hausregeln und den Spielstart. Für alle anderen sind die Einstellungen jetzt schreibgeschützt (mit Hinweis „🔒 Nur der Organisator kann die Einstellungen ändern."), serverseitig erzwungen. Trennt sich der Organisator kurz, übernimmt vertretungsweise ein anderer verbundener Mensch; kommt der Organisator zurück, erhält er die Rolle wieder

### Changed
- Regeln klarer formuliert: Wenn Nachzieh- und Ablagestapel erschöpft sind und niemand mehr etwas tun kann (oder sich lange nichts tut), endet die Runde und wird **ganz normal** gewertet - ausgelegte Karten plus, restliche Handkarten wie gewohnt **minus** (Pik Dame 100!), nur der Gewinner-Bonus entfällt. (Die Wertung selbst war bereits korrekt; jetzt steht es explizit in den Regeln.)

## [1.48.1] - 2026-07-07

### Added
- Reichere situative Bot-Reaktionen, damit die Bots menschlicher wirken (reine Präsentation, keinerlei Einfluss aufs Spiel): Wer einen dicken Ablagestapel schlucken muss, seufzt (😅); eine wertvolle Auslage bringt einen kleinen Stolz-Moment (😎); ein „Hand aus" (Ausmachen im allerersten Zug) verblüfft den ganzen Tisch (😲); und zieht sich eine Runde ewig ohne neue Auslage, gähnt gelegentlich ein Bot (😴). Alles weiterhin über die bestehende Emote-Drosselung (max. ~1 Alltagsreaktion pro Bot alle 5 s, Höhepunkte dürfen sie durchbrechen)

## [1.48.0] - 2026-07-07

### Added
- Lobby-Sitzordnung zeigt jetzt auch die Bots: Freie Plätze werden schon in der Lobby mit Bots vorbelegt, sodass man Bots genau wie Mitspieler per ▲/▼ sortieren (und den Geber festlegen) kann. Kommt eine Person per Einladungscode dazu, ersetzt sie einen Bot AN DESSEN PLATZ - die Sitzordnung bleibt erhalten. Beim Ändern der Spieleranzahl werden Bots automatisch auf- bzw. abgebaut (Menschen bleiben erhalten)

### Fixed
- Rematch mit mehreren Spielern: Der 2. Spieler blieb hängen und kam nicht in die neue Lobby. Ursache war ein über der Lobby klebendes Ergebnis-Overlay bei allen, die den Rematch-Button nicht selbst gedrückt hatten - beim Wechsel zurück in die Lobby wird es jetzt zuverlässig ausgeblendet

## [1.47.4] - 2026-07-07

### Changed
- Datenschutzerklärung ergänzt (DE + EN): Neuer Punkt zum anonymisierten Aufzeichnen von Spielzügen zur Verbesserung der Computergegner - ausschließlich Zahlenwerte des Spielzustands, ohne Name, Konto-/Gerätekennung oder IP, nicht auf die Person rückführbar, keine Weitergabe an Dritte (Art. 6 Abs. 1 lit. f DSGVO). Hintergrund: Das Menschen-Zug-Logging ist seit v1.47.3 standardmäßig aktiv
- README aktualisiert: drei Bot-Stufen (Anfänger/Fortgeschritten/Zen) statt vier, „Schwer" entfernt, Testzahl auf 223, KI-Abschnitt nennt jetzt easy=Heuristik und den Warmstart aus menschlichen Gewinnpartien

## [1.47.3] - 2026-07-07

### Changed
- Lobby: Die Versionsanzeige zeigt jetzt nur noch „v x.y.z" statt „Version x.y.z"
- Lobby: Der GitHub-Link ist jetzt nur noch das Logo (Text „Open Source auf GitHub" entfernt), mit Barrierefreiheits-Label
- Menschen-Zug-Logging (für das Imitation-Learning-Training) ist jetzt STANDARDMÄSSIG AN. Zum Abschalten PIKDAME_LOG_GAMES=0 (bzw. false/off) setzen. Docker-Kommentare und Doku entsprechend aktualisiert

## [1.47.2] - 2026-07-06

### Fixed
- Changelog-Anzeige rendert jetzt auch Links: Markdown-Links [Text](https://…) UND rohe http(s)-Adressen werden anklickbar (in neuem Tab, mit rel=noopener). Nur http/https werden verlinkt - z. B. javascript: bleibt unverlinkt, kein XSS-Risiko

### Changed
- Docker: klargestellt und dokumentiert, dass der data-Ordner (Sitzungsdaten, optionale SQLite, und ggf. human-moves.jsonl) automatisch angelegt und im benannten Volume pikdame-data persistiert wird. Für den direkten Zugriff vom Host ist in beiden compose-Dateien jetzt eine auskommentierte Bind-Mount-Alternative plus ein docker-cp-Hinweis hinterlegt; ein auskommentiertes PIKDAME_LOG_GAMES=1 zeigt, wo man das Menschen-Logging einschaltet. Der sichere Default (Named Volume, read-only Root-FS) bleibt unverändert

## [1.47.1] - 2026-07-06

### Added
- Menschen-Zug-Logs enthalten jetzt deutlich mehr trainingsrelevante Infos pro Zug: Platzierung (rank), Endpunktzahl, Gewinner-Punktzahl, Spieler-/Runden-/Zug-Anzahl, aktuelle Runde/Zugnummer, eigene Handgröße, gegnerische Handgrößen und ob eine Stapelaufnahme legal war - so kann das Training Züge gewichten oder filtern statt nur blind Gewinner zu klonen
- train.py berücksichtigt Menschendaten jetzt AUTOMATISCH: Liegt data/human-moves.jsonl vor, startet jede Stufe mit einer Behavioral-Cloning-Vorphase (abschaltbar per --no-human-data). Die Datei gehört nach <repo>/data/human-moves.jsonl

### Changed
- Menschen-Zug-Logs werden standardmäßig minifiziert abgelegt (kompaktes JSON, Beobachtungen auf 4 Nachkommastellen gerundet, Maske als 0/1) - deutlich kleinere Dateien ohne Informationsverlust fürs Training

### Fixed
- Changelog-Anzeige interpretiert **fett** (und *kursiv*) jetzt korrekt statt die Sternchen roh anzuzeigen

### Investigated, not shipped
- Zurückhalten hoher Melds (Damen-Satz / Pik-Folge neben der Damen-Position), um dem Gegner das Anlegen der Pik Dame (100 Punkte) zu verwehren: Die Überlegung ist berechtigt, aber im Selbstspiel klar gemessen negativ - das Zurückhalten kostet den Bot mehr (nicht gebankte Punkte, riskante Karten in der Hand), als der gelegentliche verschenkte Layoff schadet (breite Variante −20 Punkte/6,7σ, chirurgische Variante nur bei fast fertigem Gegner immer noch −5/1,5σ). Nicht ausgeliefert; der Bot legt hohe Melds weiterhin früh aus (das bankt sicher Punkte). Gegen menschliche Gegner, die die Pik Dame gezielt horten, könnte die Abwägung anders liegen - das ließe sich später mit echten Menschendaten prüfen

## [1.47.0] - 2026-07-06

### Added
- Aus Menschenspielen lernen (Imitation Learning): Mit PIKDAME_LOG_GAMES=1 zeichnet der Server jede menschliche Zieh- und Abwurfentscheidung über denselben StateEncoder auf, den das Netz nutzt, und schreibt sie am Spielende anonym nach data/human-moves.jsonl (nur kodierte Beobachtung, Aktion, Maske, anonyme Spiel-ID und ein „gewonnen"-Flag - keine Namen/Konten/Klarkarten). train.py kann diese Daten direkt berücksichtigen: --human-data startet eine Behavioral-Cloning-Vorphase (überwachtes Nachahmen der Gewinner-Züge), auf die dann PPO aufsetzt (SL→RL wie bei AlphaGo); --bc-only liefert ein reines Menschen-Imitations-Modell. Motivation: Ein nur gegen Bots trainiertes Netz überanpasst sich an Bot-Verhalten und wird für Menschen berechenbar - menschliche Gewinner-Züge bringen Stil und Unberechenbarkeit. Neuer Loader python/human_dataset.py, Doku-Abschnitt in docs/RL_TRAINING.md

## [1.46.2] - 2026-07-06

### Changed
- RL-Training erzeugt jetzt nur noch Netze für **Fortgeschritten** und **Zen**. Der Anfänger-Bot bleibt bewusst die handgeschriebene Heuristik: Reinforcement Learning optimiert auf Gewinnen und kann Schwäche nicht sinnvoll „trainieren". Ohne easy-Modell fällt ein Anfänger-Bot zur Laufzeit automatisch auf die Heuristik zurück (zufällige Abwürfe - der natürliche „macht Anfängerfehler"-Gegner). train.py, ONNX-Warmup, models/README und docs/RL_TRAINING.md entsprechend angepasst; die Doku erklärt zusätzlich, wie man bei Bedarf aus EINEM starken Netz per ε-greedy/Temperatur einen stufenlosen Schwierigkeitsregler ableiten könnte

## [1.46.1] - 2026-07-06

### Changed
- Aufräumen nach der Entfernung von „Schwer": Die Übergangs-Normalisierung von Alt-Werten („hard" → „Fortgeschritten") wurde entfernt - der Code kennt jetzt nur noch die drei echten Stufen (Anfänger/Fortgeschritten/Zen), ohne Kompatibilitäts-Weichen. Ein gespeichertes Spiel mit der alten „Schwer"-Stufe wird bewusst NICHT mehr umgesetzt (einmalige Ausnahme); ein solcher Bot spielt technisch weiterhin wie „Fortgeschritten", ist per Menü aber neu einzustellen. Toter Codepfad im Divergenz-Werkzeug ebenfalls entfernt

## [1.46.0] - 2026-07-06

### Changed
- Bot-Stufen umbenannt und auf drei reduziert: **Anfänger** (vorher „Leicht"), **Fortgeschritten** (vorher „Mittel") und **Zen-Meister**. Die interne Spiellogik bleibt gleich (Werte easy/medium/zen), nur die Anzeige ist klarer

### Removed
- Spielmodus „Schwer" (hard) komplett entfernt: Messungen (scripts/bot-divergence.js) hatten gezeigt, dass „Schwer" und „Mittel" bei Abwürfen zu 0,0 % unterschiedliche Entscheidungen trafen - also behavioral identisch waren (der einzige frühere Unterschied, der Damen-Notabwurf, fiel in v1.36.1 weg). Die Stufe bot keinen echten Mehrwert. Alt-Spiele oder gespeicherte Zustände mit „Schwer" werden automatisch als „Fortgeschritten" weitergeführt

## [1.45.3] - 2026-07-05

### Changed
- Trainings-Gegnerpools an eine gemessene Erkenntnis angepasst: Die Heuristik-Stufen sind weniger verschieden als gedacht. Neues Messwerkzeug scripts/bot-divergence.js zeigt - medium und hard treffen bei Abwürfen zu 0,0 % unterschiedliche Entscheidungen (behavioral identisch, seit der Damen-Notabwurf in v1.36.1 entfernt wurde), hard vs. zen unterscheiden sich in ~18 % der Abwürfe, easy ist zufällig. Es gibt also nur DREI wirklich verschiedene Stile (easy, medium≡hard, zen). Ein medium+hard-Pool wäre daher heimlich monoton; die Pools kombinieren jetzt die tatsächlich verschiedenen Stile. Fazit in docs/RL_TRAINING.md ergänzt: Der zen/hard-Unterschied liefert nur schmale, eindimensionale Vielfalt - für robusten Overfitting-Schutz ist die Self-Play-Liga der eigentliche Hebel, nicht der Heuristik-Mix

## [1.45.2] - 2026-07-05

### Changed
- RL-Training kann jetzt gegen einen gemischten Gegner-Pool laufen, verankert am bestehenden Zen-Meister: Der Env-Server akzeptiert per-Sitz-Schwierigkeiten, die Python-Umgebung eine feste Liste ODER einen bei jeder Episode neu gesampelten Pool. Die vier Trainingsstufen nutzen jetzt zen-verankerte Pools (z. B. hard trainiert gegen hard/hard/zen). Hintergrund: Ein fixer starker Referenzgegner liefert ein klares "ist das Netz besser als unser bester handgeschriebener Bot?"-Signal und verhindert Overfitting auf die Eigenheiten eines einzelnen Gegners - reines Training nur gegen Zen würde überanpassen. eval_onnx.py wertet standardmäßig gegen die Zen-Baseline aus; docs/RL_TRAINING.md erklärt Gegnerwahl, Baselines und den Self-Play-Liga-Ausbau als nächsten Schritt

## [1.45.1] - 2026-07-05

### Added
- Zug-Zähler: Am Spielende zeigt der Ergebnisbildschirm jetzt, wie viele Züge die ganze Partie gedauert hat (und über wie viele Runden) - eine schöne kleine Statistik zum Herzeigen

### Security
- Absicherung der neuen Bot-Steuerungsfelder (Zieh-Quelle, externer Abwurf, Rollout-Flags): Sie wählen ohnehin nur unter regulär erlaubten Aktionen (kein Zugriff auf verdeckte Karten) und wirken nur für Bot-Züge. Zusätzlich abgesichert, dass sie weder aus Client-Nachrichten (feste Handler, kein Feld-Kopieren) noch aus einem manipulierten/gespeicherten Spielstand eingeschleust werden können: Beim Wiederherstellen werden sie von allen Sitzen entfernt und beim Speichern nie mitgeschrieben (mit Tests für beide Wege)

### Changed
- Entwickler-Handbuch (CLAUDE.md) um das komplette RL/ONNX-Wissen ergänzt: Encoder-Parität, Steuerungs-Seams, Anti-Cheat-Absicherung, Messdisziplin (Winrate immer über Batches mit Standardfehler) und die als „untersucht, nicht ausgeliefert" dokumentierten Verfahren (Monte-Carlo, Rollout-Suche)

## [1.45.0] - 2026-07-05

### Changed
- RL-Agent lernt jetzt ZWEI Entscheidungen pro Zug statt nur den Abwurf: zusätzlich die Zieh-Quelle - verdeckt vom Stapel ziehen ODER den kompletten Ablagestapel nehmen (nur wenn regelkonform). Der Aktionsraum wuchs von 52 auf 54 (52 Abwurf-Typen + 2 Zieh-Aktionen), der Beobachtungsvektor um ein Entscheidungsphasen-Flag (376 → 377). Ziel: ein am Ende wirklich runder Bot, der auch die Stapel-Aufnahme optimal timing-t. Encoder, headless Env-Server und ONNX-Laufzeit (inkl. Zieh-Entscheidung) sind entsprechend erweitert; Auslegen bleibt heuristisch
- Trainings-Anleitung (docs/RL_TRAINING.md) auf Englisch, auf Ubuntu 24.04 und uv umgestellt (Python auf der jeweils höchsten vom ML-Stack unterstützten Version), inklusive RTX-5080-CUDA-Hinweisen
- Haupt-README um einen Abschnitt zu den KI-Bots (ONNX, Aktivierung per PIKDAME_ONNX) ergänzt
- Die exportierten .onnx-Modelle werden ab jetzt ins Repository aufgenommen (öffentliches Repo, sofort lauffähig) - nur die großen SB3-.zip-Checkpoints bleiben ausgeschlossen

## [1.44.0] - 2026-07-05

### Added
- Reinforcement-Learning-Trainingsgerüst für die Bots (neu, optional): Ein neuronales Netz kann die Abwurfentscheidung lernen und wird als ONNX-Datei je Bot-Stufe (easy/medium/hard/zen) exportiert. Trainiert wird gegen die ECHTE Spiel-Engine - ein headless Node-Env-Server (scripts/rl-env-server.js) treibt den realen GameManager, die Python-Umgebung (Gymnasium + MaskablePPO aus stable-baselines3) steuert ihn über eine stdio-JSON-Leitung. Dadurch lernt das Netz gegen die exakten Spielregeln statt gegen einen fehleranfälligen Nachbau. Kern-Bausteine: ein zustandsidentischer Encoder (game/StateEncoder.js, speist Training UND Laufzeit), das Trainingsskript (python/train.py) samt ONNX-Export, ein Prüf-Skript (python/eval_onnx.py) und eine ausführliche WSL2/Windows-11-Anleitung (docs/RL_TRAINING.md)
- ONNX-Inferenz zur Laufzeit, per Umgebungsvariable aktivierbar: Mit PIKDAME_ONNX=1 nutzen Bots das gelernte Netz für den Abwurf (game/OnnxPolicy.js, onnxruntime-node). Ohne die Variable - oder wenn Modell bzw. Laufzeit fehlen - spielen die Bots exakt wie bisher; jeder Fehler fällt lautlos auf die Heuristik zurück, der Standardpfad bleibt unverändert

### Changed
- Determinisierte Rollout-Suche (MCTS) aus v1.43.x wird NICHT produktiv geschaltet: In einer sauberen Batch-Messung über mehrere Hundert Partien blieb der Effekt klein und statistisch nicht belastbar (~+2 Gewinnrate-Punkte bei ~0,8 Sigma) - bei rund 500 ms Rechenaufwand pro Endspiel-Entscheidung. (Ein erster, vielversprechender Messwert von +8,5 Punkten/2,8 Sigma erwies sich bei größerer Stichprobe als günstige Varianz.) Das Modul bleibt als getestetes, per Flag aktivierbares Werkzeug im Code; der Weg nach vorn ist stattdessen das gelernte ONNX-Netz

## [1.43.1] - 2026-07-05

### Investigated, not shipped
- Monte-Carlo-Simulation über verdeckte Gegnerhände (200 Samples, konsistent mit der Kartenzählung): Ein neues, getestetes Modul (game/MonteCarlo.js) zieht aus dem öffentlichen Wissen den unsichtbaren Kartenpool, verteilt ihn regelkonform auf die Gegner und schätzt für jeden Abwurf-Kandidaten die Wahrscheinlichkeit, dass der nächste Spieler damit eine NEUE Kombination bilden könnte - genau die verdeckte Information, die keine Heuristik kennt. Im Selbstspiel gemessen (Batch-Varianz, mehrere Hundert Partien, Vier- UND Zweispieler): kein statistisch belastbarer Effekt (+0,6 Punkte bei 0,2 Sigma - reines Rauschen). Grund: Die bestehenden deterministischen Zen-Bausteine (Vorfilter für anlegbare Karten und Damen-Köder, erschöpfungsbewusstes Kombinations-Potenzial, dreifach gewichtete beobachtete Gegnerkarten) leiten dasselbe Signal bereits ab - MC berechnet es teurer neu, ohne neue Erkenntnis. Modul, Sampler und das A/B-Messwerkzeug (scripts/sim-bots.js --mc) bleiben getestet im Code für spätere, grundlegend andere Ansätze (z. B. vollständige Ausspiel-Rollouts bis Rundenende); die Produktion ist unberührt (nur aktiv, wenn ein Bot-Sitz das Flag ausdrücklich setzt, was ausschließlich das Sim-Werkzeug tut)

## [1.43.0] - 2026-07-05

### Added
- Joker-Ausstieg: Bots nutzten die Regel "letzte Handkarte gegen einen Joker aus der eigenen Auslage tauschen" bisher NIE - jetzt prüft jeder Bot ab Stufe Mittel bei jedem Zug, ob eine Handkarte exakt zu einem Joker-Slot in der eigenen Auslage passt (Rang UND Farbe), und tauscht. Bei der letzten Handkarte endet die Runde dadurch sofort - ein bisher komplett ungenutzter Gewinnzug
- Allgemeine Stapel-Risiko-Bewertung: Der bisherige Schutz galt nur der Pik Dame ("liegt sie versteckt im Stapel? Finger weg kurz vor Rundenende"). Jetzt vergleicht der Bot den Punktwert, auf dem er sitzen bleiben würde, MIT und OHNE die Stapelaufnahme (volle Anlege-Simulation) - jeder teure vergrabene Kartensatz (zwei Könige, ein einsames Ass) wird kurz vor Rundenende genauso gemieden wie früher nur die Dame
- Punktestand-Bewusstsein (Zen): Bei komfortablem Vorsprung in der laufenden Partie schützt der Zen-Meister ihn etwas konsequenter (gefährliche Karten werden noch ungerner gehalten); bei deutlichem Rückstand nimmt er etwas mehr Risiko in Kauf, um schneller aufzuholen. Bei ausgeglichenem Stand - inklusive jeder ersten Runde - bleibt das Verhalten exakt wie zuvor

### Investigated, not shipped
- Bewusstes Zurückhalten einer fertigen Kombination, um einem kurz vor dem Ausmachen stehenden Gegner keinen bekannten Anlege-Platz zu verschaffen, wurde gebaut und im Selbstspiel gemessen - das Ergebnis war eindeutig eine VERSCHLECHTERUNG (Winrate gegen "Schwer" fiel von ~30 % auf 17 %): Das Zurückhalten kostet mehr eigenes Tempo, als es dem Gegner nimmt. Per Ablationstest bestätigt und wieder entfernt, um keine Regression auszuliefern - der reine Erkennungsbaustein bleibt getestet im Code für spätere, klügere Anwendung

## [1.42.0] - 2026-07-05

### Changed
- Standard-Bot-Stufe ist jetzt der Zen-Meister - überall: beim Erstellen eines Spiels (Auswahlliste vorbelegt), beim Schnellstart, beim Auffüllen leerer Plätze UND als Vertretungs-Stärke, wenn ein getrennter Spieler vorübergehend vom Bot übernommen oder ein Zug nach Ablauf des Zug-Timers zu Ende gespielt wird. Wie gehabt pro Spiel und pro Bot jederzeit umstellbar

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

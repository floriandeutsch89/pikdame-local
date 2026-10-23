<!-- Operators: migration 004 adds the table play_events (runs by itself on the next start); the admin page gets a fourth tab "Festhänger". -->
### Added
- Kartenhaus: Jeder Versuch einer Etage wird mit Spielername, Ergebnis und
  Verlauf (Punkte, Züge, Grund für einen fehlenden Stern oder Abbruch) 90 Tage
  lang gespeichert. Die Admin-Seite zeigt daraus im neuen Bereich
  „Festhänger“, auf welcher Etage Spieler hängen bleiben und warum.
- Datenschutzerklärung: Abschnitt zu den gespeicherten Spielversuchen.

### Fixed
- Nach einem Server-Neustart konnte ein Tisch selten einfrieren: Das Spiel lief
  weiter, aber niemand bekam mehr den aktuellen Spielstand zu sehen.

### Changed
- Datenbank aufgeräumt: Tages-Challenge und Kartenhaus-Versuche speichern Tage
  als Datum und Zeitpunkte als Zeitstempel mit Zeitzone, die Spalten heißen
  eindeutig (`game_day`, `player_key`, `started_at` …); `play_events` heißt
  jetzt `play_attempts`, Monat und Etage stehen in eigenen Spalten. Für Betreiber:
  die Umstellung läuft beim ersten Start einmal von selbst, alle Daten bleiben
  erhalten; eigene SQL-Abfragen auf die alten Namen bitte anpassen
  (docs/admin/play-attempts.md).

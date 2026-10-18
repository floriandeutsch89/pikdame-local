<!-- bump: minor -->
<!-- Operators: players.json and stammtisch.json are imported into PostgreSQL once on the first start and renamed *.migrated. -->
### Changed
- Spielerprofile (Statistik, Abzeichen, Fortschritt) und Stammtische liegen
  jetzt in der Datenbank statt in Dateien. Bestehende Daten werden beim ersten
  Start einmalig übernommen.

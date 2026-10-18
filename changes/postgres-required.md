<!-- bump: minor -->
<!-- Operators: PIKDAME_DATABASE_URL is now required; a users.db from the old SQLite fallback is not migrated. -->
### Changed
- Der Server speichert Konten nur noch in PostgreSQL und startet ohne
  Datenbank nicht mehr. Die SQLite-Notlösung ist entfernt.

### Fixed
- Wer unter dem Namen eines noch unbestätigten Kontos spielte, bekam nach der
  Partie einen Konto-Fortschritt angezeigt, obwohl nichts gebucht wurde.

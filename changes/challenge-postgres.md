<!-- Operators: the first start imports data/challenges.json into PostgreSQL once and renames it to challenges.json.migrated; rollback: see docs/admin/operations.md. -->
### Changed
- Die Tages-Challenge speichert Bestenliste und Versuche jetzt in der
  Datenbank. Ein Neustart des Servers direkt nach dem Start oder Ende einer
  Challenge kann den Versuch nicht mehr verlieren, und ein doppelter Tipp auf
  „Starten“ beginnt nie zwei gewertete Spiele.

<!-- bump: minor -->
<!-- Operators: set PIKDAME_IMPRINT_NAME, _STREET, _CITY and _EMAIL in docker/.env BEFORE deploying, otherwise the legal page shows "Impressum nicht konfiguriert". -->
### Changed
- Die Anbieterangaben im Impressum kommen jetzt aus der Server-Konfiguration statt aus dem Quellcode. Fehlen sie, zeigt die Seite deutlich „Impressum nicht konfiguriert“.

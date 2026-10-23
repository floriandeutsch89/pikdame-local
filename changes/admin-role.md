### Changed
- Der Admin-Bereich gehört jetzt zu einem Spielerkonto mit Admin-Rolle: Admins
  finden im Konto-Dialog den Punkt „Admin-Bereich“ und bestätigen sich dort
  noch einmal mit ihrem Passkey (ohne Passkey mit dem Passwort des Kontos)
- Eine Admin-Sitzung endet nach 15 Minuten ohne Aktivität, spätestens nach
  8 Stunden, beim Abmelden im Spiel und sobald die Rolle entzogen wird
- Neuer Bereich „Protokoll“ im Admin-Bereich: wer wann was getan hat
  (365 Tage, Adressen nur gekürzt)

### Removed
- Das eigene Admin-Passwort (`PIKDAME_ADMIN_TOKEN`) mit dem Anmeldefenster des
  Browsers. Admins bestimmt jetzt der Betreiber über `PIKDAME_ADMINS` oder
  `node scripts/admin-role.js`

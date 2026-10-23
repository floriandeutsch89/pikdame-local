<!-- Migration 008: account tables in TIMESTAMPTZ with clear names, users.player_id, indexes for the mail links -->
### Changed
- Ein bestätigtes Konto ist in der Datenbank fest mit seinem Spielerprofil verbunden; ein Profil mit Konto lässt sich erst nach dem Konto löschen
- Bestätigungs-, Anmelde- und Abmelde-Links aus Mails sowie Anmeldungen werden schneller gefunden

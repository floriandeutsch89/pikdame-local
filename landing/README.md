# Landing Page für pikdame.online

Eigenständige statische Seite (`index.html`) als Startseite von
pikdame.online: Besucher wählen zwischen dem **Kartenspiel** und dem
bisherigen **Schreibblock**.

## Einrichten

1. Die zwei `href`-Adressen in `index.html` anpassen (deutlich markierter
   Kommentar-Block):
   - Kartenspiel-Link → dorthin, wo der Node-Server des Spiels läuft
   - Schreibblock-Link → die bisherige Schreibblock-App
2. `index.html` als Startseite von pikdame.online hosten (jeder statische
   Webspace reicht - kein Build, keine Abhängigkeiten).

## Empfehlung: Subdomains statt Unterpfade

Das Kartenspiel erwartet, unter der **Wurzel** seiner Adresse zu laufen
(`/client.js`, WebSocket auf `/`, PWA-Manifest). Am einfachsten:

- `pikdame.online`        → diese Landing Page (statisch)
- `spiel.pikdame.online`  → Reverse-Proxy auf den Spiel-Container (Port 8080, inkl. WebSocket-Upgrade)
- `block.pikdame.online`  → der bisherige Schreibblock

Beispiel nginx für das Spiel:

```nginx
server {
  server_name spiel.pikdame.online;
  location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;   # WebSocket
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  }
}
```

Unterpfad-Hosting (`pikdame.online/spiel/`) würde Anpassungen an allen
absoluten Pfaden des Spiels erfordern - bei Bedarf melden.

# Config check and admin page

Two ways to see which features are set up, and what is missing for the ones
that are only half configured.

## Startup report (always on)

Every start logs one block. Problems come first:

```
[config] Konfiguration:
[config]  ⚠ E-Mail               smtp.example.com: unvollständig - … (fehlt: PIKDAME_SMTP_PASS, PIKDAME_MAIL_FROM)
[config]  ⚠ Öffentliche Adresse  nicht gesetzt - Bestätigungslinks entstehen aus dem Host-Header (fälschbar) (fehlt: PIKDAME_BASE_URL)
[config]  ✓ Datenverzeichnis     /app/data
[config]  ✓ Benutzerkonten       aktiv (PostgreSQL)
[config]  – ONNX-Bots            Heuristik (Laufzeit/Modelle nicht vorhanden)
[config] 2 Punkt(e) brauchen Aufmerksamkeit (Details auch unter /admin, falls aktiv).
[config] SMTP-Prüfung: Anmeldung erfolgreich.
```

| Icon | Meaning |
| --- | --- |
| `✗` | Broken: the feature cannot work as configured |
| `⚠` | Works, but something is missing (e.g. mails without a sender address) |
| `✓` | Configured |
| `–` | Off (deliberately or not configured) |

Checked: data directory, accounts, database, mail, public base URL, reverse
proxy, WebSocket origin, ONNX bots, public mode, the admin page itself.

When `PIKDAME_SMTP_HOST` is set, the server also **logs in to the mail server
once and leaves again without sending** — a wrong host, port, TLS mode or
password shows up right after the start instead of at the first registration.

Secret values are never logged, only whether they are set.

```bash
docker compose logs app | grep '\[config\]'
```

## Admin page (`/admin`, optional)

Shows the same report, the result of the last SMTP check, a few runtime numbers
(version, uptime, games, connected players, memory), and two buttons:
**Verbindung prüfen** (SMTP login without sending) and **Testmail senden**.
It is read-only: configuration still lives in your compose file.

### Turn it on

Set a long random token (any length works; 32+ random bytes recommended):

```bash
openssl rand -hex 32
```

```yaml
environment:
  - PIKDAME_ADMIN_TOKEN=${PIKDAME_ADMIN_TOKEN:-}
# or, as a Docker secret:
#   - PIKDAME_ADMIN_TOKEN_FILE=/run/secrets/admin_token
```

Recreate the container (`docker compose up -d`). Open `https://<your-host>/admin`;
the browser asks for a login: **any user name, the token as password**.

Without the token, `/admin` answers `404` like any unknown path.

### Security

- HTTP Basic auth over your HTTPS proxy; the token is compared in constant time.
- 10 failed logins per IP within 15 minutes → `429` for the rest of the window.
- The test-mail form carries a CSRF token and refuses cross-site requests
  (`Sec-Fetch-Site`); at most 5 test mails per IP in 10 minutes.
- Responses are `no-store`, `noindex`, not frameable.
- Rotate the token by changing the variable and recreating the container.

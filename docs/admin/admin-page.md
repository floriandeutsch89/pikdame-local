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
docker compose logs pikdame | grep '\[config\]'
```

## Admin page (`/admin`, optional)

Shows the same report with **every variable behind each entry** (green = set,
grey = not set, default in use; values are never shown), the result of the last
SMTP check, a few runtime numbers (version, uptime, games, connected players,
memory), and two buttons: **Verbindung prüfen** (SMTP login without sending)
and **Testmail senden**. It is read-only: configuration still lives in your
compose file.

The credential works like Vaultwarden's `ADMIN_TOKEN`: the environment holds an
**Argon2id hash** of your admin password, never the password itself. Anyone who
reads the container environment, a backup of `.env` or `docker inspect` learns
nothing they can log in with.

### Tutorial: turn it on (5 minutes)

**1. Create the password and its hash** — inside the running container, so the
right Node version is guaranteed:

```bash
cd docker
docker compose exec pikdame node game/AdminToken.js --generate
```

```
Admin-Passwort (in den Passwort-Manager, wird nicht gespeichert):
  <zufälliges Passwort, 32 Zeichen>

PIKDAME_ADMIN_TOKEN (Argon2id-Hash):
  $argon2id$v=19$m=19456,t=2,p=1$ICbpy1eC…$dh6lblC5…

In docker/.env in EINFACHEN Anführungszeichen eintragen (sonst ersetzt Compose die $-Teile):
  PIKDAME_ADMIN_TOKEN='$argon2id$v=19$m=19456,t=2,p=1$ICbpy1eC…$dh6lblC5…'
```

Put the **password** into your password manager — it is shown once and stored
nowhere. Prefer your own password? Leave out `--generate`; the tool asks twice,
hidden (pasting from a password manager works). At least 12 characters.

**2. Store the hash** in `docker/.env`, exactly as printed, **with the single
quotes**:

```bash
PIKDAME_ADMIN_TOKEN='$argon2id$v=19$m=19456,t=2,p=1$ICbpy1eC…$dh6lblC5…'
```

:::{warning}
Without the single quotes Compose treats every `$argon2id`, `$v`, … as a
variable and silently replaces it with an empty string. The server then logs
`✗ Admin-Seite … ist aber ungültig` and `/admin` stays off.
:::

**3. Recreate the container** — a plain restart keeps the old environment:

```bash
docker compose up -d
```

**4. Check the log:**

```bash
docker compose logs pikdame | grep 'Admin-Seite'
# [config]  ✓ Admin-Seite          /admin aktiv (Argon2id-Hash)
```

**5. Log in:** open `https://<your-host>/admin`.

:::{note}
There is no login page. The **browser's own small login dialog** appears
(HTTP Basic auth — Chrome: "Anmelden", Safari: "Bei dieser Website anmelden"):

> **Benutzername:** anything, e.g. `admin` — it is ignored
>
> **Passwort:** the password from step 1

Your password manager can store it like any other site login. The first login
takes a few milliseconds longer — that is the Argon2 check.
:::

When everything is set up, every entry is green and each one lists the
variables it is built from:

```{figure} img/admin-overview.png
:alt: Admin page, configuration section: every entry with a green check mark and its variables
:width: 100%

The configuration section of a complete setup. Green variables are set, grey
ones are not set and use their default. Values are never shown.
```

**6. Check the mail setup:** under *E-Mail prüfen*, the first line shows the
result of the SMTP login the server made at startup. **Verbindung prüfen**
repeats it (login and logout, no mail is sent).

```{figure} img/admin-mail-check.png
:alt: Mail check panel: SMTP login successful, recipient field, buttons
:width: 100%

The SMTP login works.
```

Then enter your own address and press **Testmail senden**. The answer appears
at the top of the page:

```{figure} img/admin-testmail-sent.png
:alt: Green notice: test mail was accepted by the SMTP server
:width: 100%
```

"vom SMTP-Server angenommen" means your relay accepted the mail. If it does not
arrive within a few minutes, check the provider's log and your spam folder —
the most common cause is a sender address (`PIKDAME_MAIL_FROM`) on a domain the
provider has not verified.

### Alternatives

- **Docker secret instead of `.env`:** write the hash (no quotes) into a file,
  e.g. `docker/secrets/admin_token.txt`, mount it as a secret and set
  `PIKDAME_ADMIN_TOKEN_FILE=/run/secrets/admin_token` instead of
  `PIKDAME_ADMIN_TOKEN`. No quoting issues at all.
- **Without Docker:** `node game/AdminToken.js` in the project folder
  (Node 24.7 or newer).
- **Plain token:** a value that does not start with `$argon2` is compared as a
  plain password. It works, but the report shows `⚠` until you switch to a hash.

### Change or revoke

- New password: repeat steps 1–3. The old one stops working at once.
- Turn it off: remove `PIKDAME_ADMIN_TOKEN`, `docker compose up -d`. `/admin`
  then answers `404` like any unknown path.

### Troubleshooting

| Symptom | Cause |
| --- | --- |
| `/admin` gives `404` | Token not set, or invalid — see the `Admin-Seite` line in the log |
| Log: `… ist aber ungültig (abgeschnitten? …)` | `.env` value without single quotes, or hash copied incompletely |
| Log: `… dieses Node … kann Argon2 nicht prüfen` | Node older than 24.7 (only outside the official image) |
| Login dialog keeps coming back | Wrong password — the user name does not matter |
| `429 Zu viele Fehlversuche` | 10 wrong passwords from your IP in 15 minutes; wait it out |
| `503 Gerade ausgelastet` | More than two password checks at the same moment; retry |

### Security

- The password is checked against the Argon2id hash with Node's built-in
  `crypto.argon2` (19 MiB, 2 passes — OWASP's first recommendation). After the
  first successful check, the page remembers a SHA-256 of the accepted
  password in memory, so further page loads do not repeat the expensive check.
- At most two Argon2 checks run at once; 10 failed logins per IP within
  15 minutes and 30 failures per minute across all IPs are refused with `429`.
- Hashes with absurd cost parameters (e.g. a typo making `m` gigabytes) are
  rejected as invalid instead of being computed.
- The test-mail form carries a CSRF token and refuses cross-site requests
  (`Sec-Fetch-Site`); at most 5 test mails per IP in 10 minutes; the recipient
  is validated, so it cannot inject SMTP commands.
- Responses are `no-store`, `noindex`, not frameable. Use it only behind HTTPS
  (the standard Caddy setup does that).

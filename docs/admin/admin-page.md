# Config check and admin area

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
[config]  ✓ Admin-Bereich        /admin für 1 Admin-Konto, Bestätigung per Passkey, sonst Passwort
[config]  ✓ ONNX-Bots            aktiv
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
proxy, WebSocket origin, ONNX bots, public mode, the admin area (is there an
admin, can the step-up work) and an old admin token that is still set.

When `PIKDAME_SMTP_HOST` is set, the server also **logs in to the mail server
once and leaves again without sending** — a wrong host, port, TLS mode or
password shows up right after the start instead of at the first registration.

Secret values are never logged, only whether they are set.

```bash
docker compose logs pikdame | grep '\[config\]'
```

## Admin area (`/admin`)

Only for accounts with the **admin role** (see
[Access](#access-an-account-role) below). Five tabs:

| Tab | What it shows / does |
| --- | --- |
| **Konfiguration** | The report above with **every variable behind each entry** (green = set, grey = not set, default in use; hover or tap shows the value, never that of a password or token), the last SMTP check, buttons **Verbindung prüfen** (SMTP login without sending) and **Testmail senden**. Configuration itself still lives in your compose file. |
| **Benutzer** | All registered accounts: name, **e-mail**, how they sign in (passkeys / password), confirmed / link open / link expired, registration date, XP, games, wins, season XP. **Mail neu senden** (unconfirmed accounts: a fresh code and confirmation link), **Anmelde-Link senden** (confirmed accounts: a 15-minute sign-in link, e.g. after a lost passkey) and **Löschen** (two steps: question, then the real button). Admin accounts carry an **Admin** badge and cannot be deleted here. |
| **Monitoring** | Current values (app container RAM and CPU against its limits, event-loop delay, players, host RAM, free space on the data volume) and **history charts** like a hosting console: ranges 1 h / 24 h / 7 days / 30 days, cursor synced across all charts, drag to zoom, double-click to reset. Updates every 15 s. |
| **Festhänger** | Where players get stuck, with a switch per mode. **Kartenhaus**: the month floor by floor (players, win rate, abandons, median turns, the floor where the curve breaks), the players stuck on a floor with their most common reason, and any player's last attempts. **Rätsel**: the last 7–90 days by puzzle kind and by day (solve and give-up rate, checks until solved, the most common mistake, the hardest days) and the players stuck on a day. **Tutorial**: the lessons as a funnel (reached, completed, where players stop, time, refusals, the lesson where it breaks) and how tutorials end early. See {doc}`play-attempts`. |
| **Protokoll** | The audit log: who did what in the admin area and when, 50 entries per page, newest first. See [Protokoll](#protokoll-audit-log). |

The header names the signed-in admin and when the session ends at the latest,
next to the **Abmelden** button.

When everything is set up, every entry is green and each one lists the
variables it is built from:

```{figure} img/admin-overview.png
:alt: Admin area, Konfiguration tab: header with the signed-in admin and Abmelden, every entry with a green check mark and its variables
:width: 100%

The Konfiguration tab of a complete setup, below the header with the signed-in
admin. Green variables are set, grey ones are not set and use their default.
Hovering or tapping one shows its value, never that of a password or token.
```

### Check the mail setup

Under *E-Mail prüfen*, the first line shows the result of the SMTP login the
server made at startup. **Verbindung prüfen** repeats it (login and logout, no
mail is sent).

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

### Benutzer: what delete and resend do

- **Löschen** removes the account, its login sessions and its play attempts
  ({doc}`play-attempts`); the name is free again. The guest profile under that
  name (statistics and badges in `players`, favourite badges cleared) stays - the player keeps it when
  playing as a guest or registering the name again. Admin accounts are not
  deleted here: the role is the operator's (below).
- **Mail neu senden** replaces the confirmation code and link (the old ones
  stop working). Without a working SMTP setup the new mail is written to the
  server log, as at registration.
- Both actions, like the test mail, are logged (`[admin] …` and the
  **Protokoll**), need the CSRF token of the session and are refused from other
  sites.

### Guest progress follows the name into the account

Players who played as guests first and then register **the same name** keep
everything: the name-based profile was theirs all along. Once, when the e-mail
is confirmed (or, for accounts confirmed earlier, at the next login), the
account's own counters - level, games and wins - are lifted to the profile's
values. Lifted, not added: games already booked on the account are not counted
twice. The season ladder stays untouched: guest XP never buys a place in the
season finale. The log says
`[account] Gast-Fortschritt übernommen: <name> (… EP, … Spiele)`.

### Monitoring: what the numbers mean

- **App-Container** comes from the container's own cgroup: RAM and CPU are
  shown against the limits in `docker-compose.prod.yml` (512 MB, 1 CPU).
  100 % CPU = one full core.
- **Reaktionszeit** is the 99th percentile of how long a message waits before
  the server handles it. Near 0 ms is normal; above ~50 ms for longer
  periods, players notice delays.
- **Server gesamt** is the whole machine (all containers and the system). The
  app cannot see Postgres, Caddy or CrowdSec individually - it has no Docker
  access on purpose.
- **History:** samples are taken every 15 s once an admin exists (or the admin
  area was opened since the start).
  Kept at full resolution for 1 hour, as 5-minute averages for 24 hours and as
  30-minute averages for 30 days - with the **peak** per interval for RAM, CPU
  and response time, so a short spike does not vanish in an average.
  Stored in `data/monitor-history.json` (a few hundred KB), written at most
  once a minute and on shutdown, so deploys and restarts keep it. Deleting the
  file only clears the charts.
- **Gaps** in a chart are times the server did not run (deploy, restart, outage).
- The charts are drawn with [uPlot](https://github.com/leeoniya/uPlot) (MIT,
  ~50 KB), served from the app itself like every other asset - no CDN. Only
  this tab loads it.

## Access: an account role

Who may open `/admin` is a **role of a player account**, the way the admin
consoles of GitHub or Google work: you are signed in to the game with your own
account, the server knows that this account is an admin, and before the admin
area opens it asks you to confirm once more with your **passkey** (GitHub calls
it "sudo mode"). There is no separate admin password.

### Set it up (5 minutes)

**1. Your account.** Sign up in the game with the address you want to use
(Konto → Registrieren) and confirm it with the code from the mail. Add a
passkey (Konto → Anmeldewege → Passkey hinzufügen): the admin area asks for it.

**2. Name the address** in `docker/.env` (several: comma-separated). The game
shows your account's address under your name in **Konto**:

```bash
PIKDAME_ADMINS=you@example.org
```

**3. Pass it to the container.** Compose only passes the variables a service
lists. The compose files in this repository list it; a compose file of **your
own** on the server (the auto-deploy never changes it) needs the line in the
app's `environment:`:

```yaml
    environment:
      - PIKDAME_ADMINS=${PIKDAME_ADMINS:-}
```

**4. Recreate the container** - a plain restart keeps the old environment:

```bash
docker compose up -d
```

**5. Check the log:**

```bash
docker compose logs pikdame | grep -E '\[admin\]|Admin-Bereich'
# [admin] Rolle aus PIKDAME_ADMINS vergeben: <your name>
# [config]  ✓ Admin-Bereich        /admin für 1 Admin-Konto, Bestätigung per Passkey, sonst Passwort
```

**6. Open it:** in the game, **Konto → Admin-Bereich** (only admins see the
link), then **Mit Passkey bestätigen** (Face ID, fingerprint or PIN).

### Who is admin: PIKDAME_ADMINS and the CLI

| Source | Granted | Revoked |
| --- | --- | --- |
| `PIKDAME_ADMINS` | on every start, for each listed address with a **confirmed** account; an address confirmed later gets it at its next sign-in | at the next start after the address left the list |
| CLI `node scripts/admin-role.js grant` | at once, kept across restarts and changes of the list | only by `node scripts/admin-role.js revoke` |

- An account is admin while either source grants it.
- **The list wins:** `revoke` refuses an address that is in `PIKDAME_ADMINS`;
  take it out of the list and recreate the container.
- Addresses match case-insensitively; an unconfirmed address never gets the
  role (the code from the sign-up mail proves the mailbox).
- **No web page and no WebSocket message** can grant or revoke the role.
- Losing the role ends the account's admin sessions at once; the role is also
  checked again on every request.
- The table behind it is `user_roles` (`grant_source` `env` or `cli`, see
  {doc}`../developer/schema`).

### Break-glass

The CLI runs inside the container with its database settings:

```bash
cd docker
docker compose exec pikdame node scripts/admin-role.js list
docker compose exec pikdame node scripts/admin-role.js grant you@example.org
docker compose exec pikdame node scripts/admin-role.js revoke someone@example.org
```

It prints what it did, or why not (exit code 1: unknown address, unconfirmed,
or listed in `PIKDAME_ADMINS`). `list` also names listed addresses that have no
confirmed account yet.

- **Passkey lost:** sign in to the game with the e-mail sign-in link (Konto →
  Anmelde-Link per E-Mail), remove the lost passkey and add a new one, then
  confirm with it. An account with a password and no passkey left confirms
  with the password.
- **No admin left, or the variable forgotten:** `grant` above.
- **A compromised admin account:** take it out of `PIKDAME_ADMINS` (and
  `revoke` a CLI grant), `docker compose up -d`; its admin sessions end at once.
  Then send it a sign-in link or delete it like any account.

### The step-up and the admin session

- **Passkey first:** an account with a passkey must use one of **its own**
  passkeys, with user verification (Face ID, fingerprint, PIN) - a tap alone is
  refused, and so is the password.
- **Else the password** of the account. A password-less account without a
  passkey cannot enter; the page says to add one.
- **Passkeys only:** `PIKDAME_ADMIN_PASSKEY_ONLY=1` in `.env` (every compose
  file passes it; the Helm chart: `admin.passkeyOnly`). It needs passkeys,
  i.e. `PIKDAME_BASE_URL` with https; otherwise nobody gets in and the report
  says so with `✗`.
- **Handoff:** the game keeps its sign-in in the browser, not in a cookie. The
  step-up page (same origin, same tab) reads it there and sends it **in the
  request body** with the passkey answer or the password - never in an
  address, never in a log. The answer sets the admin cookie.
- **The cookie:** `HttpOnly`, `SameSite=Strict`, `Path=/admin`; with an https
  base URL also `Secure` and named `__Secure-pikdame_admin`. Its value is a
  random token; the server stores only its SHA-256 (`admin_sessions`).
- **Lifetime:** 15 minutes without a request, at most 8 hours. The charts'
  refresh every 15 s is no activity: when the session runs out, the Monitoring
  tab reloads into the step-up.
- **It ends** with Abmelden, with signing out of the game on that device, when
  the role is removed and when the account is deleted.
- **CSRF:** every form sends a token bound to the session, and only from the
  same site (`Sec-Fetch-Site`); the cookie itself never travels with a
  cross-site request (`SameSite=Strict`).
- **Failed step-ups:** after 5 per account or 10 per address within 15 minutes,
  or 30 per minute in total, further tries get `429`.

### Protokoll (audit log)

- **Recorded:** step-ups (passed, failed, refused for accounts without the
  role), Abmelden, every change (SMTP check, test mail, year-review preview,
  sign-in link, confirmation mail, account deleted), role grants and
  revocations (`PIKDAME_ADMINS` or CLI, with the sessions they ended), and
  once per session each tab that was looked at.
- **Per entry:** when, which account (the name is copied, so the entry outlives
  a deleted account; `Betreiber (…)` for role changes), what and on whom, and
  the client network cut to `/24` (IPv4) or `/48` (IPv6) - never a full
  address.
- **Kept 365 days** in `admin_audit_events`; older entries are deleted at most
  once an hour.

### From the admin token of older versions

The admin password with its Argon2id hash (`PIKDAME_ADMIN_TOKEN`,
`game/AdminToken.js`, the browser's login dialog) is gone. A value still set
opens nothing; the log says `[admin] WARNUNG: PIKDAME_ADMIN_TOKEN wird
ignoriert …` and the report shows `⚠ Alter Admin-Token`. Remove the variable
from `.env` and from your compose file, and set `PIKDAME_ADMINS` as above.

### Troubleshooting

| Symptom | Cause |
| --- | --- |
| `/admin` gives `404` | Accounts are off (`PIKDAME_ACCOUNTS=0`): without accounts there is no admin |
| "Melde dich zuerst im Spiel … an" | This browser has no game sign-in: sign in, then open the link from the account dialog in the same tab |
| "Dein Konto hat keinen Zugang zum Admin-Bereich" | Its confirmed address is not in `PIKDAME_ADMINS` (or the container never got the variable, step 3) and there is no CLI grant |
| "… weder Passkey noch Passwort" | A password-less account without passkey: add a passkey in the account dialog |
| "Für den Admin-Bereich ist ein Passkey nötig" | `PIKDAME_ADMIN_PASSKEY_ONLY=1` and the account has no passkey |
| `429 Zu viele Fehlversuche` | 5 failures for the account or 10 from your address within 15 minutes; wait |
| Log: `⚠ Admin-Bereich  kein Admin` | Nothing granted yet - see [Set it up](#set-it-up-5-minutes) |
| Back on the step-up page | The session ended: 15 minutes idle, 8 hours, Abmelden, role removed |

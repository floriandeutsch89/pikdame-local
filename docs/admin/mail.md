# E-mail (SMTP)

Pik Dame sends exactly **one** kind of mail: the address-confirmation link a
new account gets after registering. Everything else — game invites, results,
password changes — happens in the app, never by mail.

That means mail is **optional**. Without it the server still runs, accounts
still work; the confirmation link is written to the log instead of being sent
(see [Without a mail server](#without-a-mail-server-the-log-fallback)).

The SMTP client is hand-written on `node:net` / `node:tls` — no dependency, no
native module, so it works in the hotspot/CodeApp mode too.

## Environment variables

| Variable | Default | Meaning |
| --- | --- | --- |
| `PIKDAME_SMTP_HOST` | *(unset)* | Mail server, e.g. `smtp.example.com`. **Unset = log fallback**, nothing is sent. |
| `PIKDAME_SMTP_PORT` | `587` (`465` with `ssl`) | Port. |
| `PIKDAME_SMTP_SECURE` | `starttls` | `starttls`, `ssl` (implicit TLS), or `none` (plaintext — LAN only). |
| `PIKDAME_SMTP_USER` | *(unset)* | Username. Omit it and the client skips `AUTH` entirely. |
| `PIKDAME_SMTP_PASS` | *(unset)* | Password. Prefer `PIKDAME_SMTP_PASS_FILE`. |
| `PIKDAME_SMTP_PASS_FILE` | *(unset)* | Path to a file holding the password — for Docker/Kubernetes secrets. |
| `PIKDAME_SMTP_TLS_SERVERNAME` | *(host)* | Certificate name, when `PIKDAME_SMTP_HOST` points at an egress proxy whose certificate names something else. |
| `PIKDAME_MAIL_FROM` | `Pik Dame <noreply@localhost>` | Sender. Most providers **reject** mail whose `From` is not a mailbox you own. |
| `PIKDAME_BASE_URL` | *(from the request)* | Public base URL used to build the confirmation link, e.g. `https://play.pikdame.online`. Set this behind a reverse proxy, otherwise the link points at the internal host name. |

`PIKDAME_BASE_URL` is not an SMTP setting, but a wrong one is the most common
reason a confirmation mail arrives and then does not work.

## Example: provider with STARTTLS on 587

```yaml
# docker/docker-compose.prod.yml (excerpt)
services:
  pikdame:
    environment:
      - PIKDAME_SMTP_HOST=smtp.example.com
      - PIKDAME_SMTP_PORT=587
      - PIKDAME_SMTP_SECURE=starttls
      - PIKDAME_SMTP_USER=noreply@pikdame.online
      - PIKDAME_SMTP_PASS_FILE=/run/secrets/smtp_pass
      - PIKDAME_MAIL_FROM=Pik Dame <noreply@pikdame.online>
      - PIKDAME_BASE_URL=https://play.pikdame.online
    secrets:
      - smtp_pass

secrets:
  smtp_pass:
    file: ./secrets/smtp_pass.txt
```

Keep the password in a file, not in `environment:` — the compose file usually
ends up in version control, and `docker inspect` shows plain env values to
anyone who can reach the socket.

:::{warning}
The container runs **read-only** with `cap_drop: ALL` (see
{doc}`operations`). Mount the secret file read-only as well; do not write it
into the image.
:::

### Implicit TLS on 465

```
PIKDAME_SMTP_SECURE=ssl
PIKDAME_SMTP_PORT=465
```

### Unauthenticated relay in the LAN

```
PIKDAME_SMTP_HOST=192.168.1.25
PIKDAME_SMTP_PORT=25
PIKDAME_SMTP_SECURE=none
```

Leave `PIKDAME_SMTP_USER` unset — the client then sends no `AUTH` at all.
Only do this on a network you control; `none` means the password *and* the
message travel unencrypted.

## Passing the settings into the container

Compose forwards **only the variables a service lists**. In the simple stacks
(`docker/docker-compose.yml`, `docker/docker-compose.ghcr.yml`) the mail
variables are listed and read from `docker/.env`:

```
# docker/.env
PIKDAME_SMTP_HOST=smtp.example.com
PIKDAME_SMTP_PORT=587
PIKDAME_SMTP_SECURE=starttls
PIKDAME_SMTP_USER=noreply@example.org
PIKDAME_SMTP_PASS=…
PIKDAME_MAIL_FROM=Pik Dame <noreply@example.org>
PIKDAME_BASE_URL=https://play.example.org
```

Then `docker compose up -d` (a plain restart does not pick up new environment
values — the container has to be recreated). Anything left unset stays empty
and the log fallback below stays active.

### The production stack

`docker-compose.prod.yml` defaults to the **egress proxy**: the app container
has no route to the internet and reaches SMTP only through a socat relay that
can open exactly one destination. The relay host is a single variable,
`PIKDAME_SMTP_RELAY_HOST`, which feeds **both** the socat target and
`PIKDAME_SMTP_TLS_SERVERNAME` — the certificate belongs to the real mail
server, not to the proxy, so those two must never drift apart:

```
# docker/.env - switch provider in one place
PIKDAME_SMTP_RELAY_HOST=smtp.eu.mailgun.org
PIKDAME_SMTP_RELAY_PORT=587
PIKDAME_SMTP_USER=postmaster@…
PIKDAME_MAIL_FROM=Pik Dame <noreply@…>
```

**Going direct instead.** If the proxy is more trouble than it is worth, set
`PIKDAME_SMTP_HOST` to the mail server itself and add `- caddy_egress` to the
app service's `networks:` block; the socat service can then be removed. That
gives the app container an outbound route — a deliberate trade: outbound 587
to one relay is a small surface, and it removes a moving part from the mail
path. Everything else stays the same.

:::{warning}
Two settings are accepted silently by the configuration and then rejected by
every hosted provider at the first real mail: **no `PIKDAME_SMTP_USER`/PASS**
(sending without `AUTH`) and **no `PIKDAME_MAIL_FROM`** (sending as
`noreply@localhost`). The server warns about both at startup —
`[mail] WARNUNG: …` — so check the log after the first start.
:::

## Without a mail server: the log fallback

If `PIKDAME_SMTP_HOST` is unset, registration still succeeds and the complete
mail — including the confirmation link — is written to the server log:

```
[mail] SMTP nicht konfiguriert - Mail an spieler@example.com wird nur geloggt:
[mail] Betreff: Pik Dame: E-Mail-Adresse bestätigen
[mail] willkommen bei Pik Dame! Bitte bestätige deine E-Mail-Adresse über diesen Link:
[mail] https://play.pikdame.online/verify?token=...
```

This is deliberate: you can test and use the whole account flow before any
mail server exists. Copy the link out of the log and open it.

A **failed** send logs the same body after the error, so a broken relay never
loses an account:

```
[mail] Versand an spieler@example.com fehlgeschlagen: SMTP 535: authentication failed
[mail] Inhalt der nicht zugestellten Mail (Betreff: Pik Dame: E-Mail-Adresse bestätigen):
[mail] …
```

:::{note}
The link is valid for **48 hours**. Anyone who can read the server log can
confirm the address, so treat the log as sensitive while the fallback is
active.
:::

## Verifying the setup

The startup banner names the active driver, so you can check without
registering anything:

```
Benutzerkonten: aktiv (Backend: sqlite, Mail-Treiber: SMTP)
```

`Log-Fallback` there means the process never saw `PIKDAME_SMTP_HOST` — the
value did not reach the container. The same fact is served over HTTP:

```
$ curl -s https://play.example.org/statusz | grep mailDriver
  "mailDriver": "smtp",
```

Then register a test account and watch the log:

- no `[mail]` line at all — the mail was sent, SMTP worked.
- `[mail] SMTP nicht konfiguriert …` — `PIKDAME_SMTP_HOST` is not set.
- `[mail] Versand an … fehlgeschlagen: …` — SMTP is configured but the send
  failed; see the table below.

The app tells the registering user which of the three happened, so a support
message ("account created, but the confirmation e-mail could not be sent")
already narrows it down to the last case. Finally, open the confirmation link
and check that the account becomes verified.

## Troubleshooting

| Log line | Cause | Fix |
| --- | --- | --- |
| *nothing at all, driver says `Log-Fallback`* | The container never received `PIKDAME_SMTP_HOST` | List the variable under `environment:` (see [above](#passing-the-settings-into-the-container)) and recreate the container with `docker compose up -d`. |
| `SMTP 535 …` | Authentication rejected | Check user/password; many providers need an **app password**, not the account password. |
| `SMTP 550 …` / `553 …` | Sender not allowed | `PIKDAME_MAIL_FROM` must be a mailbox the account is permitted to send as. |
| `SMTP-Timeout` | Port unreachable | Outbound 587/465 blocked — very common on hosted networks. Try the provider's alternative port or a relay. |
| `certificate` / `altname` errors | Certificate does not match the host | Set `PIKDAME_SMTP_TLS_SERVERNAME` to the name on the certificate. |
| Mail arrives, link is wrong | `PIKDAME_BASE_URL` unset behind a proxy | Set it to the public URL. |

A failed send never breaks registration: the account is created either way,
and both the error **and the mail body** are logged. Users who never receive
the mail can simply register again, or you hand them the link from the log.

# Configuration

There is no config file — everything is an environment variable. The table below
is **generated from the source code** (`scripts/gen-docs.js`), so it cannot drift
out of date.

```{include} ../_generated/configuration.md
:start-line: 3
```

## Secrets

Any secret may be supplied as a file instead, by appending `_FILE` to the
variable name — this is how Docker secrets and Kubernetes secret mounts work:

```bash
PIKDAME_DATABASE_PASSWORD_FILE=/run/secrets/db_password
```

The file's contents are read once at startup and trimmed.

## Accounts and statistics need PostgreSQL

Accounts are **optional** (`PIKDAME_ACCOUNTS=0` disables them entirely — guests
can still play, they just get no profile).

- **`PIKDAME_DATABASE_URL` set** → PostgreSQL holds the accounts and all
  statistics. Back it up with `pg_dump` (see {doc}`backup-restore`).
- **No `PIKDAME_DATABASE_URL`** → the game runs play-only: no accounts, and
  statistics are not saved.

On the first start with a database, existing JSON files in the data directory
(`players.json`, `games.json`, `stats.json`, `challenges.json`,
`stammtisch.json`) are imported automatically and renamed to
`*.json.imported`. The log shows one line per file. If a table already has
data, that file is skipped (log: `already has data - not imported, file left as
is`) and stays in place. If a file cannot be imported exactly, the server
refuses to start and names the file.

Old SQLite account files (`users.db`) are not migrated. Step-by-step upgrade:
{doc}`upgrade-3.0`.

## Sign-up, passkeys and sign-in links

**Sign-up is e-mail first**, like at most services: players enter a name and an
e-mail address, nothing else. The mail carries a **6-digit code** (typed into
the open dialog; 15 minutes, 5 attempts) and a **link** (48 hours). Either one
confirms the address and signs the player in; only then do they choose how to
sign in from now on: a **passkey** (Face ID / Touch ID, Android, Windows Hello,
Bitwarden, 1Password …) or a **password**. No sign-in method ever exists for an
unconfirmed address. With the code, the passkey is created on the device that
signed up, even when the mail is read on another one.

An account can have passkeys, a password, or both; the last one cannot be
removed. Anyone who closed the dialog before choosing signs in with the e-mail
sign-in link below and gets the same choice. Unconfirmed sign-ups are deleted
after 48 hours.

Passkeys switch on by themselves when all of this is true, and stay hidden
otherwise:

- accounts are enabled,
- `PIKDAME_BASE_URL` is an **https** URL (or `http://localhost…` for
  development) — the official image and compose files set it,
- the server package `@simplewebauthn/server` is installed (it is in the image;
  a bare `node server.js` from a checkout without `npm install` has none).

:::{warning}
A passkey is bound to the **domain** of `PIKDAME_BASE_URL`
(e.g. `play.pikdame.online`). If you move the game to another domain, every
stored passkey stops working. Players then sign in with the e-mail link below
and add a new passkey; with a password set, nothing changes for them.
:::

**E-mail sign-in link** ("Anmelde-Link per E-Mail" in the sign-in dialog): the
way back in after losing a passkey or forgetting the password. Valid for
15 minutes, single use, only for confirmed accounts. The answer on screen is the
same whether or not an account exists, so the form reveals no names or
addresses; each address gets at most 3 links per 15 minutes. After signing in
by link, the account dialog offers to add a passkey or set a password. The admin
page's **Benutzer** tab can send the same link.

Password managers file a passkey under the account's **e-mail address**; the
player name is its display name in the passkey picker. After each passkey sign-in
the page reports the current names to the browser (WebAuthn Signal API, Safari
26 / Chrome 132+), so passkeys created under an older name catch up. Which
folder the entry lands in is up to the password manager (none of them asks when
saving a passkey); moving it later does not affect the passkey.

Stored: the passkey's **public** key and its signature counter (nothing secret),
and for open sign-in links and sign-up codes only a SHA-256.

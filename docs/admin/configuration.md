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

## Accounts: SQLite or PostgreSQL?

Accounts are **optional** (`PIKDAME_ACCOUNTS=0` disables them entirely — guests
can still play, they just get no profile).

- **No `PIKDAME_DATABASE_URL`** → accounts go into a SQLite file, `users.db`,
  inside the data directory. Perfect for a family server. Back up the file.
- **`PIKDAME_DATABASE_URL` set** → PostgreSQL. Use this for a public server; back
  it up with `pg_dump` (see {doc}`backup-restore`).

Switching from SQLite to PostgreSQL does **not** migrate existing accounts.

## Passkeys and sign-in links

Players can sign up and sign in with a **passkey** (Face ID / Touch ID, Android,
Windows Hello, Bitwarden, 1Password …) instead of a password. Passwords keep
working; an account can have passkeys, a password, or both — never zero: the
last way to sign in cannot be removed.

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

Stored: the passkey's **public** key and its signature counter (nothing secret),
and for open sign-in links only a SHA-256 of the token.

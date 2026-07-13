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

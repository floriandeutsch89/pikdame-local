# Shared login for the game and the tracker — design

Status: draft for review · 2026-10-09 · sub-project 2 of 2. It builds on
[game stats in the database](2026-10-09-game-stats-in-db-design.md), which
ships first.

## Goal

One account for `play.pikdame.online` (this repo) and
`tracker.pikdame.online` (repo `pikdame`, FastAPI + React). You sign up and
log in once, the profile (username, avatar) is shared, and each app keeps its
own data. Everyone keeps their stats.

## Decisions (agreed in brainstorming)

| Topic | Decision |
|---|---|
| Users | A handful; overlaps may be fixed by hand |
| Scope | SSO + shared profile (username, avatar). Apps keep their own data |
| Registration | Open, e-mail confirmation (the game's flow). Tracker invite codes are removed |
| Login methods | The game's current set: e-mail code sign-up, passkeys, e-mail login link, optional password |
| Data layout | A shared identity ("meta") database; each app keeps its own database |
| Writer | One Node service, `pikdame-auth`, built from the game's auth code, is the only writer of the identity DB |
| Code home | This repo, `auth/` package, own image `pikdame-auth`; the game uses the same package in-process in standalone mode |
| URL | `/auth/*` on every host (apex, `play.`, `tracker.`) is routed to `pikdame-auth`; passkey RP ID `pikdame.online` |
| Sign-up | Available in both apps through one shared dialog |
| Identity DB location | A second database `identity` in the game stack's Postgres container |
| Session | 1 year, sliding; server-side and revocable |
| Avatar | Pick from built-in presets, no uploads |
| Admin | The admin flag stays per app |
| Merge | Same e-mail → one account: the game's username, password and passkeys win. Tracker-only users get a username derived from their e-mail, reviewed in a dry run |

## Architecture

```
            pikdame.online   play.pikdame.online   tracker.pikdame.online
                 │                 │                      │
 Caddy:  /auth/* ──────────────────┼──────────────────────┼──► pikdame-auth (Node)
                 │ else            │ else                 │ else      │ read/write
           landing (static)   game (Node) ───┐      tracker (FastAPI) │
                                   │ r/w     │ read-only   │ r/w   ┌──▼───────────┐
                              db "pikdame"   └────────────►│───────►│ db "identity"│
                                   (game stack Postgres)   │       └──────────────┘
                                                      tracker Postgres
```

### `pikdame-auth` service (`auth/` in this repo)

- **Code:** extracted from `server.js` (account routes), `PgAccountStore.js`
  (identity part), `Passkeys.js` and `Mailer.js`. The package exports
  `createAuthService({ pool, rp, mailer, cookie })`, which returns an HTTP
  handler for `/auth/api/*` and `/auth/ui/*`.
- **Image:** `ghcr.io/…/pikdame-auth` is built from the same repo with its own
  entry point `auth/server.js` and its own version (the same SemVer and
  CHANGELOG rules, with an `auth:` scope).
- **API** (JSON, POST unless noted):

  | Area | Endpoints |
  |---|---|
  | Sign-up | `signup` (name + e-mail → code mail), `signup/verify` (code or link → signed in) |
  | Login | `login` (name/e-mail + password), `login-link` (request), `login-link/consume` (GET) |
  | Passkeys | `passkey/register/options`, `passkey/register/verify`, `passkey/login/options`, `passkey/login/verify`, `passkey/delete` |
  | Password | `password/set`, `password/remove` (the last sign-in method can never be removed, as today) |
  | Profile | `me` (GET), `profile` (avatar) |
  | Session | `logout`, `logout-all`, `session/touch` |
  | Admin | `admin/users` (GET), `admin/users/delete`: internal only, `AUTH_SERVICE_TOKEN`, blocked at Caddy (see Game → Admin page) |

- **Security:**
  - Every POST checks `Origin` against `AUTH_ALLOWED_ORIGINS`
    (`https://pikdame.online`, `https://play.pikdame.online`,
    `https://tracker.pikdame.online`).
  - Rate limits are taken over from the game: 20 per 10 min per IP for
    credential endpoints.
  - Codes, links and session tokens are stored only as SHA-256.
- **UI:** `/auth/ui/pikdame-auth.js` is a vanilla ES module with no build
  step, plus `/auth/ui/pikdame-auth.css` and the vendored
  `vendor-simplewebauthn.js`. It exposes
  `PikdameAuth.open('signup' | 'login' | 'account')` and fires
  `pikdame-auth:changed` on `window` after sign-in, sign-out or a profile
  change.
  - It is the game's current account dialog, lifted out. Texts stay German
    with English via its own small `L(de, en)` table, so the tracker gets
    both languages too.
  - On load it calls `session/touch` at most once a day per browser, which
    is what makes the sliding expiry work.
- **Config:**
  - `AUTH_DATABASE_URL` (owner of `identity`)
  - `AUTH_RP_ID=pikdame.online`, `AUTH_RP_NAME=Pik Dame`
  - `AUTH_ALLOWED_ORIGINS`, `AUTH_COOKIE_DOMAIN=.pikdame.online`
  - `AUTH_PUBLIC_URL=https://pikdame.online/auth` (links in mails)
  - SMTP (`PIKDAME_SMTP_*`, `PIKDAME_MAIL_FROM`) moves here from the game

### Identity database (`identity`, in the game stack's Postgres)

```sql
CREATE TABLE users (
  id               BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  username         TEXT NOT NULL,          -- unique (LOWER), 2–24 chars as today
  email            TEXT NOT NULL,          -- unique (LOWER)
  avatar           TEXT,                   -- preset id, NULL = default
  password_hash    BYTEA, salt TEXT NOT NULL DEFAULT '',  -- '' = passwordless
  hash_scheme      TEXT NOT NULL DEFAULT 'scrypt',        -- or 'pbkdf2_sha256'
  legacy_hash      TEXT,                   -- passlib string for pbkdf2_sha256
  verified         BOOLEAN NOT NULL DEFAULT FALSE,
  webauthn_user_id TEXT,
  login_token_hash TEXT, login_expires TIMESTAMPTZ,
  verify_code_hash TEXT, verify_code_expires TIMESTAMPTZ,
  verify_code_tries INT NOT NULL DEFAULT 0,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE webauthn_credentials (… as today, user_id → users ON DELETE CASCADE);
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,             -- SHA-256 of the cookie value
  user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL          -- now() + 1 year, pushed out by session/touch
);
CREATE TABLE deleted_users (                -- tombstones for app cleanup
  user_id BIGINT PRIMARY KEY, deleted_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

**Roles:**
- `pikdame_auth` owns the database.
- `identity_reader` (used by the game and the tracker) gets `SELECT` on
  `sessions`, `deleted_users`, and the view
  `public_users(id, username, email, avatar, verified)`. It never sees hashes
  or tokens.

### Sessions and cookies

- **Cookie:** `pikdame_sid` holds 32 random bytes (base64url), with
  `Domain=.pikdame.online; Path=/; HttpOnly; Secure; SameSite=Lax`, and
  `Max-Age` follows `expires_at`.
- **Lookup:** every app resolves the user with the same query, and caches the
  result for 60 s per token:

  ```sql
  SELECT u.id, u.username, u.avatar FROM sessions s
  JOIN public_users u ON u.id = s.user_id
  WHERE s.token_hash = $1 AND s.expires_at > now() AND u.verified
  ```
- **Logout:** removes the row. "Log out everywhere" removes all rows of that
  user. Revocation takes effect within the 60 s cache.
- **Game:**
  - In shared mode it reads the cookie on HTTP requests and on the WebSocket
    upgrade.
  - The `accountToken` in `localStorage` and in WS messages is retired. The
    client drops it once and asks `/auth/api/me`.

### Game (this repo)

- **Two modes:**
  - **Shared:** `IDENTITY_DATABASE_URL` is set (read-only role). Account UI
    comes from the shared dialog, and `/auth/*` is served by `pikdame-auth`
    through Caddy.
  - **Standalone:** not set. `server.js` mounts the `auth/` handler
    in-process on `/auth/*`, against a schema `identity` in its own database,
    with RP ID = the hostname of `PIKDAME_BASE_URL`. The same code and the
    same dialog are used either way.
- **Progression:** `xp`, `games`, `wins`, `season`, `season_xp` and
  `profile_imported` move from `users` into `player_profiles` (from
  sub-project 1). The row is keyed by `user_id`, and `name_key` is the
  username. The ladder query reads `player_profiles`.
- **Name reservation:** `isRegisteredName` asks `public_users`. The rest of
  `joinSession` stays as it is.
- **Admin page:** it stays protected by `PIKDAME_ADMIN_TOKEN`, as today. Its
  user list and deletion call `pikdame-auth` `admin/*` server-to-server over
  the `pikdame-identity` network, with a shared secret `AUTH_SERVICE_TOKEN`
  (a compose secret). Those endpoints are not routed through Caddy. Game-only
  admin features stay in the game.

### Tracker (repo `pikdame`)

- **Backend:**
  - A new `app/identity.py` holds a read-only engine on
    `IDENTITY_DATABASE_URL` and the session query above.
  - `current_user` reads `pikdame_sid`, resolves the identity user, and
    upserts the local `users` row (id = identity id; `is_admin`, groups).
- **Removed:** the JWT (`python-jose`), `passlib`, invite codes, register,
  login, password change and reset, e-mail verification, `emailer.py` and its
  templates, `PIKDAME_JWT_SECRET`, `PIKDAME_INVITE_CODES`,
  `PIKDAME_AUTO_ADMIN_ON_REGISTER`, and the `must_change_password` and
  `email_*` columns.
- **Local `users` table:**
  `id BIGINT PRIMARY KEY (= identity id), is_admin, created_at`. All FKs
  (`games`, `teams`, `user_group_memberships`, `analytics.*`, `issues`,
  `issue_attachments`) become `BIGINT … ON UPDATE CASCADE`, done in the
  tracker's startup migrations.
- **Frontend:** `AuthModal` is replaced by
  `<script type="module" src="/auth/ui/pikdame-auth.js">` and
  `PikdameAuth.open(...)`. `AuthContext` re-fetches `/api/auth/me` on
  `pikdame-auth:changed`. The username and avatar are shown in the header.
- **Deleted users:** on startup and daily, the tracker deletes local `users`
  rows whose id is in `deleted_users`. The existing `ON DELETE CASCADE` and
  `SET NULL` FKs then clean up as today. The game does the same for
  `player_profiles.user_id`, setting it to NULL.

## Migration (one-time, `auth/migrate/merge.js`)

**Inputs:** the game DB, the tracker DB, and the identity DB (empty). Run with
`--dry-run` first, then `--apply`.

1. **Game accounts:** copy them into `identity.users` with the **same ids**
   (`OVERRIDING SYSTEM VALUE`), plus their credentials. Game sessions are
   dropped, so everyone logs in once.
2. **Tracker accounts, matched by `LOWER(email)`:**
   - **Match found:** the account merges into that identity id. The game's
     username, password and passkeys win, and the tracker password is
     discarded.
   - **No match:** a new identity user is created with the tracker
     `password_hash` (`hash_scheme='pbkdf2_sha256'`, verified with Node
     `crypto.pbkdf2` and re-hashed to scrypt on the next password login). The
     username comes from the e-mail local part, cleaned to the allowed
     characters, with a numeric suffix on a clash.
   - Tracker `email_verified = false` accounts are carried over as
     unverified. They can finish with the e-mail link.
3. **Tracker remap:** in one transaction on the tracker DB,
   `UPDATE users SET id = <identity id>`. `ON UPDATE CASCADE` moves every
   reference. Ids are moved in two steps (first negative, then final) so they
   can't collide.
4. **Game progression:** move the `users` progression columns into
   `player_profiles` by `user_id`. Values are max-merged if a linked profile
   row already exists, the same rule as `importProfile`.
5. **Identity sequence:** set it past the highest id.
6. **Verification:**
   - user counts: identity = game + tracker-only
   - per tracker table: row counts before and after are equal
   - per player: summed XP, games and wins are equal before and after
   - any mismatch rolls back that step
7. **Dry-run report:** a table of e-mail → source (game/tracker/both) →
   identity id → username (★ = generated). You review the ★ names before
   `--apply`, and can pass overrides as `--rename email=Name`.

**Passkeys:** stored credentials are tied to RP ID `play.pikdame.online` and
stop working under `pikdame.online`. They are copied anyway, for history.
Affected players sign in with the e-mail link (or password) and add a new
passkey; the dialog suggests that after a link login. Players are told in
advance through the game's news/changelog.

## Deployment

| Where | Change |
|---|---|
| Game stack Postgres | Second database `identity`, roles `pikdame_auth` and `identity_reader` (init SQL in `docker/`) |
| Game compose (all three files, kept in sync) | New service `pikdame-auth`, hardened like the game (cap_drop ALL, read_only, AppArmor, pids_limit); SMTP egress moves to it |
| Docker network | New external network `pikdame-identity`, joined by Postgres (game stack), `pikdame-auth`, the game and the tracker backend. The tracker is assumed to run on the same Docker host |
| Caddy (caddy-crowdsec repo, done by you) | `handle /auth/*` → `pikdame-auth:…` in the apex, `play.` and `tracker.` site blocks, placed before the existing handlers. A snippet is provided in `docs/admin/shared-login.md` |
| Tracker compose | `IDENTITY_DATABASE_URL` (read-only role); remove the JWT, invite and SMTP variables |

### Rollout order

1. **Game release A:** extract the `auth/` package and run it in standalone
   mode in-process. Behaviour is unchanged, and the dialog moves to
   `/auth/ui`.
2. **Tracker release A:** bigint ids with `ON UPDATE CASCADE`, still with its
   own login, and sign-up frozen (no invite codes configured).
3. **On beta:** create `identity`, start `pikdame-auth`, run `merge.js
   --dry-run`, review, run `--apply`, then switch the game and tracker to
   shared mode (release B of each) and add the Caddy routes.
4. Repeat step 3 in production, with `pg_dump` of all three databases first.

**Rollback:** previous images plus the restored dumps. Because the game keeps
the same ids, a game-only rollback is simple.

## Testing

- **`auth/` package:**
  - the existing account and passkey tests move along (virtual CDP
    authenticator, Postgres via `PIKDAME_TEST_PG_URL`)
  - new: Origin allowlist, cookie attributes, sliding `session/touch`,
    `logout-all`, pbkdf2 legacy verification and re-hash, the read-only role
    can't read hashes
- **`merge.js`:** fixture DBs covering game-only, tracker-only,
  both-same-e-mail, a username clash, and an unverified tracker user. Then:
  dry-run output, apply, verification totals, and idempotency (a second run
  refuses because identity is not empty).
- **Game:** shared mode end to end. The cookie on the WS upgrade grants the
  reserved name, and an expired session falls back to guest.
- **Tracker (pytest):** `current_user` with a valid, expired or revoked
  session; upsert of the local user; the deleted-users sweep; no endpoint
  still reads the JWT.
- **Browser:** sign up on the tracker, then open `play.`: you're logged in.
  Register a passkey on `play.` and log in with it on `tracker.`. Check all
  three game layouts (CLAUDE.md 2b) and the tracker on mobile.

## Not in scope

- Renaming usernames (stats are keyed by name in places).
- Third-party login (Apple/Google; the tracker's `/apple` 501 stub is
  removed).
- Avatar uploads.
- Cross-app features (tracker showing game results).

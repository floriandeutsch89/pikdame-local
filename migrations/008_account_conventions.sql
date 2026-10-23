-- The account tables of 001 onto the schema conventions (docs/developer/schema.md):
-- TIMESTAMPTZ instants named after their event, no bare names, updated_at on
-- mutable rows, index names, indexes for the token lookups, and users.player_id.
-- PgAccountStore converts at its boundary; the game logic keeps milliseconds.

-- users: one account; a confirmed one owns its name, i.e. its player.
ALTER TABLE users RENAME COLUMN salt TO password_salt;
ALTER TABLE users RENAME COLUMN verified TO email_verified;
ALTER TABLE users RENAME COLUMN games TO games_played;
ALTER TABLE users RENAME COLUMN wins TO games_won;
ALTER TABLE users RENAME COLUMN verify_expires TO verify_expires_at;
ALTER TABLE users RENAME COLUMN login_expires TO login_expires_at;
ALTER TABLE users RENAME COLUMN verify_code_expires TO verify_code_expires_at;
ALTER TABLE users RENAME COLUMN review_mail_at TO review_mail_changed_at;
ALTER TABLE users
  ALTER COLUMN created_at TYPE TIMESTAMPTZ USING to_timestamp(created_at / 1000.0),
  ALTER COLUMN created_at SET DEFAULT now(),
  ALTER COLUMN verify_expires_at TYPE TIMESTAMPTZ USING to_timestamp(verify_expires_at / 1000.0),
  ALTER COLUMN login_expires_at TYPE TIMESTAMPTZ USING to_timestamp(login_expires_at / 1000.0),
  ALTER COLUMN verify_code_expires_at TYPE TIMESTAMPTZ USING to_timestamp(verify_code_expires_at / 1000.0),
  ALTER COLUMN review_mail_changed_at TYPE TIMESTAMPTZ USING to_timestamp(review_mail_changed_at / 1000.0),
  ADD COLUMN updated_at TIMESTAMPTZ,
  -- Set when the e-mail is confirmed. PgAccountStore links the confirmed accounts of
  -- before 008 on its first start: the player key is JS toLowerCase(), SQL lower() is locale-bound.
  ADD COLUMN player_id BIGINT,
  ADD CONSTRAINT users_player_id_key UNIQUE (player_id),
  -- A player with an account is deleted only after the account (admin page).
  ADD CONSTRAINT users_player_id_fkey FOREIGN KEY (player_id) REFERENCES players (id) ON DELETE RESTRICT;
UPDATE users SET updated_at = created_at;
ALTER TABLE users ALTER COLUMN updated_at SET NOT NULL, ALTER COLUMN updated_at SET DEFAULT now();
ALTER INDEX users_username_lower RENAME TO users_lower_username_key;
ALTER INDEX users_email_lower RENAME TO users_lower_email_key;
ALTER INDEX users_season_xp RENAME TO users_season_season_xp_idx;
-- Links from mails (confirm, sign in, unsubscribe) were sequential scans; only set tokens are indexed.
CREATE INDEX users_verify_token_idx ON users (verify_token) WHERE verify_token IS NOT NULL;
CREATE INDEX users_login_token_hash_idx ON users (login_token_hash) WHERE login_token_hash IS NOT NULL;
CREATE INDEX users_review_unsub_hash_idx ON users (review_unsub_hash) WHERE review_unsub_hash IS NOT NULL;
-- Every sign-up purges the expired unconfirmed ones.
CREATE INDEX users_verify_expires_at_idx ON users (verify_expires_at) WHERE NOT email_verified;

-- sessions -> login_sessions: an account's sign-ins (a game table is a session too).
ALTER TABLE sessions RENAME TO login_sessions;
ALTER TABLE login_sessions RENAME COLUMN token TO session_token;
ALTER TABLE login_sessions RENAME CONSTRAINT sessions_pkey TO login_sessions_pkey;
ALTER TABLE login_sessions RENAME CONSTRAINT sessions_user_id_fkey TO login_sessions_user_id_fkey;
ALTER TABLE login_sessions ALTER COLUMN created_at TYPE TIMESTAMPTZ USING to_timestamp(created_at / 1000.0),
  ALTER COLUMN created_at SET DEFAULT now();
-- Every sign-in prunes the sessions older than 90 days; deleting an account cascades by user_id.
CREATE INDEX login_sessions_created_at_idx ON login_sessions (created_at);
CREATE INDEX login_sessions_user_id_idx ON login_sessions (user_id);

-- webauthn_credentials: no bare id/name; the WebAuthn signature counter by its name.
ALTER TABLE webauthn_credentials RENAME COLUMN id TO credential_id;
ALTER TABLE webauthn_credentials RENAME COLUMN name TO credential_name;
ALTER TABLE webauthn_credentials RENAME COLUMN counter TO sign_count;
ALTER TABLE webauthn_credentials
  ALTER COLUMN created_at TYPE TIMESTAMPTZ USING to_timestamp(created_at / 1000.0),
  ALTER COLUMN created_at SET DEFAULT now(),
  ALTER COLUMN last_used_at TYPE TIMESTAMPTZ USING to_timestamp(last_used_at / 1000.0),
  ADD COLUMN updated_at TIMESTAMPTZ;
UPDATE webauthn_credentials SET updated_at = COALESCE(last_used_at, created_at);
ALTER TABLE webauthn_credentials ALTER COLUMN updated_at SET NOT NULL, ALTER COLUMN updated_at SET DEFAULT now();
ALTER INDEX webauthn_credentials_user RENAME TO webauthn_credentials_user_id_idx;

-- Season finale.
ALTER TABLE season_finals ALTER COLUMN finalized_at TYPE TIMESTAMPTZ USING to_timestamp(finalized_at / 1000.0);
ALTER TABLE season_results ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT now(); -- 'seen' changes
ALTER TABLE season_meta RENAME COLUMN key TO meta_key;
ALTER TABLE season_meta RENAME COLUMN value TO meta_value;

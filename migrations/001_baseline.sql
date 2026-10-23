-- Baseline: the account schema as it stood when migrations were introduced.
-- Idempotent on purpose: databases from before the runner already have it
-- (plus the old schema_version table) and apply this once without harm.
CREATE TABLE IF NOT EXISTS users (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  username TEXT NOT NULL,
  email TEXT NOT NULL,
  password_hash BYTEA NOT NULL,
  salt TEXT NOT NULL,
  verified BOOLEAN NOT NULL DEFAULT FALSE,
  verify_token TEXT,
  verify_expires BIGINT,
  created_at BIGINT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS users_username_lower ON users (LOWER(username));
CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower ON users (LOWER(email));
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at BIGINT NOT NULL
);
-- Progression (XP, level, season ladder). Additive and idempotent so an
-- existing database from an older version migrates on the next start.
ALTER TABLE users ADD COLUMN IF NOT EXISTS xp BIGINT NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS games INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS wins INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS season TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS season_xp BIGINT NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS season_games INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS users_season_xp ON users (season, season_xp DESC);
-- Season finale: rollovers keep the finished season, finals/results once per season.
CREATE TABLE IF NOT EXISTS season_archive (
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  season TEXT NOT NULL,
  season_xp BIGINT NOT NULL,
  season_games INTEGER NOT NULL,
  PRIMARY KEY (user_id, season)
);
CREATE TABLE IF NOT EXISTS season_finals (
  season TEXT PRIMARY KEY,
  finalized_at BIGINT NOT NULL,
  ranked INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS season_results (
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  season TEXT NOT NULL,
  place INTEGER NOT NULL,
  season_xp BIGINT NOT NULL,
  season_games INTEGER NOT NULL,
  award TEXT,
  seen BOOLEAN NOT NULL DEFAULT FALSE,
  PRIMARY KEY (user_id, season)
);
CREATE TABLE IF NOT EXISTS season_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
-- Set once the guest profile's progress was carried over (importProfile).
ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_imported BOOLEAN NOT NULL DEFAULT FALSE;
-- Passkeys: per-account WebAuthn user handle, e-mail login link (only a
-- SHA-256 of the token is stored), and the credentials themselves.
ALTER TABLE users ADD COLUMN IF NOT EXISTS webauthn_user_id TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS login_token_hash TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS login_expires BIGINT;
-- Sign-up code (password-less registration): hash, expiry, attempts.
ALTER TABLE users ADD COLUMN IF NOT EXISTS verify_code_hash TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS verify_code_expires BIGINT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS verify_code_tries INTEGER NOT NULL DEFAULT 0;
-- Year-review mail: opt-in (default off), when it changed, language, the
-- last year sent, and a SHA-256 of the unsubscribe token in that mail.
ALTER TABLE users ADD COLUMN IF NOT EXISTS review_mail BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS review_mail_at BIGINT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS review_mail_lang TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS review_mail_year TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS review_unsub_hash TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS review_mail_consent TEXT;
CREATE TABLE IF NOT EXISTS webauthn_credentials (
  id TEXT PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  public_key BYTEA NOT NULL,
  counter BIGINT NOT NULL DEFAULT 0,
  transports TEXT,
  device_type TEXT,
  backed_up BOOLEAN NOT NULL DEFAULT FALSE,
  name TEXT,
  created_at BIGINT NOT NULL,
  last_used_at BIGINT
);
CREATE INDEX IF NOT EXISTS webauthn_credentials_user ON webauthn_credentials (user_id);

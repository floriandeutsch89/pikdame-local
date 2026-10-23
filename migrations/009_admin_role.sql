-- Admin access as an account role (docs/admin/admin-page.md): who holds it and from
-- which source, the admin sign-ins after a step-up, and the audit log. Choices:
-- docs/developer/schema.md, section "Admin access".

-- One row per grant and source: PIKDAME_ADMINS ('env', synced on every start) or the
-- CLI ('cli', kept until the CLI revokes it). An account is admin while a row exists.
CREATE TABLE user_roles (
  user_id BIGINT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role_name TEXT NOT NULL,
  grant_source TEXT NOT NULL,
  granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT user_roles_pkey PRIMARY KEY (user_id, role_name, grant_source),
  CONSTRAINT user_roles_role_name_check CHECK (role_name IN ('admin')),
  CONSTRAINT user_roles_grant_source_check CHECK (grant_source IN ('env', 'cli'))
);

-- An admin sign-in after a step-up; only a SHA-256 of the cookie value is stored.
-- login_session_hash ties it to the game sign-in it came from (signing out there ends
-- it). last_seen_at is the only column that changes, so it doubles as updated_at.
CREATE TABLE admin_sessions (
  session_token_hash TEXT NOT NULL,
  user_id BIGINT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  login_session_hash TEXT NOT NULL,
  step_up_method TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT admin_sessions_pkey PRIMARY KEY (session_token_hash),
  CONSTRAINT admin_sessions_step_up_method_check CHECK (step_up_method IN ('passkey', 'password'))
);

-- What happened in the admin area, kept 365 days. The account name is copied: the
-- row outlives the account. client_network is the address cut to /24 or /48.
CREATE TABLE admin_audit_events (
  id BIGINT GENERATED ALWAYS AS IDENTITY,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  user_id BIGINT REFERENCES users (id) ON DELETE SET NULL,
  user_name TEXT,
  action TEXT NOT NULL,
  action_target TEXT,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  client_network CIDR,
  CONSTRAINT admin_audit_events_pkey PRIMARY KEY (id)
);
-- The "Protokoll" page (newest first) and the retention delete.
CREATE INDEX admin_audit_events_occurred_at_idx ON admin_audit_events (occurred_at);

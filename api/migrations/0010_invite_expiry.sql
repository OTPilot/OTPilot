-- Team invites expire after 48 hours.
ALTER TABLE pending_invites ADD COLUMN expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '48 hours';

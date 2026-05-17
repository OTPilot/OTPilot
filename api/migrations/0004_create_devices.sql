CREATE TABLE devices (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id      TEXT        NOT NULL,
  name           TEXT        NOT NULL,
  os             TEXT        NOT NULL,
  browser        TEXT        NOT NULL,
  first_seen_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  pending_action TEXT,
  pending_nonce  TEXT,
  UNIQUE(user_id, device_id)
);

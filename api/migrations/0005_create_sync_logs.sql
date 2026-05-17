CREATE TABLE sync_logs (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id      TEXT        NOT NULL,
  action         TEXT        NOT NULL,
  accounts_count INT         NOT NULL DEFAULT 0,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX sync_logs_user_device_idx ON sync_logs(user_id, device_id, created_at DESC);

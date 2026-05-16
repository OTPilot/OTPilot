CREATE TABLE accounts (
  user_id        UUID        PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  encrypted_blob TEXT        NOT NULL,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

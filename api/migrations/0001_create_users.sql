CREATE TABLE users (
  id               UUID        PRIMARY KEY,
  plan             TEXT        NOT NULL DEFAULT 'free',
  stripe_customer_id TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

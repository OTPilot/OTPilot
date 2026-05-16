CREATE TABLE teams (
  id                     UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name                   TEXT        NOT NULL,
  owner_id               UUID        NOT NULL REFERENCES users(id),
  stripe_subscription_id TEXT,
  seat_limit             INTEGER     NOT NULL DEFAULT 5,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE team_members (
  team_id   UUID        NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id   UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role      TEXT        NOT NULL DEFAULT 'member',
  joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (team_id, user_id)
);

CREATE TABLE pending_invites (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  email      TEXT        NOT NULL,
  team_id    UUID        NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  invited_by UUID        NOT NULL REFERENCES users(id),
  token      TEXT        NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  accepted_at TIMESTAMPTZ
);

CREATE TABLE shared_codes (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id         UUID        NOT NULL REFERENCES users(id),
  team_id          UUID        REFERENCES teams(id) ON DELETE CASCADE,
  account_name     TEXT        NOT NULL,
  encrypted_secret TEXT        NOT NULL,
  sharing_key_iv   TEXT        NOT NULL,
  active           BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE share_access (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  shared_code_id  UUID        NOT NULL REFERENCES shared_codes(id) ON DELETE CASCADE,
  user_id         UUID        NOT NULL REFERENCES users(id),
  granted_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at      TIMESTAMPTZ
);

CREATE TABLE audit_logs (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id    UUID        NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  actor_id   UUID        REFERENCES users(id),
  action     TEXT        NOT NULL,
  target_id  UUID,
  metadata   JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

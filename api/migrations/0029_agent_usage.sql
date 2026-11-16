-- Free plan: AI agents get 10 uses a month (a browser_login or a run), counted
-- where the server hands out a copy (POST /agent/grants/open). One row per
-- user per UTC month (month = date_trunc('month', NOW() AT TIME ZONE 'UTC')),
-- so a new month starts from 0 (no rollover). Paid plans and the trial are
-- never counted.
CREATE TABLE agent_usage (
  user_id UUID    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  month   DATE    NOT NULL,
  uses    INTEGER NOT NULL DEFAULT 0 CHECK (uses >= 0),
  PRIMARY KEY (user_id, month)
);

-- One per MCP tool call (its use_id): a retry of the same call, for the same
-- accounts, opens them again without counting twice. Kept a day.
CREATE TABLE agent_use_tokens (
  id         UUID        PRIMARY KEY,
  agent_id   UUID        NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  user_id    UUID        NOT NULL,
  tool       TEXT        NOT NULL,
  item_ids   UUID[]      NOT NULL, -- sorted
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX agent_use_tokens_created ON agent_use_tokens (created_at);

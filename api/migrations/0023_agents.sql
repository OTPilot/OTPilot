-- 2.1 OTPilot for AI agents (docs/agents/plan.md).
--
-- An agent is an OTPilot MCP server on the user's computer, with its own ECDH
-- P-256 keypair (the private key never leaves that computer). The user lets it
-- use some of their vault items: each grant is a copy of one item, projected to
-- what the agent may use and encrypted under a key wrapped to the agent's public
-- key — the server only stores ciphertext.

CREATE TABLE agents (
  id               UUID        PRIMARY KEY,
  -- NULL while the pairing hasn't been claimed by a signed-in user.
  user_id          UUID        REFERENCES users(id) ON DELETE CASCADE,
  name             TEXT        NOT NULL,
  machine          TEXT        NOT NULL DEFAULT '',
  public_key       TEXT        NOT NULL,
  -- pairing: registered by the MCP, waiting to be claimed (15 min);
  -- pending: claimed, waiting for the user's approval in the extension (15 min);
  -- active:  approved. Denied / revoked agents are deleted.
  status           TEXT        NOT NULL CHECK (status IN ('pairing', 'pending', 'active')),
  -- SHA-256 of the secret the MCP polls with until it gets its token.
  pair_secret_hash TEXT        NOT NULL,
  -- SHA-256 of the agent's bearer token; set once, when the MCP collects it.
  token_hash       TEXT        UNIQUE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  claimed_at       TIMESTAMPTZ,
  approved_at      TIMESTAMPTZ,
  last_used_at     TIMESTAMPTZ,
  CHECK ((status = 'pairing') = (user_id IS NULL))
);
CREATE INDEX agents_user ON agents (user_id) WHERE user_id IS NOT NULL;

CREATE TABLE agent_grants (
  agent_id       UUID        NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  -- The owner's vault item (no FK, like shares: deleting the item deletes its
  -- grants in the same transaction).
  item_id        UUID        NOT NULL,
  -- What the copy holds: { "kind": "2fa" | "login" | "fields", "fields"?: [...] }.
  scope          JSONB       NOT NULL,
  encrypted_item TEXT        NOT NULL,
  wrapped_key    TEXT        NOT NULL,
  expires_at     TIMESTAMPTZ,
  -- The copy is only handed out after a one-time approval (agent_requests).
  ask_every_time BOOLEAN     NOT NULL DEFAULT FALSE,
  -- Commands `run` may use this item with (empty: any).
  commands       TEXT[]      NOT NULL DEFAULT '{}',
  revision       BIGINT      NOT NULL DEFAULT nextval('vault_revision_seq'),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (agent_id, item_id)
);
CREATE INDEX agent_grants_item ON agent_grants (item_id);

-- An agent asking for an account it doesn't have (`item_id` NULL: free text in
-- `query`, matched against the vault by the extension), or for one use of an
-- "ask every time" grant (`item_id` set).
CREATE TABLE agent_requests (
  id             UUID        PRIMARY KEY,
  agent_id       UUID        NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  query          TEXT        NOT NULL DEFAULT '',
  reason         TEXT        NOT NULL DEFAULT '',
  tool           TEXT        NOT NULL DEFAULT '',
  item_id        UUID,
  status         TEXT        NOT NULL DEFAULT 'pending'
                             CHECK (status IN ('pending', 'allowed', 'denied')),
  -- A one-time use, once allowed: the copy is handed out until then.
  released_until TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  decided_at     TIMESTAMPTZ
);
CREATE INDEX agent_requests_agent ON agent_requests (agent_id, created_at);

-- What each agent did with which item (never a value). Trimmed to the last
-- 200 per agent on insert.
CREATE TABLE agent_uses (
  id         BIGSERIAL   PRIMARY KEY,
  agent_id   UUID        NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  item_id    UUID,
  action     TEXT        NOT NULL,
  detail     TEXT        NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX agent_uses_agent ON agent_uses (agent_id, id);

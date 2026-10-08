-- 2.0 sharing (docs/sharing.md): an item stays in its owner's vault; a
-- share is a copy of it (the whole item or some of its fields) encrypted
-- under its own share key (SK), which the server never sees. Grants say who
-- can open a share: one person (SK wrapped to their public key) or one
-- collection (SK encrypted under the collection key), with a role.
--
-- Shares live within a team: dissolving the team removes them, and leaving
-- it removes the person's shares and grants (teams::remove_member_atomic).
CREATE TABLE shares (
  id             UUID        PRIMARY KEY,
  team_id        UUID        NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  owner_id       UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- The owner's vault item it's a copy of (no FK: the copy's lifetime is
  -- managed with the item's — deleting the item deletes its shares).
  item_id        UUID        NOT NULL,
  -- A copy of the whole item (editable by `edit` grants) or of some fields
  -- (read-only).
  whole          BOOLEAN     NOT NULL,
  encrypted_item TEXT        NOT NULL,
  revision       BIGINT      NOT NULL DEFAULT nextval('vault_revision_seq'),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX shares_owner ON shares (owner_id);
CREATE INDEX shares_owner_item ON shares (owner_id, item_id);

CREATE TABLE share_grants (
  share_id      UUID        NOT NULL REFERENCES shares(id) ON DELETE CASCADE,
  user_id       UUID        REFERENCES users(id) ON DELETE CASCADE,
  collection_id UUID        REFERENCES collections(id) ON DELETE CASCADE,
  role          TEXT        NOT NULL CHECK (role IN ('view', 'edit')),
  -- SK wrapped to the user's public key, or encrypted under the collection key.
  wrapped_key   TEXT        NOT NULL,
  granted_by    UUID        REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK ((user_id IS NULL) <> (collection_id IS NULL))
);
CREATE UNIQUE INDEX share_grants_share_user ON share_grants (share_id, user_id) WHERE user_id IS NOT NULL;
CREATE UNIQUE INDEX share_grants_share_collection ON share_grants (share_id, collection_id) WHERE collection_id IS NOT NULL;
CREATE INDEX share_grants_user ON share_grants (user_id) WHERE user_id IS NOT NULL;
CREATE INDEX share_grants_collection ON share_grants (collection_id) WHERE collection_id IS NOT NULL;

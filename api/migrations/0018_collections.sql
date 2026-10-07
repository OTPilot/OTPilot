-- 2.0 team collections ("share everything", end-to-end encrypted).
-- A collection belongs to a team; its items are vault_items with a
-- collection_id, encrypted under the collection key (CK). The server never
-- sees CK: each member row carries CK wrapped to that member's ECDH public
-- key (users.public_key). The name is encrypted under CK too.
CREATE TABLE collections (
  id             UUID        PRIMARY KEY,
  team_id        UUID        NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  encrypted_name TEXT        NOT NULL,
  created_by     UUID        REFERENCES users(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX collections_team ON collections (team_id);

-- manage: edit + add/remove members, rename, delete. edit: change items.
-- view: read items.
CREATE TABLE collection_members (
  collection_id UUID        NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  user_id       UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role          TEXT        NOT NULL CHECK (role IN ('manage', 'edit', 'view')),
  wrapped_key   TEXT        NOT NULL,
  added_by      UUID        REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (collection_id, user_id)
);
CREATE INDEX collection_members_user ON collection_members (user_id);

-- Deleting a collection deletes its items (members drop collections that
-- are no longer listed for them).
ALTER TABLE vault_items
  ADD CONSTRAINT vault_items_collection FOREIGN KEY (collection_id) REFERENCES collections(id) ON DELETE CASCADE;
CREATE INDEX vault_items_collection_revision ON vault_items (collection_id, revision) WHERE collection_id IS NOT NULL;

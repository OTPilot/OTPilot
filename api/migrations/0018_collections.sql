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

-- Collection items belong to the collection, not to whoever wrote them:
-- deleting a writer's account must not delete shared items. Personal items
-- keep an owner; collection items have none.
ALTER TABLE vault_items ALTER COLUMN owner_id DROP NOT NULL;
ALTER TABLE vault_items ADD CONSTRAINT vault_items_owner_or_collection
  CHECK ((collection_id IS NULL) = (owner_id IS NOT NULL));

-- Whatever removes a member (leaving, being removed from the collection or
-- the team, deleting the account): a collection left without members is
-- deleted with its items, one left without a manager gets its oldest member
-- as manager. (Skipped when the collection itself is being deleted.)
CREATE FUNCTION collection_member_removed() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM collections WHERE id = OLD.collection_id) THEN
    RETURN NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM collection_members WHERE collection_id = OLD.collection_id) THEN
    DELETE FROM collections WHERE id = OLD.collection_id;
  ELSIF NOT EXISTS (SELECT 1 FROM collection_members WHERE collection_id = OLD.collection_id AND role = 'manage') THEN
    UPDATE collection_members SET role = 'manage'
    WHERE collection_id = OLD.collection_id
      AND user_id = (SELECT user_id FROM collection_members WHERE collection_id = OLD.collection_id
                     ORDER BY created_at, user_id LIMIT 1);
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER collection_member_removed AFTER DELETE ON collection_members
  FOR EACH ROW EXECUTE FUNCTION collection_member_removed();

-- Account deletion was blocked for anyone who ever acted in a team (the
-- audit log referenced them without ON DELETE; DELETE /users/me ignored the
-- error and left the row). The entry stays, without its actor.
ALTER TABLE audit_logs DROP CONSTRAINT audit_logs_actor_id_fkey;
ALTER TABLE audit_logs ADD CONSTRAINT audit_logs_actor_id_fkey
  FOREIGN KEY (actor_id) REFERENCES users(id) ON DELETE SET NULL;

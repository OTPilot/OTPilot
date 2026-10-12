-- In-extension notices: "a teammate added you to a collection" / "shared an
-- item with you". The extension lists them and counts them on its icon
-- badge; dismissing one deletes it, and so does the list once it's 30 days
-- old or no longer reaches the user (bounded: at most one per collection
-- membership / direct grant). Team invitations aren't stored here: they're
-- read live from pending_invites (by email), so an accepted, declined or
-- expired invite disappears by itself.
CREATE TABLE notifications (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- collection_added | item_shared
  kind        TEXT        NOT NULL,
  team_id     UUID        NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  actor_id    UUID        REFERENCES users(id) ON DELETE SET NULL,
  -- The collection or share it's about; a notice whose target is gone (or no
  -- longer reaches the user) is deleted.
  target_id   UUID        NOT NULL,
  role        TEXT        NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- One notice per thing: being added again replaces the earlier one.
CREATE UNIQUE INDEX notifications_one_per_target ON notifications (user_id, kind, target_id);

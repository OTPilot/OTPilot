-- In-extension notices: "a teammate added you to a collection" / "shared an
-- item with you". The extension shows the unread ones and counts them on its
-- icon badge. Team invitations aren't stored here: they're read live from
-- pending_invites (by email), so an accepted, declined or expired invite
-- disappears by itself.
CREATE TABLE notifications (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- collection_added | item_shared
  kind        TEXT        NOT NULL,
  team_id     UUID        NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  actor_id    UUID        REFERENCES users(id) ON DELETE SET NULL,
  -- The collection or share it's about; a notice whose target is gone (or no
  -- longer reaches the user) isn't listed.
  target_id   UUID        NOT NULL,
  role        TEXT        NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  read_at     TIMESTAMPTZ
);
CREATE INDEX notifications_unread ON notifications (user_id, created_at) WHERE read_at IS NULL;

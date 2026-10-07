-- Deleting an account must not fail on what the user left behind in a team
-- (DELETE /users/me first cancels their subscriptions, dissolves the team
-- they own and leaves the one they're in; see routes/auth.rs). These go with
-- the account: invites they sent, codes they shared (and every recipient's
-- access to them), and their access to codes shared with them.
ALTER TABLE pending_invites DROP CONSTRAINT pending_invites_invited_by_fkey;
ALTER TABLE pending_invites ADD CONSTRAINT pending_invites_invited_by_fkey
  FOREIGN KEY (invited_by) REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE shared_codes DROP CONSTRAINT shared_codes_owner_id_fkey;
ALTER TABLE shared_codes ADD CONSTRAINT shared_codes_owner_id_fkey
  FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE share_access DROP CONSTRAINT share_access_user_id_fkey;
ALTER TABLE share_access ADD CONSTRAINT share_access_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
-- teams.owner_id stays without ON DELETE on purpose: a team is dissolved
-- explicitly (members downgraded) before its owner's account goes.

-- Set when an account deletion starts (before its billing is collected and
-- cancelled): from then on no checkout or team creation is accepted, and a
-- checkout completion that still arrives cancels its subscription instead of
-- granting the plan. Cleared again if the deletion fails, so it can be retried.
ALTER TABLE users ADD COLUMN deletion_started_at TIMESTAMPTZ;

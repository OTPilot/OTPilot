-- Enforce "one team per user" at the database level so concurrent invite-accepts
-- can't race a user into two teams (the application checks too, but this is the
-- atomic backstop). The (team_id, user_id) PK still prevents duplicate rows.
ALTER TABLE team_members ADD CONSTRAINT team_members_user_id_unique UNIQUE (user_id);
